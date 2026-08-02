/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor -- test boundary: direct boot-config parsing asserts the capability fails closed on malformed key material */

import { generateKeyPairSync } from "node:crypto";

import { expect, test } from "@effect/vitest";

import { loadReleaseEvidenceConfig } from "./config";
import { POLICY } from "./test-fixtures";

const keyMaterial = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
};

const enabledEnvironment = (input: { readonly retainedKeys?: string } = {}) => {
  const active = keyMaterial();
  return {
    EXECUTOR_RELEASE_EVIDENCE_ENABLED: "true",
    EXECUTOR_RELEASE_EVIDENCE_TENANT_ID: "glink-tenant",
    EXECUTOR_RELEASE_EVIDENCE_PRINCIPAL_ID: "glink-release",
    EXECUTOR_RELEASE_EVIDENCE_CALLER_TOKEN: "a-test-caller-token-that-is-long-enough",
    EXECUTOR_RELEASE_EVIDENCE_ED25519_KEY_ID: "active-key",
    EXECUTOR_RELEASE_EVIDENCE_ED25519_PRIVATE_KEY: active.privateKey,
    ...(input.retainedKeys === undefined
      ? {}
      : { EXECUTOR_RELEASE_EVIDENCE_ED25519_VERIFICATION_KEYS_JSON: input.retainedKeys }),
    EXECUTOR_RELEASE_EVIDENCE_COOLIFY_BASE_URL: "https://coolify.example",
    EXECUTOR_RELEASE_EVIDENCE_COOLIFY_TOKEN: "a-test-coolify-token-that-is-long-enough",
    EXECUTOR_RELEASE_EVIDENCE_POLICY_JSON: JSON.stringify(POLICY),
  };
};

test("leaves the privileged capability absent until it is explicitly enabled", () => {
  expect(loadReleaseEvidenceConfig({})).toBeNull();
});

test("loads an active signing key and validates a retained public rotation key", () => {
  const retained = keyMaterial();
  const config = loadReleaseEvidenceConfig(
    enabledEnvironment({
      retainedKeys: JSON.stringify([{ keyId: "previous-key", publicKey: retained.publicKey }]),
    }),
  );

  expect(config?.signing.keyId).toBe("active-key");
  expect(config?.signing.verificationKeys).toEqual([
    { keyId: "previous-key", publicKey: retained.publicKey },
  ]);
});

test("fails closed when a retained verification-key record is malformed", () => {
  try {
    loadReleaseEvidenceConfig(
      enabledEnvironment({
        retainedKeys: JSON.stringify([{ keyId: "previous-key", publicKey: "not-a-key" }]),
      }),
    );
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid-request" });
    return;
  }
  throw new Error("Expected malformed retained verification key to be rejected");
});

test("pins the active Root and Zero lifecycle marker contracts", () => {
  const environment = enabledEnvironment();
  environment.EXECUTOR_RELEASE_EVIDENCE_POLICY_JSON = JSON.stringify({
    ...POLICY,
    root: {
      ...POLICY.root,
      requiredStartupMarkers: POLICY.root.requiredStartupMarkers.slice(0, -1),
    },
  });
  try {
    loadReleaseEvidenceConfig(environment);
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid-request" });
    return;
  }
  throw new Error("Expected a stale Root marker policy to be rejected");
});
