import { Effect } from "effect";
import type * as Cause from "effect/Cause";
import { describe, expect, test } from "@effect/vitest";

import type { EngineStackIdentity } from "@executor-js/api/server";
import type {
  ExecutionEngine,
  ExecutionResult,
  PausedExecution,
  ResumeResponse,
} from "@executor-js/execution";
import { FormElicitation, ToolAddress } from "@executor-js/sdk/shared";

import { makeLiveExecutionRouter } from "./live-execution-router";

const identity = (accountId: string): EngineStackIdentity => ({
  accountId,
  organizationId: "org-1",
  organizationName: "Test",
});

const pausedExecution = (executionId: string): PausedExecution =>
  ({
    id: executionId,
    requiresLiveApproval: true,
    elicitationContext: {
      address: ToolAddress.make("tools.test.org.main.write"),
      request: FormElicitation.make({
        message: "Approve write?",
        requestedSchema: { type: "object", properties: {} },
      }),
    },
  }) satisfies PausedExecution;

const pausedResult = (executionId: string): ExecutionResult => ({
  status: "paused",
  execution: pausedExecution(executionId),
});

const completedResult: ExecutionResult = {
  status: "completed",
  result: { result: "ok" },
};

const makeFakeEngine = (executionId: string) => {
  let paused = false;
  let resumes = 0;
  let cancellations = 0;
  const grants = new WeakSet<object>();

  const engine: ExecutionEngine<Cause.YieldableError> = {
    execute: () => Effect.succeed({ result: "ok" }),
    executeWithPause: () =>
      Effect.sync(() => {
        paused = true;
        return pausedResult(executionId);
      }),
    resume: (_id: string, response: ResumeResponse) =>
      Effect.sync(() => {
        resumes += 1;
        if (!paused) return null;
        if (response.action === "cancel" || response.action === "decline") {
          cancellations += 1;
          paused = false;
          return completedResult;
        }
        if (!grants.has(response)) return pausedResult(executionId);
        paused = false;
        return completedResult;
      }),
    grantLiveApproval: (_id, response) =>
      Effect.sync(() => {
        if (!paused || response.action !== "accept") return null;
        const granted = { ...response };
        grants.add(granted);
        return granted;
      }),
    isExecutionSettled: () => Effect.sync(() => !paused),
    getPausedExecution: () => Effect.sync(() => (paused ? pausedExecution(executionId) : null)),
    pausedExecutionCount: () => Effect.sync(() => (paused ? 1 : 0)),
    hasPausedExecutions: () => Effect.sync(() => paused),
    getDescription: Effect.succeed("fake"),
  };

  return {
    engine,
    resumes: () => resumes,
    cancellations: () => cancellations,
  };
};

describe("self-host live execution router", () => {
  test("routes a later request to the exact engine that owns the pause", async () => {
    const router = makeLiveExecutionRouter();
    const firstRaw = makeFakeEngine("exec-first");
    const laterRaw = makeFakeEngine("exec-unused");
    const firstRequest = router.decorate(firstRaw.engine, identity("alice"));
    const laterRequest = router.decorate(laterRaw.engine, identity("alice"));

    await Effect.runPromise(firstRequest.executeWithPause("code"));
    expect(await Effect.runPromise(laterRequest.getPausedExecution("exec-first"))).not.toBeNull();

    // A serialized accept is not the process-local grant.
    const stillPaused = await Effect.runPromise(
      laterRequest.resume("exec-first", { action: "accept" }),
    );
    expect(stillPaused?.status).toBe("paused");

    const granted = await Effect.runPromise(
      laterRequest.grantLiveApproval("exec-first", { action: "accept" }),
    );
    expect(granted).not.toBeNull();
    const completed = await Effect.runPromise(laterRequest.resume("exec-first", granted!));
    expect(completed?.status).toBe("completed");
    expect(firstRaw.resumes()).toBe(2);
    expect(laterRaw.resumes()).toBe(0);

    await Effect.runPromise(router.dispose);
  });

  test("does not reveal or resume another account's execution id", async () => {
    const router = makeLiveExecutionRouter();
    const raw = makeFakeEngine("exec-owned");
    const owner = router.decorate(raw.engine, identity("alice"));
    const stranger = router.decorate(makeFakeEngine("exec-other").engine, identity("mallory"));

    await Effect.runPromise(owner.executeWithPause("code"));
    expect(await Effect.runPromise(stranger.getPausedExecution("exec-owned"))).toBeNull();
    expect(
      await Effect.runPromise(stranger.grantLiveApproval("exec-owned", { action: "accept" })),
    ).toBeNull();
    expect(
      await Effect.runPromise(stranger.resume("exec-owned", { action: "decline" })),
    ).toBeNull();
    expect(raw.resumes()).toBe(0);

    await Effect.runPromise(router.dispose);
    expect(raw.cancellations()).toBe(1);
  });

  test("cancels the oldest pause when the bounded live-fiber allowance is full", async () => {
    const router = makeLiveExecutionRouter({
      maxLivePauses: 1,
      maxLivePausesPerOwner: 1,
    });
    const oldest = makeFakeEngine("exec-oldest");
    const newest = makeFakeEngine("exec-newest");
    const firstRequest = router.decorate(oldest.engine, identity("alice"));
    const secondRequest = router.decorate(newest.engine, identity("alice"));

    await Effect.runPromise(firstRequest.executeWithPause("code"));
    await Effect.runPromise(secondRequest.executeWithPause("code"));

    expect(oldest.cancellations()).toBe(1);
    expect(await Effect.runPromise(secondRequest.getPausedExecution("exec-oldest"))).toBeNull();
    expect(await Effect.runPromise(secondRequest.getPausedExecution("exec-newest"))).not.toBeNull();

    await Effect.runPromise(router.dispose);
  });

  test("expires and cancels an abandoned pause", async () => {
    const router = makeLiveExecutionRouter({ pauseTtlMs: 20 });
    const raw = makeFakeEngine("exec-expiring");
    const request = router.decorate(raw.engine, identity("alice"));

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* request.executeWithPause("code");
        yield* Effect.sleep(50);
      }),
    );

    expect(raw.cancellations()).toBe(1);
    expect(await Effect.runPromise(request.getPausedExecution("exec-expiring"))).toBeNull();
    await Effect.runPromise(router.dispose);
  });
});
