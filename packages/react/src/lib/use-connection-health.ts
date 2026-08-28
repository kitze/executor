// Shared stale-while-revalidate health probing for connections. The persistent
// shell overview owns automatic and periodic list checks; detail rows consume
// those coherent results and retain their explicit manual check. Keeping both
// paths here gives them the same freshness, reconnect, and cache semantics.

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { RegistryContext, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import type { Connection, HealthCheckResult, HealthStatus, Owner } from "@executor-js/sdk/shared";

import { checkConnectionHealth, connectionsAllAtom, connectionsOptimisticAtom } from "../api/atoms";
import { ExecutorApiClient } from "../api/client";
import { connectionCheckKeys } from "../api/reactivity-keys";

/** Freshness window for periodic revalidation. On mount, a non-healthy verdict
 *  still gets one immediate recovery probe; after that, every fresh result
 *  waits for this window. That prevents a manual Refresh from immediately
 *  triggering the same upstream request again. */
export const HEALTH_REVALIDATE_MS = 5 * 60 * 1000;

const connectionParams = (connection: Connection) => ({
  owner: connection.owner,
  integration: connection.integration,
  name: connection.name,
});

/** The single-connection fallback keeps its original mount behavior: a recent
 *  healthy verdict renders untouched, while non-healthy verdicts revalidate
 *  once when this hook owns automatic probing. The shell-level list model uses
 *  the periodic all-status schedule below instead. */
const healthyAndFresh = (last: HealthCheckResult | null | undefined): boolean =>
  last?.status === "healthy" && Date.now() - last.checkedAt < HEALTH_REVALIDATE_MS;

/** Next time the persistent list model should revalidate. Failed attempts are
 *  also an anchor, so a transient failure cannot spin in a render/retry loop. */
export const nextConnectionHealthRevalidationAt = (
  probe: HealthCheckResult | null | undefined,
  attemptedAt?: number,
): number => {
  const anchor = Math.max(probe?.checkedAt ?? 0, attemptedAt ?? 0);
  return anchor === 0 ? 0 : anchor + HEALTH_REVALIDATE_MS;
};

/** The revalidation query: a healthy (but stale) verdict defers to the
 *  server-enforced window so N open tabs can't stampede the upstream; a
 *  missing or non-healthy verdict forces a fresh probe.
 *
 *  A non-healthy verdict deliberately sends NO window. Suppressing its probe
 *  would suppress the only thing that can discover recovery: the verdict is
 *  persisted, so a gated request would answer "still expired" from the row
 *  the previous probe wrote, and the dot could not turn green until the window
 *  elapsed. Recovery visibility is the contract these surfaces are built on
 *  (see the health-checks-ui, graphql-introspection-health and
 *  mcp-oauth-reconnect-health scenarios), so the upstream cost of re-probing a
 *  broken connection is paid on purpose. What must NOT happen — one broken
 *  connection raising a server error on every probe — is fixed where it
 *  belongs, in the server folding a credential-resolution failure into a
 *  persisted verdict rather than into the failure channel. */
export const revalidateQuery = (
  last: HealthCheckResult | null | undefined,
): { readonly ifStaleMs?: number } =>
  last?.status === "healthy" ? { ifStaleMs: HEALTH_REVALIDATE_MS } : {};

/** Identity of a persisted verdict, for detecting the reconnect transition.
 *  An OAuth re-mint clears `last_health`, so a verdict giving way to `null`
 *  means the grant was replaced and the row must re-probe even though it never
 *  remounts (its React key is owner:integration:name, unchanged by a
 *  reconnect). This CLEARING transition is the only re-trigger: reacting to
 *  every epoch change instead would race probes against cache refetches
 *  (a refetch can deliver a snapshot older than a just-adopted verdict) and
 *  storm upstreams with re-probes. `null` is a real epoch — never-checked or
 *  just-re-minted — distinct from the "never seen" sentinel `undefined`. */
const verdictEpoch = (last: HealthCheckResult | null | undefined): number | null =>
  last?.checkedAt ?? null;

/** The verdict to display: whichever of the live probe and the persisted
 *  verdict is FRESHEST. A plain live-over-persisted preference would let a
 *  pre-reconnect probe shadow the verdict a completed reconnect persisted
 *  (any surface may write a newer verdict server-side; this hook only learns
 *  of it through the refetched row). Ties keep the live result: identical
 *  timestamps mean it IS the persisted verdict, echoed back. */
const freshestVerdict = (
  live: HealthCheckResult | null,
  persisted: HealthCheckResult | null | undefined,
): HealthCheckResult | null => {
  if (live === null) return persisted ?? null;
  if (persisted == null) return live;
  return persisted.checkedAt > live.checkedAt ? persisted : live;
};

/**
 * Imperative invalidation after a health write. Both owner-scoped rows and the
 * all-connections source must refresh: the persistent health overview and the
 * integration detail consume the latter.
 */
function useInvalidateConnections(): (owner: Owner) => void {
  const registry = useContext(RegistryContext);
  return useCallback(
    (owner: Owner) => {
      registry.refresh(connectionsOptimisticAtom(owner));
      registry.refresh(connectionsAllAtom);
    },
    [registry],
  );
}

/**
 * Health for ONE connection, stale-while-revalidate. The persisted verdict
 * renders instantly; a background probe on mount corrects it in place (once
 * per mount, quiet on failure: the persisted verdict is still the best known
 * state). `runCheck` is the manual path ("Check now"): it always forces a
 * fresh probe and folds the result into the same live state.
 */
export function useConnectionHealth(
  connection: Connection,
  options?: { readonly revalidate?: boolean },
): {
  readonly probe: HealthCheckResult | null;
  readonly status: HealthStatus;
  readonly runCheck: () => Promise<Exit.Exit<HealthCheckResult, unknown>>;
} {
  // A live probe result, once a check has run; merged with the persisted
  // verdict by freshness (see freshestVerdict for why not live-always-wins).
  const [liveProbe, setLiveProbe] = useState<HealthCheckResult | null>(null);
  const doCheck = useAtomSet(checkConnectionHealth, { mode: "promiseExit" });
  const invalidateConnections = useInvalidateConnections();

  const probe = freshestVerdict(liveProbe, connection.lastHealth);
  const status: HealthStatus = probe?.status ?? "unknown";

  // Health checks are AUTOMATIC: loading the list revalidates any verdict
  // older than the freshness window (or never checked), stale-while-revalidate
  // style: the persisted verdict renders instantly, the probe corrects it in
  // place. The guard is once per mount PLUS once per clearing: the ref holds
  // the last epoch seen, and a verdict giving way to `null` (an OAuth re-mint
  // cleared it) re-arms the probe — that is how a completed reconnect gets its
  // recovery probe without a page reload. Only the clearing transition
  // re-arms; every other epoch change (a probe's own verdict echoed back by
  // the refetch, a concurrent surface's fresher verdict) stays quiet, keeping
  // the no-probe-storm invariant of the original once-per-mount guard.
  const seenEpoch = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (options?.revalidate === false) return;
    const last = connection.lastHealth;
    const epoch = verdictEpoch(last);
    const firstSight = seenEpoch.current === undefined;
    const cleared = epoch === null && seenEpoch.current !== null && !firstSight;
    seenEpoch.current = epoch;
    if (!firstSight && !cleared) return;
    if (healthyAndFresh(last)) return;
    void doCheck({
      params: connectionParams(connection),
      query: revalidateQuery(last),
    }).then((exit) => {
      // Background refresh: update the dot on success, stay quiet on failure
      // (the persisted verdict is still the best known state). Invalidate the
      // connections cache ONLY when the verdict actually changed: on the
      // common no-change reconfirm we skip it, so an automatic probe never
      // churns the cache (which would refetch connections, re-run this
      // effect, and, but for the epoch guard, risk a probe loop).
      if (!Exit.isSuccess(exit)) return;
      seenEpoch.current = exit.value.checkedAt;
      setLiveProbe(exit.value);
      if (exit.value.status !== (last?.status ?? "unknown")) {
        invalidateConnections(connection.owner);
      }
    });
  }, [connection, doCheck, invalidateConnections, options?.revalidate]);

  const runCheck = useCallback(async () => {
    // Manual "Check now": invalidate the connections cache unconditionally so
    // every surface picks up the freshly persisted verdict. Adopting the
    // result's epoch keeps the resulting refetch from re-probing.
    const exit = await doCheck({
      params: connectionParams(connection),
      query: {},
      reactivityKeys: connectionCheckKeys,
    });
    if (Exit.isSuccess(exit)) {
      seenEpoch.current = exit.value.checkedAt;
      setLiveProbe(exit.value);
    }
    return exit;
  }, [connection, doCheck]);

  return { probe, status, runCheck };
}

/** Collision-free identity for an owner/integration/connection tuple. Slugs
 *  and names may themselves contain colons, so delimiter joining is invalid. */
export const connectionHealthProbeKey = (
  connection: Pick<Connection, "owner" | "integration" | "name">,
): string => JSON.stringify([connection.owner, connection.integration, connection.name]);

interface IndependentHealthCheckRequest {
  readonly params: {
    readonly owner: Connection["owner"];
    readonly integration: Connection["integration"];
    readonly name: Connection["name"];
  };
  readonly query: { readonly ifStaleMs?: number };
  readonly reactivityKeys: typeof connectionCheckKeys;
}

/**
 * One mutation atom per connection. The generic health mutation atom is a
 * single latest-wins operation, so firing it for every sidebar row at once
 * interrupts siblings. Keying the typed Effect client operation by connection
 * preserves independent in-flight probes without dropping the API boundary.
 */
const independentHealthCheckAtom = Atom.family((_connectionKey: string) =>
  ExecutorApiClient.runtime.fn<IndependentHealthCheckRequest>()(
    Effect.fnUntraced(function* (request) {
      const client = yield* ExecutorApiClient;
      return yield* client.connections.checkHealth(request);
    }),
    { reactivityKeys: connectionCheckKeys },
  ),
);

/** Reuse an already-running check for the same connection and registry. This
 *  covers the small window where a user clicks Refresh while the automatic
 *  shell probe is still in flight, without coupling independent connections. */
const independentChecksByRegistry = new WeakMap<
  AtomRegistry.AtomRegistry,
  Map<string, Promise<HealthCheckResult | null>>
>();

/** Run a list/sidebar probe through its connection-keyed typed API operation. */
export function useRunConnectionHealthCheck(): (
  connection: Connection,
  options?: { readonly force?: boolean },
) => Promise<HealthCheckResult | null> {
  const registry = useContext(RegistryContext);
  return useCallback(
    (connection, options) => {
      const key = connectionHealthProbeKey(connection);
      let checks = independentChecksByRegistry.get(registry);
      if (!checks) {
        checks = new Map();
        independentChecksByRegistry.set(registry, checks);
      }
      const existing = checks.get(key);
      if (existing) return existing;

      const atom = independentHealthCheckAtom(key);
      registry.set(atom, {
        params: connectionParams(connection),
        query: options?.force ? {} : revalidateQuery(connection.lastHealth),
        reactivityKeys: connectionCheckKeys,
      });
      const pending = Effect.runPromiseExit(
        AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
      ).then((exit) => (Exit.isSuccess(exit) ? exit.value : null));
      const tracked = pending.then((result) => {
        if (checks.get(key) === tracked) checks.delete(key);
        return result;
      });
      checks.set(key, tracked);
      return tracked;
    },
    [registry],
  );
}

/**
 * Health for MANY connections at once (the persistent shell overview), where
 * hooks-in-a-loop is illegal. One independent mutation atom per connection
 * prevents sibling checks from interrupting each other. A small scheduler
 * revalidates every verdict after the freshness window, and failed attempts
 * receive the same backoff so they cannot spin.
 */
export function useConnectionsHealth(
  connections: readonly Connection[],
  options?: { readonly revalidate?: boolean },
): (connection: Connection) => HealthCheckResult | null {
  const [liveProbes, setLiveProbes] = useState<ReadonlyMap<string, HealthCheckResult>>(new Map());
  const [scheduleTick, setScheduleTick] = useState(0);
  const runCheck = useRunConnectionHealthCheck();
  const attemptedAt = useRef(new Map<string, number>());
  const persistedEpochs = useRef(new Map<string, number | null>());
  const initializedKeys = useRef(new Set<string>());
  const resetLiveProbe = useRef(new Set<string>());

  // Reconnecting an OAuth account clears its persisted verdict without
  // changing the connection tuple. Drop the old live result and its backoff so
  // the replacement credential probes immediately. Also prune removed rows so
  // a later connection reusing the same tuple starts cleanly.
  useEffect(() => {
    const currentKeys = new Set<string>();
    const discardLive = new Set<string>();

    for (const connection of connections) {
      const key = connectionHealthProbeKey(connection);
      currentKeys.add(key);
      const epoch = verdictEpoch(connection.lastHealth);
      const seen = persistedEpochs.current.has(key);
      const previous = persistedEpochs.current.get(key);
      if (seen && previous !== null && epoch === null) {
        attemptedAt.current.delete(key);
        resetLiveProbe.current.add(key);
        discardLive.add(key);
      } else if (epoch !== null) {
        resetLiveProbe.current.delete(key);
      }
      persistedEpochs.current.set(key, epoch);
    }

    for (const key of persistedEpochs.current.keys()) {
      if (currentKeys.has(key)) continue;
      persistedEpochs.current.delete(key);
      attemptedAt.current.delete(key);
      initializedKeys.current.delete(key);
      resetLiveProbe.current.delete(key);
      discardLive.add(key);
    }

    if (discardLive.size === 0) return;
    setLiveProbes((current) => {
      const next = new Map(current);
      for (const key of discardLive) next.delete(key);
      return next;
    });
  }, [connections]);

  const probeFor = useCallback(
    (connection: Connection): HealthCheckResult | null => {
      const key = connectionHealthProbeKey(connection);
      const live = resetLiveProbe.current.has(key) ? null : (liveProbes.get(key) ?? null);
      return freshestVerdict(live, connection.lastHealth);
    },
    [liveProbes],
  );

  useEffect(() => {
    if (options?.revalidate === false) return;

    const now = Date.now();
    for (const connection of connections) {
      const key = connectionHealthProbeKey(connection);
      const firstSight = !initializedKeys.current.has(key);
      initializedKeys.current.add(key);
      const probe = probeFor(connection);
      const nextAt = nextConnectionHealthRevalidationAt(probe, attemptedAt.current.get(key));
      // Preserve the recovery contract: a non-healthy persisted verdict gets
      // one immediate check whenever this model mounts. Later cache epochs
      // (including a manual Refresh result) are adopted and wait for the
      // periodic window, so they never trigger a follow-up duplicate.
      const initialNonHealthy = firstSight && probe?.status !== "healthy";
      if (!initialNonHealthy && nextAt > now) continue;

      // Record before starting the promise. Any cache event while this request
      // is in flight sees the backoff and cannot launch a duplicate.
      attemptedAt.current.set(key, now);
      void runCheck(connection).then((result) => {
        setScheduleTick((current) => current + 1);
        if (result === null) return;
        resetLiveProbe.current.delete(key);
        setLiveProbes((current) => {
          const previous = current.get(key);
          if (previous && previous.checkedAt > result.checkedAt) return current;
          return new Map(current).set(key, result);
        });
      });
    }
  }, [connections, options?.revalidate, probeFor, runCheck, scheduleTick]);

  // The shell stays mounted across routes, so dependency changes alone are not
  // enough to age a healthy dot. Wake exactly when the earliest verdict (or
  // failed attempt) becomes stale; the probe effect above does the work.
  useEffect(() => {
    if (options?.revalidate === false || connections.length === 0) return;

    let nextAt = Number.POSITIVE_INFINITY;
    for (const connection of connections) {
      const key = connectionHealthProbeKey(connection);
      nextAt = Math.min(
        nextAt,
        nextConnectionHealthRevalidationAt(probeFor(connection), attemptedAt.current.get(key)),
      );
    }
    if (!Number.isFinite(nextAt)) return;

    const timeout = setTimeout(
      () => setScheduleTick((current) => current + 1),
      Math.max(0, nextAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [connections, options?.revalidate, probeFor, scheduleTick]);

  return probeFor;
}
