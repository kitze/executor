import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "@effect/vitest";

import { mintInviteCode } from "../testing/mint-invite";

process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-toolkit-keys-"));
process.env.BETTER_AUTH_SECRET = "toolkit-keys-secret-0123456789-abcdefg";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL = "admin@toolkit-keys.test";
process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD = "admin-pass-123456";

const { makeSelfHostApiHandler } = await import("../app");
const { handler, dispose } = await makeSelfHostApiHandler();
afterAll(() => dispose());
const BASE = "http://localhost:4788";

const request = (
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
  extra?: Record<string, string>,
) =>
  handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const signIn = async () => {
  const response = await request("/api/auth/sign-in/email", "", "POST", {
    email: process.env.EXECUTOR_BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD,
  });
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  return token;
};

const createToolkit = async (token: string, name: string) => {
  const response = await request("/api/toolkits", token, "POST", { owner: "user", name });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; slug: string };
};

const createKey = async (token: string, name: string) => {
  const response = await request("/api/account/api-keys", token, "POST", { name });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; value: string };
};

const initialize = (slug: string) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: slug, version: "1" },
  },
});

test("a toolkit-bound key cannot escape through MCP, account, admin or Better Auth", async () => {
  const owner = await signIn();
  const toolkit = await createToolkit(owner, "Scoped Key Toolkit");
  const other = await createToolkit(owner, "Other Toolkit");
  const key = await createKey(owner, "Scoped automation");
  const bindingPath = `/api/account/api-keys/${key.id}/toolkit`;
  const malformed = await handler(
    new Request(`${BASE}${bindingPath}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
      body: "{",
    }),
  );
  expect(malformed.status).toBe(400);
  expect((await request(bindingPath, owner, "PATCH", { toolkitId: toolkit.id })).status).toBe(200);
  const binding = await request(bindingPath, owner);
  expect(((await binding.json()) as { toolkitId: string }).toolkitId).toBe(toolkit.id);

  const scopedPath = `/mcp/toolkits/${toolkit.slug}`;
  const opened = await request(scopedPath, key.value, "POST", initialize(toolkit.slug), {
    accept: "application/json, text/event-stream",
  });
  expect(opened.status, "the assigned toolkit accepts the key").toBe(200);
  const sessionId = opened.headers.get("mcp-session-id") ?? "";
  expect(sessionId).not.toBe("");
  await opened.text();

  for (const path of [
    "/mcp",
    `/mcp/toolkits/${other.slug}`,
    "/api/tools",
    "/api/toolkits",
    "/api/account/api-keys",
    "/api/admin/users",
    "/api/auth/get-session",
    bindingPath,
  ]) {
    expect((await request(path, key.value)).status, `${path} is outside the key scope`).toBe(403);
  }
  expect(
    (await request("/api/auth/api-key/create", key.value, "POST", { name: "Escaped key" })).status,
  ).toBe(403);
  expect((await request(bindingPath, key.value, "PATCH", { toolkitId: null })).status).toBe(403);
  expect(
    (
      await request("/api/toolkits", key.value, "GET", undefined, {
        "x-executor-mcp-original-path": scopedPath,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(scopedPath, key.value, "POST", initialize(toolkit.slug), {
        cookie: "better-auth.session_token=another-credential",
        accept: "application/json, text/event-stream",
      })
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/toolkits", owner)).status,
    "the owner session retains management access",
  ).toBe(200);

  // Rebinding closes even an already-issued MCP session on its old resource.
  expect((await request(bindingPath, owner, "PATCH", { toolkitId: other.id })).status).toBe(200);
  expect(
    (
      await request(
        scopedPath,
        key.value,
        "POST",
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
      )
    ).status,
  ).toBe(403);
  expect((await request(`/api/account/api-keys/${key.id}`, owner, "DELETE")).status).toBe(200);
  expect(
    (
      await request(`/mcp/toolkits/${other.slug}`, key.value, "POST", initialize(other.slug), {
        accept: "application/json, text/event-stream",
      })
    ).status,
    "revocation still rejects the key",
  ).toBe(401);
});

test("bindings use stable toolkit IDs and cannot target another user's personal toolkit", async () => {
  const owner = await signIn();
  const inviteCode = await mintInviteCode(handler);
  const joined = await request("/api/auth/sign-up/email", "", "POST", {
    email: "member@toolkit-keys.test",
    password: "member-pass-123456",
    name: "Member",
    inviteCode,
  });
  expect(joined.status).toBe(200);
  const member = joined.headers.get("set-auth-token") ?? "";
  const privateToolkit = await createToolkit(member, "Member Private");
  const key = await createKey(owner, "Stable toolkit binding");
  const bindingPath = `/api/account/api-keys/${key.id}/toolkit`;
  expect(
    (await request(bindingPath, owner, "PATCH", { toolkitId: privateToolkit.id })).status,
  ).toBe(404);
  expect(
    (await request(bindingPath, member, "PATCH", { toolkitId: privateToolkit.id })).status,
  ).toBe(404);

  const toolkit = await createToolkit(owner, "Recreated Toolkit");
  expect((await request(bindingPath, owner, "PATCH", { toolkitId: toolkit.id })).status).toBe(200);
  expect((await request(`/api/toolkits/${toolkit.id}`, owner, "DELETE")).status).toBe(200);
  const replacement = await createToolkit(owner, "Recreated Toolkit");
  expect(replacement.slug).toBe(toolkit.slug);
  expect(replacement.id).not.toBe(toolkit.id);
  expect(
    (
      await request(
        `/mcp/toolkits/${replacement.slug}`,
        key.value,
        "POST",
        initialize(replacement.slug),
        {
          accept: "application/json, text/event-stream",
        },
      )
    ).status,
  ).toBe(403);
});
