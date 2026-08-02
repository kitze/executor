import { describe, expect, it } from "@effect/vitest";

import {
  OpaqueValueHandoffError,
  isOpaqueValueReference,
  makeOpaqueValueHandoff,
} from "./opaque-value-handoff";

const MARKER = "opaque-value-regression-marker";

const valueAt = (value: unknown, path: readonly string[]): unknown => {
  let current = value as Record<string, unknown> | undefined;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[segment] as Record<string, unknown> | undefined;
  }
  return current;
};

describe("opaque sensitive value handoff", () => {
  it("seals declared output leaves without changing unrelated data", () => {
    const handoff = makeOpaqueValueHandoff();
    const protectedValue = handoff.protectOutput(
      {
        envs: [{ name: "SOURCE_ENV", value: MARKER }],
        "slash/key": { "tilde~key": MARKER },
        public: "visible",
      },
      ["/envs/*/value", "/slash~1key/tilde~0key"],
    );

    expect(JSON.stringify(protectedValue)).not.toContain(MARKER);
    expect(valueAt(protectedValue, ["public"])).toBe("visible");
    expect(isOpaqueValueReference(valueAt(protectedValue, ["envs", "0", "value"]))).toBe(true);
    expect(isOpaqueValueReference(valueAt(protectedValue, ["slash/key", "tilde~key"]))).toBe(true);
    expect(handoff.hasOpaqueValues()).toBe(true);
  });

  it("uses a non-secret type-compatible value for validation and resolves only afterwards", () => {
    const handoff = makeOpaqueValueHandoff();
    const protectedValue = handoff.protectOutput({ value: MARKER }, ["/value"]);
    const reference = valueAt(protectedValue, ["value"]);

    const prepared = handoff.prepareInputForValidation({ body: { value: reference } }, [
      "/body/value",
    ]);
    expect(prepared.containsOpaqueValue).toBe(true);
    expect(valueAt(prepared.value, ["body", "value"])).toBe("x".repeat(MARKER.length));
    expect(JSON.stringify(prepared.value)).not.toContain(MARKER);

    const resolved = handoff.resolveInputAfterApproval({ body: { value: reference } }, [
      "/body/value",
    ]);
    expect(valueAt(resolved, ["body", "value"])).toBe(MARKER);
  });

  it("rejects fabricated, foreign, and undeclared opaque references", () => {
    const source = makeOpaqueValueHandoff();
    const protectedValue = source.protectOutput({ value: MARKER }, ["/value"]);
    const reference = valueAt(protectedValue, ["value"]);
    const otherExecution = makeOpaqueValueHandoff();

    expect(() =>
      otherExecution.prepareInputForValidation({ body: { value: reference } }, ["/body/value"]),
    ).toThrow(OpaqueValueHandoffError);
    expect(() =>
      source.prepareInputForValidation({ accidental: reference }, ["/body/value"]),
    ).toThrow(OpaqueValueHandoffError);
    expect(() =>
      source.prepareInputForValidation(
        { body: { value: { _tag: "ExecutorOpaqueValue", id: "not-issued-here" } } },
        ["/body/value"],
      ),
    ).toThrow(OpaqueValueHandoffError);
  });

  it("redacts sealed values from result, error, and log-shaped data", () => {
    const handoff = makeOpaqueValueHandoff();
    handoff.protectOutput({ value: MARKER }, ["/value"]);

    const safe = handoff.redact({
      result: { echoed: MARKER },
      error: { message: `upstream echoed ${MARKER}`, details: { value: MARKER } },
      logs: [`sandbox printed ${MARKER}`],
    });

    expect(JSON.stringify(safe)).not.toContain(MARKER);
    expect(handoff.redactText(`message: ${MARKER}`)).not.toContain(MARKER);
  });
});
