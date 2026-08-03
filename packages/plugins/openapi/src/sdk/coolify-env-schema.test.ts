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
import {
  coolifyDatabaseResponseSensitiveFields,
  coolifyDatabaseUpdateSensitiveFields,
  isCoolifyDatabaseResponseSchema,
  isCoolifyDatabaseUpdateRequestSchema,
  isCoolifyMisdeclaredDatabaseResponseSchema,
  isVerifiedCoolifyDatabaseReadOperation,
  isVerifiedCoolifyDatabaseUpdateOperation,
} from "./coolify-environment";

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
const listApplicationsOperationName = "applications.listApplications";
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

const applicationSafeMetadata = {
  uuid: "app-1",
  name: "Fixture application",
} as const;

const applicationRepositoryCanaries = {
  git_repository:
    "https://fixture-user:coolify-repository-userinfo-canary@example.invalid/org/repository.git",
  git_full_url:
    "https://example.invalid/org/repository.git?access_token=coolify-repository-token-canary",
} as const;

const environmentSecretCanaries = {
  value: "coolify-environment-value-canary",
  real_value: "coolify-environment-real-value-canary",
} as const;

const transformedSiblingCanaries = (value: string) => ({
  base64Echo: Buffer.from(value).toString("base64"),
  base64urlEcho: Buffer.from(value).toString("base64url"),
  arbitraryEcho: [...value].reverse().join(""),
});

const environmentTransformedSiblingCanaries = transformedSiblingCanaries(
  environmentSecretCanaries.value,
);
const applicationTransformedSiblingCanaries = transformedSiblingCanaries(
  applicationSecretCanaries.manual_webhook_secret_github,
);

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

const applicationResponseSchema = () => ({
  type: "object",
  properties: {
    uuid: { type: "string" },
    name: { type: "string" },
    git_repository: { type: "string" },
    git_full_url: { type: "string" },
    ...Object.fromEntries(
      Object.keys(applicationSecretCanaries).map((name) => [name, { type: "string" }]),
    ),
  },
});

const applicationReadOperation = (
  operationId: string,
  schema: Record<string, unknown>,
  parameters: readonly Record<string, unknown>[] = [],
) => ({
  operationId,
  tags: ["Applications"],
  parameters,
  responses: {
    "200": {
      description: "OK",
      content: { "application/json": { schema } },
    },
  },
});

const getApplicationOperation = () =>
  applicationReadOperation("getApplicationByUuid", applicationResponseSchema(), [
    {
      name: "uuid",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ]);

const listApplicationsOperation = () =>
  applicationReadOperation("listApplications", {
    type: "array",
    items: applicationResponseSchema(),
  });

const coolifySpec = (
  baseUrl: string,
  createResponseSchema: Record<string, unknown> = environmentVariableResponseSchema(),
) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Coolify API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/applications": {
        get: listApplicationsOperation(),
      },
      "/applications/{uuid}/envs": {
        post: operation(
          "createEnvByApplicationUuid",
          environmentVariableRequestSchema(),
          createResponseSchema,
        ),
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

const expectTransformedSiblingsDropped = (
  value: unknown,
  canaries: Readonly<Record<string, string>>,
): void => {
  const rendered = JSON.stringify(value);
  for (const canary of Object.values(canaries)) expect(rendered).not.toContain(canary);
};

const serveCoolifyFixture = (options?: { readonly environmentKey?: unknown }) =>
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
        if (method === "GET" && path.replace(/\/$/, "").endsWith("/applications")) {
          return HttpServerResponse.jsonUnsafe([
            {
              ...applicationSafeMetadata,
              name: applicationRepositoryCanaries.git_repository,
              ...applicationSecretCanaries,
              ...applicationRepositoryCanaries,
              ...applicationTransformedSiblingCanaries,
              error: { message: applicationRepositoryCanaries.git_repository },
              logs: Object.values(applicationRepositoryCanaries),
              trace: {
                "http.response.body": Object.values(applicationRepositoryCanaries).join("|"),
              },
            },
          ]);
        }
        if (method === "GET" && path.endsWith("/envs")) {
          return HttpServerResponse.jsonUnsafe([
            {
              key: options?.environmentKey ?? "ENV",
              ...environmentSecretCanaries,
              ...environmentTransformedSiblingCanaries,
            },
          ]);
        }
        if (method === "GET") {
          return HttpServerResponse.jsonUnsafe({
            ...applicationSafeMetadata,
            ...applicationSecretCanaries,
            ...applicationTransformedSiblingCanaries,
          });
        }
        if (method === "POST" && path.endsWith("/envs")) {
          return HttpServerResponse.jsonUnsafe({
            key: "ENV",
            ...environmentSecretCanaries,
            ...environmentTransformedSiblingCanaries,
          });
        }
        if (method === "PATCH" && path.endsWith("/envs/bulk")) {
          return HttpServerResponse.jsonUnsafe([
            {
              key: "ENV",
              ...environmentSecretCanaries,
              ...environmentTransformedSiblingCanaries,
            },
          ]);
        }
        if (method === "PATCH" && path.endsWith("/envs")) {
          return HttpServerResponse.jsonUnsafe({
            key: "ENV",
            ...environmentSecretCanaries,
            ...environmentTransformedSiblingCanaries,
          });
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
  it("strictly gates Coolify database credential reads and updates", () => {
    const parameters = [{ name: "uuid", location: "path", required: true }] as const;
    const readIdentity = {
      operationId: "getDatabaseByUuid",
      method: "get",
      pathTemplate: "/databases/{uuid}",
      parameters,
    } as const;
    const updateIdentity = {
      operationId: "databases.updateDatabaseByUuid",
      method: "patch",
      pathTemplate: "/databases/{uuid}",
      parameters,
    } as const;
    const responseSchema = {
      type: "object",
      properties: {
        internal_db_url: { type: "string" },
        external_db_url: { type: "string" },
        password: { type: "string" },
        postgres_password: { type: "string" },
      },
    };
    const requestSchema = {
      type: "object",
      properties: { password: { type: "string" }, name: { type: "string" } },
    };

    expect(isVerifiedCoolifyDatabaseReadOperation(readIdentity)).toBe(true);
    expect(isVerifiedCoolifyDatabaseUpdateOperation(updateIdentity)).toBe(true);
    expect(isCoolifyDatabaseResponseSchema(responseSchema)).toBe(true);
    expect(isCoolifyMisdeclaredDatabaseResponseSchema({ type: "string" })).toBe(true);
    expect(isCoolifyMisdeclaredDatabaseResponseSchema({ type: "object" })).toBe(false);
    expect(coolifyDatabaseResponseSensitiveFields(responseSchema)).toEqual([
      "internal_db_url",
      "external_db_url",
      "password",
      "postgres_password",
    ]);
    expect(isCoolifyDatabaseUpdateRequestSchema(requestSchema)).toBe(true);
    expect(coolifyDatabaseUpdateSensitiveFields(requestSchema)).toEqual(["password"]);

    expect(
      isVerifiedCoolifyDatabaseReadOperation({
        ...readIdentity,
        pathTemplate: "/tenant-databases/{uuid}",
      }),
    ).toBe(false);
    expect(
      isVerifiedCoolifyDatabaseUpdateOperation({ ...updateIdentity, operationId: "updateTenant" }),
    ).toBe(false);
    expect(
      isCoolifyDatabaseResponseSchema({
        type: "object",
        properties: { internal_db_url: { type: "string" }, password: { type: "object" } },
      }),
    ).toBe(false);
    expect(
      isCoolifyDatabaseUpdateRequestSchema({
        type: "object",
        properties: { password: { type: "object" } },
      }),
    ).toBe(false);
  });
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
        expect(fresh).toHaveLength(7);
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
          readonly sensitiveOutputSafeScalars?: readonly Record<string, string>[];
        };
        expect(freshApplicationReadAnnotations.sensitiveOutputPaths).toEqual([
          "/http_basic_auth_password",
          "/manual_webhook_secret_bitbucket",
          "/manual_webhook_secret_gitea",
          "/manual_webhook_secret_github",
          "/manual_webhook_secret_gitlab",
        ]);
        expect(freshApplicationReadAnnotations.sensitiveOutputSafeScalars).toBeUndefined();

        const freshApplicationList = fresh.find(
          (candidate) => candidate.name === listApplicationsOperationName,
        );
        const freshApplicationListAnnotations = freshApplicationList?.annotations as {
          readonly sensitiveOutputPaths?: readonly string[];
          readonly sensitiveOutputSafeScalars?: readonly Record<string, string>[];
        };
        expect(freshApplicationListAnnotations.sensitiveOutputPaths).toEqual([
          "/*/http_basic_auth_password",
          "/*/manual_webhook_secret_bitbucket",
          "/*/manual_webhook_secret_gitea",
          "/*/manual_webhook_secret_github",
          "/*/manual_webhook_secret_gitlab",
        ]);
        expect(freshApplicationListAnnotations.sensitiveOutputSafeScalars).toBeUndefined();

        const freshEnvironmentCreate = fresh.find(
          (candidate) => candidate.name === "applications.createEnvByApplicationUuid",
        );
        const freshEnvironmentCreateAnnotations = freshEnvironmentCreate?.annotations as {
          readonly sensitiveInputPaths?: readonly string[];
          readonly sensitiveOutputPaths?: readonly string[];
          readonly sensitiveOutputSafeScalars?: readonly Record<string, string>[];
        };
        expect(freshEnvironmentCreateAnnotations.sensitiveInputPaths).toEqual([
          "/body/value",
          "/input/value",
        ]);
        expect(freshEnvironmentCreateAnnotations.sensitiveOutputPaths).toEqual([
          "/real_value",
          "/value",
        ]);
        expect(freshEnvironmentCreateAnnotations.sensitiveOutputSafeScalars).toBeUndefined();

        const freshEnvironmentList = fresh.find(
          (candidate) => candidate.name === listEnvironmentOperationName,
        );
        const freshEnvironmentListAnnotations = freshEnvironmentList?.annotations as {
          readonly sensitiveOutputPaths?: readonly string[];
          readonly sensitiveOutputSafeScalars?: readonly Record<string, string>[];
        };
        expect(freshEnvironmentListAnnotations.sensitiveOutputPaths).toEqual([
          "/*/real_value",
          "/*/value",
        ]);
        expect(freshEnvironmentListAnnotations.sensitiveOutputSafeScalars).toBeUndefined();

        const freshEnvironmentUpdate = fresh.find(
          (candidate) => candidate.name === updateEnvironmentOperationName,
        );
        const freshEnvironmentUpdateAnnotations = freshEnvironmentUpdate?.annotations as {
          readonly sensitiveInputPaths?: readonly string[];
          readonly sensitiveOutputPaths?: readonly string[];
          readonly sensitiveOutputSafeScalars?: readonly Record<string, string>[];
        };
        expect(freshEnvironmentUpdateAnnotations.sensitiveInputPaths).toEqual([
          "/body/value",
          "/input/value",
        ]);
        expect(freshEnvironmentUpdateAnnotations.sensitiveOutputPaths).toEqual([
          "/real_value",
          "/value",
        ]);
        expect(freshEnvironmentUpdateAnnotations.sensitiveOutputSafeScalars).toBeUndefined();

        const freshEnvironmentBatch = fresh.find(
          (candidate) => candidate.name === updateEnvironmentsOperationName,
        );
        const freshEnvironmentBatchAnnotations = freshEnvironmentBatch?.annotations as {
          readonly sensitiveInputPaths?: readonly string[];
          readonly sensitiveOutputPaths?: readonly string[];
          readonly sensitiveOutputSafeScalars?: readonly Record<string, string>[];
        };
        expect(freshEnvironmentBatchAnnotations.sensitiveInputPaths).toEqual([
          "/body/data/*/value",
          "/input/data/*/value",
        ]);
        expect(freshEnvironmentBatchAnnotations.sensitiveOutputPaths).toEqual([
          "/*/real_value",
          "/*/value",
        ]);
        expect(freshEnvironmentBatchAnnotations.sensitiveOutputSafeScalars).toBeUndefined();

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
        expect(republished).toHaveLength(7);
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

        const createResult = yield* executor.execute(
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
          { ...accepted, opaqueValueHandoff: makeOpaqueValueHandoff() },
        );
        expect(createResult).toEqual({
          ok: true,
          data: null,
          http: { status: 200, headers: {} },
        });
        expect(JSON.stringify(createResult)).not.toContain(environmentSecretCanaries.value);
        expect(JSON.stringify(createResult)).not.toContain(environmentSecretCanaries.real_value);
        expectTransformedSiblingsDropped(createResult, environmentTransformedSiblingCanaries);

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
        expect(readResult.data?.uuid).toBeUndefined();
        expect(readResult.data?.name).toBeUndefined();
        for (const name of Object.keys(applicationSecretCanaries)) {
          expect(isOpaqueValueReference(readResult.data?.[name])).toBe(true);
        }
        expectTransformedSiblingsDropped(readResult, applicationTransformedSiblingCanaries);

        const applicationListResult = (yield* executor.execute(
          connection.address(listApplicationsOperationName),
          {},
          { ...accepted, opaqueValueHandoff: makeOpaqueValueHandoff() },
        )) as { readonly ok?: boolean; readonly data?: readonly Record<string, unknown>[] };
        expect(applicationListResult.ok).toBe(true);
        expect(Object.keys(applicationListResult.data?.[0] ?? {}).sort()).toEqual([
          "http_basic_auth_password",
          "manual_webhook_secret_bitbucket",
          "manual_webhook_secret_gitea",
          "manual_webhook_secret_github",
          "manual_webhook_secret_gitlab",
        ]);
        for (const name of Object.keys(applicationSecretCanaries)) {
          expect(isOpaqueValueReference(applicationListResult.data?.[0]?.[name])).toBe(true);
        }
        const applicationListSurface = JSON.stringify(applicationListResult);
        for (const canary of Object.values(applicationRepositoryCanaries)) {
          expect(applicationListSurface).not.toContain(canary);
        }
        expect(applicationListSurface).not.toContain("coolify-repository-userinfo-canary");
        expect(applicationListSurface).not.toContain("coolify-repository-token-canary");
        expectTransformedSiblingsDropped(
          applicationListResult,
          applicationTransformedSiblingCanaries,
        );

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
        expect(listResult.data?.[0]?.key).toBeUndefined();
        expect(Object.keys(listResult.data?.[0] ?? {}).sort()).toEqual(["real_value", "value"]);
        expectTransformedSiblingsDropped(listResult, environmentTransformedSiblingCanaries);

        const updateResult = yield* executor.execute(
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
        );
        expect(updateResult).toEqual({
          ok: true,
          data: null,
          http: { status: 200, headers: {} },
        });
        expect(JSON.stringify(updateResult)).not.toContain(environmentSecretCanaries.value);
        expect(JSON.stringify(updateResult)).not.toContain(environmentSecretCanaries.real_value);
        expectTransformedSiblingsDropped(updateResult, environmentTransformedSiblingCanaries);

        const batchResult = yield* executor.execute(
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
        );
        expect(batchResult).toEqual({
          ok: true,
          data: null,
          http: { status: 200, headers: {} },
        });
        expect(JSON.stringify(batchResult)).not.toContain(environmentSecretCanaries.value);
        expect(JSON.stringify(batchResult)).not.toContain(environmentSecretCanaries.real_value);
        expectTransformedSiblingsDropped(batchResult, environmentTransformedSiblingCanaries);

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

  it.effect("drops a runtime object from a schema-declared safe string field", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transformed = {
          base64: Buffer.from(environmentSecretCanaries.value).toString("base64"),
          base64url: Buffer.from(environmentSecretCanaries.value).toString("base64url"),
          arbitrary: [...environmentSecretCanaries.value].reverse().join(""),
        };
        const fixture = yield* serveCoolifyFixture({ environmentKey: transformed });
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: fixture.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(executor, fixture, {
          slug: "coolify_object_key",
        });

        const result = (yield* executor.execute(
          connection.address(listEnvironmentOperationName),
          { uuid: "app-1" },
          { opaqueValueHandoff: makeOpaqueValueHandoff() },
        )) as { readonly data?: readonly Record<string, unknown>[] };
        expect(Object.keys(result.data?.[0] ?? {}).sort()).toEqual(["real_value", "value"]);
        expect(isOpaqueValueReference(result.data?.[0]?.value)).toBe(true);
        const rendered = JSON.stringify(result);
        for (const canary of Object.values(transformed)) expect(rendered).not.toContain(canary);
      }),
    ),
  );

  it.effect("sends opaque values through schema-gated POST and PATCH sinks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* serveCoolifyFixture();
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: fixture.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(executor, fixture, {
          slug: "coolify",
        });
        const handoff = makeOpaqueValueHandoff();

        const postSource = (yield* executor.execute(
          connection.address(listEnvironmentOperationName),
          { uuid: "app-1" },
          { opaqueValueHandoff: handoff },
        )) as { readonly data?: readonly { readonly value?: unknown }[] };
        expect(isOpaqueValueReference(postSource.data?.[0]?.value)).toBe(true);
        const postResult = yield* executor.execute(
          connection.address("applications.createEnvByApplicationUuid"),
          {
            uuid: "app-1",
            body: { key: "OPAQUE_POST", value: postSource.data?.[0]?.value },
          },
          { ...accepted, opaqueValueHandoff: handoff },
        );

        const patchSource = (yield* executor.execute(
          connection.address(listEnvironmentOperationName),
          { uuid: "app-1" },
          { opaqueValueHandoff: handoff },
        )) as { readonly data?: readonly { readonly value?: unknown }[] };
        expect(isOpaqueValueReference(patchSource.data?.[0]?.value)).toBe(true);
        const patchResult = yield* executor.execute(
          connection.address(updateEnvironmentOperationName),
          {
            uuid: "app-1",
            body: { key: "OPAQUE_PATCH", value: patchSource.data?.[0]?.value },
          },
          { ...accepted, opaqueValueHandoff: handoff },
        );

        const safeResult = {
          ok: true,
          data: null,
          http: { status: 200, headers: {} },
        };
        expect(postResult).toEqual(safeResult);
        expect(patchResult).toEqual(safeResult);

        const writes = (yield* fixture.requests).filter(
          (request) => request.method === "POST" || request.method === "PATCH",
        );
        expect(
          writes.map((request) => ({ method: request.method, body: decodeJson(request.body) })),
        ).toEqual([
          {
            method: "POST",
            body: { key: "OPAQUE_POST", value: environmentSecretCanaries.value },
          },
          {
            method: "PATCH",
            body: { key: "OPAQUE_PATCH", value: environmentSecretCanaries.value },
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

  it.effect(
    "does not infer sensitive create outputs without the Coolify response fingerprint",
    () =>
      Effect.gen(function* () {
        const compiled = yield* compileOpenApiSpec(
          coolifySpec("https://coolify.fixture.invalid", {
            type: "object",
            properties: { id: { type: "string" }, message: { type: "string" } },
          }),
        );
        const create = compiled.definitions.find(
          (candidate) => candidate.operation.operationId === "createEnvByApplicationUuid",
        );
        expect(create).toBeDefined();
        expect(create?.operation.sensitiveInputPaths).toEqual(["/body/value", "/input/value"]);
        expect(create?.operation.sensitiveOutputPaths).toBeUndefined();
      }),
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
          sensitiveOutputSafeScalars: undefined,
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

  it.effect("fails closed for a persisted v1 Coolify application-list binding", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(coolifySpec("https://coolify.fixture.invalid"));
      const stored = openApiStoredOperationsFromCompiled("coolify", compiled).find(
        (candidate) => candidate.toolName === listApplicationsOperationName,
      );
      expect(stored).toBeDefined();
      if (!stored) return;
      expect(stored.binding.sensitivityVersion).toBe(2);

      const persistedV1 = {
        ...stored,
        binding: {
          ...stored.binding,
          sensitivityVersion: 1 as const,
          sensitiveInputPaths: undefined,
          sensitiveOutputPaths: undefined,
          sensitiveOutputSafeScalars: undefined,
          sensitiveResponseHeaders: undefined,
        },
      };
      const annotations = yield* resolveOpenApiBackedAnnotations({
        ctx: {
          storage: {
            getOperation: () => Effect.succeed(persistedV1),
          },
        } as never,
        integration: "coolify",
        toolRows: [{ name: stored.toolName }],
      });

      expect(annotations[stored.toolName]).toEqual({
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
