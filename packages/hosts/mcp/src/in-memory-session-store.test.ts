import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  makeInMemoryMcpSessionStore,
  McpEngineBuildError,
  type McpBuildServerOptions,
} from "./in-memory-session-store";
import { makeInProcessBrowserApprovalStore } from "./browser-approval-store";
import { defaultMcpResource, type Principal } from "./seams";

const TEST_PRINCIPAL: Principal = {
  accountId: "acct_test",
  organizationId: "org_test",
  organizationName: "Test Org",
  email: "test@example.com",
  name: "Test",
  avatarUrl: null,
  roles: ["user"],
};

it("preserves native elicitation mode when creating an in-memory MCP session", async () => {
  let buildOptions: McpBuildServerOptions | undefined;
  const sessions = makeInMemoryMcpSessionStore((_principal, options) => {
    buildOptions = options;
    return Effect.fail(new McpEngineBuildError({ cause: "stop after capturing options" }));
  });

  const result = await Effect.runPromise(
    sessions.store.dispatch({
      request: new Request("https://executor.test/mcp?elicitation_mode=native", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: { form: {} } },
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      }),
      principal: TEST_PRINCIPAL,
      resource: defaultMcpResource,
      sessionId: null,
      method: "POST",
    }),
  );

  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(500);
  expect(buildOptions?.elicitationMode).toEqual({ mode: "native" });
});

it("keeps the first concurrent in-process browser decision terminal until settlement", async () => {
  const approvals = makeInProcessBrowserApprovalStore();
  const executionId = "exec-first-terminal";
  const first = { action: "decline" as const, content: { reason: "first" } };
  const later = { action: "accept" as const, content: { reason: "later" } };

  const [firstResult, laterResult] = await Promise.all([
    Effect.runPromise(approvals.recordResponse(executionId, first)),
    Effect.runPromise(approvals.recordResponse(executionId, later)),
  ]);

  expect(firstResult).toEqual(first);
  expect(laterResult).toEqual(first);
  expect(await Effect.runPromise(approvals.store.takeResponse(executionId))).toEqual(first);
  // Retries and independent resume long-polls observe the same decision; it
  // is cleared only after the owning pause has actually settled.
  expect(await Effect.runPromise(approvals.store.waitForResponse!(executionId))).toEqual(first);
});
