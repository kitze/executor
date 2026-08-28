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

const makeStubEngine = (initialPauseId: string, firstResumePauseId?: string) => {
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
        if (firstResumePauseId !== undefined && state.resumeCount === 1) {
          const execution = pause(firstResumePauseId);
          state.paused.set(firstResumePauseId, execution);
          return { status: "paused" as const, execution };
        }
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
        expect(first.state.shutdownCount).toBe(1);
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

  it.effect("evicts the oldest pause at both per-account and global capacity", () =>
    Effect.gen(function* () {
      const retention = makeSelfHostExecutionRetention({
        ttlMs: 60_000,
        maxRetainedEngines: 2,
        maxRetainedEnginesPerAccount: 2,
      });
      return yield* Effect.gen(function* () {
        const first = makeStubEngine("exec_first");
        const second = makeStubEngine("exec_second");
        const third = makeStubEngine("exec_third");
        const fourth = makeStubEngine("exec_fourth");

        const firstRequest = retention.decorate(first.engine, identity);
        yield* firstRequest.executeWithPause("return await tools.policy()", {});
        yield* firstRequest.shutdown;

        const secondRequest = retention.decorate(second.engine, identity);
        yield* secondRequest.executeWithPause("return await tools.policy()", {});
        yield* secondRequest.shutdown;

        const thirdRequest = retention.decorate(third.engine, {
          ...identity,
          organizationId: "org_2",
        });
        yield* thirdRequest.executeWithPause("return await tools.policy()", {});
        yield* thirdRequest.shutdown;

        const ownerProbe = retention.decorate(makeStubEngine("exec_probe").engine, identity);
        expect(first.state.shutdownCount).toBe(1);
        yield* firstRequest.shutdown;
        expect(first.state.shutdownCount).toBe(1);
        expect(yield* ownerProbe.getPausedExecution("exec_first")).toBeNull();
        expect(yield* ownerProbe.getPausedExecution("exec_second")).not.toBeNull();
        expect(yield* thirdRequest.getPausedExecution("exec_third")).not.toBeNull();

        const otherIdentity = { ...identity, accountId: "user_2" };
        const fourthRequest = retention.decorate(fourth.engine, otherIdentity);
        yield* fourthRequest.executeWithPause("return await tools.policy()", {});
        yield* fourthRequest.shutdown;

        expect(second.state.shutdownCount).toBe(1);
        expect(yield* ownerProbe.getPausedExecution("exec_second")).toBeNull();
        expect(yield* thirdRequest.getPausedExecution("exec_third")).not.toBeNull();
        expect(yield* fourthRequest.getPausedExecution("exec_fourth")).not.toBeNull();

        yield* ownerProbe.shutdown;
        yield* retention.dispose;
        expect(third.state.shutdownCount).toBe(1);
        expect(fourth.state.shutdownCount).toBe(1);
      }).pipe(Effect.ensuring(retention.dispose));
    }),
  );

  it.effect("drops superseded ids and releases a terminal pause immediately", () =>
    Effect.gen(function* () {
      const retention = makeSelfHostExecutionRetention({ ttlMs: 60_000 });
      return yield* Effect.gen(function* () {
        const retained = makeStubEngine("exec_first_step", "exec_second_step");
        const firstRequest = retention.decorate(retained.engine, identity);
        yield* firstRequest.executeWithPause("return await tools.policy()", {});
        yield* firstRequest.shutdown;

        const secondRequest = retention.decorate(makeStubEngine("exec_unused").engine, identity);
        const next = yield* secondRequest.resume("exec_first_step", { action: "accept" });
        expect(next?.status).toBe("paused");
        expect(yield* secondRequest.getPausedExecution("exec_first_step")).toBeNull();
        expect(yield* secondRequest.getPausedExecution("exec_second_step")).not.toBeNull();
        yield* secondRequest.shutdown;

        const finalRequest = retention.decorate(makeStubEngine("exec_unused_2").engine, identity);
        const completed = yield* finalRequest.resume("exec_second_step", { action: "accept" });
        expect(completed?.status).toBe("completed");
        expect(retained.state.shutdownCount).toBe(1);
        expect(yield* finalRequest.getPausedExecution("exec_second_step")).toBeNull();
        yield* finalRequest.shutdown;

        yield* retention.dispose;
        expect(retained.state.shutdownCount).toBe(1);
      }).pipe(Effect.ensuring(retention.dispose));
    }),
  );

  it.effect("fails closed on an overdue pause even when its timer has not run", () =>
    Effect.gen(function* () {
      let now = 1_000;
      const retention = makeSelfHostExecutionRetention({
        ttlMs: 60_000,
        now: () => now,
      });
      return yield* Effect.gen(function* () {
        const retained = makeStubEngine("exec_overdue");
        const firstRequest = retention.decorate(retained.engine, identity);
        yield* firstRequest.executeWithPause("return await tools.policy()", {});
        yield* firstRequest.shutdown;

        now += 60_001;
        const laterRequest = retention.decorate(makeStubEngine("exec_unused").engine, identity);
        expect(yield* laterRequest.getPausedExecution("exec_overdue")).toBeNull();
        expect(retained.state.shutdownCount).toBe(1);
        yield* firstRequest.shutdown;
        expect(retained.state.shutdownCount).toBe(1);
        yield* laterRequest.shutdown;

        yield* retention.dispose;
        expect(retained.state.shutdownCount).toBe(1);
      }).pipe(Effect.ensuring(retention.dispose));
    }),
  );
});
