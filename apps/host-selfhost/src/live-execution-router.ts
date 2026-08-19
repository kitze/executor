import { Effect, Fiber } from "effect";
import type * as Cause from "effect/Cause";

import type { EngineStackIdentity } from "@executor-js/api/server";
import type { ExecutionEngine, ExecutionResult, ResumeResponse } from "@executor-js/execution";

// A console/API approval is deliberately process-local: the only safe thing to
// resume is the exact suspended fiber that produced the prompt. The shared HTTP
// stack builds a fresh engine for every request, so this router retains ONLY
// engines with a live pause and sends a later get/grant/resume request back to
// its owning engine. It never persists or replays code.

const DEFAULT_PAUSE_TTL_MS = 15 * 60_000;
const DEFAULT_SETTLED_TTL_MS = 60_000;
const DEFAULT_MAX_LIVE_PAUSES = 16;
const DEFAULT_MAX_LIVE_PAUSES_PER_OWNER = 8;
const DEFAULT_MAX_ENTRIES = 128;

type WideEngine = ExecutionEngine<Cause.YieldableError>;

interface LiveExecutionEntry {
  readonly owner: string;
  readonly engine: WideEngine;
  state: "paused" | "settled";
  sequence: number;
  timer: Fiber.Fiber<void, never> | null;
}

export interface LiveExecutionRouterOptions {
  /** Human approval window. The upstream persisted fallback used 15 minutes. */
  readonly pauseTtlMs?: number;
  /** Short retry window for an already-settled resume response. */
  readonly settledTtlMs?: number;
  /** Global cap on QuickJS fibers waiting for a human. */
  readonly maxLivePauses?: number;
  /** Per-account cap so one caller cannot occupy the whole global allowance. */
  readonly maxLivePausesPerOwner?: number;
  /** Bounded idempotency routes, including lightweight settled entries. */
  readonly maxEntries?: number;
}

export interface LiveExecutionRouter {
  readonly decorate: <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ) => ExecutionEngine<E>;
  readonly dispose: Effect.Effect<void>;
}

const positiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.floor(value);

const ownerKey = (identity: EngineStackIdentity): string =>
  JSON.stringify([identity.accountId, identity.organizationId]);

export const makeLiveExecutionRouter = (
  options: LiveExecutionRouterOptions = {},
): LiveExecutionRouter => {
  const pauseTtlMs = positiveInteger(options.pauseTtlMs, DEFAULT_PAUSE_TTL_MS);
  const settledTtlMs = positiveInteger(options.settledTtlMs, DEFAULT_SETTLED_TTL_MS);
  const maxLivePauses = positiveInteger(options.maxLivePauses, DEFAULT_MAX_LIVE_PAUSES);
  const maxLivePausesPerOwner = positiveInteger(
    options.maxLivePausesPerOwner,
    DEFAULT_MAX_LIVE_PAUSES_PER_OWNER,
  );
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);

  const entries = new Map<string, LiveExecutionEntry>();
  let sequence = 0;

  const lookup = (executionId: string, owner: string): LiveExecutionEntry | null => {
    const entry = entries.get(executionId);
    // An id owned by another account is indistinguishable from a missing id.
    return entry?.owner === owner ? entry : null;
  };

  const interruptTimer = (entry: LiveExecutionEntry): Effect.Effect<void> => {
    const timer = entry.timer;
    entry.timer = null;
    return timer ? Fiber.interrupt(timer).pipe(Effect.asVoid) : Effect.void;
  };

  const cancelPausedEntry = (executionId: string, entry: LiveExecutionEntry): Effect.Effect<void> =>
    entry.state === "paused"
      ? entry.engine
          .resume(executionId, { action: "cancel" })
          .pipe(Effect.ignoreCause({ log: false }))
      : Effect.void;

  const evict = (executionId: string, entry: LiveExecutionEntry): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (entries.get(executionId) !== entry) return;
      entries.delete(executionId);
      yield* interruptTimer(entry);
      yield* cancelPausedEntry(executionId, entry);
    });

  const oldest = (
    predicate: (entry: LiveExecutionEntry) => boolean,
  ): readonly [string, LiveExecutionEntry] | null => {
    let candidate: readonly [string, LiveExecutionEntry] | null = null;
    for (const item of entries) {
      if (!predicate(item[1])) continue;
      if (candidate === null || item[1].sequence < candidate[1].sequence) candidate = item;
    }
    return candidate;
  };

  const expire = (executionId: string, expected: LiveExecutionEntry): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entries.get(executionId) !== expected) return Effect.void;
      entries.delete(executionId);
      expected.timer = null;
      return cancelPausedEntry(executionId, expected);
    });

  const schedule = (
    executionId: string,
    entry: LiveExecutionEntry,
    ttlMs: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* interruptTimer(entry);
      entry.timer = yield* Effect.forkDetach(
        Effect.sleep(ttlMs).pipe(Effect.flatMap(() => expire(executionId, entry))),
      );
    });

  const enforceCapacity = (owner: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (
        [...entries.values()].filter((entry) => entry.owner === owner && entry.state === "paused")
          .length >= maxLivePausesPerOwner
      ) {
        const victim = oldest((entry) => entry.owner === owner && entry.state === "paused");
        if (!victim) break;
        yield* evict(victim[0], victim[1]);
      }

      while (
        [...entries.values()].filter((entry) => entry.state === "paused").length >= maxLivePauses
      ) {
        const victim = oldest((entry) => entry.state === "paused");
        if (!victim) break;
        yield* evict(victim[0], victim[1]);
      }

      while (entries.size >= maxEntries) {
        // Settled retry routes are cheapest to discard. If every entry is live,
        // cancel the oldest pause instead of allowing unbounded QuickJS runtimes.
        const victim = oldest((entry) => entry.state === "settled") ?? oldest(() => true);
        if (!victim) break;
        yield* evict(victim[0], victim[1]);
      }
    });

  const rememberPause = (
    executionId: string,
    owner: string,
    engine: WideEngine,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const existing = entries.get(executionId);
      if (existing) {
        // UUID collisions are not expected. Never replace another owner's live
        // route if one somehow occurs.
        if (existing.owner !== owner || existing.engine !== engine) return;
        existing.state = "paused";
        existing.sequence = ++sequence;
        yield* schedule(executionId, existing, pauseTtlMs);
        return;
      }

      yield* enforceCapacity(owner);
      const entry: LiveExecutionEntry = {
        owner,
        engine,
        state: "paused",
        sequence: ++sequence,
        timer: null,
      };
      entries.set(executionId, entry);
      yield* schedule(executionId, entry, pauseTtlMs);
    });

  const rememberSettled = (executionId: string, entry: LiveExecutionEntry): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (entries.get(executionId) !== entry) return;
      entry.state = "settled";
      entry.sequence = ++sequence;
      yield* schedule(executionId, entry, settledTtlMs);
    });

  const forget = (executionId: string, entry: LiveExecutionEntry): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (entries.get(executionId) !== entry) return;
      entries.delete(executionId);
      // There is no live pause according to the owning engine, so only stop the
      // router's retention timer; do not attempt a synthetic second resume.
      yield* interruptTimer(entry);
    });

  const recordRoutedOutcome = (
    executionId: string,
    entry: LiveExecutionEntry,
    result: ExecutionResult | null,
  ): Effect.Effect<void> =>
    result === null
      ? forget(executionId, entry)
      : Effect.gen(function* () {
          yield* rememberSettled(executionId, entry);
          if (result.status === "paused") {
            yield* rememberPause(result.execution.id, entry.owner, entry.engine);
          }
        });

  const decorate = <E extends Cause.YieldableError>(
    engine: ExecutionEngine<E>,
    identity: EngineStackIdentity,
  ): ExecutionEngine<E> => {
    const owner = ownerKey(identity);
    const wideEngine = engine as WideEngine;

    const routed = (executionId: string): ExecutionEngine<E> | null => {
      const entry = lookup(executionId, owner);
      return entry ? (entry.engine as ExecutionEngine<E>) : null;
    };

    return {
      ...engine,
      executeWithPause: (code, executeOptions) =>
        engine
          .executeWithPause(code, executeOptions)
          .pipe(
            Effect.tap((result) =>
              result.status === "paused"
                ? rememberPause(result.execution.id, owner, wideEngine)
                : Effect.void,
            ),
          ),
      resume: (executionId: string, response: ResumeResponse) =>
        Effect.suspend(() => {
          const entry = lookup(executionId, owner);
          const target = routed(executionId);
          if (!entry || !target) return Effect.succeed(null);
          return target
            .resume(executionId, response)
            .pipe(Effect.tap((result) => recordRoutedOutcome(executionId, entry, result)));
        }),
      grantLiveApproval: (executionId, response) =>
        Effect.suspend(() => {
          const target = routed(executionId);
          return target ? target.grantLiveApproval(executionId, response) : Effect.succeed(null);
        }),
      isExecutionSettled: (executionId) =>
        Effect.suspend(() => {
          const target = routed(executionId);
          return target?.isExecutionSettled
            ? target.isExecutionSettled(executionId)
            : Effect.succeed(false);
        }),
      getPausedExecution: (executionId) =>
        Effect.suspend(() => {
          const entry = lookup(executionId, owner);
          const target = routed(executionId);
          if (!entry || !target) return Effect.succeed(null);
          return target
            .getPausedExecution(executionId)
            .pipe(
              Effect.tap((paused) => (paused === null ? forget(executionId, entry) : Effect.void)),
            );
        }),
      pausedExecutionCount: () =>
        Effect.sync(
          () =>
            [...entries.values()].filter(
              (entry) => entry.owner === owner && entry.state === "paused",
            ).length,
        ),
      hasPausedExecutions: () =>
        Effect.sync(() =>
          [...entries.values()].some((entry) => entry.owner === owner && entry.state === "paused"),
        ),
    };
  };

  const dispose = Effect.gen(function* () {
    const snapshot = [...entries.entries()];
    entries.clear();
    for (const [executionId, entry] of snapshot) {
      yield* interruptTimer(entry);
      yield* cancelPausedEntry(executionId, entry);
    }
  });

  return { decorate, dispose };
};
