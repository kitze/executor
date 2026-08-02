import { describe, expect, it } from "@effect/vitest";

import {
  OpaqueValueHandoffError,
  isOpaqueValueReference,
  makeOpaqueValueHandoff,
} from "./opaque-value-handoff";

const MARKER = "opaque-value-regression-marker";
const STRUCTURAL_KEY_MARKER = "opaque-structural-key-marker";
const JSON_MARKER = 'opaque-json-"escaped"-marker';
const URI_MARKER = "opaque-uri/a?b=marker";
const sourceContext = {
  principal: "tenant-a\u0000alice",
  integration: "coolify",
  connection: "production",
  operation: "applications.listEnvs",
};
const sinkContext = {
  principal: "tenant-a\u0000alice",
  integration: "coolify",
  connection: "production",
  operation: "applications.updateEnv",
};

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

  it("redacts structural clones, primitive/key echoes, and common serialized forms", () => {
    const handoff = makeOpaqueValueHandoff();
    const sensitive = {
      pin: 481_516,
      enabled: true,
      [STRUCTURAL_KEY_MARKER]: JSON_MARKER,
      uri: URI_MARKER,
    };
    handoff.protectOutput({ secret: sensitive }, ["/secret"]);

    const clone = { ...sensitive };
    const redacted = handoff.redact({
      nestedClone: { clone },
      keyEcho: { [STRUCTURAL_KEY_MARKER]: "public" },
      primitiveEcho: "pin=481516 enabled=true",
      uriEcho: encodeURIComponent(URI_MARKER),
      jsonEcho: JSON.stringify(JSON_MARKER),
    });
    const rendered = JSON.stringify(redacted);

    for (const marker of [STRUCTURAL_KEY_MARKER, JSON_MARKER, URI_MARKER, "481516"]) {
      expect(rendered).not.toContain(marker);
    }
    expect(rendered).not.toContain("enabled=true");
  });

  it("disposes raw capabilities and redaction material when its TTL elapses", async () => {
    const handoff = makeOpaqueValueHandoff({ ttlMs: 0 });
    const sealed = handoff.protectOutput({ value: MARKER }, ["/value"]);
    const reference = valueAt(sealed, ["value"]);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(() =>
      handoff.resolveInputAfterApproval({ body: { value: reference } }, ["/body/value"]),
    ).toThrow(OpaqueValueHandoffError);
    expect(() => handoff.protectOutput({ value: MARKER }, ["/value"])).toThrow(
      OpaqueValueHandoffError,
    );
    // Values are no longer retained merely to redact a later, unrelated
    // object once the execution's opaque authority has expired.
    expect(handoff.redactText(`echo ${MARKER}`)).toContain(MARKER);
  });

  it("fails closed synchronously for an invalid caller-provided TTL", () => {
    const handoff = makeOpaqueValueHandoff({ ttlMs: Number.NaN, now: () => 1_000 });
    const sealed = handoff.protectOutput({ value: MARKER }, ["/value"]);
    const reference = valueAt(sealed, ["value"]);

    expect(() =>
      handoff.resolveInputAfterApproval({ body: { value: reference } }, ["/body/value"]),
    ).toThrow(OpaqueValueHandoffError);
  });

  it("consumes a capability before returning it and never restores it after a sink failure", () => {
    const handoff = makeOpaqueValueHandoff({ executionId: "execution-a" });
    const sealed = handoff.protectOutput({ value: MARKER }, ["/value"], sourceContext);
    const reference = valueAt(sealed, ["value"]);
    const input = { body: { value: reference } };

    handoff.prepareInputForValidation(input, ["/body/value"], sinkContext);
    const resolved = handoff.resolveInputAfterApproval(input, ["/body/value"], sinkContext);
    expect(valueAt(resolved, ["body", "value"])).toBe(MARKER);
    // A plugin/network failure after this point must not make the handle valid
    // again. Its retry has to reread the source and mint a fresh reference.
    expect(() => handoff.resolveInputAfterApproval(input, ["/body/value"], sinkContext)).toThrow(
      OpaqueValueHandoffError,
    );
    expect(JSON.stringify(handoff.redact({ error: `sink failed: ${MARKER}` }))).not.toContain(
      MARKER,
    );
  });

  it("allows exactly one concurrent resolver and binds the source to its principal", async () => {
    const handoff = makeOpaqueValueHandoff({ executionId: "execution-a" });
    const sealed = handoff.protectOutput({ value: MARKER }, ["/value"], sourceContext);
    const reference = valueAt(sealed, ["value"]);
    const input = { body: { value: reference } };
    handoff.prepareInputForValidation(input, ["/body/value"], sinkContext);

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() =>
        handoff.resolveInputAfterApproval(input, ["/body/value"], sinkContext),
      ),
      Promise.resolve().then(() =>
        handoff.resolveInputAfterApproval(input, ["/body/value"], sinkContext),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const foreign = makeOpaqueValueHandoff({ executionId: "execution-b" });
    const foreignSealed = foreign.protectOutput({ value: MARKER }, ["/value"], sourceContext);
    const foreignReference = valueAt(foreignSealed, ["value"]);
    expect(() =>
      foreign.resolveInputAfterApproval({ body: { value: foreignReference } }, ["/body/value"], {
        ...sinkContext,
        principal: "tenant-a\u0000mallory",
      }),
    ).toThrow(OpaqueValueHandoffError);
  });

  it("requires an exact source and prepared integration/connection/operation/sink binding", () => {
    const handoff = makeOpaqueValueHandoff({ executionId: "execution-a" });
    const sealed = handoff.protectOutput({ value: MARKER }, ["/value"], sourceContext);
    const reference = valueAt(sealed, ["value"]);
    const approvedInput = { body: { value: reference } };

    expect(() =>
      handoff.resolveInputAfterApproval(approvedInput, ["/body/value"], sinkContext),
    ).toThrow(OpaqueValueHandoffError);

    handoff.prepareInputForValidation(approvedInput, ["/body/value"], sinkContext);
    for (const foreignSink of [
      { ...sinkContext, integration: "other-integration" },
      { ...sinkContext, connection: "other-connection" },
      { ...sinkContext, operation: "other-operation" },
    ]) {
      expect(() =>
        handoff.resolveInputAfterApproval(approvedInput, ["/body/value"], foreignSink),
      ).toThrow(OpaqueValueHandoffError);
    }
    expect(() =>
      handoff.resolveInputAfterApproval(
        { body: { other: reference } },
        ["/body/other"],
        sinkContext,
      ),
    ).toThrow(OpaqueValueHandoffError);

    const resolved = handoff.resolveInputAfterApproval(approvedInput, ["/body/value"], sinkContext);
    expect(valueAt(resolved, ["body", "value"])).toBe(MARKER);
  });

  it("fails closed on expiry and distinguishes literal star keys from wildcards", () => {
    let now = 1_000;
    const handoff = makeOpaqueValueHandoff({
      executionId: "execution-a",
      ttlMs: 1,
      now: () => now,
    });
    const sealed = handoff.protectOutput(
      {
        "*": { value: MARKER },
        items: [{ value: MARKER }],
      },
      ["/~2/value", "/items/*/value"],
      sourceContext,
    );
    expect(isOpaqueValueReference(valueAt(sealed, ["*", "value"]))).toBe(true);
    expect(isOpaqueValueReference(valueAt(sealed, ["items", "0", "value"]))).toBe(true);

    const reference = valueAt(sealed, ["*", "value"]);
    now += 1;
    expect(() =>
      handoff.resolveInputAfterApproval(
        { body: { value: reference } },
        ["/body/value"],
        sinkContext,
      ),
    ).toThrow(OpaqueValueHandoffError);
  });
});
