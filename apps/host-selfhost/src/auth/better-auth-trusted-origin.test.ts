import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

// This fixture deliberately mixes an HTTPS canonical URL with a trusted HTTP
// LAN alias. Better Auth cookie attributes are static for the instance, so the
// alias needs a non-Secure cookie; the HTTPS-only fixture in better-auth.test.ts
// separately covers the CHIPS attributes used by embedded browsers.
process.env.NODE_ENV = "production";
process.env.TEST = "false";
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-auth-origin-"));
process.env.BETTER_AUTH_SECRET = "test-secret-0123456789-abcdefghijklmnop-qrstuv";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@test.local";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-password-123";
process.env.EXECUTOR_WEB_BASE_URL = "https://executor.example.com";
process.env.EXECUTOR_TRUSTED_ORIGINS = "http://executor.home.arpa:4788";

const { makeSelfHostApiHandler } = await import("../app");

const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());

test("an HTTP trusted alias receives a usable session cookie with an HTTPS canonical URL", async () => {
  const alias = "http://executor.home.arpa:4788";
  const signIn = await handler(
    new Request(`${alias}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: alias,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "admin@test.local",
        password: "admin-password-123",
      }),
    }),
  );
  expect(signIn.status).toBe(200);
  const sessionCookie = signIn.headers.get("set-cookie");
  expect(sessionCookie).toContain("better-auth.session_token=");
  expect(sessionCookie).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
  expect(sessionCookie).not.toContain("__Secure-");
});

test("an explicitly trusted browser alias can sign up without changing the canonical base URL", async () => {
  const alias = "http://executor.home.arpa:4788";
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${alias}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: alias,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "trusted-alias@test.local",
        password: "member-password-123",
        name: "Trusted Alias",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(200);
});

test("an unlisted browser alias remains blocked", async () => {
  const alias = "http://untrusted.home.arpa:4788";
  const inviteCode = await mintInviteCode(handler);
  const signUp = await handler(
    new Request(`${alias}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: alias,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({
        email: "untrusted-alias@test.local",
        password: "member-password-123",
        name: "Untrusted Alias",
        inviteCode,
      }),
    }),
  );
  expect(signUp.status).toBe(403);
});
