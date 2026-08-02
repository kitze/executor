import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

import {
  ConnectionName,
  createExecutor,
  IntegrationSlug,
  isOpaqueValueReference,
  makeOpaqueValueHandoff,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveTestHttpApp,
} from "@executor-js/sdk/testing";

import { addOpenApiTestConnection } from "../testing";
import {
  compileOpenApiSpec,
  openApiStoredOperationsFromCompiled,
  repairCoolifyApplicationEnvInputSchema,
  resolveOpenApiBackedAnnotations,
} from "./backing";
import { openApiPlugin } from "./plugin";

type CapturedRequest = {
  readonly method: string;
  readonly url: string;
  readonly body: string;
};

const environmentVariableProperties = {
  key: { type: "string" },
  value: { type: "string" },
  is_preview: { type: "boolean" },
  is_literal: { type: "boolean" },
  is_multiline: { type: "boolean" },
  is_shown_once: { type: "boolean" },
};

const nonTargetOperationName = "applications.updateEnvironmentMetadataByApplicationUuid";
const getApplicationOperationName = "applications.getApplicationByUuid";
const listEnvironmentOperationName = "applications.listEnvsByApplicationUuid";
const updateEnvironmentOperationName = "applications.updateEnvByApplicationUuid";
const updateEnvironmentsOperationName = "applications.updateEnvsByApplicationUuid";

// Test-only canaries, never values captured from an upstream response.
const applicationSecretCanaries = {
  manual_webhook_secret_github: "coolify-webhook-github-canary",
  manual_webhook_secret_gitlab: "coolify-webhook-gitlab-canary",
  manual_webhook_secret_bitbucket: "coolify-webhook-bitbucket-canary",
  manual_webhook_secret_gitea: "coolify-webhook-gitea-canary",
  http_basic_auth_password: "coolify-basic-auth-canary",
} as const;

const environmentSecretCanaries = {
  value: "coolify-environment-value-canary",
  real_value: "coolify-environment-real-value-canary",
} as const;

const environmentVariableRequestSchema = () => ({
  type: "object",
  properties: { ...environmentVariableProperties },
});

const bulkEnvironmentVariableRequestSchema = () => ({
  type: "object",
  properties: {
    data: {
      type: "array",
      items: environmentVariableRequestSchema(),
    },
  },
});

const environmentVariableResponseSchema = () => ({
  type: "object",
  properties: {
    key: { type: "string" },
    value: { type: "string" },
    real_value: { type: "string" },
  },
});

const environmentVariableListResponseSchema = () => ({
  type: "array",
  items: environmentVariableResponseSchema(),
});

const operation = (
  operationId: string,
  bodySchema: Record<string, unknown>,
  responseSchema: Record<string, unknown> = { type: "object" },
) => ({
  operationId,
  tags: ["Applications"],
  parameters: [
    {
      name: "uuid",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ],
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: bodySchema,
      },
    },
  },
  responses: {
    "200": {
      description: "OK",
      content: {
        "application/json": {
          schema: responseSchema,
        },
      },
    },
  },
});

const listEnvironmentOperation = () => ({
  operationId: "listEnvsByApplicationUuid",
  tags: ["Applications"],
  parameters: [
    {
      name: "uuid",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ],
  responses: {
    "200": {
      description: "OK",
      content: {
        "application/json": {
          schema: environmentVariableListResponseSchema(),
        },
      },
    },
  },
});

const getApplicationOperation = () => ({
  operationId: "getApplicationByUuid",
  tags: ["Applications"],
  parameters: [
    {
      name: "uuid",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ],
  responses: {
    "200": {
      description: "OK",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: Object.fromEntries(
              Object.keys(applicationSecretCanaries).map((name) => [name, { type: "string" }]),
            ),
          },
        },
      },
    },
  },
});

const coolifySpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Coolify API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/applications/{uuid}/envs": {
        post: operation("createEnvByApplicationUuid", environmentVariableRequestSchema()),
        patch: operation(
          "updateEnvByApplicationUuid",
          environmentVariableRequestSchema(),
          environmentVariableResponseSchema(),
        ),
        get: listEnvironmentOperation(),
      },
      "/applications/{uuid}": {
        get: getApplicationOperation(),
      },
      "/applications/{uuid}/envs/bulk": {
        patch: operation(
          "updateEnvsByApplicationUuid",
          bulkEnvironmentVariableRequestSchema(),
          environmentVariableListResponseSchema(),
        ),
      },
      // This has the same legacy body shape but is not one of Coolify's
      // lifecycle-compatible endpoints. It proves the repair is not a broad
      // "any applications env tool" rewrite.
      "/applications/{uuid}/envs/metadata": {
        patch: operation(
          "updateEnvironmentMetadataByApplicationUuid",
          environmentVariableRequestSchema(),
        ),
      },
    },
  });

const tenantLocalCollisionSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Tenant-local API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/applications/{uuid}/envs": {
        patch: operation("updateEnvByApplicationUuid", {
          type: "object",
          properties: {
            ...environmentVariableProperties,
            enabled: { type: "boolean" },
          },
        }),
      },
    },
  });

const legacySingleInputSchema = () => ({
  type: "object",
  properties: {
    uuid: { type: "string" },
    body: environmentVariableRequestSchema(),
  },
  required: ["uuid", "body"],
  additionalProperties: false,
});

const legacyBatchInputSchema = () => ({
  type: "object",
  properties: {
    uuid: { type: "string" },
    body: bulkEnvironmentVariableRequestSchema(),
  },
  required: ["uuid", "body"],
  additionalProperties: false,
});

const accepted = {
  onElicitation: () => Effect.succeed({ action: "accept" as const, content: {} }),
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const serveCoolifyFixture = () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<readonly CapturedRequest[]>([]);
    const server = yield* serveTestHttpApp((request) =>
      Effect.gen(function* () {
        const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
        yield* Ref.update(requests, (all) => [
          ...all,
          {
            method: request.method,
            url: request.url ?? "/",
            body,
          },
        ]);
        const method = request.method.toUpperCase();
        const path = new URL(request.url ?? "/", "https://coolify.fixture.invalid").pathname;
        if (method === "GET" && path.endsWith("/envs")) {
          return HttpServerResponse.jsonUnsafe([{ key: "ENV", ...environmentSecretCanaries }]);
        }
        if (method === "GET") {
          return HttpServerResponse.jsonUnsafe(applicationSecretCanaries);
        }
        if (method === "PATCH" && path.endsWith("/envs/bulk")) {
          return HttpServerResponse.jsonUnsafe([{ key: "ENV", ...environmentSecretCanaries }]);
        }
        if (method === "PATCH" && path.endsWith("/envs")) {
          return HttpServerResponse.jsonUnsafe({ key: "ENV", ...environmentSecretCanaries });
        }
        return HttpServerResponse.jsonUnsafe({ ok: true });
      }),
    );

    return {
      ...server,
      specJson: coolifySpec(server.baseUrl),
      requests: Ref.get(requests),
    };
  });

describe("Coolify application environment variable schema compatibility", () => {
  it.effect("republishes legacy bindings with lifecycle flags and sends them unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* serveCoolifyFixture();
        const plugins = [
          openApiPlugin({ httpClientLayer: fixture.httpClientLayer }),
          memoryCredentialsPlugin(),
        ] as const;
        const config = makeTestConfig({ plugins });
        const executor = yield* createExecutor(config);
        const connection = yield* addOpenApiTestConnection(executor, fixture, {
          slug: "coolify",
        });

        const legacySchemas = {
          "applications.createEnvByApplicationUuid": legacySingleInputSchema(),
          "applications.updateEnvByApplicationUuid": legacySingleInputSchema(),
          "applications.updateEnvsByApplicationUuid": legacyBatchInputSchema(),
        } as const;

        const fresh = yield* Effect.promise(() =>
          config.db.findMany("tool", {
            where: (b) =>
              b.and(b("integration", "=", "coolify"), b("connection", "=", connection.connection)),
          }),
        );
        expect(fresh).toHaveLength(6);
        for (const name of Object.keys(legacySchemas)) {
          const row = fresh.find((candidate) => candidate.name === name);
          expect(encodeJson(row?.input_schema)).toContain('"is_runtime"');
          expect(encodeJson(row?.input_schema)).toContain('"is_buildtime"');
        }
        const freshNonTarget = fresh.find((candidate) => candidate.name === nonTargetOperationName);
        expect(encodeJson(freshNonTarget?.input_schema)).not.toContain('"is_runtime"');
        expect(encodeJson(freshNonTarget?.input_schema)).not.toContain('"is_buildtime"');

        const freshApplicationRead = fresh.find(
          (candidate) => candidate.name === getApplicationOperationName,
        );
        const freshApplicationReadAnnotations = freshApplicationRead?.annotations as {
          readonly sensitiveOutputPaths?: readonly string[];
        };
        expect(freshApplicationReadAnnotations.sensitiveOutputPaths).toEqual([
          "/http_basic_auth_password",
          "/manual_webhook_secret_bitbucket",
          "/manual_webhook_secret_gitea",
          "/manual_webhook_secret_github",
          "/manual_webhook_secret_gitlab",
        ]);

        const freshEnvironmentList = fresh.find(
          (candidate) => candidate.name === listEnvironmentOperationName,
        );
        const freshEnvironmentListAnnotations = freshEnvironmentList?.annotations as {
          readonly sensitiveOutputPaths?: readonly string[];
        };
        expect(freshEnvironmentListAnnotations.sensitiveOutputPaths).toEqual([
          "/*/real_value",
          "/*/value",
        ]);

        const freshEnvironmentUpdate = fresh.find(
          (candidate) => candidate.name === updateEnvironmentOperationName,
        );
        const freshEnvironmentUpdateAnnotations = freshEnvironmentUpdate?.annotations as {
          readonly sensitiveInputPaths?: readonly string[];
          readonly sensitiveOutputPaths?: readonly string[];
        };
        expect(freshEnvironmentUpdateAnnotations.sensitiveInputPaths).toEqual([
          "/body/value",
          "/input/value",
        ]);
        expect(freshEnvironmentUpdateAnnotations.sensitiveOutputPaths).toEqual([
          "/real_value",
          "/value",
        ]);

        const freshEnvironmentBatch = fresh.find(
          (candidate) => candidate.name === updateEnvironmentsOperationName,
        );
        const freshEnvironmentBatchAnnotations = freshEnvironmentBatch?.annotations as {
          readonly sensitiveInputPaths?: readonly string[];
          readonly sensitiveOutputPaths?: readonly string[];
        };
        expect(freshEnvironmentBatchAnnotations.sensitiveInputPaths).toEqual([
          "/body/data/*/value",
          "/input/data/*/value",
        ]);
        expect(freshEnvironmentBatchAnnotations.sensitiveOutputPaths).toEqual([
          "/*/real_value",
          "/*/value",
        ]);

        for (const [name, inputSchema] of Object.entries(legacySchemas)) {
          yield* Effect.promise(() =>
            config.db.updateMany("tool", {
              where: (b) =>
                b.and(
                  b("integration", "=", "coolify"),
                  b("connection", "=", connection.connection),
                  b("name", "=", name),
                ),
              set: { input_schema: inputSchema },
            }),
          );
        }

        // A deployed Executor must describe old persisted rows correctly before
        // anyone manually refreshes a connection.
        for (const name of Object.keys(legacySchemas)) {
          const schema = yield* executor.tools.schema(connection.address(name));
          expect(schema?.inputTypeScript).toContain("is_runtime?: boolean");
          expect(schema?.inputTypeScript).toContain("is_buildtime?: boolean");
        }
        const nonTargetSchema = yield* executor.tools.schema(
          connection.address(nonTargetOperationName),
        );
        expect(nonTargetSchema?.inputTypeScript).not.toContain("is_runtime?: boolean");
        expect(nonTargetSchema?.inputTypeScript).not.toContain("is_buildtime?: boolean");

        const stillLegacy = yield* Effect.promise(() =>
          config.db.findMany("tool", {
            where: (b) =>
              b.and(b("integration", "=", "coolify"), b("connection", "=", connection.connection)),
          }),
        );
        for (const name of Object.keys(legacySchemas)) {
          const row = stillLegacy.find((candidate) => candidate.name === name);
          const schema = encodeJson(row?.input_schema);
          expect(schema).not.toContain('"is_runtime"');
          expect(schema).not.toContain('"is_buildtime"');
        }

        // Refresh also writes the repaired schema back into the persisted tool
        // catalog so future reads do not depend on the legacy projection.
        yield* executor.connections.refresh({
          owner: connection.owner,
          integration: IntegrationSlug.make(connection.slug),
          name: ConnectionName.make(connection.connection),
        });

        const republished = yield* Effect.promise(() =>
          config.db.findMany("tool", {
            where: (b) =>
              b.and(b("integration", "=", "coolify"), b("connection", "=", connection.connection)),
          }),
        );
        expect(republished).toHaveLength(6);
        for (const name of Object.keys(legacySchemas)) {
          const row = republished.find((candidate) => candidate.name === name);
          const schema = encodeJson(row?.input_schema);
          expect(schema).toContain('"is_runtime"');
          expect(schema).toContain('"is_buildtime"');
        }
        const republishedNonTarget = republished.find(
          (candidate) => candidate.name === nonTargetOperationName,
        );
        const nonTargetPersistedSchema = encodeJson(republishedNonTarget?.input_schema);
        expect(nonTargetPersistedSchema).not.toContain('"is_runtime"');
        expect(nonTargetPersistedSchema).not.toContain('"is_buildtime"');

        yield* executor.execute(
          connection.address("applications.createEnvByApplicationUuid"),
          {
            uuid: "app-1",
            body: {
              key: "CREATE_ONLY",
              value: "one",
              is_runtime: true,
              is_buildtime: false,
            },
          },
          accepted,
        );

        // A generic application read is a source, never plaintext sandbox
        // data.  The executor seals the exact upstream fields into opaque
        // handles before the returned ToolResult crosses its trust boundary.
        const readResult = (yield* executor.execute(
          connection.address(getApplicationOperationName),
          { uuid: "app-1" },
          { ...accepted, opaqueValueHandoff: makeOpaqueValueHandoff() },
        )) as { readonly ok?: boolean; readonly data?: Record<string, unknown> };
        expect(JSON.stringify(readResult)).not.toContain(
          applicationSecretCanaries.manual_webhook_secret_github,
        );
        expect(JSON.stringify(readResult)).not.toContain(
          applicationSecretCanaries.manual_webhook_secret_gitlab,
        );
        expect(JSON.stringify(readResult)).not.toContain(
          applicationSecretCanaries.manual_webhook_secret_bitbucket,
        );
        expect(JSON.stringify(readResult)).not.toContain(
          applicationSecretCanaries.manual_webhook_secret_gitea,
        );
        expect(JSON.stringify(readResult)).not.toContain(
          applicationSecretCanaries.http_basic_auth_password,
        );
        expect(readResult.ok).toBe(true);
        for (const name of Object.keys(applicationSecretCanaries)) {
          expect(isOpaqueValueReference(readResult.data?.[name])).toBe(true);
        }

        const listResult = (yield* executor.execute(
          connection.address(listEnvironmentOperationName),
          { uuid: "app-1" },
          { ...accepted, opaqueValueHandoff: makeOpaqueValueHandoff() },
        )) as { readonly ok?: boolean; readonly data?: readonly Record<string, unknown>[] };
        expect(listResult.ok).toBe(true);
        expect(JSON.stringify(listResult)).not.toContain(environmentSecretCanaries.value);
        expect(JSON.stringify(listResult)).not.toContain(environmentSecretCanaries.real_value);
        expect(isOpaqueValueReference(listResult.data?.[0]?.value)).toBe(true);
        expect(isOpaqueValueReference(listResult.data?.[0]?.real_value)).toBe(true);

        const updateResult = (yield* executor.execute(
          connection.address(updateEnvironmentOperationName),
          {
            uuid: "app-1",
            body: {
              key: "UPDATE_ONLY",
              value: "two",
              is_runtime: false,
              is_buildtime: true,
            },
          },
          { ...accepted, opaqueValueHandoff: makeOpaqueValueHandoff() },
        )) as { readonly ok?: boolean; readonly data?: Record<string, unknown> };
        expect(updateResult.ok).toBe(true);
        expect(JSON.stringify(updateResult)).not.toContain(environmentSecretCanaries.value);
        expect(JSON.stringify(updateResult)).not.toContain(environmentSecretCanaries.real_value);
        expect(isOpaqueValueReference(updateResult.data?.value)).toBe(true);
        expect(isOpaqueValueReference(updateResult.data?.real_value)).toBe(true);

        const batchResult = (yield* executor.execute(
          connection.address(updateEnvironmentsOperationName),
          {
            uuid: "app-1",
            body: {
              data: [
                {
                  key: "BATCH_ONLY",
                  value: "three",
                  is_runtime: false,
                  is_buildtime: false,
                },
              ],
            },
          },
          { ...accepted, opaqueValueHandoff: makeOpaqueValueHandoff() },
        )) as { readonly ok?: boolean; readonly data?: readonly Record<string, unknown>[] };
        expect(batchResult.ok).toBe(true);
        expect(JSON.stringify(batchResult)).not.toContain(environmentSecretCanaries.value);
        expect(JSON.stringify(batchResult)).not.toContain(environmentSecretCanaries.real_value);
        expect(isOpaqueValueReference(batchResult.data?.[0]?.value)).toBe(true);
        expect(isOpaqueValueReference(batchResult.data?.[0]?.real_value)).toBe(true);

        const requests = yield* fixture.requests;
        const writes = requests.filter(
          (request) => request.method === "POST" || request.method === "PATCH",
        );
        expect(writes).toHaveLength(3);
        expect(writes.map((request) => decodeJson(request.body))).toEqual([
          {
            key: "CREATE_ONLY",
            value: "one",
            is_runtime: true,
            is_buildtime: false,
          },
          {
            key: "UPDATE_ONLY",
            value: "two",
            is_runtime: false,
            is_buildtime: true,
          },
          {
            data: [
              {
                key: "BATCH_ONLY",
                value: "three",
                is_runtime: false,
                is_buildtime: false,
              },
            ],
          },
        ]);
      }),
    ),
  );

  it.effect("leaves a tenant-local integration named coolify untouched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* serveCoolifyFixture();
        const plugins = [
          openApiPlugin({ httpClientLayer: fixture.httpClientLayer }),
          memoryCredentialsPlugin(),
        ] as const;
        const config = makeTestConfig({ plugins });
        const executor = yield* createExecutor(config);
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...fixture, specJson: tenantLocalCollisionSpec(fixture.baseUrl) },
          { slug: "coolify" },
        );
        const toolName = "applications.updateEnvByApplicationUuid";

        const fresh = yield* Effect.promise(() =>
          config.db.findFirst("tool", {
            where: (b) =>
              b.and(
                b("integration", "=", "coolify"),
                b("connection", "=", connection.connection),
                b("name", "=", toolName),
              ),
          }),
        );
        expect(encodeJson(fresh?.input_schema)).not.toContain('"is_runtime"');
        expect(encodeJson(fresh?.input_schema)).not.toContain('"is_buildtime"');
        expect(fresh?.annotations).toEqual({
          requiresApproval: true,
          approvalDescription: "PATCH /applications/{uuid}/envs",
        });

        const projected = yield* executor.tools.schema(connection.address(toolName));
        expect(projected?.inputTypeScript).not.toContain("is_runtime?: boolean");
        expect(projected?.inputTypeScript).not.toContain("is_buildtime?: boolean");

        yield* executor.connections.refresh({
          owner: connection.owner,
          integration: IntegrationSlug.make(connection.slug),
          name: ConnectionName.make(connection.connection),
        });
        const refreshed = yield* Effect.promise(() =>
          config.db.findFirst("tool", {
            where: (b) =>
              b.and(
                b("integration", "=", "coolify"),
                b("connection", "=", connection.connection),
                b("name", "=", toolName),
              ),
          }),
        );
        expect(encodeJson(refreshed?.input_schema)).not.toContain('"is_runtime"');
        expect(encodeJson(refreshed?.input_schema)).not.toContain('"is_buildtime"');
        expect(refreshed?.annotations).toEqual({
          requiresApproval: true,
          approvalDescription: "PATCH /applications/{uuid}/envs",
        });
      }),
    ),
  );

  it.effect("fails closed for a legacy Coolify environment binding without inventing sinks", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(coolifySpec("https://coolify.fixture.invalid"));
      const definition = compiled.definitions.find(
        (candidate) => candidate.operation.operationId === "updateEnvByApplicationUuid",
      );
      expect(definition).toBeDefined();
      if (!definition) return;

      const stored = openApiStoredOperationsFromCompiled("coolify", compiled).find(
        (candidate) => candidate.toolName === definition.toolPath,
      );
      expect(stored).toBeDefined();
      if (!stored) return;

      const legacy = {
        ...stored,
        binding: {
          ...stored.binding,
          sensitivityVersion: undefined,
          sensitiveInputPaths: undefined,
          sensitiveOutputPaths: undefined,
          sensitiveResponseHeaders: undefined,
        },
      };
      const annotations = yield* resolveOpenApiBackedAnnotations({
        ctx: {
          storage: {
            getOperation: () => Effect.succeed(legacy),
          },
        } as never,
        integration: "coolify",
        toolRows: [{ name: stored.toolName }],
      });

      expect(annotations[stored.toolName]).toEqual({
        requiresApproval: true,
        approvalDescription: "PATCH /applications/{uuid}/envs",
        sensitiveOutputPaths: [""],
        sensitiveResponseHeaders: true,
      });
    }),
  );

  it("leaves a target-named operation on another route untouched", () => {
    const legacy = legacySingleInputSchema();
    expect(
      repairCoolifyApplicationEnvInputSchema("applications.updateEnvByApplicationUuid", legacy, {
        method: "patch",
        pathTemplate: "/tenant-applications/{uuid}/envs",
        parameters: [{ name: "uuid", location: "path", required: true }],
      }),
    ).toBe(legacy);
  });

  it("adds only the lifecycle field still absent from a matching upstream schema", () => {
    const partial = legacySingleInputSchema();
    const body = partial.properties.body as {
      properties: Record<string, unknown>;
    };
    body.properties.is_runtime = { type: "boolean" };

    const repaired = repairCoolifyApplicationEnvInputSchema(
      "applications.updateEnvByApplicationUuid",
      partial,
      {
        method: "patch",
        pathTemplate: "/applications/{uuid}/envs",
        parameters: [{ name: "uuid", location: "path", required: true }],
      },
    ) as {
      properties: { body: { properties: Record<string, unknown> } };
    };

    expect(repaired.properties.body.properties.is_runtime).toEqual({ type: "boolean" });
    expect(repaired.properties.body.properties.is_buildtime).toEqual({
      type: "boolean",
      description: "Whether this environment variable is available while the application builds.",
    });
  });

  it("is inert once Coolify publishes the lifecycle fields itself", () => {
    const current = {
      type: "object",
      properties: {
        uuid: { type: "string" },
        body: {
          type: "object",
          properties: {
            ...environmentVariableProperties,
            is_runtime: { type: "boolean" },
            is_buildtime: { type: "boolean" },
          },
        },
      },
      required: ["uuid", "body"],
      additionalProperties: false,
    };

    expect(
      repairCoolifyApplicationEnvInputSchema("applications.updateEnvByApplicationUuid", current, {
        method: "patch",
        pathTemplate: "/applications/{uuid}/envs",
        parameters: [{ name: "uuid", location: "path", required: true }],
      }),
    ).toBe(current);
  });
});
