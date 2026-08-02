/* oxlint-disable executor/no-try-catch-or-throw, executor/no-double-cast, executor/no-error-constructor -- test boundary: this file verifies the public accepting-verifier contract against a restart-safe libSQL ledger */

import { createClient } from "@libsql/client";
import { expect, test } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  POSTDEPLOY_ACTION,
  payloadDigest,
  verifyAndConsumePostdeployBinding,
  type JsonValue,
  type PreflightReceiptPayload,
  type ReleaseEvidencePostdeployRequest,
  type SignedReceipt,
} from "./protocol";
import { MemoryReleaseEvidenceStore, createReleaseEvidenceService } from "./service";
import {
  createSqliteReleaseEvidenceVerifierLedger,
  initializeReleaseEvidenceVerifierLedger,
} from "./sqlite-verifier-ledger";
import {
  CALLER,
  MAIN_SHA,
  NONCE,
  POLICY,
  ROOT_RUNTIME_IMAGE_DIGEST,
  ZERO_RUNTIME_IMAGE_DIGEST,
  observer,
  preflightRequest,
  signer,
} from "./test-fixtures";

const temporaryClient = async () => {
  const directory = await mkdtemp(join(tmpdir(), "executor-release-evidence-verifier-"));
  return {
    client: createClient({ url: `file:${join(directory, "verifier-ledger.db")}` }),
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const postdeployRequest = (
  preflight: SignedReceipt<PreflightReceiptPayload>,
): ReleaseEvidencePostdeployRequest => ({
  action: POSTDEPLOY_ACTION,
  protocolVersion: 1,
  tenantId: CALLER.tenantId,
  principalId: CALLER.principalId,
  nonce: NONCE,
  proposedMainSha: MAIN_SHA,
  preflightReceiptId: preflight.receiptId,
  preflightPayloadDigest: payloadDigest(preflight.payload as unknown as JsonValue),
});

const signedChain = async () => {
  const signing = signer();
  const service = createReleaseEvidenceService({
    caller: CALLER,
    policy: POLICY,
    signer: signing,
    store: new MemoryReleaseEvidenceStore(),
    observer: observer(),
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  const preflight = await service.preflight(preflightRequest());
  return {
    preflight,
    postdeploy: await service.postdeploy(postdeployRequest(preflight)),
    verificationKeys: [{ keyId: signing.keyId, publicKey: signing.publicKey }],
  };
};

const acceptance = (
  chain: Awaited<ReturnType<typeof signedChain>>,
  ledger: ReturnType<typeof createSqliteReleaseEvidenceVerifierLedger>,
  now = "2026-08-02T12:01:00.000Z",
) => ({
  ...chain,
  ledger,
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
  now,
});

test("a verifier-owned SQLite ledger rejects an identical signed chain after a restart", async () => {
  const database = await temporaryClient();
  try {
    await initializeReleaseEvidenceVerifierLedger(database.client);
    const chain = await signedChain();
    const first = createSqliteReleaseEvidenceVerifierLedger(database.client);
    await verifyAndConsumePostdeployBinding(acceptance(chain, first));

    // A new ledger instance models an independent verifier process after its
    // restart. It sees the durable nonce digest and rejects the copied chain.
    const afterRestart = createSqliteReleaseEvidenceVerifierLedger(database.client);
    await expect(
      verifyAndConsumePostdeployBinding(acceptance(chain, afterRestart)),
    ).rejects.toMatchObject({
      code: "receipt-replayed",
    });
  } finally {
    database.client.close();
    await database.dispose();
  }
});

test("an expired chain is rejected before it can consume a verifier nonce", async () => {
  const database = await temporaryClient();
  try {
    await initializeReleaseEvidenceVerifierLedger(database.client);
    const chain = await signedChain();
    const ledger = createSqliteReleaseEvidenceVerifierLedger(database.client);
    await expect(
      verifyAndConsumePostdeployBinding(acceptance(chain, ledger, "2026-08-02T13:00:00.000Z")),
    ).rejects.toMatchObject({ code: "receipt-expired" });
    const rows = await database.client.execute(
      "SELECT nonce_digest FROM release_evidence_verifier_nonce",
    );
    expect(rows.rows).toHaveLength(0);
  } finally {
    database.client.close();
    await database.dispose();
  }
});

test("the durable ledger is bounded and cleanup is both expiry-aware and rate-controlled", async () => {
  const database = await temporaryClient();
  try {
    await initializeReleaseEvidenceVerifierLedger(database.client);
    const ledger = createSqliteReleaseEvidenceVerifierLedger(database.client, {
      retentionMs: 1_000,
      maxEntries: 1,
      cleanupIntervalMs: 60_000,
      cleanupBatchSize: 1,
    });
    const first = await ledger.consumeNonce({
      tenantId: CALLER.tenantId,
      principalId: CALLER.principalId,
      nonceDigest: "a".repeat(64),
      expiresAt: "2026-08-02T12:00:01.000Z",
      now: "2026-08-02T12:00:00.000Z",
    });
    expect(first).toBe("consumed");

    // Although the first nonce is expired by now, the persistent cleanup clock
    // prevents a high-rate stream from forcing a database sweep per receipt.
    const fullBeforeInterval = await ledger.consumeNonce({
      tenantId: CALLER.tenantId,
      principalId: CALLER.principalId,
      nonceDigest: "b".repeat(64),
      expiresAt: "2026-08-02T12:10:00.000Z",
      now: "2026-08-02T12:00:02.000Z",
    });
    expect(fullBeforeInterval).toBe("full");

    const afterInterval = await ledger.consumeNonce({
      tenantId: CALLER.tenantId,
      principalId: CALLER.principalId,
      nonceDigest: "b".repeat(64),
      expiresAt: "2026-08-02T12:10:00.000Z",
      now: "2026-08-02T12:01:00.000Z",
    });
    expect(afterInterval).toBe("consumed");
    const rows = await database.client.execute(
      "SELECT nonce_digest FROM release_evidence_verifier_nonce ORDER BY nonce_digest",
    );
    expect(rows.rows).toEqual([{ nonce_digest: "b".repeat(64) }]);
  } finally {
    database.client.close();
    await database.dispose();
  }
});
