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
  ROOT_RUNTIME_IMAGE_DIGEST,
  ZERO_RUNTIME_IMAGE_DIGEST,
  observer,
  postdeployObservation,
  preflightRequest,
  signer,
} from "./test-fixtures";

const makeService = (
  input: {
    readonly now?: () => Date;
    readonly postdeployRuntimeImageDigest?: string;
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
        postdeploy: input.postdeployRuntimeImageDigest
          ? postdeployObservation(input.postdeployRuntimeImageDigest)
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

const verification = (input: { readonly keyId: string; readonly publicKey: string }) => ({
  action: POSTDEPLOY_ACTION,
  tenantId: CALLER.tenantId,
  principalId: CALLER.principalId,
  nonce: NONCE,
  proposedMainSha: MAIN_SHA,
  root: POLICY.root,
  zero: POLICY.zero,
  rootDeployment: {
    deploymentUuid: "root-deployment-uuid",
    deploymentId: "9001",
    runtimeImageDigest: ROOT_RUNTIME_IMAGE_DIGEST,
  },
  zeroDeployment: {
    deploymentUuid: "zero-deployment-uuid",
    deploymentId: "9002",
    runtimeImageDigest: ZERO_RUNTIME_IMAGE_DIGEST,
  },
  now: "2026-08-02T12:01:00.000Z",
  verificationKeys: [input],
});

test("issues a signed preflight and one bound, signed postdeploy receipt", async () => {
  const { service, signing } = makeService();
  const preflight = await service.preflight(preflightRequest());
  const postRequest = postdeployRequest(preflight);
  const postdeploy = await service.postdeploy(postRequest);

  const verified = verifyPostdeployBinding({
    preflight,
    postdeploy,
    ...verification({ keyId: signing.keyId, publicKey: signing.publicKey }),
  });
  expect(verified.payload.observedMainSha).toBe(MAIN_SHA);
  expect(verified.payload.root.deployment.deploymentHistoryDigest).toBe("aa".repeat(32));
  expect(verified.payload.publicBuildEnvironmentManifest).toEqual({
    version: 1,
    expectedDigest: EXPECTED_MANIFEST_DIGEST,
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

test("offline verification rejects a substituted valid runtime image digest", async () => {
  const substituted = `sha256:${"ab".repeat(32)}`;
  const { service, signing } = makeService({ postdeployRuntimeImageDigest: substituted });
  const preflight = await service.preflight(preflightRequest());
  const postdeploy = await service.postdeploy(postdeployRequest(preflight));
  expectFailureCode(
    () =>
      verifyPostdeployBinding({
        preflight,
        postdeploy,
        ...verification({ keyId: signing.keyId, publicKey: signing.publicKey }),
      }),
    "receipt-constraint-mismatch",
  );
});

test("offline verifier rejects a signature mutation, wrong app, action, tenant, and expiry", async () => {
  const { service, signing } = makeService();
  const preflight = await service.preflight(preflightRequest());
  const request = postdeployRequest(preflight);
  const postdeploy = await service.postdeploy(request);

  const mutated = {
    ...postdeploy,
    payload: { ...postdeploy.payload, observedMainSha: "f".repeat(40) },
  } as typeof postdeploy;
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(mutated, {
        ...verification({ keyId: signing.keyId, publicKey: signing.publicKey }),
      }),
    "invalid-signature",
  );

  const receiptVerification = verification({ keyId: signing.keyId, publicKey: signing.publicKey });
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...receiptVerification,
        tenantId: "wrong-tenant",
      }),
    "receipt-constraint-mismatch",
  );
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...receiptVerification,
        action: "coolify.glink.authorizeReleaseEnvironment.v1",
      }),
    "receipt-constraint-mismatch",
  );
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...receiptVerification,
        root: { ...POLICY.root, uuid: "wrong-root-app" },
      }),
    "receipt-constraint-mismatch",
  );
  expectFailureCode(
    () =>
      verifyReleaseEvidenceReceipt(postdeploy, {
        ...receiptVerification,
        now: "2026-08-02T13:00:00.000Z",
      }),
    "receipt-expired",
  );
});
