import { Effect, Layer } from "effect";
import type * as Cause from "effect/Cause";

import { EngineDecorator, type EngineStackIdentity } from "@executor-js/api/server";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";
import { OPAQUE_VALUE_TTL_MS } from "@executor-js/sdk";

interface RetainedEngineRecord {
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly ownerKey: string;
  readonly executionIds: Set<string>;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface SelfHostExecutionRetention {
  readonly decorate: <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ) => ExecutionEngine<E>;
  readonly dispose: Effect.Effect<void>;
}

export interface SelfHostExecutionRetentionOptions {
  readonly ttlMs?: number;
}

const identityKey = (identity: EngineStackIdentity): string =>
  `${identity.organizationId}\u0000${identity.accountId}`;

/**
 * Keep self-host HTTP approval fibers alive across the execute and resume
 * requests without persisting or replaying their code.
 *
 * This is deliberately a self-host seam: its SQLite handle lives for the
 * process lifetime, so the retained engine can safely continue using the exact
 * executor that produced the pause. Cloud's request-scoped postgres handle
 * cannot cross request boundaries and must not use this decorator.
 */
export const makeSelfHostExecutionRetention = (
  options: SelfHostExecutionRetentionOptions = {},
): SelfHostExecutionRetention => {
  const ttlMs = options.ttlMs ?? OPAQUE_VALUE_TTL_MS;
  const byExecutionId = new Map<string, RetainedEngineRecord>();
  const byEngine = new WeakMap<object, RetainedEngineRecord>();
  const records = new Set<RetainedEngineRecord>();

  const removeRecord = (record: RetainedEngineRecord): void => {
    if (!records.delete(record)) return;
    clearTimeout(record.timer);
    byEngine.delete(record.engine);
    for (const executionId of record.executionIds) {
      if (byExecutionId.get(executionId) === record) byExecutionId.delete(executionId);
    }
  };

  const expireRecord = (record: RetainedEngineRecord): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!records.has(record)) return Effect.void;
      removeRecord(record);
      return record.engine.shutdown;
    });

  const retain = <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    ownerKey: string,
    executionId: string,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      let record = byEngine.get(engine);
      if (!record) {
        let created: RetainedEngineRecord | undefined;
        const timer = setTimeout(() => {
          if (created) Effect.runFork(expireRecord(created));
        }, ttlMs);
        timer.unref?.();
        record = {
          engine,
          ownerKey,
          executionIds: new Set<string>(),
          timer,
        };
        created = record;
        byEngine.set(engine, record);
        records.add(record);
      }
      record.executionIds.add(executionId);
      byExecutionId.set(executionId, record);
    });

  const decorate = <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ): ExecutionEngine<E> => {
    const ownerKey = identityKey(identity);

    const retainedEngine = (executionId: string): ExecutionEngine<E> | undefined => {
      const record = byExecutionId.get(executionId);
      if (!record || record.ownerKey !== ownerKey) return undefined;
      // Records are written only by this generic decorator and routed back to
      // the same host engine contract. The map erases E solely so identities
      // can share one registry without weakening the public engine type.
      return record.engine as ExecutionEngine<E>;
    };

    const route = (executionId: string): ExecutionEngine<E> =>
      retainedEngine(executionId) ?? engine;

    const retainOutcome = (
      routed: ExecutionEngine<E>,
      outcome: ExecutionResult | null,
    ): Effect.Effect<void> =>
      outcome?.status === "paused" ? retain(routed, ownerKey, outcome.execution.id) : Effect.void;

    const retainedForOwner = (): readonly RetainedEngineRecord[] =>
      Array.from(records).filter((record) => record.ownerKey === ownerKey);

    return {
      ...engine,
      executeWithPause: (code, executeOptions) =>
        engine
          .executeWithPause(code, executeOptions)
          .pipe(Effect.tap((outcome) => retainOutcome(engine, outcome))),
      resume: (executionId, response) => {
        const routed = route(executionId);
        return routed
          .resume(executionId, response)
          .pipe(Effect.tap((outcome) => retainOutcome(routed, outcome)));
      },
      grantLiveApproval: (executionId, response) =>
        route(executionId).grantLiveApproval(executionId, response),
      isExecutionSettled: (executionId) => {
        const routed = route(executionId);
        return routed.isExecutionSettled?.(executionId) ?? Effect.succeed(false);
      },
      getPausedExecution: (executionId) => route(executionId).getPausedExecution(executionId),
      pausedExecutionCount: () =>
        Effect.all(
          [
            ...(byEngine.has(engine) ? [] : [engine]),
            ...retainedForOwner().map((record) => record.engine),
          ].map((candidate) => candidate.pausedExecutionCount()),
        ).pipe(Effect.map((counts) => counts.reduce((total, count) => total + count, 0))),
      hasPausedExecutions: () =>
        Effect.all(
          [
            ...(byEngine.has(engine) ? [] : [engine]),
            ...retainedForOwner().map((record) => record.engine),
          ].map((candidate) => candidate.hasPausedExecutions()),
        ).pipe(Effect.map((values) => values.some(Boolean))),
      // The request owns a newly-created engine unless it returned a pause.
      // Once retained, the registry owns shutdown and the request finalizer
      // must leave the live fiber alone for the later resume request.
      shutdown: Effect.suspend(() => (byEngine.has(engine) ? Effect.void : engine.shutdown)),
    };
  };

  return {
    decorate,
    dispose: Effect.gen(function* () {
      const retained = Array.from(records);
      for (const record of retained) removeRecord(record);
      yield* Effect.all(
        retained.map((record) => record.engine.shutdown),
        { concurrency: "unbounded", discard: true },
      );
    }),
  };
};

export const makeSelfHostExecutionRetentionDecorator = (
  retention: SelfHostExecutionRetention,
): Layer.Layer<EngineDecorator> =>
  Layer.succeed(EngineDecorator)({
    decorate: (engine, identity) => retention.decorate(engine, identity),
  });
