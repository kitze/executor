// A sensitive source response must stay opaque to every public Executor
// surface, while still being usable exactly once by an approved sensitive sink.
// This uses the real Vercel emulator's wire ledger (not a service stub) to
// prove the write happens only after the human decision.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { createEmulator, type Emulator, type LedgerEntry } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Browser, Mcp, Target } from "../src/services";
import { parseBrowserApproval } from "../src/surfaces/mcp";
import type { Identity } from "../src/target";

const api = composePluginApi([openApiHttpPlugin()] as const);
const CONNECTION = ConnectionName.make("main");
const ENV_KEY = "OPAQUE_HANDOFF_VALUE";
const COOLIFY_ENV_KEY = "COOLIFY_RESPONSE_SEALING";

const unique = (prefix: string): string => `${prefix}_${randomBytes(5).toString("hex")}`;

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const vercelEmulator = Effect.acquireRelease(
  Effect.gen(function* () {
    const port = yield* availablePort;
    return yield* Effect.promise(() => createEmulator({ service: "vercel", port }));
  }),
  (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
);

const opaqueEnvSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Opaque handoff fixture", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/v10/projects/{idOrName}/env": {
        get: {
          operationId: "getProjectEnvs",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
            { name: "slug", in: "query", schema: { type: "string" } },
            { name: "decrypt", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": {
              description: "project environment variables",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      envs: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string" },
                            value: { type: "string", "x-executor-sensitive": true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: "createProjectEnv",
          parameters: [
            { name: "idOrName", in: "path", required: true, schema: { type: "string" } },
            { name: "slug", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["key", "value", "target"],
                  properties: {
                    key: { type: "string" },
                    value: { type: "string", "x-executor-sensitive": true },
                    target: { type: "array", items: { type: "string" } },
                    type: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "created environment variable",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      envs: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { value: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/applications/{uuid}/envs": {
        post: {
          operationId: "createEnvByApplicationUuid",
          tags: ["Applications"],
          parameters: [{ name: "uuid", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    key: { type: "string" },
                    value: { type: "string" },
                    is_preview: { type: "boolean" },
                    is_literal: { type: "boolean" },
                    is_multiline: { type: "boolean" },
                    is_shown_once: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "created Coolify environment variable",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      value: { type: "string" },
                      real_value: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const handoffCode = (input: {
  readonly sourceAddress: string;
  readonly sinkAddress: string;
  readonly sourceProject: string;
  readonly targetProject: string;
  readonly teamSlug: string;
}): string => `
const callable = (address) => {
  let node = tools;
  for (const segment of address.split(".").slice(1)) node = node[segment];
  return node;
};
const source = await callable(${JSON.stringify(input.sourceAddress)})({
  idOrName: ${JSON.stringify(input.sourceProject)},
  slug: ${JSON.stringify(input.teamSlug)},
  decrypt: true,
});
console.log("source response", source);
const value = source.data.envs.find((entry) => entry.key === ${JSON.stringify(ENV_KEY)}).value;
console.log("opaque source value", value);
const created = await callable(${JSON.stringify(input.sinkAddress)})({
  idOrName: ${JSON.stringify(input.targetProject)},
  slug: ${JSON.stringify(input.teamSlug)},
  body: { key: ${JSON.stringify(ENV_KEY)}, value, target: ["production"], type: "encrypted" },
});
console.log("sink response", created);
return { source, created };
`;

const coolifyCreateCode = (input: {
  readonly address: string;
  readonly applicationUuid: string;
  readonly requestValue: string;
}): string => `
const callable = (address) => {
  let node = tools;
  for (const segment of address.split(".").slice(1)) node = node[segment];
  return node;
};
const created = await callable(${JSON.stringify(input.address)})({
  uuid: ${JSON.stringify(input.applicationUuid)},
  body: {
    key: ${JSON.stringify(COOLIFY_ENV_KEY)},
    value: ${JSON.stringify(input.requestValue)},
    is_preview: false,
    is_literal: true,
    is_multiline: false,
    is_shown_once: false,
  },
});
console.log("Coolify create response", created);
return created;
`;

const textAndRawContainNo = (
  value: { readonly text: string; readonly raw: unknown },
  marker: string,
) => {
  expect(value.text, "MCP text never reveals the sensitive marker").not.toContain(marker);
  expect(
    JSON.stringify(value.raw),
    "MCP structured content never reveals the sensitive marker",
  ).not.toContain(marker);
};

const authenticatedFetch = (
  identity: Identity,
  input: URL,
  init: RequestInit = {},
): Promise<Response> =>
  fetch(input, {
    ...init,
    headers: { ...(identity.headers ?? {}), ...(init.headers ?? {}) },
  });

const pausedExecutionUrl = (
  targetBaseUrl: string,
  approvalUrl: string,
  executionId: string,
): URL => {
  const mcpSessionId = new URL(approvalUrl).searchParams.get("mcp_session_id");
  if (!mcpSessionId) throw new Error("browser approval URL did not include an MCP session id");
  return new URL(
    `/api/mcp-sessions/${encodeURIComponent(mcpSessionId)}/executions/${encodeURIComponent(executionId)}`,
    targetBaseUrl,
  );
};

const targetPosts = (
  entries: readonly LedgerEntry[],
  targetProject: string,
): readonly LedgerEntry[] =>
  entries.filter(
    (entry) => entry.method === "POST" && entry.path === `/v10/projects/${targetProject}/env`,
  );

scenario(
  "MCP approval · an opaque OpenAPI environment value reaches only an accepted target write",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: makeApiClient } = yield* Api;
      const browser = yield* Browser;
      const mcp = yield* Mcp;
      const identity = yield* target.newIdentity();
      const client = yield* makeApiClient(api, identity);
      const emulator = yield* vercelEmulator;

      const slug = unique("opaque_handoff");
      const teamSlug = unique("opaque_team");
      const sourceProject = unique("opaque_source");
      const acceptedProject = unique("opaque_accepted");
      const declinedProject = unique("opaque_declined");
      const marker = unique("opaque_value");
      const credential = yield* Effect.promise(() =>
        emulator.credentials.mint({ type: "bearer-token", login: unique("opaque_user") }),
      );
      if (!credential.token)
        return yield* Effect.die("Vercel emulator did not issue a bearer token.");

      yield* Effect.promise(() =>
        emulator.seed({
          teams: [{ slug: teamSlug, name: "Opaque handoff team" }],
          projects: [
            {
              name: sourceProject,
              team: teamSlug,
              envVars: [
                {
                  key: ENV_KEY,
                  value: marker,
                  type: "encrypted",
                  target: ["production"],
                },
              ],
            },
            { name: acceptedProject, team: teamSlug },
            { name: declinedProject, team: teamSlug },
          ],
        }),
      );

      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: opaqueEnvSpec(emulator.url) },
              slug,
              baseUrl: emulator.url,
              authenticationTemplate: [
                {
                  slug: "apiKey",
                  type: "apiKey",
                  headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
                },
              ],
            },
          });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: CONNECTION,
              integration: IntegrationSlug.make(slug),
              template: AuthTemplateSlug.make("apiKey"),
              value: credential.token,
            },
          });

          const tools = yield* client.tools.list({ query: {} });
          const sourceAddress = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((address) => address.endsWith("getProjectEnvs"));
          const sinkAddress = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((address) => address.endsWith("createProjectEnv"));
          const coolifyCreateAddress = tools
            .filter((tool) => String(tool.integration) === slug)
            .map((tool) => String(tool.address))
            .find((address) => address.endsWith("createEnvByApplicationUuid"));
          expect(sourceAddress, "the sensitive source operation is available").toBeDefined();
          expect(sinkAddress, "the sensitive sink operation is available").toBeDefined();
          expect(
            coolifyCreateAddress,
            "the Coolify-compatible create operation is available",
          ).toBeDefined();
          if (!sourceAddress || !sinkAddress || !coolifyCreateAddress) return;

          const session = mcp.session(identity, { elicitationMode: "browser" });
          yield* session.listTools();
          yield* Effect.promise(() => emulator.ledger.clear());

          const accepted = yield* session.call("execute", {
            code: handoffCode({
              sourceAddress,
              sinkAddress,
              sourceProject,
              targetProject: acceptedProject,
              teamSlug,
            }),
          });
          textAndRawContainNo(accepted, marker);
          const acceptedApproval = parseBrowserApproval(accepted);

          const pausedUrl = pausedExecutionUrl(
            target.baseUrl,
            acceptedApproval.approvalUrl,
            acceptedApproval.executionId,
          );
          const pausedResponse = yield* Effect.promise(() =>
            authenticatedFetch(identity, pausedUrl),
          );
          const pausedBody = yield* Effect.promise(() => pausedResponse.text());
          expect(pausedResponse.status, "the browser pause API loads the current interaction").toBe(
            200,
          );
          expect(pausedBody, "paused HTTP data omits the source value").not.toContain(marker);
          expect(pausedBody, "paused HTTP data is metadata-only").not.toContain('"args"');
          expect(
            targetPosts(yield* Effect.promise(() => emulator.ledger.list()), acceptedProject),
            "no target write exists before approval",
          ).toEqual([]);

          const [acceptedResume] = yield* Effect.all(
            [
              session.awaitResume(acceptedApproval.executionId),
              browser.session(identity, async ({ page, step }) => {
                await step("Open the opaque handoff approval", async () => {
                  const url = new URL(acceptedApproval.approvalUrl);
                  await page.goto(`${url.pathname}${url.search}`, { waitUntil: "networkidle" });
                  await page.getByText("User approval required").waitFor();
                });
                await step("Review metadata without argument values", async () => {
                  expect(await page.getByText("Arguments", { exact: true }).count()).toBe(0);
                  expect(await page.content()).not.toContain(marker);
                });
                await step("Approve the opaque target write", async () => {
                  await page.getByRole("button", { name: "Approve" }).click();
                  await page.getByText("Approve sent").waitFor();
                });
              }),
            ],
            { concurrency: "unbounded" },
          );
          expect(acceptedResume.ok, "the accepted execution completes").toBe(true);
          textAndRawContainNo(acceptedResume, marker);

          const acceptedPosts = targetPosts(
            yield* Effect.promise(() => emulator.ledger.list()),
            acceptedProject,
          );
          expect(acceptedPosts, "one target write follows the approval").toHaveLength(1);
          expect(acceptedPosts[0]?.request.body).toMatchObject({ value: marker });

          // The Coolify compatibility rule is the only source of output
          // sensitivity here: the response schema deliberately has no
          // x-executor-sensitive annotations, and this marker never appeared in
          // the request or the earlier source response. If POST response paths
          // are not inferred, this exact canary reaches MCP text/raw output.
          yield* Effect.promise(() => emulator.ledger.clear());
          const coolifyApplication = unique("coolify_application");
          const coolifyRequestValue = unique("coolify_request_value");
          const coolifyResponseMarker = unique("coolify_response_only");
          const coolifyPath = `/applications/${coolifyApplication}/envs`;
          const responseFault = yield* Effect.promise(() =>
            emulator.faults.arm({
              match: { method: "POST", pathPattern: coolifyPath },
              response: {
                status: 200,
                body: {
                  key: COOLIFY_ENV_KEY,
                  value: coolifyResponseMarker,
                  real_value: coolifyResponseMarker,
                },
              },
            }),
          );

          const coolifyPaused = yield* session.call("execute", {
            code: coolifyCreateCode({
              address: coolifyCreateAddress,
              applicationUuid: coolifyApplication,
              requestValue: coolifyRequestValue,
            }),
          });
          textAndRawContainNo(coolifyPaused, coolifyResponseMarker);
          const coolifyApproval = parseBrowserApproval(coolifyPaused);

          const [coolifyResume] = yield* Effect.all(
            [
              session.awaitResume(coolifyApproval.executionId),
              browser.session(identity, async ({ page, step }) => {
                await step("Open the Coolify create approval", async () => {
                  const url = new URL(coolifyApproval.approvalUrl);
                  await page.goto(`${url.pathname}${url.search}`, { waitUntil: "networkidle" });
                  await page.getByText("User approval required").waitFor();
                });
                await step("Approve the Coolify create", async () => {
                  await page.getByRole("button", { name: "Approve" }).click();
                  await page.getByText("Approve sent").waitFor();
                });
              }),
            ],
            { concurrency: "unbounded" },
          );
          expect(coolifyResume.ok, "the approved Coolify create completes").toBe(true);
          textAndRawContainNo(coolifyResume, coolifyResponseMarker);

          const coolifyPosts = (yield* Effect.promise(() => emulator.ledger.list())).filter(
            (entry) => entry.method === "POST" && entry.path === coolifyPath,
          );
          expect(coolifyPosts, "one Coolify create follows browser approval").toHaveLength(1);
          expect(coolifyPosts[0]).toMatchObject({
            faulted: true,
            faultId: responseFault.id,
            request: {
              body: {
                key: COOLIFY_ENV_KEY,
                value: coolifyRequestValue,
              },
            },
            response: {
              status: 200,
              body: {
                value: coolifyResponseMarker,
                real_value: coolifyResponseMarker,
              },
            },
          });

          yield* Effect.promise(() => emulator.ledger.clear());
          const declined = yield* session.call("execute", {
            code: handoffCode({
              sourceAddress,
              sinkAddress,
              sourceProject,
              targetProject: declinedProject,
              teamSlug,
            }),
          });
          textAndRawContainNo(declined, marker);
          const declinedApproval = parseBrowserApproval(declined);
          expect(
            targetPosts(yield* Effect.promise(() => emulator.ledger.list()), declinedProject),
            "the declined target has no pre-decision write",
          ).toEqual([]);

          const [declinedResume] = yield* Effect.all(
            [
              session.awaitResume(declinedApproval.executionId),
              browser.session(identity, async ({ page, step }) => {
                await step("Open the second opaque handoff approval", async () => {
                  const url = new URL(declinedApproval.approvalUrl);
                  await page.goto(`${url.pathname}${url.search}`, { waitUntil: "networkidle" });
                  await page.getByText("User approval required").waitFor();
                });
                await step("Decline the opaque target write", async () => {
                  await page.getByRole("button", { name: "Decline" }).click();
                  await page.getByText("Decline sent").waitFor();
                });
              }),
            ],
            { concurrency: "unbounded" },
          );
          textAndRawContainNo(declinedResume, marker);
          expect(
            targetPosts(yield* Effect.promise(() => emulator.ledger.list()), declinedProject),
            "a declined opaque value never reaches the target service",
          ).toEqual([]);
        }),
        Effect.gen(function* () {
          yield* client.connections
            .remove({
              params: { owner: "org", integration: IntegrationSlug.make(slug), name: CONNECTION },
            })
            .pipe(Effect.ignore);
          yield* client.openapi.removeSpec({ params: { slug } }).pipe(Effect.ignore);
          yield* Effect.promise(() => emulator.faults.clear()).pipe(Effect.ignore);
        }),
      );
    }),
  ),
);
