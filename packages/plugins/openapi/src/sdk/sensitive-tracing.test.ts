import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import type * as Tracer from "effect/Tracer";
import { HttpServerResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  createExecutor,
  isOpaqueValueReference,
  makeOpaqueValueHandoff,
  type ToolAddress,
} from "@executor-js/sdk";
import {
  makeTestConfig,
  memoryCredentialsPlugin,
  serveTestHttpApp,
} from "@executor-js/sdk/testing";

import { addOpenApiTestConnection } from "../testing";
import { openApiPlugin } from "./plugin";

type RecordedSpan = {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly events: Array<{
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>> | undefined;
  }>;
  status: Tracer.SpanStatus;
};

/** Records the complete public span surface, including terminal exits, so a
 * regression cannot hide a value in an event or error instead of attributes. */
const makeRecordingTracer = (): {
  readonly tracer: Tracer.Tracer;
  readonly spans: RecordedSpan[];
} => {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const attributes = new Map<string, unknown>();
      let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
      const recorded: RecordedSpan = { name: options.name, attributes, events: [], status };
      spans.push(recorded);
      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${spans.length}`,
        traceId: "trace-sensitive-inputs",
        parent: options.parent,
        annotations: options.annotations,
        get status() {
          return status;
        },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end: (endTime, exit) => {
          status = { _tag: "Ended", startTime: options.startTime, endTime, exit };
          recorded.status = status;
        },
        attribute: (key, value) => {
          attributes.set(key, value);
        },
        event: (name, _startTime, eventAttributes) => {
          recorded.events.push({ name, attributes: eventAttributes });
        },
        addLinks: () => undefined,
      };
    },
  };
  return { tracer, spans };
};

const PATH_MARKER = "trace-path-sensitive-canary";
const QUERY_MARKER = "trace-query-sensitive-canary";
const HEADER_MARKER = "trace-header-sensitive-canary";
const BODY_MARKER = "trace-body-sensitive-canary";
const SERVER_MARKER = "trace-server-sensitive-canary";
const OUTPUT_MARKER = "trace-output-sensitive-canary";
const ERROR_MARKER = "trace-error-sensitive-canary";
const RESPONSE_HEADER_MARKER = "trace-response-header-sensitive-canary";
const AUTH_QUERY_MARKER = "trace-auth-query-canary";
const AUTH_HEADER_MARKER = "trace-auth-header-canary";
const ALTERNATE_RESPONSE_MARKER = "trace-alternate-response-canary";
const OPAQUE_PROVENANCE_MARKER = 'trace opaque "line1\r\nline2" * / marker';
const ALL_MARKERS = [
  PATH_MARKER,
  QUERY_MARKER,
  HEADER_MARKER,
  BODY_MARKER,
  SERVER_MARKER,
  OUTPUT_MARKER,
  ERROR_MARKER,
  RESPONSE_HEADER_MARKER,
  AUTH_QUERY_MARKER,
  AUTH_HEADER_MARKER,
  ALTERNATE_RESPONSE_MARKER,
];
const SENSITIVE_INPUT_MARKERS = [
  PATH_MARKER,
  QUERY_MARKER,
  HEADER_MARKER,
  BODY_MARKER,
  SERVER_MARKER,
];

const tracingSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Sensitive tracing fixture", version: "1.0.0" },
    servers: [
      {
        url: `${baseUrl}/{serverToken}`,
        variables: {
          serverToken: { default: "public", "x-secret": true },
        },
      },
    ],
    paths: {
      "/records/{pathToken}": {
        post: {
          operationId: "sendSensitive",
          tags: ["Tracing"],
          parameters: [
            {
              name: "pathToken",
              in: "path",
              required: true,
              schema: { type: "string", format: "token" },
            },
            {
              name: "queryToken",
              in: "query",
              schema: { type: "string", format: "token" },
            },
            {
              name: "headerToken",
              in: "header",
              schema: { type: "string", format: "token" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { value: { type: "string", format: "password" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { output: { type: "string", format: "secret" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const sensitiveErrorSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Sensitive error fixture", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/error": {
        get: {
          operationId: "getSensitiveError",
          tags: ["Tracing"],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
            "400": {
              description: "Failed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { detail: { type: "string", format: "secret" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const sensitiveHeaderSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Sensitive header fixture", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/header": {
        get: {
          operationId: "getSensitiveHeader",
          tags: ["Tracing"],
          responses: {
            "200": {
              description: "OK",
              headers: {
                "x-sensitive-output": { schema: { type: "string", format: "secret" } },
              },
              content: {
                "application/json": {
                  schema: { type: "object", properties: { public: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  });

const authOnlySpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Auth tracing fixture", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/public": {
        get: {
          operationId: "getPublic",
          tags: ["Tracing"],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { public: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
  });

const alternateSensitiveResponseSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Alternate sensitive response fixture", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/alternate": {
        get: {
          operationId: "getAlternateSensitiveResponse",
          tags: ["Tracing"],
          responses: {
            "200": {
              description: "Public default response",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { public: { type: "string" } } },
                },
              },
            },
            "201": {
              description: "Sensitive alternate response",
              content: {
                "application/vnd.fixture+json": {
                  schema: {
                    type: "object",
                    properties: { alternate: { type: "string", format: "secret" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const opaqueProvenanceSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Opaque provenance fixture", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/source": {
        get: {
          operationId: "readOpaqueSource",
          tags: ["Tracing"],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { value: { type: "string", format: "secret" } },
                  },
                },
              },
            },
          },
        },
      },
      "/sink": {
        post: {
          operationId: "writeOpaqueSink",
          tags: ["Tracing"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { value: { type: "string", format: "password" } },
                  required: ["value"],
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const opaqueAdversarialEchoes = (value: string): readonly string[] => {
  const json = JSON.stringify(value);
  const uri = encodeURIComponent(value);
  return [
    encodeURIComponent(json),
    new URLSearchParams([["value", json]]).toString(),
    encodeURIComponent(value.replaceAll("\r\n", "\n")),
    uri.replaceAll("*", "%2A"),
    encodeURIComponent(uri),
  ];
};

const opaqueSourceSiblingTransforms = (value: string): readonly string[] => [
  Buffer.from(value).toString("base64"),
  Buffer.from(value).toString("base64url"),
  [...value].reverse().join(""),
];

const spanSurface = (spans: readonly RecordedSpan[]): string =>
  JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: [...span.attributes.entries()],
      events: span.events,
      status: span.status,
    })),
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );

describe("OpenAPI sensitive transport tracing", () => {
  it.effect("sends declared sensitive fields upstream but never records them in spans", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* Ref.make<
          readonly {
            readonly url: string;
            readonly headers: Readonly<Record<string, string>>;
            readonly body: string;
          }[]
        >([]);
        const server = yield* serveTestHttpApp((request) =>
          Effect.gen(function* () {
            const body = yield* request.text.pipe(Effect.catch(() => Effect.succeed("")));
            yield* Ref.update(requests, (all) => [
              ...all,
              { url: request.url ?? "/", headers: request.headers, body },
            ]);
            return HttpServerResponse.jsonUnsafe({ output: OUTPUT_MARKER });
          }),
        );
        const plugins = [
          openApiPlugin({ httpClientLayer: server.httpClientLayer }),
          memoryCredentialsPlugin(),
        ] as const;
        const executor = yield* createExecutor(makeTestConfig({ plugins }));
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...server, specJson: tracingSpec(server.baseUrl) },
          { slug: "trace", baseUrl: null },
        );
        const { tracer, spans } = makeRecordingTracer();
        const address = connection.address("tracing.sendSensitive") as ToolAddress;

        const result = yield* Effect.withTracer(
          executor.execute(
            address,
            {
              pathToken: PATH_MARKER,
              queryToken: QUERY_MARKER,
              headers: { headerToken: HEADER_MARKER },
              body: { value: BODY_MARKER },
              server: { variables: { serverToken: SERVER_MARKER } },
            },
            {
              onElicitation: () => Effect.succeed({ action: "accept" as const }),
              opaqueValueHandoff: makeOpaqueValueHandoff(),
            },
          ),
          tracer,
        );

        const received = JSON.stringify(yield* Ref.get(requests));
        for (const marker of SENSITIVE_INPUT_MARKERS) {
          expect(received, `the upstream should receive ${marker}`).toContain(marker);
        }
        expect(JSON.stringify(result)).not.toContain(OUTPUT_MARKER);

        const observed = spanSurface(spans);
        for (const marker of ALL_MARKERS) {
          expect(
            observed,
            `no span name, attribute, event, status, or error may contain ${marker}`,
          ).not.toContain(marker);
        }
      }),
    ),
  );

  it.effect("redacts a declared sensitive error body before result or trace construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTestHttpApp(() =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ detail: ERROR_MARKER }, { status: 400 })),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...server, specJson: sensitiveErrorSpec(server.baseUrl) },
          { slug: "trace_error" },
        );
        const { tracer, spans } = makeRecordingTracer();
        const result = yield* Effect.withTracer(
          executor.execute(
            connection.address("tracing.getSensitiveError"),
            {},
            {
              opaqueValueHandoff: makeOpaqueValueHandoff(),
            },
          ),
          tracer,
        );

        expect(JSON.stringify(result)).not.toContain(ERROR_MARKER);
        expect(spanSurface(spans)).not.toContain(ERROR_MARKER);
      }),
    ),
  );

  it.effect("strips a declared sensitive response header even with a public body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTestHttpApp(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { public: "ok" },
              { headers: { "x-sensitive-output": RESPONSE_HEADER_MARKER } },
            ),
          ),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...server, specJson: sensitiveHeaderSpec(server.baseUrl) },
          { slug: "trace_header" },
        );
        const { tracer, spans } = makeRecordingTracer();
        const result = yield* Effect.withTracer(
          executor.execute(
            connection.address("tracing.getSensitiveHeader"),
            {},
            {
              opaqueValueHandoff: makeOpaqueValueHandoff(),
            },
          ),
          tracer,
        );

        expect(JSON.stringify(result)).not.toContain(RESPONSE_HEADER_MARKER);
        expect(result).toMatchObject({ ok: true, data: { public: "ok" }, http: { headers: {} } });
        expect(spanSurface(spans)).not.toContain(RESPONSE_HEADER_MARKER);
      }),
    ),
  );

  it.effect("seals a sensitive 201 alternate-media response at runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveTestHttpApp(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { alternate: ALTERNATE_RESPONSE_MARKER },
              { status: 201, headers: { "content-type": "application/vnd.fixture+json" } },
            ),
          ),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...server, specJson: alternateSensitiveResponseSpec(server.baseUrl) },
          { slug: "trace_alternate" },
        );
        const { tracer, spans } = makeRecordingTracer();
        const result = (yield* Effect.withTracer(
          executor.execute(
            connection.address("tracing.getAlternateSensitiveResponse"),
            {},
            {
              opaqueValueHandoff: makeOpaqueValueHandoff(),
            },
          ),
          tracer,
        )) as { readonly ok?: boolean; readonly data?: Record<string, unknown> };

        expect(result.ok).toBe(true);
        expect(isOpaqueValueReference(result.data?.alternate)).toBe(true);
        expect(JSON.stringify(result)).not.toContain(ALTERNATE_RESPONSE_MARKER);
        expect(spanSurface(spans)).not.toContain(ALTERNATE_RESPONSE_MARKER);
      }),
    ),
  );

  it.effect("taints an opaque-consuming OpenAPI response instead of matching transforms", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const receivedBodies = yield* Ref.make<readonly unknown[]>([]);
        const echoes = opaqueAdversarialEchoes(OPAQUE_PROVENANCE_MARKER);
        const sourceTransforms = opaqueSourceSiblingTransforms(OPAQUE_PROVENANCE_MARKER);
        const server = yield* serveTestHttpApp((request) =>
          request.url?.endsWith("/source")
            ? Effect.succeed(
                HttpServerResponse.jsonUnsafe({
                  value: OPAQUE_PROVENANCE_MARKER,
                  base64Echo: sourceTransforms[0],
                  base64urlEcho: sourceTransforms[1],
                  arbitraryEcho: sourceTransforms[2],
                  error: { message: sourceTransforms[0] },
                  logs: sourceTransforms,
                  trace: { "http.response.body": sourceTransforms.join("|") },
                }),
              )
            : Effect.gen(function* () {
                const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
                if (body !== null) {
                  yield* Ref.update(receivedBodies, (all) => [...all, body]);
                }
                return HttpServerResponse.jsonUnsafe(
                  {
                    success: echoes,
                    error: echoes.map((echo) => ({ message: echo })),
                    logs: echoes,
                    trace: echoes.map((echo) => ({ "http.response.body": echo })),
                    directText: echoes.join("\n"),
                  },
                  { status: 202, headers: { "x-opaque-echo": echoes.join(",") } },
                );
              }),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...server, specJson: opaqueProvenanceSpec(server.baseUrl) },
          { slug: "trace_opaque_provenance" },
        );
        const handoff = makeOpaqueValueHandoff();
        const { tracer, spans } = makeRecordingTracer();
        const source = (yield* Effect.withTracer(
          executor.execute(
            connection.address("tracing.readOpaqueSource"),
            {},
            {
              opaqueValueHandoff: handoff,
            },
          ),
          tracer,
        )) as { readonly ok?: boolean; readonly data?: { readonly value?: unknown } };
        expect(source.ok).toBe(true);
        expect(isOpaqueValueReference(source.data?.value)).toBe(true);
        expect(Object.keys(source.data ?? {})).toEqual(["value"]);
        const sourcePublicSurface = `${JSON.stringify(source)}\n${spanSurface(spans)}`;
        expect(sourcePublicSurface).not.toContain(OPAQUE_PROVENANCE_MARKER);
        for (const transform of sourceTransforms) {
          expect(sourcePublicSurface).not.toContain(transform);
        }

        const result = yield* Effect.withTracer(
          executor.execute(
            connection.address("tracing.writeOpaqueSink"),
            { body: { value: source.data?.value } },
            {
              onElicitation: () => Effect.succeed({ action: "accept" as const }),
              opaqueValueHandoff: handoff,
            },
          ),
          tracer,
        );

        expect(yield* Ref.get(receivedBodies)).toEqual([{ value: OPAQUE_PROVENANCE_MARKER }]);
        expect(result).toEqual({
          ok: true,
          data: null,
          http: { status: 202, headers: {} },
        });
        const publicSurface = `${JSON.stringify(result)}\n${spanSurface(spans)}`;
        expect(publicSurface).not.toContain(OPAQUE_PROVENANCE_MARKER);
        for (const echo of echoes) expect(publicSurface).not.toContain(echo);
        for (const transform of sourceTransforms) expect(publicSurface).not.toContain(transform);
      }),
    ),
  );

  it.effect("suppresses transport spans for unannotated custom-header and query API keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* Ref.make<
          readonly { readonly url: string; readonly headers: unknown }[]
        >([]);
        const server = yield* serveTestHttpApp((request) =>
          Effect.gen(function* () {
            yield* Ref.update(requests, (all) => [
              ...all,
              { url: request.url ?? "/", headers: request.headers },
            ]);
            return HttpServerResponse.jsonUnsafe({ public: "ok" });
          }),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              openApiPlugin({ httpClientLayer: server.httpClientLayer }),
              memoryCredentialsPlugin(),
            ] as const,
          }),
        );
        const connection = yield* addOpenApiTestConnection(
          executor,
          { ...server, specJson: authOnlySpec(server.baseUrl) },
          {
            slug: "trace_auth",
            authenticationTemplate: [
              {
                slug: AuthTemplateSlug.make("apiKey"),
                type: "apiKey",
                headers: {
                  "x-custom-auth": [{ type: "variable", name: "token" }],
                },
                queryParams: {
                  access_key: [{ type: "variable", name: "token" }],
                },
              },
            ],
          },
          { value: `${AUTH_QUERY_MARKER}-${AUTH_HEADER_MARKER}` },
        );
        const { tracer, spans } = makeRecordingTracer();
        const result = yield* Effect.withTracer(
          executor.execute(connection.address("tracing.getPublic"), {}),
          tracer,
        );

        expect(result).toMatchObject({ ok: true, data: { public: "ok" } });
        const received = JSON.stringify(yield* Ref.get(requests));
        expect(received).toContain(AUTH_QUERY_MARKER);
        expect(received).toContain(AUTH_HEADER_MARKER);
        const observed = spanSurface(spans);
        expect(observed).not.toContain(AUTH_QUERY_MARKER);
        expect(observed).not.toContain(AUTH_HEADER_MARKER);
      }),
    ),
  );
});
