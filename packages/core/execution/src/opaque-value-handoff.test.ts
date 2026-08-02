import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  ElicitationResponse,
  isOpaqueValueReference,
  ToolResult,
  createExecutor,
  definePlugin,
  tool,
} from "@executor-js/sdk";
import { makeTestConfig } from "@executor-js/sdk/testing";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

import { createExecutionEngine, formatPausedExecution } from "./engine";

const MARKER = "opaque-execution-regression-marker";
const DIRECT_ARGUMENT_MARKER = "approval-argument-regression-marker";

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
              Effect.succeed(ToolResult.ok({ envs: [{ key: "SOURCE_VALUE", value: MARKER }] })),
          }),
          tool({
            name: "write",
            description: "Write an environment value",
            annotations: { sensitiveInputPaths: ["/body/value"] },
            execute: (args) =>
              Effect.sync(() => {
                ledger.writes.push(args);
                return {
                  echoed: (args as { readonly body?: { readonly value?: unknown } }).body?.value,
                };
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
        // This rule normally bypasses a write approval. An opaque input must
        // still stop for a live human decision.
        yield* executor.policies.create({
          owner: "org",
          pattern: "opaque.write",
          action: "approve",
        });

        const paused = yield* engine.executeWithPause(handoffCode);
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

        const resumed = yield* engine.resume(paused.execution.id, { action: "accept" });
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
        expect(JSON.stringify(resumed.result.result)).toContain("ExecutorOpaqueValue");
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
