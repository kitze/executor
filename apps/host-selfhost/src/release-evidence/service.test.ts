/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-double-cast -- test boundary: direct protocol-verifier calls and explicit assertion failures exercise the public non-Effect receipt API */

import { expect, test } from "@effect/vitest";

import {
  POSTDEPLOY_ACTION,
  payloadDigest,
  verifyPostdeployBinding,
  verifyReleaseEvidenceReceipt,
  type JsonValue,
  type PreflightReceiptPayload,
  type ReleaseEvidencePostdeployRequest,
  type SignedReceipt,
} from "./protocol";
import { MemoryReleaseEvidenceStore, createReleaseEvidenceService } from "./service";
import {
  CALLER,
  EXPECTED_MANIFEST_DIGEST,
  MAIN_SHA,
  NONCE,
  POLICY,
  observer,
  postdeployObservation,
  preflightRequest,
  signer,
} from "./test-fixtures";

const makeService = (
  input: {
    readonly now?: () => Date;
    readonly postdeployDigest?: string;
  } = {},
) => {
  const signing = signer();
  const store = new MemoryReleaseEvidenceStore();
  return {
    signing,
    service: createReleaseEvidenceService({
      caller: CALLER,
      policy: POLICY,
      signer: signing,
      store,
      observer: observer({
        postdeploy: input.postdeployDigest
          ? postdeployObservation(input.postdeployDigest)
          : undefined,
      }),
      now: input.now ?? (() => new Date("2026-08-02T12:00:00.000Z")),
    }),
  };
};

const expectFailureCode = (operation: () => unknown, code: string): void => {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
};

const postdeployRequest = (
  preflight: SignedReceipt<PreflightReceiptPayload>,
): ReleaseEvidencePostdeployRequest => ({
  action: POSTDEPLOY_ACTION,
  protocolVersion: 1 as const,
  tenantId: CALLER.tenantId,
  principalId: CALLER.principalId,
  nonce: NONCE,
  proposedMainSha: MAIN_SHA,
  preflightReceiptId: preflight.receiptId,
  preflightPayloadDigest: payloadDigest(preflight.payload as unknown as JsonValue),
});

test("issues a signed preflight and one bound, signed postdeploy receipt", async () => {
  const { service, signing } = makeService();
  const preflight = await service.preflight(preflightRequest());
  const postRequest = postdeployRequest(preflight);
  const postdeploy = await service.postdeploy(postRequest);

  const verified = verifyPostdeployBinding({
    preflight,
    postdeploy,
    verificationKeys: [{ keyId: signing.keyId, publicKey: signing.publicKey }],
    now: "2026-08-02T12:01:00.000Z",
  });
  expect(verified.payload.observedMainSha).toBe(MAIN_SHA);
  expect(verified.payload.root.deployment.deploymentHistoryDigest).toBe("aa".repeat(32));
  expect(verified.payload.publicBuildEnvironmentManifest).toEqual({
    version: 1,
    expectedDigest: EXPECTED_MANIFEST_DIGEST,
    actualDigest: EXPECTED_MANIFEST_DIGEST,
  });
  expect(JSON.stringify(postdeploy)).not.toContain("secret-from-coolify");
});

test("keeps an unconsumed preflight verifiable across a signing-key rotation", async () => {
  const oldSigning = signer("glink-test-key-old");
  const nextSigning = signer("glink-test-key-next");
  const store = new MemoryReleaseEvidenceStore();
  const options = {
    caller: CALLER,
    policy: POLICY,
    store,
    observer: observer(),
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  };
  const beforeRotation = createReleaseEvidenceService({ ...options, signer: oldSigning });
  const preflight = await beforeRotation.preflight(preflightRequest());

  const afterRotation = createReleaseEvidenceService({
    ...options,
    signer: nextSigning,
    verificationKeys: [{ keyId: oldSigning.keyId, publicKey: oldSigning.publicKey }],
  });
  const postdeploy = await afterRotation.postdeploy(postdeployRequest(preflight));

  expect(afterRotation.publicKeys()).toEqual([
    { keyId: nextSigning.keyId, publicKey: nextSigning.publicKey },
    { keyId: oldSigning.keyId, publicKey: oldSigning.publicKey },
  ]);
  expect(postdeploy.keyId).toBe(nextSigning.keyId);
});

test("rejects nonce replay and a second postdeploy consumption", async () => {
  const { service } = makeService();
  const preflight = await service.preflight(preflightRequest());
  await expect(service.preflight(preflightRequest())).rejects.toMatchObject({
    code: "nonce-replayed",
  });

  const postRequest = postdeployRequest(preflight);
  await service.postdeploy(postRequest);
  await expect(service.postdeploy(postRequest)).rejects.toMatchObject({
    code: "preflight-consumed",
  });
});

test("rejects preflight mutation, SHA mutation, and wrong tenant before collecting postdeploy evidence", async () => {
  const { service } = makeService();
  const preflight = await service.preflight(preflightRequest());
  const postRequest = postdeployRequest(preflight);

  await expect(
    service.postdeploy({ ...postRequest, proposedMainSha: "f".repeat(40) }),
  ).rejects.toMatchObject({ code: "preflight-unavailable" });
  await expect(
    service.postdeploy({ ...postRequest, tenantId: "another-tenant" }),
  ).rejects.toMatchObject({ code: "invalid-request" });
  await expect(
    service.postdeploy({ ...postRequest, preflightPayloadDigest: "e".repeat(64) }),
  ).rejects.toMatchObject({ code: "preflight-unavailable" });
});

test("rejects a postdeploy observation whose public build manifest digest does not consume preflight", async () => {
  const { service } = makeService({ postdeployDigest: "ab".repeat(32) });
  const preflight = await service.preflight(preflightRequest());
  const request = postdeployRequest(preflight);
  await expect(service.postdeploy(request)).rejects.toMatchObject({ code: "evidence-rejected" });
});

test("offline verifier rejects a signature mutation, wrong app, action, tenant, expiry, and replay", async () => {
  const { service, signing } = makeService();
  const preflight = await service.preflight(preflightRequest());
  const request = postdeployRequest(preflight);
  const postdeploy = await service.postdeploy(request);
  const keys = [{ keyId: signing.keyId, publicKey: signing.publicKey }];

  const mutated = {
    ...postdeploy,
    payload: { ...postdeploy.payload, observedMainSha: "f".repeat(40) },
  } as typeof postdeploy;
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(mutated, {
        action: POSTDEPLOY_ACTION,
        tenantId: CALLER.tenantId,
        principalId: CALLER.principalId,
        nonce: NONCE,
        proposedMainSha: MAIN_SHA,
        root: POLICY.root,
        zero: POLICY.zero,
        now: "2026-08-02T12:01:00.000Z",
        verificationKeys: keys,
      }),
    "invalid-signature",
  );

  const verification = {
    action: POSTDEPLOY_ACTION,
    tenantId: CALLER.tenantId,
    principalId: CALLER.principalId,
    nonce: NONCE,
    proposedMainSha: MAIN_SHA,
    root: POLICY.root,
    zero: POLICY.zero,
    now: "2026-08-02T12:01:00.000Z",
    verificationKeys: keys,
  } as const;
  expectFailureCode(
    () => verifyReleaseEvidenceReceipt(postdeploy, { ...verification, tenantId: "wrong-tenant" }),
    "receipt-constraint-mismatch",
  );
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...verification,
        action: "coolify.glink.authorizeReleaseEnvironment.v1",
      }),
    "receipt-constraint-mismatch",
  );
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...verification,
        root: { ...POLICY.root, uuid: "wrong-root-app" },
      }),
    "receipt-constraint-mismatch",
  );
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...verification,
        now: "2026-08-02T13:00:00.000Z",
      }),
    "receipt-expired",
  );
  const seen = new Set<string>();
  verifyReleaseEvidenceReceipt(postdeploy, {
    ...verification,
    replayStore: { has: (id) => seen.has(id), add: (id) => seen.add(id) },
  });
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...verification,
        replayStore: { has: (id) => seen.has(id), add: (id) => seen.add(id) },
      }),
    "receipt-replayed",
  );
});
