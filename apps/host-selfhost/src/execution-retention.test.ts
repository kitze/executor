import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  ExecutionEngine,
  ExecutionResult,
  PausedExecution,
  ResumeResponse,
} from "@executor-js/execution";
import { FormElicitation, ToolAddress } from "@executor-js/sdk";

import { makeSelfHostExecutionRetention } from "./execution-retention";

const identity = {
  accountId: "user_1",
  organizationId: "org_1",
  organizationName: "Org 1",
};

const pause = (id: string): PausedExecution => ({
  id,
  elicitationContext: {
    address: ToolAddress.make("executor.coreTools.policies.create"),
    request: FormElicitation.make({
      message: "Approve policy creation?",
      requestedSchema: {},
    }),
  },
});

interface StubEngineState {
  readonly paused: Map<string, PausedExecution>;
  executeCount: number;
  resumeCount: number;
  grantCount: number;
  shutdownCount: number;
}

const makeStubEngine = (initialPauseId: string) => {
  const state: StubEngineState = {
    paused: new Map(),
    executeCount: 0,
    resumeCount: 0,
    grantCount: 0,
    shutdownCount: 0,
  };

  const completed: ExecutionResult = {
    status: "completed",
    result: { result: "done" },
  };

  const engine: ExecutionEngine<never> = {
    execute: () => Effect.succeed({ result: "done" }),
    executeWithPause: () =>
      Effect.sync(() => {
        state.executeCount += 1;
        const execution = pause(initialPauseId);
        state.paused.set(initialPauseId, execution);
        return { status: "paused" as const, execution };
      }),
    resume: (executionId) =>
      Effect.sync(() => {
        state.resumeCount += 1;
        if (!state.paused.delete(executionId)) return null;
        return completed;
      }),
    grantLiveApproval: (executionId, response) =>
      Effect.sync(() => {
        state.grantCount += 1;
        return state.paused.has(executionId) ? ({ ...response } satisfies ResumeResponse) : null;
      }),
    isExecutionSettled: (executionId) =>
      Effect.sync(() => state.resumeCount > 0 && !state.paused.has(executionId)),
    getPausedExecution: (executionId) => Effect.sync(() => state.paused.get(executionId) ?? null),
    pausedExecutionCount: () => Effect.sync(() => state.paused.size),
    hasPausedExecutions: () => Effect.sync(() => state.paused.size > 0),
    getDescription: Effect.succeed("stub"),
    shutdown: Effect.sync(() => {
      state.shutdownCount += 1;
      state.paused.clear();
    }),
  };

  return { engine, state };
};

describe("self-host HTTP execution retention", () => {
  it.effect("routes a later approval request to the exact engine that paused", () =>
    Effect.gen(function* () {
      const retention = makeSelfHostExecutionRetention({ ttlMs: 60_000 });
      return yield* Effect.gen(function* () {
        const first = makeStubEngine("exec_retained");
        const firstRequest = retention.decorate(first.engine, identity);

        const outcome = yield* firstRequest.executeWithPause("return await tools.policy()", {});
        expect(outcome.status).toBe("paused");

        // The middleware finalizer runs after the execute response. Ownership has
        // moved to the retention registry, so this must leave the pause intact.
        yield* firstRequest.shutdown;
        expect(first.state.shutdownCount).toBe(0);

        const second = makeStubEngine("exec_unused");
        const resumeRequest = retention.decorate(second.engine, identity);

        expect(yield* resumeRequest.getPausedExecution("exec_retained")).not.toBeNull();
        expect(yield* resumeRequest.pausedExecutionCount()).toBe(1);

        const granted = yield* resumeRequest.grantLiveApproval("exec_retained", {
          action: "accept",
        });
        expect(granted).not.toBeNull();
        if (!granted) return;

        const resumed = yield* resumeRequest.resume("exec_retained", granted);
        expect(resumed?.status).toBe("completed");
        expect(first.state.grantCount).toBe(1);
        expect(first.state.resumeCount).toBe(1);
        expect(second.state.grantCount).toBe(0);
        expect(second.state.resumeCount).toBe(0);

        // The second request's unused engine is still request-owned.
        yield* resumeRequest.shutdown;
        expect(second.state.shutdownCount).toBe(1);

        yield* retention.dispose;
        expect(first.state.shutdownCount).toBe(1);
      }).pipe(Effect.ensuring(retention.dispose));
    }),
  );

  it.effect("does not reveal a retained pause to another tenant or subject", () =>
    Effect.gen(function* () {
      const retention = makeSelfHostExecutionRetention({ ttlMs: 60_000 });
      return yield* Effect.gen(function* () {
        const owner = makeStubEngine("exec_private");
        const ownerRequest = retention.decorate(owner.engine, identity);
        yield* ownerRequest.executeWithPause("return await tools.policy()", {});

        const stranger = makeStubEngine("exec_stranger");
        const strangerRequest = retention.decorate(stranger.engine, {
          ...identity,
          accountId: "user_2",
        });

        expect(yield* strangerRequest.getPausedExecution("exec_private")).toBeNull();
        expect(
          yield* strangerRequest.grantLiveApproval("exec_private", { action: "accept" }),
        ).toBeNull();
        expect(owner.state.grantCount).toBe(0);

        yield* retention.dispose;
      }).pipe(Effect.ensuring(retention.dispose));
    }),
  );
});
