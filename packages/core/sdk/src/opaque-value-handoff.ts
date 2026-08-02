import { Predicate } from "effect";

// ---------------------------------------------------------------------------
// Opaque sensitive values — per-execution, in-memory capabilities.
//
// A sandbox may carry JSON-safe references, never their underlying values. The
// executor resolves a reference only in a declared sensitive input position
// after a live human acceptance. A handle is single-use: after acceptance it
// is consumed before any real value is returned and is never restored, even if
// the downstream sink fails. A retry must reread the source for a new handle.
// ---------------------------------------------------------------------------

export const OPAQUE_VALUE_TAG = "ExecutorOpaqueValue" as const;
export const OPAQUE_VALUE_TTL_MS = 15 * 60 * 1000;

export type OpaqueValueReference = {
  readonly _tag: typeof OPAQUE_VALUE_TAG;
  readonly id: string;
};

const REDACTED = "[redacted]";
const MAX_REDACTION_DEPTH = 40;

/** A deliberately value-free failure. It is safe to surface to a sandbox. */
export class OpaqueValueHandoffError extends Error {
  readonly _tag = "OpaqueValueHandoffError";

  constructor(message: string) {
    super(message);
    this.name = "OpaqueValueHandoffError";
  }
}

/** Internal-only provenance supplied by the scoped executor. It never crosses
 * a public approval, browser, MCP, or sandbox boundary. A tool address is
 * deliberately split into authority-bearing parts: a capability must not
 * become valid merely because another address happens to stringify similarly.
 */
export type OpaqueValueCallContext = {
  readonly principal: string;
  readonly integration: string;
  readonly connection: string;
  readonly operation: string;
};

export type OpaqueValueHandoffOptions = {
  /** Random id for one sandbox execution. Defaults only for direct unit use. */
  readonly executionId?: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
};

type OpaqueOperationScope = {
  readonly integration: string;
  readonly connection: string;
  readonly operation: string;
};

type OpaqueSource = OpaqueOperationScope & {
  readonly path: string;
};

type OpaqueSink = OpaqueOperationScope & {
  readonly path: string;
};

type OpaqueEntry = {
  readonly value: unknown;
  /** Never derived by resolving the value at the sink. It is made while the
   * source response is being sealed, solely for side-effect-free validation. */
  readonly validationValue: unknown;
  readonly executionId: string;
  readonly principal: string;
  readonly source: OpaqueSource;
  readonly expiresAt: number;
};

/**
 * The pre-approval validation pass fixes the exact sink a handle is about to
 * enter.  Resolution rejects a different tool or JSON Pointer even if that
 * other location is also marked sensitive.  This is deliberately in-memory:
 * it is authority for one live pause, not durable replay state.
 */
type OpaquePreparedBinding = {
  readonly executionId: string;
  readonly principal: string;
  readonly source: OpaqueSource;
  readonly sink: OpaqueSink;
};

type KeySegment = { readonly _tag: "key"; readonly value: string };
type WildcardSegment = { readonly _tag: "wildcard" };
type PathSegment = KeySegment | WildcardSegment;

const WILDCARD: WildcardSegment = { _tag: "wildcard" };

const isWildcard = (segment: PathSegment | undefined): segment is WildcardSegment =>
  Predicate.isTagged("wildcard")(segment);

type ReplacedInput = {
  readonly value: unknown;
  readonly containsOpaqueValue: boolean;
};

/** Internal execution-scoped contract threaded through `InvokeOptions`. */
export interface OpaqueValueHandoff {
  /** Whether this execution has ever sealed a value and must not be made durable. */
  readonly hasOpaqueValues: () => boolean;
  /** Replace declared sensitive output leaves with opaque capability objects. */
  readonly protectOutput: (
    value: unknown,
    paths: readonly string[] | undefined,
    context?: OpaqueValueCallContext,
  ) => unknown;
  /**
   * Replace permitted opaque input values with type-compatible, non-secret
   * placeholders for pre-approval validation. Reject references anywhere else.
   */
  readonly prepareInputForValidation: (
    value: unknown,
    paths: readonly string[] | undefined,
    context?: OpaqueValueCallContext,
  ) => ReplacedInput;
  /** Resolve permitted opaque input references only after the approval gate.
   * This consumes all handles synchronously before returning any true value. */
  readonly resolveInputAfterApproval: (
    value: unknown,
    paths: readonly string[] | undefined,
    context?: OpaqueValueCallContext,
  ) => unknown;
  /** Remove any sealed value from a result, error, log, or trace-safe object. */
  readonly redact: (value: unknown) => unknown;
  readonly redactText: (value: string) => string;
  /** Permanently discard raw capabilities and every redaction needle held for
   * this execution. Idempotent so both a TTL and fiber settlement can race
   * safely. Once disposed, new sensitive sources fail closed. */
  readonly dispose: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isOpaqueValueReference = (value: unknown): value is OpaqueValueReference => {
  if (!isRecord(value) || !Predicate.isTagged(OPAQUE_VALUE_TAG)(value)) return false;
  return typeof (value as Record<string, unknown>).id === "string";
};

/**
 * `*` remains the established wildcard syntax. A literal JSON property named
 * `*` is encoded as `~2`; `~0` and `~1` retain their RFC 6901 meanings. This
 * is intentionally an extension because RFC 6901 itself has no wildcard.
 */
const decodePointer = (path: string): PathSegment[] => {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous metadata parser rejects invalid plugin annotations before a tool invocation begins
    throw new OpaqueValueHandoffError("Sensitive value metadata contains an invalid JSON Pointer.");
  }
  return path
    .slice(1)
    .split("/")
    .map((part): PathSegment => {
      if (part === "*") return WILDCARD;
      let out = "";
      for (let index = 0; index < part.length; index += 1) {
        const char = part[index]!;
        if (char !== "~") {
          out += char;
          continue;
        }
        const escaped = part[index + 1];
        if (escaped === "0") {
          out += "~";
          index += 1;
          continue;
        }
        if (escaped === "1") {
          out += "/";
          index += 1;
          continue;
        }
        if (escaped === "2") {
          out += "*";
          index += 1;
          continue;
        }
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous metadata parser rejects invalid plugin annotations before a tool invocation begins
        throw new OpaqueValueHandoffError(
          "Sensitive value metadata contains an invalid JSON Pointer.",
        );
      }
      return { _tag: "key", value: out };
    });
};

const decodePointers = (paths: readonly string[] | undefined): readonly PathSegment[][] =>
  (paths ?? []).map(decodePointer);

const encodePointer = (segments: readonly string[]): string =>
  segments.length === 0
    ? ""
    : `/${segments
        .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1").replaceAll("*", "~2"))
        .join("/")}`;

const matchesPath = (path: readonly string[], pattern: readonly PathSegment[]): boolean =>
  path.length === pattern.length &&
  path.every((segment, index) => isWildcard(pattern[index]) || pattern[index]?.value === segment);

const matchingSuffixes = (
  patterns: readonly PathSegment[][],
  segment: string,
): readonly PathSegment[][] =>
  patterns
    .filter((pattern) => isWildcard(pattern[0]) || pattern[0]?.value === segment)
    .map((pattern) => pattern.slice(1));

const validationValueFor = (value: unknown, seen = new WeakMap<object, unknown>()): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Retain broad type/length constraints without retaining any character.
    return "x".repeat(Math.max(1, Math.min(value.length, 256)));
  }
  if (typeof value === "number") return Number.isInteger(value) ? 1 : 1.5;
  if (typeof value === "boolean") return false;
  if (typeof value === "bigint") return 1n;
  if (typeof value === "symbol" || typeof value === "function") return undefined;
  if (Array.isArray(value)) {
    const known = seen.get(value);
    if (known !== undefined) return known;
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(validationValueFor(item, seen));
    return out;
  }
  if (!isRecord(value)) return undefined;
  const known = seen.get(value);
  if (known !== undefined) return known;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = validationValueFor(item, seen);
  return out;
};

const stringsIn = (
  value: unknown,
  out = new Set<string>(),
  seen = new WeakSet<object>(),
): Set<string> => {
  if (
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint") &&
    String(value).length > 0
  ) {
    out.add(String(value));
  }
  if (typeof value !== "object" || value === null) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, out, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 0) out.add(key);
      stringsIn(item, out, seen);
    }
  }
  return out;
};

const cloneAndReplaceOutput = (
  value: unknown,
  patterns: readonly PathSegment[][],
  seal: (value: unknown, path: readonly string[]) => OpaqueValueReference,
  path: readonly string[] = [],
): unknown => {
  if (patterns.some((pattern) => pattern.length === 0)) return seal(value, path);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, index) => {
      const next = cloneAndReplaceOutput(item, matchingSuffixes(patterns, String(index)), seal, [
        ...path,
        String(index),
      ]);
      changed ||= next !== item;
      return next;
    });
    return changed ? out : value;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = cloneAndReplaceOutput(item, matchingSuffixes(patterns, key), seal, [...path, key]);
    changed ||= next !== item;
    out[key] = next;
  }
  return changed ? out : value;
};

type OpaqueOccurrence = {
  readonly id: string;
  readonly path: readonly string[];
  readonly entry: OpaqueEntry;
};

const defaultContext: OpaqueValueCallContext = {
  principal: "opaque-direct-unit-principal",
  integration: "opaque-direct-unit-integration",
  connection: "opaque-direct-unit-connection",
  operation: "opaque-direct-unit-operation",
};

const scopeFor = (context: OpaqueValueCallContext): OpaqueOperationScope => ({
  integration: context.integration,
  connection: context.connection,
  operation: context.operation,
});

const sameScope = (left: OpaqueOperationScope, right: OpaqueOperationScope): boolean =>
  left.integration === right.integration &&
  left.connection === right.connection &&
  left.operation === right.operation;

/** Validate every capability before resolving any true value. */
const inspectOpaqueInputs = (
  value: unknown,
  patterns: readonly PathSegment[][],
  entries: Map<string, OpaqueEntry>,
  context: OpaqueValueCallContext,
  executionId: string,
  now: () => number,
): { readonly occurrences: readonly OpaqueOccurrence[]; readonly containsOpaqueValue: boolean } => {
  let containsOpaqueValue = false;
  const occurrences: OpaqueOccurrence[] = [];
  const seenIds = new Set<string>();

  const visit = (current: unknown, path: readonly string[], depth: number): void => {
    if (depth > MAX_REDACTION_DEPTH) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability walker rejects unbounded caller shapes before plugin invocation
      throw new OpaqueValueHandoffError("Sensitive value input is too deeply nested.");
    }
    if (isOpaqueValueReference(current)) {
      if (!patterns.some((pattern) => matchesPath(path, pattern))) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability lookup rejects a handle outside its declared sink path
        throw new OpaqueValueHandoffError(
          "An opaque sensitive value may only be used in this operation's declared sensitive field.",
        );
      }
      const entry = entries.get(current.id);
      if (!entry) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability lookup rejects forged, consumed, or foreign handles
        throw new OpaqueValueHandoffError(
          "This opaque sensitive value is no longer available in the current execution.",
        );
      }
      if (entry.executionId !== executionId || entry.principal !== context.principal) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a capability issued for another scoped execution/principal must never resolve here
        throw new OpaqueValueHandoffError(
          "This opaque sensitive value is not available to this execution.",
        );
      }
      if (entry.expiresAt <= now()) {
        entries.delete(current.id);
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: expiry rejects before the source value is read
        throw new OpaqueValueHandoffError("This opaque sensitive value has expired.");
      }
      if (seenIds.has(current.id)) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: one capability represents exactly one sink leaf
        throw new OpaqueValueHandoffError(
          "An opaque sensitive value may only be used once; read the source again for a new value.",
        );
      }
      seenIds.add(current.id);
      containsOpaqueValue = true;
      occurrences.push({ id: current.id, path, entry });
      return;
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        visit(current[index], [...path, String(index)], depth + 1);
      }
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, item] of Object.entries(current)) visit(item, [...path, key], depth + 1);
  };

  visit(value, [], 0);
  return { occurrences, containsOpaqueValue };
};

const replaceOpaqueInputs = (
  value: unknown,
  replacements: ReadonlyMap<string, unknown>,
): unknown => {
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_REDACTION_DEPTH) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability walker rejects unbounded caller shapes before plugin invocation
      throw new OpaqueValueHandoffError("Sensitive value input is too deeply nested.");
    }
    if (isOpaqueValueReference(current)) return replacements.get(current.id) ?? current;
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    if (!isRecord(current)) return current;
    return Object.fromEntries(
      Object.entries(current).map(([key, item]) => [key, visit(item, depth + 1)]),
    );
  };
  return visit(value, 0);
};

const redactionFormsFor = (value: string): readonly string[] => {
  const forms = new Set<string>([value]);
  const json = JSON.stringify(value);
  if (typeof json === "string") {
    forms.add(json);
    forms.add(json.slice(1, -1));
  }
  // `encodeURIComponent` is a common upstream echo form for query/path
  // values. It can throw on malformed UTF-16, which simply leaves the raw
  // form in place; a malformed string is still covered by the direct needle.
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URI encoding rejects malformed surrogate input.
  try {
    const uriEncoded = encodeURIComponent(value);
    forms.add(uriEncoded);
    // Several form/body clients approximate application/x-www-form-urlencoded
    // by replacing encoded spaces with `+`. Unlike URLSearchParams below, that
    // leaves characters such as `~` untouched, so it is a distinct echo form
    // and must be retained independently.
    forms.add(uriEncoded.replaceAll("%20", "+"));
  } catch {
    // no encoded form for malformed UTF-16
  }
  // HTML form encoding is not identical to encodeURIComponent: most notably,
  // spaces become `+` (and characters such as `~` use a different escape
  // set). Upstream services routinely echo request-body fields, URLs, and
  // errors in this representation, so retain the exact scalar encoding as a
  // redaction needle as well. The fixed key is discarded and never contains
  // caller material.
  forms.add(new URLSearchParams([["value", value]]).toString().slice("value=".length));
  return [...forms].filter((form) => form.length > 0);
};

const replaceText = (value: string, needles: readonly string[]): string => {
  let out = value;
  for (const needle of [...needles].sort((left, right) => right.length - left.length)) {
    if (needle.length > 0) out = out.replaceAll(needle, REDACTED);
  }
  return out;
};

const structurallyEquals = (
  left: unknown,
  right: unknown,
  depth = 0,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean => {
  if (Object.is(left, right)) return true;
  if (depth > MAX_REDACTION_DEPTH || typeof left !== "object" || left === null) return false;
  if (typeof right !== "object" || right === null) return false;
  const leftSeen = seen.get(left);
  if (leftSeen?.has(right)) return true;
  const nextSeen = leftSeen ?? new WeakSet<object>();
  nextSeen.add(right);
  seen.set(left, nextSeen);
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEquals(value, right[index], depth + 1, seen))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        structurallyEquals(leftRecord[key], rightRecord[key], depth + 1, seen),
    )
  );
};

export const makeOpaqueValueHandoff = (
  options: OpaqueValueHandoffOptions = {},
): OpaqueValueHandoff => {
  const entries = new Map<string, OpaqueEntry>();
  const preparedBindings = new Map<string, OpaquePreparedBinding>();
  const executionId = options.executionId ?? `opaque_${crypto.randomUUID()}`;
  const requestedTtlMs = options.ttlMs ?? OPAQUE_VALUE_TTL_MS;
  // Invalid caller-supplied TTLs must expire synchronously as well as schedule
  // an immediate cleanup; otherwise NaN/Infinity could leave a short window in
  // which the entry's expiry comparison never succeeds.
  const ttlMs = Number.isFinite(requestedTtlMs) && requestedTtlMs >= 0 ? requestedTtlMs : 0;
  const now = options.now ?? Date.now;
  // Keep redaction material after an accepted sink consumes its capability.
  // It is never consulted for resolution, so a failure cannot restore a handle.
  const redactionNeedles = new Set<string>();
  const redactionValues: unknown[] = [];
  let hasSealedValues = false;
  let disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (expiryTimer !== undefined) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    entries.clear();
    preparedBindings.clear();
    redactionNeedles.clear();
    redactionValues.length = 0;
  };

  const scheduleDisposal = (): void => {
    if (disposed || expiryTimer !== undefined) return;
    const timer = setTimeout(() => {
      expiryTimer = undefined;
      dispose();
    }, ttlMs);
    // Unit handoffs and short-lived executions should not keep a Node process
    // alive merely because their fail-closed cleanup alarm has not fired yet.
    (timer as typeof timer & { readonly unref?: () => void }).unref?.();
    expiryTimer = timer;
  };

  const assertAvailable = (): void => {
    if (disposed) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a disposed process-local capability must fail before any raw source value crosses the sandbox boundary
      throw new OpaqueValueHandoffError(
        "This opaque sensitive value is no longer available in the current execution.",
      );
    }
  };

  const redactText = (value: string): string => replaceText(value, [...redactionNeedles]);

  const redact = (value: unknown, depth = 0, seen = new WeakMap<object, unknown>()): unknown => {
    if (depth > MAX_REDACTION_DEPTH) return REDACTED;
    if (redactionValues.some((sensitiveValue) => structurallyEquals(value, sensitiveValue))) {
      return REDACTED;
    }
    if (typeof value === "string") return redactText(value);
    if (typeof value !== "object" || value === null || isOpaqueValueReference(value)) return value;
    const known = seen.get(value);
    if (known !== undefined) return known;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(redact(item, depth + 1, seen));
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) {
      const safeKey = redactText(key);
      out[safeKey] = key === "stack" ? REDACTED : redact(item, depth + 1, seen);
    }
    return out;
  };

  return {
    hasOpaqueValues: () => hasSealedValues,
    protectOutput: (value, paths, context = defaultContext) => {
      const patterns = decodePointers(paths);
      if (patterns.length === 0) return redact(value);
      assertAvailable();
      const sealed = cloneAndReplaceOutput(value, patterns, (sensitiveValue, path) => {
        const id = crypto.randomUUID();
        const needles = [...stringsIn(sensitiveValue)];
        redactionValues.push(sensitiveValue);
        for (const needle of needles) {
          for (const form of redactionFormsFor(needle)) redactionNeedles.add(form);
        }
        entries.set(id, {
          value: sensitiveValue,
          validationValue: validationValueFor(sensitiveValue),
          executionId,
          principal: context.principal,
          source: { ...scopeFor(context), path: encodePointer(path) },
          expiresAt: now() + ttlMs,
        });
        hasSealedValues = true;
        scheduleDisposal();
        return { _tag: OPAQUE_VALUE_TAG, id };
      });
      return redact(sealed);
    },
    prepareInputForValidation: (value, paths, context = defaultContext) => {
      const inspected = inspectOpaqueInputs(
        value,
        decodePointers(paths),
        entries,
        context,
        executionId,
        now,
      );
      // Bind only after every referenced handle passed validation. A malformed
      // multi-handle input cannot leave a partial sink reservation behind.
      const nextBindings = inspected.occurrences.map((occurrence) => ({
        occurrence,
        binding: {
          executionId: occurrence.entry.executionId,
          principal: occurrence.entry.principal,
          source: occurrence.entry.source,
          sink: { ...scopeFor(context), path: encodePointer(occurrence.path) },
        } satisfies OpaquePreparedBinding,
      }));
      for (const { occurrence, binding } of nextBindings) {
        const existing = preparedBindings.get(occurrence.id);
        if (
          existing &&
          (existing.executionId !== binding.executionId ||
            existing.principal !== binding.principal ||
            !sameScope(existing.source, binding.source) ||
            existing.source.path !== binding.source.path ||
            !sameScope(existing.sink, binding.sink) ||
            existing.sink.path !== binding.sink.path)
        ) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: a live capability cannot silently change its approved destination
          throw new OpaqueValueHandoffError(
            "This opaque sensitive value is already bound to a different approved destination.",
          );
        }
      }
      for (const { occurrence, binding } of nextBindings) {
        preparedBindings.set(occurrence.id, binding);
      }
      return {
        value: replaceOpaqueInputs(
          value,
          new Map(
            inspected.occurrences.map((occurrence) => [
              occurrence.id,
              occurrence.entry.validationValue,
            ]),
          ),
        ),
        containsOpaqueValue: inspected.containsOpaqueValue,
      };
    },
    resolveInputAfterApproval: (value, paths, context = defaultContext) => {
      const inspected = inspectOpaqueInputs(
        value,
        decodePointers(paths),
        entries,
        context,
        executionId,
        now,
      );
      // Validate every pre-approved source/sink binding before consuming any
      // capability. This prevents an altered request from moving a source
      // value to a second sensitive field after the human has approved it.
      for (const occurrence of inspected.occurrences) {
        const binding = preparedBindings.get(occurrence.id);
        const sink = { ...scopeFor(context), path: encodePointer(occurrence.path) };
        if (
          !binding ||
          binding.executionId !== occurrence.entry.executionId ||
          binding.principal !== occurrence.entry.principal ||
          !sameScope(binding.source, occurrence.entry.source) ||
          binding.source.path !== occurrence.entry.source.path ||
          !sameScope(binding.sink, sink) ||
          binding.sink.path !== sink.path
        ) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: resolve requires the exact source/sink binding established before human approval
          throw new OpaqueValueHandoffError(
            "This opaque sensitive value is not bound to this approved destination.",
          );
        }
      }
      // One synchronous state transition: consume every valid capability before
      // a real value is returned. Concurrent callers and sequential reuse find
      // no entry, and a downstream sink error never reintroduces one.
      for (const occurrence of inspected.occurrences) {
        entries.delete(occurrence.id);
        preparedBindings.delete(occurrence.id);
      }
      return replaceOpaqueInputs(
        value,
        new Map(inspected.occurrences.map((occurrence) => [occurrence.id, occurrence.entry.value])),
      );
    },
    redact,
    redactText,
    dispose,
  };
};
