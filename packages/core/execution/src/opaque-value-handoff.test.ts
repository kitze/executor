import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Logger } from "effect";
import type * as Tracer from "effect/Tracer";

import {
  ElicitationResponse,
  FormElicitation,
  ToolAddress,
  isOpaqueValueReference,
  makeOpaqueValueHandoff,
  ToolResult,
  createExecutor,
  definePlugin,
  tool,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import { createExecutionEngine, formatPausedExecution } from "./engine";

const MARKER = 'opaque execution "line1\r\nline2" * / marker';
const DIRECT_ARGUMENT_MARKER = "approval-argument-regression-marker";
const GENERATED_MARKER = "generated-sensitive-sink-regression-marker";
const REPOSITORY_CREDENTIAL_MARKER = "repository-userinfo-regression-marker";
const repositoryCredentialUrls = [
  `https://fixture-user:${REPOSITORY_CREDENTIAL_MARKER}@example.invalid/org/repository.git`,
  `https://example.invalid/org/repository?access_token=${REPOSITORY_CREDENTIAL_MARKER}`,
] as const;

const adversarialEchoes = (value: string): readonly string[] => {
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

const arbitrarySourceTransforms = (value: string): readonly string[] => [
  Buffer.from(value).toString("base64"),
  Buffer.from(value).toString("base64url"),
  [...value].reverse().join(""),
];

type RecordedSpan = {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly events: readonly {
    readonly name: string;
    readonly attributes: Readonly<Record<string, unknown>> | undefined;
  }[];
  status: Tracer.SpanStatus;
};

const makeRecordingTracer = (): {
  readonly tracer: Tracer.Tracer;
  readonly spans: RecordedSpan[];
} => {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer.Tracer = {
    span: (options) => {
      const attributes = new Map<string, unknown>();
      const events: {
        readonly name: string;
        readonly attributes: Readonly<Record<string, unknown>> | undefined;
      }[] = [];
      let status: Tracer.SpanStatus = { _tag: "Started", startTime: options.startTime };
      const recorded: RecordedSpan = {
        name: options.name,
        attributes,
        events,
        status,
      };
      spans.push(recorded);
      return {
        _tag: "Span",
        name: options.name,
        spanId: `span-${spans.length}`,
        traceId: "trace-opaque-execution",
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
          events.push({ name, attributes: eventAttributes });
        },
        addLinks: () => undefined,
      };
    },
  };
  return { tracer, spans };
};

const spanSurface = (spans: readonly RecordedSpan[]): string =>
  cycleSafeStringify(
    spans.map((span) => ({
      name: span.name,
      attributes: [...span.attributes.entries()],
      events: span.events,
      status: span.status,
    })),
  );

const cycleSafeStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item !== "object" || item === null) return item;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    return item;
  });
};

type Ledger = {
  readonly writes: unknown[];
  readonly reviews: unknown[];
};

const makePlugin = (ledger: Ledger) =>
  definePlugin(() => ({
    id: "opaque-execution-test" as const,
    storage: () => ({}),
    staticIntegrations: () => [
      {
        id: "opaque",
        kind: "test",
        name: "Opaque handoff test",
        tools: [
          tool({
            name: "read",
            description: "Read an environment value",
            annotations: { sensitiveOutputPaths: ["/envs/*/value"] },
            execute: () =>
              Effect.gen(function* () {
                const transforms = arbitrarySourceTransforms(MARKER);
                yield* Effect.log("opaque source response", {
                  transforms,
                  repositoryCredentialUrls,
                });
                yield* Effect.annotateCurrentSpan({
                  "opaque.source.transforms": [...transforms, ...repositoryCredentialUrls].join(
                    "|",
                  ),
                });
                return {
                  ok: true,
                  data: {
                    envs: [
                      {
                        key: "SOURCE_VALUE",
                        value: MARKER,
                        base64Echo: transforms[0],
                        base64urlEcho: transforms[1],
                        arbitraryEcho: transforms[2],
                        git_repository: repositoryCredentialUrls[0],
                        git_full_url: repositoryCredentialUrls[1],
                        error: { message: transforms[0] },
                        logs: [...transforms, ...repositoryCredentialUrls],
                        trace: {
                          "http.response.body": [...transforms, ...repositoryCredentialUrls].join(
                            "|",
                          ),
                        },
                      },
                    ],
                  },
                  envelopeEcho: transforms[0],
                  error: { message: transforms[1] },
                  logs: [...transforms, ...repositoryCredentialUrls],
                  trace: { "http.response.body": transforms[2] },
                  http: {
                    status: 200,
                    headers: { "x-source-echo": transforms[0] },
                    envelopeEcho: transforms[1],
                  },
                } as never;
              }),
          }),
          tool({
            name: "write",
            description: "Write an environment value",
            annotations: { sensitiveInputPaths: ["/body/value"] },
            execute: (args) =>
              Effect.gen(function* () {
                ledger.writes.push(args);
                const value = (args as { readonly body?: { readonly value?: unknown } }).body
                  ?.value;
                const echoes = adversarialEchoes(String(value));
                yield* Effect.log("opaque sink response", { echoes });
                yield* Effect.annotateCurrentSpan({
                  "opaque.adversarial.echo": echoes.join("|"),
                });
                return ToolResult.ok(
                  {
                    success: echoes.map((echo) => ({ body: echo })),
                    error: echoes.map((echo) => ({ message: echo })),
                    logs: echoes,
                    trace: echoes.map((echo) => ({ "http.response.body": echo })),
                    directText: echoes.join("\n"),
                  },
                  { http: { status: 202, headers: { "x-opaque-echo": echoes.join(",") } } },
                );
              }),
          }),
          tool({
            name: "writeFailure",
            description: "Reject an environment value",
            annotations: { sensitiveInputPaths: ["/body/value"] },
            execute: (args) =>
              Effect.sync(() => {
                ledger.writes.push(args);
                const value = (args as { readonly body?: { readonly value?: unknown } }).body
                  ?.value;
                const echoes = adversarialEchoes(String(value));
                return ToolResult.fail({
                  code: echoes[0] ?? "UPSTREAM_REJECTED",
                  message: `rejected ${echoes[0]}`,
                  details: { echoes },
                  status: 422,
                  retryable: false,
                });
              }),
          }),
          tool({
            name: "writeText",
            description: "Write an environment value and return text",
            annotations: { sensitiveInputPaths: ["/body/value"] },
            execute: (args) =>
              Effect.sync(() => {
                ledger.writes.push(args);
                const value = (args as { readonly body?: { readonly value?: unknown } }).body
                  ?.value;
                return adversarialEchoes(String(value)).join("\n");
              }),
          }),
          tool({
            name: "writeDefect",
            description: "Defect after receiving an environment value",
            annotations: { sensitiveInputPaths: ["/body/value"] },
            execute: (args) =>
              Effect.gen(function* () {
                ledger.writes.push(args);
                const value = (args as { readonly body?: { readonly value?: unknown } }).body
                  ?.value;
                const transforms = arbitrarySourceTransforms(String(value));
                yield* Effect.log("opaque sink defect", { transforms });
                yield* Effect.annotateCurrentSpan({
                  "opaque.defect.transforms": transforms.join("|"),
                });
                // oxlint-disable-next-line executor/no-error-constructor -- regression boundary: prove an untrusted built-in Error defect carrying source material is normalized before Cause.pretty/trace surfaces
                return yield* Effect.die(new Error(`${String(value)}|${transforms.join("|")}`));
              }),
          }),
          tool({
            name: "writeAndElicit",
            description: "Write a sensitive value, then request another approval",
            annotations: {
              requiresApproval: true,
              mayElicit: true,
              sensitiveInputPaths: ["/body/value"],
            },
            execute: (args, { elicit }) =>
              Effect.gen(function* () {
                ledger.writes.push(args);
                const body = (
                  args as {
                    readonly body?: { readonly value?: unknown; readonly fail?: unknown };
                  }
                ).body;
                const value = String(body?.value);
                const transforms = arbitrarySourceTransforms(value);
                yield* Effect.log("sensitive handler before elicitation", {
                  value,
                  transforms,
                });
                yield* Effect.annotateCurrentSpan({
                  "opaque.elicitation.raw": `${value}|${transforms.join("|")}`,
                });
                yield* elicit({
                  ...FormElicitation.make({
                    message: `Confirm ${value} ${transforms.join(" ")}`,
                    requestedSchema: {
                      type: "object",
                      properties: {
                        confirmation: { description: `${value}|${transforms.join("|")}` },
                      },
                    },
                  }),
                  args: { body: { value }, transforms },
                } as never);
                if (body?.fail === true) {
                  return ToolResult.fail({
                    code: transforms[0] ?? "FAILED",
                    message: `${value}|${transforms.join("|")}`,
                    details: { value, transforms },
                    status: 422,
                  });
                }
                return {
                  ok: true,
                  data: { value, transforms },
                  envelopeEcho: transforms[0],
                  error: { message: transforms[1] },
                  logs: transforms,
                  http: {
                    status: 202,
                    headers: { "x-sensitive-echo": value },
                    envelopeEcho: transforms[2],
                  },
                } as never;
              }),
          }),
          tool({
            name: "review",
            description: "A normal approval-gated tool",
            annotations: { requiresApproval: true },
            execute: (args) =>
              Effect.sync(() => {
                ledger.reviews.push(args);
                return { ok: true };
              }),
          }),
        ],
      },
    ],
  }))();

const makeHarness = () =>
  Effect.gen(function* () {
    const ledger: Ledger = { writes: [], reviews: [] };
    const executor = yield* createExecutor(
      makeTestConfig({ plugins: [makePlugin(ledger)] as const }),
    );
    const engine = createExecutionEngine({ executor, codeExecutor: makeQuickJsExecutor() });
    return { executor, engine, ledger };
  });

const handoffCode = `
const source = await tools.opaque.read({});
console.log("source", source);
const reference = source.data.envs[0].value;
console.log("reference", reference);
const written = await tools.opaque.write({ body: { value: reference } });
console.log("written", written);
return { source, written };
`;

describe("opaque sensitive value execution", () => {
  it.effect(
    "keeps a source value out of the sandbox and resolves it at the approved sink only",
    () =>
      Effect.gen(function* () {
        const { executor, engine, ledger } = yield* makeHarness();
        const { tracer, spans } = makeRecordingTracer();
        const recordedLogs: string[] = [];
        const logger = Logger.make<unknown, void>((options) => {
          recordedLogs.push(JSON.stringify(options.message));
        });
        // This rule normally bypasses a write approval. An opaque input must
        // still stop for a live human decision.
        yield* executor.policies.create({
          owner: "org",
          pattern: "opaque.write",
          action: "approve",
        });

        const paused = yield* engine
          .executeWithPause(handoffCode)
          .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
        expect(paused.status, "an opaque-consuming call still pauses under an approve policy").toBe(
          "paused",
        );
        if (paused.status !== "paused") return;

        const formatted = formatPausedExecution(paused.execution);
        expect(paused.execution.hasOpaqueValues).toBe(true);
        expect(Object.hasOwn(paused.execution.elicitationContext, "args")).toBe(false);
        const interaction = formatted.structured.interaction;
        expect(interaction).toBeDefined();
        if (!interaction || typeof interaction !== "object") return;
        expect(Object.hasOwn(interaction, "args")).toBe(false);
        expect(JSON.stringify(formatted)).not.toContain(MARKER);
        expect(formatted.text).not.toContain(MARKER);
        expect(ledger.writes, "the sink has not received a value before approval").toEqual([]);

        const rawResume = yield* engine
          .resume(paused.execution.id, { action: "accept" })
          .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
        expect(rawResume?.status, "raw model/API JSON cannot release the secret").toBe("paused");
        expect(ledger.writes, "a rejected raw accept does not invoke the sink").toEqual([]);

        const granted = yield* engine.grantLiveApproval(paused.execution.id, { action: "accept" });
        expect(granted, "an authenticated browser/native endpoint mints the grant").not.toBeNull();
        if (!granted) return;
        const resumed = yield* engine
          .resume(paused.execution.id, granted)
          .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
        expect(resumed?.status).toBe("completed");
        if (resumed?.status !== "completed") return;

        expect(ledger.writes).toHaveLength(1);
        expect(ledger.writes[0]).toMatchObject({ body: { value: MARKER } });
        expect(
          JSON.stringify(resumed.result),
          "result and sandbox logs are redacted",
        ).not.toContain(MARKER);
        expect(resumed.result.logs?.join("\n") ?? "", "sandbox logs are redacted").not.toContain(
          MARKER,
        );
        const sandboxResult = resumed.result.result as {
          readonly source?: {
            readonly data?: { readonly envs?: readonly Record<string, unknown>[] };
          };
          readonly written?: unknown;
        };
        expect(Object.keys(sandboxResult.source?.data?.envs?.[0] ?? {})).toEqual(["value"]);
        expect(sandboxResult.written).toEqual({
          ok: true,
          data: null,
          http: { status: 202, headers: {} },
        });
        expect(sandboxResult.source).toMatchObject({
          http: { status: 200, headers: {} },
        });
        expect(Object.keys(sandboxResult.source ?? {}).sort()).toEqual(["data", "http", "ok"]);
        expect(JSON.stringify(resumed.result.result)).toContain("ExecutorOpaqueValue");

        const echoes = adversarialEchoes(MARKER);
        expect(echoes[0], "JSON.stringify followed by URI encoding").toContain("%5C%22");
        expect(echoes[1], "JSON.stringify followed by form encoding").toContain("+");
        expect(echoes[2], "CRLF normalization leaves only an encoded LF").toContain("%0A");
        expect(echoes[2]).not.toContain("%0D%0A");
        expect(echoes[3], "strict RFC3986 encoding escapes star").toContain("%2A");
        expect(echoes[4], "double encoding escapes the first percent bytes").toContain("%25");
        const publicSurface = JSON.stringify(resumed);
        const observedSpans = spanSurface(spans);
        const observedLogs = recordedLogs.join("\n");
        for (const echo of [
          ...echoes,
          ...arbitrarySourceTransforms(MARKER),
          ...repositoryCredentialUrls,
          REPOSITORY_CREDENTIAL_MARKER,
        ]) {
          expect(publicSurface).not.toContain(echo);
          expect(observedSpans).not.toContain(echo);
          expect(observedLogs).not.toContain(echo);
        }
      }),
  );

  it.effect("normalizes a sensitive Effect defect before result, log, or Cause tracing", () =>
    Effect.gen(function* () {
      const { executor, ledger } = yield* makeHarness();
      const { tracer, spans } = makeRecordingTracer();
      const recordedLogs: string[] = [];
      const logger = Logger.make<unknown, void>((options) => {
        recordedLogs.push(JSON.stringify(options.message));
      });
      const exit = yield* executor
        .execute(
          ToolAddress.make("opaque.writeDefect"),
          { body: { value: MARKER } },
          { opaqueValueHandoff: makeOpaqueValueHandoff() },
        )
        .pipe(Effect.withTracer(tracer), Effect.withLogger(logger), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(ledger.writes).toEqual([{ body: { value: MARKER } }]);

      const renderedCause = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
      const publicSurface = `${cycleSafeStringify(exit)}\n${renderedCause}\n${spanSurface(spans)}\n${recordedLogs.join("\n")}`;
      expect(publicSurface).not.toContain(MARKER);
      for (const transform of arbitrarySourceTransforms(MARKER)) {
        expect(publicSurface).not.toContain(transform);
      }
    }),
  );

  it.effect("suppresses transformed opaque echoes in failures and raw text results", () =>
    Effect.gen(function* () {
      const { executor, engine, ledger } = yield* makeHarness();
      const { tracer, spans } = makeRecordingTracer();
      for (const operation of ["writeFailure", "writeText"] as const) {
        yield* executor.policies.create({
          owner: "org",
          pattern: `opaque.${operation}`,
          action: "approve",
        });

        const paused = yield* Effect.withTracer(
          engine.executeWithPause(`
            const source = await tools.opaque.read({});
            const reference = source.data.envs[0].value;
            return await tools.opaque.${operation}({ body: { value: reference } });
          `),
          tracer,
        );
        expect(paused.status).toBe("paused");
        if (paused.status !== "paused") continue;
        const grant = yield* engine.grantLiveApproval(paused.execution.id, { action: "accept" });
        expect(grant).not.toBeNull();
        if (!grant) continue;
        const resumed = yield* Effect.withTracer(engine.resume(paused.execution.id, grant), tracer);
        expect(resumed?.status).toBe("completed");
        if (resumed?.status !== "completed") continue;

        const expectedResult =
          operation === "writeFailure"
            ? {
                ok: false,
                error: {
                  code: "UPSTREAM_REQUEST_FAILED",
                  message: "Upstream request failed.",
                  status: 422,
                  retryable: false,
                },
              }
            : { ok: true, data: null };
        expect(resumed.result.result).toEqual(expectedResult);
        expect(JSON.stringify(resumed)).not.toContain(MARKER);
        for (const echo of adversarialEchoes(MARKER)) {
          expect(JSON.stringify(resumed)).not.toContain(echo);
        }
      }
      expect(ledger.writes).toEqual([{ body: { value: MARKER } }, { body: { value: MARKER } }]);
      const observedSpans = spanSurface(spans);
      for (const echo of adversarialEchoes(MARKER)) {
        expect(observedSpans).not.toContain(echo);
      }
    }),
  );

  it.effect(
    "keeps resolved and runtime-generated sink values internal across consecutive pauses",
    () =>
      Effect.gen(function* () {
        const { engine, ledger } = yield* makeHarness();
        const { tracer, spans } = makeRecordingTracer();
        const recordedLogs: string[] = [];
        const logger = Logger.make<unknown, void>((options) => {
          recordedLogs.push(cycleSafeStringify(options.message));
        });
        const observedBoundaries: unknown[] = [];

        for (const scenario of [
          {
            marker: GENERATED_MARKER,
            firstRequiresLiveApproval: false,
            fail: false,
            code: `
              const generated = ${JSON.stringify(GENERATED_MARKER)};
              return await tools.opaque.writeAndElicit({
                body: { value: generated, fail: false }
              });
            `,
          },
          {
            marker: MARKER,
            firstRequiresLiveApproval: true,
            fail: true,
            code: `
              const source = await tools.opaque.read({});
              return await tools.opaque.writeAndElicit({
                body: { value: source.data.envs[0].value, fail: true }
              });
            `,
          },
        ] as const) {
          const first = yield* engine
            .executeWithPause(scenario.code)
            .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
          expect(first.status).toBe("paused");
          if (first.status !== "paused") continue;
          expect(first.execution.requiresLiveApproval === true).toBe(
            scenario.firstRequiresLiveApproval,
          );
          observedBoundaries.push(first, formatPausedExecution(first.execution));

          const firstResponse = scenario.firstRequiresLiveApproval
            ? yield* engine.grantLiveApproval(first.execution.id, { action: "accept" })
            : ({ action: "accept" } as const);
          expect(firstResponse).not.toBeNull();
          if (!firstResponse) continue;
          const second = yield* engine
            .resume(first.execution.id, firstResponse)
            .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
          expect(second?.status).toBe("paused");
          if (second?.status !== "paused") continue;
          expect(second.execution.requiresLiveApproval).toBe(true);
          expect(Object.keys(second.execution.elicitationContext).sort()).toEqual([
            "address",
            "request",
            "requiresLiveApproval",
          ]);
          expect(Object.keys(second.execution.elicitationContext.request).sort()).toEqual([
            "_tag",
            "message",
            "requestedSchema",
          ]);

          const persisted = yield* engine.getPausedExecution(second.execution.id);
          expect(persisted).not.toBeNull();
          const rawAccept = yield* engine
            .resume(second.execution.id, { action: "accept" })
            .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
          expect(rawAccept?.status).toBe("paused");
          observedBoundaries.push(
            second,
            persisted,
            rawAccept,
            formatPausedExecution(second.execution),
          );

          const grant = yield* engine.grantLiveApproval(second.execution.id, {
            action: "accept",
          });
          expect(grant).not.toBeNull();
          if (!grant) continue;
          const completed = yield* engine
            .resume(second.execution.id, grant)
            .pipe(Effect.withTracer(tracer), Effect.withLogger(logger));
          expect(completed?.status).toBe("completed");
          if (completed?.status !== "completed") continue;
          observedBoundaries.push(completed);

          const latestWrite = ledger.writes.at(-1) as {
            readonly body?: { readonly value?: unknown };
          };
          expect(latestWrite.body?.value).toBe(scenario.marker);
          expect(completed.result.result).toEqual(
            scenario.fail
              ? {
                  ok: false,
                  error: {
                    code: "UPSTREAM_REQUEST_FAILED",
                    message: "Upstream request failed.",
                    status: 422,
                  },
                }
              : {
                  ok: true,
                  data: null,
                  http: { status: 202, headers: {} },
                },
          );

          const scenarioSurface = cycleSafeStringify(observedBoundaries);
          for (const secret of [scenario.marker, ...arbitrarySourceTransforms(scenario.marker)]) {
            expect(scenarioSurface).not.toContain(secret);
          }
        }

        const completeSurface = `${cycleSafeStringify(observedBoundaries)}\n${recordedLogs.join(
          "\n",
        )}\n${spanSurface(spans)}`;
        for (const secret of [
          GENERATED_MARKER,
          MARKER,
          ...arbitrarySourceTransforms(GENERATED_MARKER),
          ...arbitrarySourceTransforms(MARKER),
          REPOSITORY_CREDENTIAL_MARKER,
          ...repositoryCredentialUrls,
        ]) {
          expect(completeSurface).not.toContain(secret);
        }
      }),
  );

  it.effect("does not invoke an opaque sink after a decline", () =>
    Effect.gen(function* () {
      const { executor, engine, ledger } = yield* makeHarness();
      yield* executor.policies.create({ owner: "org", pattern: "opaque.write", action: "approve" });

      const paused = yield* engine.executeWithPause(handoffCode);
      expect(paused.status).toBe("paused");
      if (paused.status !== "paused") return;

      const declined = yield* engine.resume(paused.execution.id, { action: "decline" });
      expect(declined?.status).toBe("completed");
      expect(ledger.writes, "declining never reaches the sink").toEqual([]);
      expect(JSON.stringify(declined)).not.toContain(MARKER);
      expect(
        yield* engine.grantLiveApproval(paused.execution.id, { action: "accept" }),
        "the first terminal decline cannot be changed into a later acceptance",
      ).toBeNull();
    }),
  );

  it.effect("never lets autoApprove release an opaque value", () =>
    Effect.gen(function* () {
      const { executor, engine, ledger } = yield* makeHarness();
      yield* executor.policies.create({ owner: "org", pattern: "opaque.write", action: "approve" });

      const paused = yield* engine.executeWithPause(handoffCode, { autoApprove: true });
      expect(paused.status, "opaque input turns autoApprove back into a live pause").toBe("paused");
      if (paused.status !== "paused") return;
      expect(paused.execution.elicitationContext.requiresLiveApproval).toBe(true);
      expect(ledger.writes).toEqual([]);

      const rawResume = yield* engine.resume(paused.execution.id, { action: "accept" });
      expect(rawResume?.status).toBe("paused");
      expect(ledger.writes).toEqual([]);
      const granted = yield* engine.grantLiveApproval(paused.execution.id, { action: "accept" });
      expect(granted).not.toBeNull();
      if (!granted) return;
      const resumed = yield* engine.resume(paused.execution.id, granted);
      expect(resumed?.status).toBe("completed");
      expect(ledger.writes).toHaveLength(1);
      expect(JSON.stringify(resumed)).not.toContain(MARKER);
    }),
  );

  it.effect("settles duplicate concurrent live-grant resumes exactly once", () =>
    Effect.gen(function* () {
      const { executor, engine, ledger } = yield* makeHarness();
      yield* executor.policies.create({ owner: "org", pattern: "opaque.write", action: "approve" });

      const paused = yield* engine.executeWithPause(handoffCode);
      expect(paused.status).toBe("paused");
      if (paused.status !== "paused") return;

      const grants = yield* Effect.all(
        [
          engine.grantLiveApproval(paused.execution.id, { action: "accept" }),
          engine.grantLiveApproval(paused.execution.id, { action: "accept" }),
        ],
        { concurrency: "unbounded" },
      );
      const [firstGrant, secondGrant] = grants;
      expect(firstGrant).not.toBeNull();
      expect(secondGrant).not.toBeNull();
      if (!firstGrant || !secondGrant) return;

      const outcomes = yield* Effect.all(
        [
          engine.resume(paused.execution.id, firstGrant),
          engine.resume(paused.execution.id, secondGrant),
        ],
        { concurrency: "unbounded" },
      );
      expect(outcomes.map((outcome) => outcome?.status)).toEqual(["completed", "completed"]);
      expect(ledger.writes, "all duplicate live grants share one terminal execution").toHaveLength(
        1,
      );
      expect(JSON.stringify(outcomes)).not.toContain(MARKER);
    }),
  );

  it.effect("rejects an arbitrary inline elicitation accept for an opaque sink", () =>
    Effect.gen(function* () {
      const { executor, engine, ledger } = yield* makeHarness();
      yield* executor.policies.create({ owner: "org", pattern: "opaque.write", action: "approve" });

      const result = yield* engine.execute(handoffCode, {
        onElicitation: () => Effect.succeed({ action: "accept" as const }),
      });

      expect(result.error).toContain("requires approval but the request was declined");
      expect(ledger.writes, "an in-process callback is not a live approval grant").toEqual([]);
    }),
  );

  it.effect("consumes a capability once across sequential and concurrent sink attempts", () =>
    Effect.gen(function* () {
      const { executor, engine, ledger } = yield* makeHarness();
      yield* executor.policies.create({ owner: "org", pattern: "opaque.write", action: "approve" });

      const sequential = yield* engine.executeWithPause(`
        const source = await tools.opaque.read({});
        const ref = source.data.envs[0].value;
        const first = await tools.opaque.write({ body: { value: ref } });
        const second = await tools.opaque.write({ body: { value: ref } });
        return { first, second };
      `);
      expect(sequential.status).toBe("paused");
      if (sequential.status !== "paused") return;
      const sequentialGrant = yield* engine.grantLiveApproval(sequential.execution.id, {
        action: "accept",
      });
      expect(sequentialGrant).not.toBeNull();
      if (!sequentialGrant) return;
      const sequentialResult = yield* engine.resume(sequential.execution.id, sequentialGrant);
      expect(sequentialResult?.status).toBe("completed");
      expect(ledger.writes).toHaveLength(1);
      expect(JSON.stringify(sequentialResult)).not.toContain(MARKER);

      const concurrent = yield* engine.executeWithPause(`
        const source = await tools.opaque.read({});
        const ref = source.data.envs[0].value;
        return await Promise.all([
          tools.opaque.write({ body: { value: ref } }),
          tools.opaque.write({ body: { value: ref } }),
        ]);
      `);
      expect(concurrent.status).toBe("paused");
      if (concurrent.status !== "paused") return;
      const concurrentGrant = yield* engine.grantLiveApproval(concurrent.execution.id, {
        action: "accept",
      });
      expect(concurrentGrant).not.toBeNull();
      if (!concurrentGrant) return;
      const firstResume = yield* engine.resume(concurrent.execution.id, concurrentGrant);
      // Depending on the sandbox scheduler, the second invocation either
      // reaches a queued approval before consumption or sees the consumed
      // handle immediately. Neither path may issue a second target write.
      const nextPauseId = firstResume?.status === "paused" ? firstResume.execution.id : null;
      const finalConcurrentResult = nextPauseId
        ? yield* Effect.gen(function* () {
            const secondGrant = yield* engine.grantLiveApproval(nextPauseId, { action: "accept" });
            if (!secondGrant) return null;
            return yield* engine.resume(nextPauseId, secondGrant);
          })
        : firstResume;
      expect(finalConcurrentResult).not.toBeNull();
      expect(JSON.stringify(finalConcurrentResult)).not.toContain(MARKER);
      expect(ledger.writes).toHaveLength(2);
    }),
  );

  it.effect("never puts ordinary approval arguments in a public pause", () =>
    Effect.gen(function* () {
      const { engine, ledger } = yield* makeHarness();
      const paused = yield* engine.executeWithPause(
        `return await tools.opaque.review({ comment: ${JSON.stringify(DIRECT_ARGUMENT_MARKER)} });`,
      );
      expect(paused.status).toBe("paused");
      if (paused.status !== "paused") return;

      const formatted = formatPausedExecution(paused.execution);
      expect(JSON.stringify(formatted)).not.toContain(DIRECT_ARGUMENT_MARKER);
      expect(Object.hasOwn(paused.execution.elicitationContext, "args")).toBe(false);

      const resumed = yield* engine.resume(paused.execution.id, { action: "accept" });
      expect(resumed?.status).toBe("completed");
      expect(ledger.reviews).toEqual([{ comment: DIRECT_ARGUMENT_MARKER }]);
    }),
  );

  it.effect("rejects a capability returned by another execution", () =>
    Effect.gen(function* () {
      const { executor, engine: sourceEngine, ledger } = yield* makeHarness();
      const source = yield* sourceEngine.executeWithPause(
        "const value = await tools.opaque.read({}); return value.data.envs[0].value;",
      );
      expect(source.status).toBe("completed");
      if (source.status !== "completed") return;
      const reference = source.result.result;
      expect(
        isOpaqueValueReference(reference),
        "the first sandbox only receives a capability",
      ).toBe(true);
      if (!isOpaqueValueReference(reference)) return;

      const restartedEngine = createExecutionEngine({
        executor,
        codeExecutor: makeQuickJsExecutor(),
      });
      const foreign = yield* restartedEngine.executeWithPause(
        `return await tools.opaque.write({ body: { value: ${JSON.stringify(reference)} } });`,
      );
      expect(foreign.status).toBe("completed");
      if (foreign.status !== "completed") return;

      expect(ledger.writes, "a post-restart execution cannot resolve the old capability").toEqual(
        [],
      );
      expect(JSON.stringify(foreign.result)).not.toContain(MARKER);
      expect(foreign.result.error, "the sandbox receives only an opaque failure").toContain(
        "Internal tool error",
      );
    }),
  );

  it.effect("rejects a stale live approval grant after an engine restart", () =>
    Effect.gen(function* () {
      const { executor, engine: originalEngine, ledger } = yield* makeHarness();
      yield* executor.policies.create({ owner: "org", pattern: "opaque.write", action: "approve" });

      const original = yield* originalEngine.executeWithPause(handoffCode);
      expect(original.status).toBe("paused");
      if (original.status !== "paused") return;
      const staleGrant = yield* originalEngine.grantLiveApproval(original.execution.id, {
        action: "accept",
      });
      expect(staleGrant).not.toBeNull();
      if (!staleGrant) return;

      // Settle the pre-restart fiber, then retain its process-local grant as a
      // hostile stale object. A real restart cannot serialize this WeakMap
      // membership at all; this is the stronger in-memory proof.
      yield* originalEngine.resume(original.execution.id, { action: "decline" });

      const restartedEngine = createExecutionEngine({
        executor,
        codeExecutor: makeQuickJsExecutor(),
      });
      const fresh = yield* restartedEngine.executeWithPause(handoffCode);
      expect(fresh.status).toBe("paused");
      if (fresh.status !== "paused") return;
      expect(fresh.execution.id).not.toBe(original.execution.id);

      const staleResume = yield* restartedEngine.resume(fresh.execution.id, staleGrant);
      expect(staleResume?.status).toBe("paused");
      expect(ledger.writes, "a stale grant never releases the new execution").toEqual([]);

      const freshGrant = yield* restartedEngine.grantLiveApproval(fresh.execution.id, {
        action: "accept",
      });
      expect(freshGrant).not.toBeNull();
      if (!freshGrant) return;
      const resumed = yield* restartedEngine.resume(fresh.execution.id, freshGrant);
      expect(resumed?.status).toBe("completed");
      expect(ledger.writes).toHaveLength(1);
      expect(JSON.stringify(resumed)).not.toContain(MARKER);
    }),
  );

  it.effect("keeps inline approvals metadata-only too", () =>
    Effect.gen(function* () {
      const { engine } = yield* makeHarness();
      const seen: unknown[] = [];
      const result = yield* engine.execute(
        `return await tools.opaque.review({ comment: ${JSON.stringify(DIRECT_ARGUMENT_MARKER)} });`,
        {
          onElicitation: (context) => {
            seen.push(context);
            return Effect.succeed(ElicitationResponse.make({ action: "accept" }));
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(JSON.stringify(seen)).not.toContain(DIRECT_ARGUMENT_MARKER);
      expect(Object.hasOwn(seen[0] as object, "args")).toBe(false);
    }),
  );
});
