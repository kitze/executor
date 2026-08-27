import { Deferred, Effect } from "effect";

import type { CredentialResolutionError } from "./errors";
import type { StorageFailure } from "./fuma-runtime";

/** Stable identity for one OAuth grant within a host. The tenant is required
 *  because a host-level coordinator is shared by executors for many tenants. */
export interface OAuthRefreshIdentity {
  readonly tenant: string;
  readonly owner: string;
  readonly subject: string;
  readonly integration: string;
  readonly connection: string;
}

type OAuthRefreshEffect = Effect.Effect<string | null, StorageFailure | CredentialResolutionError>;

/**
 * Coalesces overlapping refresh-token grants for one connection.
 *
 * Share one coordinator across every request-created Executor backed by the
 * same credential store. The built-in coordinator is process-local; hosts with
 * multiple processes or replicas can provide a durable implementation through
 * `ExecutorConfig.oauthRefreshCoordinator`.
 */
export interface OAuthRefreshCoordinator {
  readonly coordinate: (
    identity: OAuthRefreshIdentity,
    refresh: OAuthRefreshEffect,
  ) => OAuthRefreshEffect;
}

const refreshIdentityKey = (identity: OAuthRefreshIdentity): string =>
  JSON.stringify([
    identity.tenant,
    identity.owner,
    identity.subject,
    identity.integration,
    identity.connection,
  ]);

/** Make an in-memory coordinator suitable for one long-lived host process. */
export const makeOAuthRefreshCoordinator = (): OAuthRefreshCoordinator => {
  const inFlight = new Map<
    string,
    Deferred.Deferred<string | null, StorageFailure | CredentialResolutionError>
  >();

  return {
    coordinate: (identity, refresh) =>
      // Installing the latch and starting its owner is uninterruptible.
      // Individual HTTP/MCP callers only await the latch, so canceling one
      // cannot abort or un-gate a token rotation that the authorization server
      // may already be processing. The owner remains a child of the initiating
      // request so that request-scoped Executor resources stay alive until the
      // refresh has settled.
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const key = refreshIdentityKey(identity);
          const existing = inFlight.get(key);
          if (existing) return restore(Deferred.await(existing));

          const latch = Deferred.makeUnsafe<
            string | null,
            StorageFailure | CredentialResolutionError
          >();
          inFlight.set(key, latch);

          const runRefresh = Effect.exit(refresh).pipe(
            Effect.flatMap((exit) => Deferred.done(latch, exit)),
            Effect.ensuring(
              Effect.sync(() => {
                if (inFlight.get(key) === latch) inFlight.delete(key);
              }),
            ),
            Effect.uninterruptible,
          );

          return Effect.gen(function* () {
            yield* Effect.forkChild(runRefresh);
            return yield* restore(Deferred.await(latch));
          });
        }),
      ),
  };
};
