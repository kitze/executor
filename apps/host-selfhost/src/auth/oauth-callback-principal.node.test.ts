import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";
import { Effect } from "effect";
import { withQueryContext } from "@executor-js/fumadb/query";
import { encodeOAuthCallbackState, ORG_SUBJECT } from "@executor-js/sdk";

// Configure before importing the self-host modules: Better Auth reads these
// settings at construction and seeds this test instance's sole organization.
const DATA_DIR = mkdtempSync(join(tmpdir(), "eh-oauth-callback-principal-"));
process.env.EXECUTOR_DATA_DIR = DATA_DIR;
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_WEB_BASE_URL = "https://executor.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "callback-admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";

const { SELF_HOST_NAMESPACE, SELF_HOST_SCHEMA_VERSION } = await import("../config");
const { createSelfHostDb } = await import("../db/self-host-db");
const { resolveAuthProviders } = await import("./index");

const db = await createSelfHostDb({
  path: join(DATA_DIR, "data.db"),
  namespace: SELF_HOST_NAMESPACE,
  version: SELF_HOST_SCHEMA_VERSION,
});
const auth = await resolveAuthProviders(db);
afterAll(() => db.close());

const adapter = (await auth.betterAuth.auth.$context).adapter;
const callbackUser = await adapter.findOne<{ id: string }>({
  model: "user",
  where: [{ field: "email", value: "callback-admin@test.local" }],
});
expect(callbackUser).not.toBeNull();
const CALLBACK_USER_ID = callbackUser!.id;

const callbackRequest = (state: string, orgSlug = auth.betterAuth.organizationSlug): Request => {
  const wrapped = encodeOAuthCallbackState({ state, orgSlug });
  return new Request(
    `https://executor.test/api/oauth/callback?${new URLSearchParams({ state: wrapped, code: "code" })}`,
  );
};

const seedSession = async (input: {
  readonly state: string;
  readonly owner: "org" | "user";
  readonly subject: string;
  readonly payload: unknown;
  readonly expiresAt: number;
}): Promise<void> => {
  const scoped = withQueryContext(db.db, {
    tenant: auth.betterAuth.organizationId,
    subject: input.owner === "user" ? input.subject : null,
  });
  await scoped.create("oauth_session", {
    tenant: auth.betterAuth.organizationId,
    owner: input.owner,
    subject: input.subject,
    state: input.state,
    client_slug: "test-client",
    integration: "test",
    name: "connection",
    template: "oauth",
    redirect_url: "https://executor.test/api/oauth/callback",
    pkce_verifier: "verifier",
    identity_label: null,
    payload: input.payload,
    expires_at: BigInt(input.expiresAt),
    created_at: new Date(),
  });
};

test("a cookie-free wrapped callback state restores the original org actor", async () => {
  await seedSession({
    state: "org-state",
    owner: "org",
    subject: ORG_SUBJECT,
    payload: { callbackSubject: CALLBACK_USER_ID },
    expiresAt: Date.now() + 60_000,
  });

  const principal = await Effect.runPromise(
    auth.oauthCallbackPrincipalResolver(callbackRequest("org-state")),
  );

  expect(principal).toMatchObject({
    kind: "member",
    accountId: CALLBACK_USER_ID,
    organizationId: auth.betterAuth.organizationId,
  });
  expect(principal?.liveApprovalProvenance).toBeUndefined();
});

test("a user-owned callback state uses its row subject and rejects a mismatched payload", async () => {
  await seedSession({
    state: "user-state",
    owner: "user",
    subject: CALLBACK_USER_ID,
    payload: {},
    expiresAt: Date.now() + 60_000,
  });
  await seedSession({
    state: "mismatched-user-state",
    owner: "user",
    subject: CALLBACK_USER_ID,
    payload: { callbackSubject: "another-user" },
    expiresAt: Date.now() + 60_000,
  });

  await expect(
    Effect.runPromise(auth.oauthCallbackPrincipalResolver(callbackRequest("user-state"))),
  ).resolves.toMatchObject({ accountId: CALLBACK_USER_ID });
  await expect(
    Effect.runPromise(
      auth.oauthCallbackPrincipalResolver(callbackRequest("mismatched-user-state")),
    ),
  ).resolves.toBeNull();
});

test("expired, foreign-org, and incomplete state capabilities never authenticate", async () => {
  await seedSession({
    state: "expired-state",
    owner: "org",
    subject: ORG_SUBJECT,
    payload: { callbackSubject: CALLBACK_USER_ID },
    expiresAt: Date.now() - 1,
  });
  await seedSession({
    state: "missing-subject-state",
    owner: "org",
    subject: ORG_SUBJECT,
    payload: {},
    expiresAt: Date.now() + 60_000,
  });

  await expect(
    Effect.runPromise(auth.oauthCallbackPrincipalResolver(callbackRequest("expired-state"))),
  ).resolves.toBeNull();
  await expect(
    Effect.runPromise(
      auth.oauthCallbackPrincipalResolver(callbackRequest("expired-state", "another-org")),
    ),
  ).resolves.toBeNull();
  await expect(
    Effect.runPromise(
      auth.oauthCallbackPrincipalResolver(callbackRequest("missing-subject-state")),
    ),
  ).resolves.toBeNull();
});
