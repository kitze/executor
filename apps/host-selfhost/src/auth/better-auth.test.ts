import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";
import { MCP_TRANSITION_JSON_HEADER } from "./mcp-transition-json";

// Real Better Auth path: set a secret + bootstrap admin before importing.
// Better Auth skips origin checks in test mode by default; this suite exercises
// the production check so the browser login flow covers the real path.
process.env.NODE_ENV = "production";
process.env.TEST = "false";
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-auth-"));
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_WEB_BASE_URL = "https://executor.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";
delete process.env.EXECUTOR_TRUSTED_ORIGINS;

const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

const BASE = "https://executor.test";

test("migrations create both the Better Auth and FumaDB executor schema regions", async () => {
  // Open a SEPARATE libSQL connection to the same file Better Auth (via its own
  // LibsqlDialect connection) and the FumaDB drizzle client wrote to. That this
  // connection can read Better Auth's tables AND rows proves the cross-connection
  // invariant: there is no shared in-process handle anymore, yet a row Better
  // Auth wrote is immediately visible here on the same file: URL.
  const { createClient } = await import("@libsql/client");
  const db = createClient({
    url: `file:${join(process.env.EXECUTOR_DATA_DIR!, "data.db")}`,
  });
  const names = (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(
    // oxlint-disable-next-line executor/no-redundant-primitive-cast -- boundary: sqlite_master.name is TEXT; narrow libSQL's SQLValue to string for the table-name list
    (r) => r.name as string,
  );
  // Better Auth tables
  for (const t of ["user", "session", "account", "organization", "member"]) {
    expect(names).toContain(t);
  }
  // FumaDB executor tables coexist in the same file (v2: a connection IS the
  // credential, so the `connection` table replaces the v1 `secret` table).
  expect(names).toContain("connection");

  // CROSS-CONNECTION PROOF: the bootstrap admin Better Auth wrote through its
  // LibsqlDialect connection is readable through this independent connection.
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the SELECT column is the schema contract for the Better Auth `user` row read off this independent libSQL connection
  const admin = (
    await db.execute({
      sql: "SELECT email FROM user WHERE email = ?",
      args: ["admin@test.local"],
    })
  ).rows[0] as unknown as { email: string } | undefined;
  expect(admin?.email).toBe("admin@test.local");
  db.close();
});

test("sign-up issues a bearer token and resolves to a per-user org-pinned identity", async () => {
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "member@test.local",
        password: "member-password-123",
        name: "Member",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const signedToken = signUp.headers.get("set-auth-token");
  expect(signedToken).toBeTruthy();
  const signUpBody = (await signUp.json()) as { token?: string };
  expect(signUpBody.token).toBeTruthy();
  const sessionCookie = signUp.headers.get("set-cookie") ?? "";
  expect(sessionCookie).toContain("Secure");
  expect(sessionCookie).toContain("SameSite=None");
  expect(sessionCookie).toContain("Partitioned");

  // The bearer token resolves to the user pinned to their own org (the v2 binding
  // is `{ tenant: org, subject: user }`; `/api/account/me` reflects both).
  const me = await handler(
    new Request("http://localhost/api/account/me", {
      // The browser fallback stores the raw token from the JSON body. The
      // bearer plugin accepts it without relying on the rejected cookie.
      headers: { authorization: `Bearer ${signUpBody.token}` },
    }),
  );
  expect(me.status).toBe(200);
  const body = (await me.json()) as {
    user: { id: string; email: string };
    organization: { id: string; name: string } | null;
  };
  expect(body.user.email).toBe("member@test.local");
  expect(body.organization).not.toBeNull();
  expect(body.organization!.id).toBeTruthy();
});

test("MCP sign-in exposes a tab bearer and completes consent without session cookies", async () => {
  const redirectUri = "https://grok.test/oauth/callback";
  const registration = await handler(
    new Request(`${BASE}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Grok test",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  expect([200, 201]).toContain(registration.status);
  const clientId = String(((await registration.json()) as { client_id?: string }).client_id ?? "");
  expect(clientId).not.toBe("");

  const state = "grok-state";
  const authorizeUrl = new URL(`${BASE}/api/auth/mcp/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: "grok-test-code-challenge",
    code_challenge_method: "S256",
    scope: "openid",
    state,
  }).toString();
  const authorize = await handler(new Request(authorizeUrl, { redirect: "manual" }));
  expect(authorize.status).toBe(302);
  expect(new URL(authorize.headers.get("location") ?? "", BASE).pathname).toBe("/login");
  const loginPromptCookie = (authorize.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  expect(loginPromptCookie).toContain("oidc_login_prompt=");

  // The MCP after-hook consumes the pending prompt and replaces the ordinary
  // sign-in JSON with a consent redirect. The app opts into the same-origin
  // JSON representation so Browser Fetch can retain the bearer and target.
  const signIn = await handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: loginPromptCookie,
        origin: BASE,
        [MCP_TRANSITION_JSON_HEADER]: "json",
      },
      body: JSON.stringify({
        email: "admin@test.local",
        password: "admin-password-123",
      }),
      redirect: "manual",
    }),
  );
  expect(signIn.status).toBe(200);
  const bearer = signIn.headers.get("set-auth-token") ?? "";
  expect(bearer).not.toBe("");
  expect(signIn.headers.get("access-control-expose-headers")).toContain("set-auth-token");
  const signInBody = (await signIn.json()) as { token?: string; url?: string };
  expect(signInBody.token).toBe(bearer);
  const consentUrl = new URL(signInBody.url ?? "", BASE);
  expect(consentUrl.pathname).toBe("/mcp-consent");
  expect(consentUrl.searchParams.get("consent_code")).toBeTruthy();

  // When the login-prompt cookie was rejected, sign-in returns ordinary JSON.
  // The page then resumes this authorize request with the same tab bearer and
  // receives the same JSON transition without relying on any Cookie header.
  const resumedAuthorize = await handler(
    new Request(authorizeUrl, {
      headers: {
        authorization: `Bearer ${bearer}`,
        [MCP_TRANSITION_JSON_HEADER]: "json",
      },
    }),
  );
  expect(resumedAuthorize.status).toBe(200);
  const resumedBody = (await resumedAuthorize.json()) as { token?: string; url?: string };
  expect(resumedBody.token).toBeUndefined();
  const resumedConsentUrl = new URL(resumedBody.url ?? "", BASE);
  expect(resumedConsentUrl.pathname).toBe("/mcp-consent");
  const consentCode = resumedConsentUrl.searchParams.get("consent_code") ?? "";
  expect(consentCode).not.toBe("");

  const consent = await handler(
    new Request(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        origin: BASE,
      },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    }),
  );
  expect(consent.status).toBe(200);
  const redirect = new URL(
    String(((await consent.json()) as { redirectURI?: string }).redirectURI ?? ""),
  );
  expect(redirect.origin + redirect.pathname).toBe(redirectUri);
  expect(redirect.searchParams.get("code")).toBeTruthy();
  expect(redirect.searchParams.get("state")).toBe(state);
});

test("self-host API keys are not capped by Better Auth's default request limit", async () => {
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "key-user@test.local",
        password: "member-password-123",
        name: "Key User",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
  const token = signUp.headers.get("set-auth-token");
  expect(token).toBeTruthy();

  const createKey = await handler(
    new Request(`${BASE}/api/account/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "MCP bootstrap" }),
    }),
  );
  expect(createKey.status).toBe(200);
  const keyBody = (await createKey.json()) as { value: string };

  for (let i = 0; i < 12; i++) {
    const me = await handler(
      new Request(`${BASE}/api/account/me`, {
        headers: { "x-api-key": keyBody.value },
      }),
    );
    expect(me.status).toBe(200);
  }
});

test("an unauthenticated request is rejected with 401", async () => {
  const res = await handler(new Request("http://localhost/api/account/me"));
  expect(res.status).toBe(401);
});
