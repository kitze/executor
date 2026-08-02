import { Predicate } from "effect";

// ---------------------------------------------------------------------------
// Opaque sensitive values — per-execution, in-memory capabilities.
//
// A sandbox is allowed to carry these JSON-safe references, never their
// underlying values. The executor resolves a reference only in a declared
// sensitive input position after a human has accepted the operation.
// ---------------------------------------------------------------------------

export const OPAQUE_VALUE_TAG = "ExecutorOpaqueValue" as const;

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

type OpaqueEntry = {
  readonly value: unknown;
  /** Never derived by resolving the value at the sink. It is made while the
   * source response is being sealed, solely for side-effect-free validation. */
  readonly validationValue: unknown;
  readonly stringNeedles: readonly string[];
};

type PathSegment = string | "*";

type ReplacedInput = {
  readonly value: unknown;
  readonly containsOpaqueValue: boolean;
};

/** Internal execution-scoped contract threaded through `InvokeOptions`. */
export interface OpaqueValueHandoff {
  /** Whether this execution has sealed a value and must not be made durable. */
  readonly hasOpaqueValues: () => boolean;
  /** Replace declared sensitive output leaves with opaque capability objects. */
  readonly protectOutput: (value: unknown, paths: readonly string[] | undefined) => unknown;
  /**
   * Replace permitted opaque input values with type-compatible, non-secret
   * placeholders for pre-approval validation. Reject references anywhere else.
   */
  readonly prepareInputForValidation: (
    value: unknown,
    paths: readonly string[] | undefined,
  ) => ReplacedInput;
  /** Resolve permitted opaque input references. The executor calls this only
   * after its approval gate has accepted the call. */
  readonly resolveInputAfterApproval: (
    value: unknown,
    paths: readonly string[] | undefined,
  ) => unknown;
  /** Remove any sealed value from a result, error, log, or trace-safe object. */
  readonly redact: (value: unknown) => unknown;
  readonly redactText: (value: string) => string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isOpaqueValueReference = (value: unknown): value is OpaqueValueReference => {
  if (!isRecord(value) || !Predicate.isTagged(OPAQUE_VALUE_TAG)(value)) return false;
  return typeof (value as Record<string, unknown>).id === "string";
};

const decodePointer = (path: string): PathSegment[] => {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous metadata parser rejects invalid plugin annotations before a tool invocation begins
    throw new OpaqueValueHandoffError("Sensitive value metadata contains an invalid JSON Pointer.");
  }
  return path
    .slice(1)
    .split("/")
    .map((part) => {
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
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous metadata parser rejects invalid plugin annotations before a tool invocation begins
        throw new OpaqueValueHandoffError(
          "Sensitive value metadata contains an invalid JSON Pointer.",
        );
      }
      return out === "*" ? "*" : out;
    });
};

const decodePointers = (paths: readonly string[] | undefined): readonly PathSegment[][] =>
  (paths ?? []).map(decodePointer);

const matchesPath = (path: readonly string[], pattern: readonly PathSegment[]): boolean =>
  path.length === pattern.length &&
  path.every((segment, index) => pattern[index] === "*" || pattern[index] === segment);

const matchingSuffixes = (
  patterns: readonly PathSegment[][],
  segment: string,
): readonly PathSegment[][] =>
  patterns
    .filter((pattern) => pattern[0] === "*" || pattern[0] === segment)
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
  if (typeof value === "string" && value.length > 0) out.add(value);
  if (typeof value !== "object" || value === null) return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, out, seen);
  } else {
    for (const item of Object.values(value)) stringsIn(item, out, seen);
  }
  return out;
};

const cloneAndReplaceOutput = (
  value: unknown,
  patterns: readonly PathSegment[][],
  seal: (value: unknown) => OpaqueValueReference,
): unknown => {
  if (patterns.some((pattern) => pattern.length === 0)) return seal(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item, index) => {
      const next = cloneAndReplaceOutput(item, matchingSuffixes(patterns, String(index)), seal);
      changed ||= next !== item;
      return next;
    });
    return changed ? out : value;
  }
  if (!isRecord(value)) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = cloneAndReplaceOutput(item, matchingSuffixes(patterns, key), seal);
    changed ||= next !== item;
    out[key] = next;
  }
  return changed ? out : value;
};

const replaceOpaqueInputs = (
  value: unknown,
  patterns: readonly PathSegment[][],
  entries: ReadonlyMap<string, OpaqueEntry>,
  useActualValue: boolean,
): ReplacedInput => {
  let containsOpaqueValue = false;
  const visit = (current: unknown, path: readonly string[], depth: number): unknown => {
    if (depth > MAX_REDACTION_DEPTH) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability walker rejects unbounded caller shapes before plugin invocation
      throw new OpaqueValueHandoffError("Sensitive value input is too deeply nested.");
    }
    if (isOpaqueValueReference(current)) {
      if (!patterns.some((pattern) => matchesPath(path, pattern))) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability walker rejects a handle outside its declared sink path
        throw new OpaqueValueHandoffError(
          "An opaque sensitive value may only be used in this operation's declared sensitive field.",
        );
      }
      const entry = entries.get(current.id);
      if (!entry) {
        // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: synchronous capability lookup rejects forged or foreign execution handles
        throw new OpaqueValueHandoffError(
          "This opaque sensitive value is no longer available in the current execution.",
        );
      }
      containsOpaqueValue = true;
      return useActualValue ? entry.value : entry.validationValue;
    }
    if (Array.isArray(current))
      return current.map((item, index) => visit(item, [...path, String(index)], depth + 1));
    if (!isRecord(current)) return current;
    return Object.fromEntries(
      Object.entries(current).map(([key, item]) => [key, visit(item, [...path, key], depth + 1)]),
    );
  };
  return { value: visit(value, [], 0), containsOpaqueValue };
};

const replaceText = (value: string, needles: readonly string[]): string => {
  let out = value;
  for (const needle of needles) {
    if (needle.length > 0) out = out.replaceAll(needle, REDACTED);
  }
  return out;
};

export const makeOpaqueValueHandoff = (): OpaqueValueHandoff => {
  const entries = new Map<string, OpaqueEntry>();

  const redactText = (value: string): string => {
    const needles = [...entries.values()].flatMap((entry) => entry.stringNeedles);
    return replaceText(value, needles);
  };

  const redact = (value: unknown, depth = 0, seen = new WeakMap<object, unknown>()): unknown => {
    if (depth > MAX_REDACTION_DEPTH) return REDACTED;
    for (const entry of entries.values()) {
      if (Object.is(value, entry.value)) return REDACTED;
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
      out[key] = key === "stack" ? REDACTED : redact(item, depth + 1, seen);
    }
    return out;
  };

  return {
    hasOpaqueValues: () => entries.size > 0,
    protectOutput: (value, paths) => {
      const patterns = decodePointers(paths);
      if (patterns.length === 0) return redact(value);
      const sealed = cloneAndReplaceOutput(value, patterns, (sensitiveValue) => {
        const id = crypto.randomUUID();
        entries.set(id, {
          value: sensitiveValue,
          validationValue: validationValueFor(sensitiveValue),
          stringNeedles: [...stringsIn(sensitiveValue)],
        });
        return { _tag: OPAQUE_VALUE_TAG, id };
      });
      return redact(sealed);
    },
    prepareInputForValidation: (value, paths) =>
      replaceOpaqueInputs(value, decodePointers(paths), entries, false),
    resolveInputAfterApproval: (value, paths) =>
      replaceOpaqueInputs(value, decodePointers(paths), entries, true).value,
    redact,
    redactText,
  };
};
