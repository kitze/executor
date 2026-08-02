import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { Schema } from "effect";

import { ExecutorApi } from "../api";
import {
  formatExecuteResult,
  formatPausedExecution,
  type ResumeResponse,
} from "@executor-js/execution";
import { resolveArtifactAction } from "@executor-js/host-mcp/artifact-action";
import { TOOL_CALL_CONTRACT_MESSAGE } from "@executor-js/host-mcp/tool-call-code";
import { ExecutionEngineService, ExecutorService } from "../services";
import { capture, captureEngineError } from "@executor-js/api";
import { RequestLiveApprovalProvenance } from "../server/identity";

class ExecutionNotFoundError extends Schema.TaggedErrorClass<ExecutionNotFoundError>()(
  "ExecutionNotFoundError",
  {
    executionId: Schema.String,
  },
) {}

/**
 * An artifact-originated execution that could not be resolved into a call.
 *
 * Carries the same vocabulary the MCP host's `execute-action` returns
 * (`invalid_action_code`, `artifact_unavailable`, `binding_unresolved`) so the
 * shell sees one contract whichever transport it reached the server through,
 * and the binding UI that ships with sharing can key off `role`/`integration`.
 */
class ArtifactActionError extends Schema.TaggedErrorClass<ArtifactActionError>()(
  "ArtifactActionError",
  {
    error: Schema.Literals(["invalid_action_code", "artifact_unavailable", "binding_unresolved"]),
    reason: Schema.String,
    role: Schema.optional(Schema.String),
    integration: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * An approval that expired before the human answered.
 *
 * Distinct from `ExecutionNotFoundError` (an id that was never ours) so the
 * shell can tell the user their approval window closed and the action can simply
 * be triggered again — nothing ran. 410 Gone, because the resource existed and
 * deliberately no longer does.
 */
class ApprovalExpiredError extends Schema.TaggedErrorClass<ApprovalExpiredError>()(
  "ApprovalExpiredError",
  {
    executionId: Schema.String,
  },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return "This approval expired. Trigger the action again.";
  }
}

/** A bearer API key cannot stand in for the human/session authority required
 * to release an opaque value into a sensitive sink. */
class LiveApprovalForbiddenError extends Schema.TaggedErrorClass<LiveApprovalForbiddenError>()(
  "LiveApprovalForbiddenError",
  {
    executionId: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Accepting this action requires an authenticated browser or user session.";
  }
}

/**
 * Parse and bind one artifact-originated call, or fail with something the shell
 * can render inside the component that made it.
 *
 * The artifact is read through the request's own scoped executor, so an id that
 * isn't this caller's simply doesn't resolve.
 */
const resolveArtifactCode = (
  code: string,
  artifactId: string,
): Effect.Effect<string, ArtifactActionError, ExecutorService> =>
  Effect.gen(function* () {
    const executor = yield* ExecutorService;
    const resolution = yield* resolveArtifactAction({
      code,
      artifactId,
      loadArtifact: (id) =>
        executor.artifacts.get(id).pipe(Effect.catchCause(() => Effect.succeed(null))),
    });

    if (resolution.status === "ok") return resolution.code;
    if (resolution.status === "binding_unresolved") {
      return yield* new ArtifactActionError({
        error: "binding_unresolved",
        reason: resolution.message,
        role: resolution.role,
        integration: resolution.integration,
      });
    }
    return yield* new ArtifactActionError({
      error: resolution.status,
      reason:
        resolution.status === "artifact_unavailable"
          ? "This action refers to an artifact that isn't available on this account."
          : TOOL_CALL_CONTRACT_MESSAGE,
    });
  });

export const ExecutionsHandlers = HttpApiBuilder.group(ExecutorApi, "executions", (handlers) =>
  handlers
    .handle("getPaused", ({ params: path }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const paused = yield* captureEngineError(engine.getPausedExecution(path.executionId));

          if (!paused) {
            return yield* new ExecutionNotFoundError({ executionId: path.executionId });
          }

          return formatPausedExecution(paused);
        }),
      ),
    )
    .handle("execute", ({ payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          // An artifact-originated request is not arbitrary code. It is parsed
          // against the shell proxy's one grammar and rewritten through the
          // artifact's connection bindings, exactly as `execute-action` does in
          // the MCP host — the console's artifact page must not be a wider door
          // onto the same iframe.
          const code =
            payload.artifactId === undefined
              ? payload.code
              : yield* resolveArtifactCode(payload.code, payload.artifactId);
          const outcome = yield* captureEngineError(
            engine.executeWithPause(code, { autoApprove: payload.autoApprove }),
          );

          if (outcome.status === "completed") {
            const formatted = formatExecuteResult(outcome.result);
            return {
              status: "completed" as const,
              text: formatted.text,
              structured: formatted.structured,
              isError: formatted.isError,
            };
          }

          // A paused fiber is the only authority that can resume code. Do not
          // persist/replay code after a process hop: even an artifact's narrow
          // one-call source can evolve behind an approval boundary, and a later
          // replay with auto-approval could read then release a new secret. A
          // restarted caller must execute again and receive a fresh approval.

          const formatted = formatPausedExecution(outcome.execution);
          return {
            status: "paused" as const,
            text: formatted.text,
            structured: formatted.structured,
          };
        }),
      ),
    )
    .handle("resume", ({ params: path, payload }) =>
      capture(
        Effect.gen(function* () {
          const engine = yield* ExecutionEngineService;
          const paused = yield* engine.getPausedExecution(path.executionId);
          if (!paused) {
            return yield* new ApprovalExpiredError({ executionId: path.executionId });
          }

          const response = {
            action: payload.action,
            content: payload.content as Record<string, unknown> | undefined,
          };
          let responseToResume: ResumeResponse = response;

          if (payload.action === "accept" && paused.requiresLiveApproval === true) {
            const provenance = yield* RequestLiveApprovalProvenance;
            if (provenance !== "session") {
              return yield* new LiveApprovalForbiddenError({ executionId: path.executionId });
            }
            const granted = yield* engine.grantLiveApproval(path.executionId, response);
            if (!granted) {
              return yield* new ApprovalExpiredError({ executionId: path.executionId });
            }
            responseToResume = granted;
          }

          const result = yield* captureEngineError(
            engine.resume(path.executionId, responseToResume),
          );

          // No live pause means the process/human approval window changed. It
          // is intentionally non-replayable: start a fresh execution so every
          // step, including any later secret read, receives a fresh approval.
          if (!result) {
            return yield* new ApprovalExpiredError({ executionId: path.executionId });
          }

          if (result.status === "completed") {
            const formatted = formatExecuteResult(result.result);
            return {
              status: "completed" as const,
              text: formatted.text,
              structured: formatted.structured,
              isError: formatted.isError,
            };
          }

          const formatted = formatPausedExecution(result.execution);
          return {
            status: "paused" as const,
            text: formatted.text,
            structured: formatted.structured,
          };
        }),
      ),
    ),
);
