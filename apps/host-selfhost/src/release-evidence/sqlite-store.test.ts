/* oxlint-disable executor/no-try-catch-or-throw, executor/no-double-cast -- test boundary: the file-backed libSQL harness owns resource cleanup and verifies the public receipt serialization edge */

import { createClient } from "@libsql/client";
import { expect, test } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { payloadDigest, type JsonValue } from "./protocol";
import { createReleaseEvidenceService } from "./service";
import { createSqliteReleaseEvidenceStore, initializeReleaseEvidenceStore } from "./sqlite-store";
import {
  CALLER,
  MAIN_SHA,
  NONCE,
  POLICY,
  observer,
  preflightRequest,
  signer,
} from "./test-fixtures";

const makeService = (store: ReturnType<typeof createSqliteReleaseEvidenceStore>) => {
  const signing = signer();
  return {
    signing,
    service: createReleaseEvidenceService({
      caller: CALLER,
      policy: POLICY,
      signer: signing,
      store,
      observer: observer(),
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    }),
  };
};

const temporaryClient = async () => {
  const directory = await mkdtemp(join(tmpdir(), "executor-release-evidence-"));
  return {
    client: createClient({ url: `file:${join(directory, "release-evidence.db")}` }),
    dispose: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
};

test("SQLite persists the preflight binding and atomically allows one postdeploy consumer", async () => {
  const database = await temporaryClient();
  try {
    const { client } = database;
    await initializeReleaseEvidenceStore(client);
    const store = createSqliteReleaseEvidenceStore(client);
    const { service } = makeService(store);
    const preflight = await service.preflight(preflightRequest());
    const request = {
      action: "coolify.glink.collectReleaseEvidence.v1" as const,
      protocolVersion: 1 as const,
      tenantId: CALLER.tenantId,
      principalId: CALLER.principalId,
      nonce: NONCE,
      proposedMainSha: MAIN_SHA,
      preflightReceiptId: preflight.receiptId,
      preflightPayloadDigest: payloadDigest(preflight.payload as unknown as JsonValue),
    };
    const concurrent = await Promise.allSettled([
      service.postdeploy(request),
      service.postdeploy(request),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await client.execute(
      "SELECT nonce_digest, preflight_receipt_json, consumed_at, postdeploy_receipt_id FROM release_evidence_nonce",
    );
    expect(rows.rows).toHaveLength(1);
    expect(typeof rows.rows[0]?.nonce_digest).toBe("string");
    expect(rows.rows[0]?.consumed_at).not.toBeNull();
    expect(typeof rows.rows[0]?.postdeploy_receipt_id).toBe("string");
    // The ledger contains the signed reduced receipt, never raw upstream data.
    expect(String(rows.rows[0]?.preflight_receipt_json)).not.toContain("secret-from-coolify");
  } finally {
    database.client.close();
    await database.dispose();
  }
});

test("a new store instance sees a prior nonce record and refuses replay after a restart", async () => {
  const database = await temporaryClient();
  try {
    const { client } = database;
    await initializeReleaseEvidenceStore(client);
    const first = makeService(createSqliteReleaseEvidenceStore(client));
    await first.service.preflight(preflightRequest());
    const second = makeService(createSqliteReleaseEvidenceStore(client));
    await expect(second.service.preflight(preflightRequest())).rejects.toMatchObject({
      code: "nonce-replayed",
    });
  } finally {
    database.client.close();
    await database.dispose();
  }
});
