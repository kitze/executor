import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import type {
  ExecutionEngine,
  ExecutionResult,
  PausedExecution,
  ResumeResponse,
} from "@executor-js/execution";
import { FormElicitation, ToolAddress, type Executor } from "@executor-js/sdk";

import { ExecutorApi } from "../api";
import { CoreHandlers } from "../handlers";
import { observabilityMiddleware } from "../observability";
import { ExecutionEngineService, ExecutorService } from "../services";
import { RequestLiveApprovalProvenance } from "../server/identity";

const EXECUTION_ID = "exec_live_approval";

const pausedExecution = (requiresLiveApproval: boolean): PausedExecution => ({
  id: EXECUTION_ID,
  elicitationContext: {
    address: ToolAddress.make("tools.fixture.org.main.write"),
    request: FormElicitation.make({
      message: "Approve fixture write",
      requestedSchema: { type: "object", properties: {} },
    }),
  },
  ...(requiresLiveApproval ? { requiresLiveApproval: true } : {}),
});

const completed: ExecutionResult = {
  status: "completed",
  result: { result: { ok: true }, logs: [] },
};

const fakeEngine = (paused: PausedExecution) => {
  const grants: ResumeResponse[] = [];
  const grantedResponses: ResumeResponse[] = [];
  const resumes: ResumeResponse[] = [];
  const engine: ExecutionEngine = {
    execute: () => Effect.succeed({ result: null }),
    executeWithPause: () => Effect.succeed(completed),
    getPausedExecution: (executionId) => Effect.succeed(executionId === paused.id ? paused : null),
    grantLiveApproval: (executionId, response) =>
      Effect.sync(() => {
        grants.push(response);
        if (executionId !== paused.id) return null;
        const granted = { ...response };
        grantedResponses.push(granted);
        return granted;
      }),
    resume: (executionId, response) =>
      Effect.sync(() => {
        resumes.push(response);
        return executionId === paused.id ? completed : null;
      }),
    pausedExecutionCount: () => Effect.succeed(1),
    hasPausedExecutions: () => Effect.succeed(true),
    getDescription: Effect.succeed("fixture engine"),
  };
  return { engine, grants, grantedResponses, resumes };
};

const webHandlerFor = (engine: ExecutionEngine) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(ExecutorApi).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(observabilityMiddleware(ExecutorApi)),
          Layer.provide(Layer.succeed(ExecutorService)({} as Executor)),
          Layer.provide(Layer.succeed(ExecutionEngineService)(engine)),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const resumeRequest = (
  content?: Record<string, unknown>,
  action: ResumeResponse["action"] = "accept",
) =>
  new Request(`http://localhost/executions/${EXECUTION_ID}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...(content ? { content } : {}) }),
  });

const requestContext = (engine: ExecutionEngine, provenance?: "session" | "none") => {
  const base = Context.make(ExecutorService, {} as Executor).pipe(
    Context.add(ExecutionEngineService, engine),
  );
  return provenance === undefined
    ? base
    : base.pipe(Context.add(RequestLiveApprovalProvenance, provenance));
};

describe("generic execution resume live-approval provenance", () => {
  it.effect("rejects a default/API-key accept without minting a live grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = fakeEngine(pausedExecution(true));
        const web = yield* webHandlerFor(fixture.engine);

        const response = yield* Effect.promise(() =>
          web.handler(resumeRequest(), requestContext(fixture.engine)),
        );

        expect(response.status).toBe(403);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "LiveApprovalForbiddenError",
          executionId: EXECUTION_ID,
        });
        expect(fixture.grants).toEqual([]);
        expect(fixture.resumes).toEqual([]);
      }),
    ),
  );

  it.effect("lets session provenance mint and consume the live grant object", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = fakeEngine(pausedExecution(true));
        const web = yield* webHandlerFor(fixture.engine);

        const response = yield* Effect.promise(() =>
          web.handler(
            resumeRequest({ approvedBy: "human" }),
            requestContext(fixture.engine, "session"),
          ),
        );

        expect(response.status).toBe(200);
        expect(fixture.grants).toHaveLength(1);
        expect(fixture.grantedResponses).toHaveLength(1);
        expect(fixture.resumes).toHaveLength(1);
        expect(fixture.resumes[0]).toBe(fixture.grantedResponses[0]);
        expect(fixture.resumes[0]).not.toBe(fixture.grants[0]);
      }),
    ),
  );

  it.effect("keeps ordinary accepts valid without minting a live grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = fakeEngine(pausedExecution(false));
        const web = yield* webHandlerFor(fixture.engine);

        const response = yield* Effect.promise(() =>
          web.handler(resumeRequest({ confirmed: true }), requestContext(fixture.engine, "none")),
        );

        expect(response.status).toBe(200);
        expect(fixture.grants).toEqual([]);
        expect(fixture.resumes).toEqual([{ action: "accept", content: { confirmed: true } }]);
      }),
    ),
  );

  it.effect("lets an unprovenanced caller decline a live pause without minting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = fakeEngine(pausedExecution(true));
        const web = yield* webHandlerFor(fixture.engine);

        const response = yield* Effect.promise(() =>
          web.handler(resumeRequest(undefined, "decline"), requestContext(fixture.engine)),
        );

        expect(response.status).toBe(200);
        expect(fixture.grants).toEqual([]);
        expect(fixture.resumes).toEqual([{ action: "decline", content: undefined }]);
      }),
    ),
  );
});
