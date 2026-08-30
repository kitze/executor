import { Effect, Schema } from "effect";

import { ElicitationId, ToolAddress } from "./ids";
import type { OpaqueValueHandoff } from "./opaque-value-handoff";

/* A tool that needs user input mid-call suspends and the host's `onElicitation`
 * handler (executor-level, overridable per `execute`) answers. Tools that never
 * elicit never trigger it. Schema-tagged so requests/responses cross the wire. */

/** Implementation-defined context an upstream attached to the request.
 *
 *  Opaque and never interpreted here — it is carried so a host can SHOW the
 *  terms of an approval it would otherwise hide. The case that forced it: a
 *  Codex plugin's per-site browser approval sends an empty `requestedSchema`
 *  and puts `persist: "always"` and the `origin` in its metadata, so
 *  accepting grants a permanent allow for that site. Without this the user is
 *  asked to consent to strictly more than the prompt tells them. */
export const ElicitationMeta = Schema.Record(Schema.String, Schema.Unknown);
export type ElicitationMeta = typeof ElicitationMeta.Type;

/** Tool needs structured input from the user (render a form). */
export const FormElicitation = Schema.TaggedStruct("FormElicitation", {
  message: Schema.String,
  /** JSON Schema describing the fields to collect. */
  requestedSchema: Schema.Record(Schema.String, Schema.Unknown),
  meta: Schema.optional(ElicitationMeta),
});
export type FormElicitation = typeof FormElicitation.Type;

/** Tool needs the user to visit a URL (OAuth, approval page, etc.). */
export const UrlElicitation = Schema.TaggedStruct("UrlElicitation", {
  message: Schema.String,
  url: Schema.String,
  /** Unique id so the host can correlate the callback. */
  elicitationId: ElicitationId,
  meta: Schema.optional(ElicitationMeta),
});
export type UrlElicitation = typeof UrlElicitation.Type;

export type ElicitationRequest = FormElicitation | UrlElicitation;

export const ElicitationAction = Schema.Literals(["accept", "decline", "cancel"]);
export type ElicitationAction = typeof ElicitationAction.Type;

export const ElicitationResponse = Schema.Struct({
  action: ElicitationAction,
  /** Present when `action` is "accept" — the data the user provided. */
  content: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type ElicitationResponse = typeof ElicitationResponse.Type;

/**
 * Handler input deliberately contains metadata only. Invocation arguments stay
 * in the active tool fiber; public approval, browser, and native-MCP paths
 * must never receive caller values by default.
 */
export interface ElicitationContext {
  readonly address: ToolAddress;
  readonly request: ElicitationRequest;
  /** Metadata only: this gate consumes an opaque value and therefore cannot be
   * auto-accepted by a transport-level Run/Test shortcut. */
  readonly requiresLiveApproval?: boolean;
}

/** Host-provided handler the SDK calls when a tool suspends for input. */
export type ElicitationHandler = (ctx: ElicitationContext) => Effect.Effect<ElicitationResponse>;

/** Executor-level elicitation policy: a handler, or `"accept-all"` to
 *  auto-accept every request (tests / non-interactive hosts). */
export type OnElicitation = ElicitationHandler | "accept-all";

/** Per-call options for `execute`. */
export interface InvokeOptions {
  /** Override the executor-level handler for this single call. */
  readonly onElicitation?: OnElicitation;
  /** @internal Per-sandbox-execution sensitive-value capability store. */
  readonly opaqueValueHandoff?: OpaqueValueHandoff;
  /** @internal A declared sensitive tool input may reach a path/query/header,
   * request body, or server variable. Downstream transports must not emit raw
   * request telemetry for this invocation. */
  readonly disableSensitiveRequestTracing?: boolean;
}

/** A tool was declined or cancelled during elicitation. */
export class ElicitationDeclinedError extends Schema.TaggedErrorClass<ElicitationDeclinedError>()(
  "ElicitationDeclinedError",
  {
    address: ToolAddress,
    action: Schema.Literals(["decline", "cancel"]),
  },
) {
  // Derived message so telemetry (span status, logs) labels the failure
  // instead of rendering an Error with an empty message.
  override get message(): string {
    return `Tool approval ${this.action === "cancel" ? "cancelled" : "declined"}: ${this.address}`;
  }
}
