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

        const rawResume = yield* engine.resume(paused.execution.id, { action: "accept" });
        expect(rawResume?.status, "raw model/API JSON cannot release the secret").toBe("paused");
        expect(ledger.writes, "a rejected raw accept does not invoke the sink").toEqual([]);

        const granted = yield* engine.grantLiveApproval(paused.execution.id, { action: "accept" });
        expect(granted, "an authenticated browser/native endpoint mints the grant").not.toBeNull();
        if (!granted) return;
        const resumed = yield* engine.resume(paused.execution.id, granted);
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
