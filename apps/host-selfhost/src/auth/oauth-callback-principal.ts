import { Effect, Option, Schema } from "effect";

import { type Principal } from "@executor-js/api/server";
import { withQueryContext } from "@executor-js/fumadb/query";
import { decodeOAuthCallbackState, ORG_SUBJECT } from "@executor-js/sdk";

import type { SelfHostDbHandle } from "../db/self-host-db";
import type { BetterAuthHandle } from "./better-auth";
import { OAUTH_CALLBACK_PATH } from "./oauth-callback-login";

// The session payload is opaque to the storage layer. Decode the one callback
// binding we own here rather than probing the unknown JSON object. SQLite can
// return json columns as either parsed values or serialized strings.
const OAuthCallbackSessionPayload = Schema.Struct({
  callbackSubject: Schema.optional(Schema.String),
});
const OAuthCallbackSessionPayloadFromJson = Schema.fromJsonString(OAuthCallbackSessionPayload);
const decodeOAuthCallbackSessionPayload = Schema.decodeUnknownOption(
  Schema.Union([OAuthCallbackSessionPayload, OAuthCallbackSessionPayloadFromJson]),
);

const OAuthCallbackSession = Schema.Struct({
  owner: Schema.Literals(["org", "user"]),
  subject: Schema.String,
  payload: Schema.Unknown,
  expires_at: Schema.BigInt,
});
const decodeOAuthCallbackSession = Schema.decodeUnknownOption(OAuthCallbackSession);

const BetterAuthCallbackUser = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  image: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeBetterAuthCallbackUser = Schema.decodeUnknownOption(BetterAuthCallbackUser);

const parseRoles = (role: string | null | undefined): ReadonlyArray<string> =>
  (role ?? "user")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const callbackSubjectFromPayload = (payload: unknown): string | null => {
  const decoded = Option.getOrNull(decodeOAuthCallbackSessionPayload(payload));
  return decoded?.callbackSubject || null;
};

export type OAuthCallbackPrincipalResolver = (request: Request) => Effect.Effect<Principal | null>;

export interface OAuthCallbackPrincipalResolverOptions {
  readonly db: SelfHostDbHandle;
  readonly betterAuth: BetterAuthHandle;
}

/**
 * Resolve the short-lived OAuth state capability into the original acting
 * member. OAuth providers return through a top-level navigation, where an
 * embedded browser can neither send its partitioned session cookie nor replay
 * its tab-scoped bearer. The state is therefore the sole credential accepted
 * by this resolver, and only for an unexpired session in this self-host's one
 * tenant.
 *
 * This deliberately returns a member Principal without live-approval
 * provenance: state permits exactly the callback completion, not a general
 * browser-session capability.
 */
export const makeOAuthCallbackPrincipalResolver =
  (options: OAuthCallbackPrincipalResolverOptions): OAuthCallbackPrincipalResolver =>
  (request) =>
    Effect.tryPromise({
      try: async () => {
        if (request.method !== "GET") return null;

        const url = new URL(request.url);
        if (url.pathname !== OAUTH_CALLBACK_PATH) return null;

        const callbackState = decodeOAuthCallbackState(url.searchParams.get("state"));
        // A wrapped state is addressed to exactly one self-host organization.
        // Do not accept another instance's capability merely because its raw
        // state happens to exist in the local database.
        if (
          callbackState === null ||
          callbackState.orgSlug !== options.betterAuth.organizationSlug
        ) {
          return null;
        }

        // State lookup is a tenant-wide, read-only query. The actual principal
        // is intentionally recovered only *after* this capability is proven.
        const db = withQueryContext(options.db.db, {
          tenant: options.betterAuth.organizationId,
          subject: null,
          reach: "tenant" as const,
          writes: "denied" as const,
        });
        const session = await db.findFirst("oauth_session", {
          where: (builder) => builder("state", "=", callbackState.state),
        });
        const decodedSession = Option.getOrNull(decodeOAuthCallbackSession(session));
        if (!decodedSession) return null;

        const expiresAt = Number(decodedSession.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

        const callbackSubject = callbackSubjectFromPayload(decodedSession.payload);
        const subject =
          decodedSession.owner === "org"
            ? decodedSession.subject === ORG_SUBJECT
              ? callbackSubject
              : null
            : decodedSession.owner === "user" && decodedSession.subject.length > 0
              ? callbackSubject === null || callbackSubject === decodedSession.subject
                ? decodedSession.subject
                : null
              : null;
        if (subject === null) return null;

        const context = await options.betterAuth.auth.$context;
        const rawUser = await context.adapter.findOne<unknown>({
          model: "user",
          where: [{ field: "id", value: subject }],
        });
        const user = Option.getOrNull(decodeBetterAuthCallbackUser(rawUser));
        // The adapter lookup must return the very subject selected above. This
        // guards against a malformed adapter response becoming a principal.
        if (user === null || user.id !== subject) return null;

        return {
          kind: "member",
          accountId: user.id,
          organizationId: options.betterAuth.organizationId,
          organizationName: options.betterAuth.organizationName,
          organizationSlug: options.betterAuth.organizationSlug,
          email: user.email,
          name: user.name ?? null,
          avatarUrl: user.image ?? null,
          roles: parseRoles(user.role),
        } satisfies Principal;
      },
      // OAuth state is an authentication capability. A storage or adapter
      // fault must fail closed rather than turning into an authenticated route.
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));
