import { Effect, Layer } from "effect";
import type * as Cause from "effect/Cause";

import { EngineDecorator, type EngineStackIdentity } from "@executor-js/api/server";
import type { ExecutionEngine, ExecutionResult } from "@executor-js/execution";
import { OPAQUE_VALUE_TTL_MS } from "@executor-js/sdk";

interface RetainedEngineRecord {
  readonly engine: ExecutionEngine<Cause.YieldableError>;
  readonly ownerKey: string;
  readonly quotaKey: string;
  readonly executionIds: Set<string>;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  shutdownStarted: boolean;
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
  readonly maxRetainedEngines?: number;
  readonly maxRetainedEnginesPerAccount?: number;
  readonly now?: () => number;
}

// A retained engine owns a live QuickJS fiber (whose VM has its own memory
// ceiling), so the TTL alone is not an availability bound. Keep ordinary
// multi-step approval flows roomy while containing an authenticated burst.
const DEFAULT_MAX_RETAINED_ENGINES = 32;
const DEFAULT_MAX_RETAINED_ENGINES_PER_ACCOUNT = 8;

const identityKey = (identity: EngineStackIdentity): string =>
  `${identity.organizationId}\u0000${identity.accountId}`;

const positiveIntegerOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

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
  const ttlMs = positiveIntegerOr(options.ttlMs, OPAQUE_VALUE_TTL_MS);
  const now = options.now ?? Date.now;
  const maxRetainedEngines = positiveIntegerOr(
    options.maxRetainedEngines,
    DEFAULT_MAX_RETAINED_ENGINES,
  );
  const maxRetainedEnginesPerAccount = Math.min(
    maxRetainedEngines,
    positiveIntegerOr(
      options.maxRetainedEnginesPerAccount,
      DEFAULT_MAX_RETAINED_ENGINES_PER_ACCOUNT,
    ),
  );
  const byExecutionId = new Map<string, RetainedEngineRecord>();
  const byEngine = new WeakMap<object, RetainedEngineRecord>();
  // A wrapper whose engine ever entered the registry must never reclaim it in
  // its request finalizer. Eviction, expiry, terminal cleanup, or process
  // disposal owns that shutdown instead. Weak membership keeps this race-safe
  // without extending an engine's lifetime.
  const registryOwnedEngines = new WeakSet<object>();
  const records = new Set<RetainedEngineRecord>();

  const removeRecord = (record: RetainedEngineRecord): void => {
    if (!records.delete(record)) return;
    clearTimeout(record.timer);
    byEngine.delete(record.engine);
    for (const executionId of record.executionIds) {
      if (byExecutionId.get(executionId) === record) byExecutionId.delete(executionId);
    }
  };

  const shutdownRecord = (record: RetainedEngineRecord): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (record.shutdownStarted) return Effect.void;
      record.shutdownStarted = true;
      removeRecord(record);
      return record.engine.shutdown;
    });

  const expireOverdueRecord = (record: RetainedEngineRecord): boolean => {
    if (now() < record.expiresAt || !records.has(record)) return false;
    removeRecord(record);
    Effect.runFork(shutdownRecord(record));
    return true;
  };

  const sweepOverdueRecords = (): void => {
    for (const record of records) expireOverdueRecord(record);
  };

  const removeExecutionId = (record: RetainedEngineRecord, executionId: string): void => {
    record.executionIds.delete(executionId);
    if (byExecutionId.get(executionId) === record) byExecutionId.delete(executionId);
  };

  const evictForCapacity = (quotaKey: string): readonly RetainedEngineRecord[] => {
    sweepOverdueRecords();
    const evicted: RetainedEngineRecord[] = [];
    const accountRecords = Array.from(records).filter((record) => record.quotaKey === quotaKey);

    while (accountRecords.length >= maxRetainedEnginesPerAccount) {
      const oldest = accountRecords.shift();
      if (!oldest) break;
      removeRecord(oldest);
      evicted.push(oldest);
    }

    while (records.size >= maxRetainedEngines) {
      const oldest = records.values().next().value as RetainedEngineRecord | undefined;
      if (!oldest) break;
      removeRecord(oldest);
      evicted.push(oldest);
    }

    return evicted;
  };

  const retain = <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    ownerKey: string,
    quotaKey: string,
    executionId: string,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      let record = byEngine.get(engine);
      let evicted: readonly RetainedEngineRecord[] = [];
      if (!record) {
        evicted = evictForCapacity(quotaKey);
        let created: RetainedEngineRecord | undefined;
        const timer = setTimeout(() => {
          if (created) Effect.runFork(shutdownRecord(created));
        }, ttlMs);
        timer.unref?.();
        record = {
          engine,
          ownerKey,
          quotaKey,
          executionIds: new Set<string>(),
          expiresAt: now() + ttlMs,
          timer,
          shutdownStarted: false,
        };
        created = record;
        byEngine.set(engine, record);
        registryOwnedEngines.add(engine);
        records.add(record);
      }
      record.executionIds.add(executionId);
      byExecutionId.set(executionId, record);
      return evicted;
    }).pipe(
      Effect.flatMap((evicted) =>
        Effect.all(evicted.map(shutdownRecord), { concurrency: 2, discard: true }),
      ),
    );

  const decorate = <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ): ExecutionEngine<E> => {
    const ownerKey = identityKey(identity);
    const quotaKey = identity.accountId;

    const retainedEngine = (executionId: string): ExecutionEngine<E> | undefined => {
      const record = byExecutionId.get(executionId);
      if (!record || record.ownerKey !== ownerKey || expireOverdueRecord(record)) return undefined;
      // Records are written only by this generic decorator and routed back to
      // the same host engine contract. The map erases E solely so identities
      // can share one registry without weakening the public engine type.
      return record.engine as ExecutionEngine<E>;
    };

    const route = (executionId: string): ExecutionEngine<E> =>
      retainedEngine(executionId) ?? engine;

    const settleOutcome = (
      routed: ExecutionEngine<E>,
      outcome: ExecutionResult | null,
    ): Effect.Effect<void> => {
      if (outcome?.status === "paused") {
        return retain(routed, ownerKey, quotaKey, outcome.execution.id);
      }
      const record = byEngine.get(routed);
      return record ? shutdownRecord(record) : Effect.void;
    };

    const retainedForOwner = (): readonly RetainedEngineRecord[] => {
      sweepOverdueRecords();
      return Array.from(records).filter((record) => record.ownerKey === ownerKey);
    };

    return {
      ...engine,
      executeWithPause: (code, executeOptions) =>
        engine
          .executeWithPause(code, executeOptions)
          .pipe(Effect.tap((outcome) => settleOutcome(engine, outcome))),
      resume: (executionId, response) => {
        const routed = route(executionId);
        return routed.resume(executionId, response).pipe(
          Effect.tap((outcome) => {
            const record = byEngine.get(routed);
            if (record) removeExecutionId(record, executionId);
            return settleOutcome(routed, outcome);
          }),
        );
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
      // must leave the live fiber alone for the later resume request. Ownership
      // remains recorded after eviction/expiry so a racing finalizer cannot
      // shut the same engine down twice.
      shutdown: Effect.suspend(() =>
        registryOwnedEngines.has(engine) ? Effect.void : engine.shutdown,
      ),
    };
  };

  return {
    decorate,
    dispose: Effect.gen(function* () {
      const retained = Array.from(records);
      for (const record of retained) removeRecord(record);
      yield* Effect.all(retained.map(shutdownRecord), { concurrency: 4, discard: true });
    }),
  };
};

export const makeSelfHostExecutionRetentionDecorator = (
  retention: SelfHostExecutionRetention,
): Layer.Layer<EngineDecorator> =>
  Layer.succeed(EngineDecorator)({
    decorate: (engine, identity) => retention.decorate(engine, identity),
  });
