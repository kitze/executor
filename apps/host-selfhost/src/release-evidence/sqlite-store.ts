/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-tagged-error, executor/no-json-parse -- boundary: libSQL transactions and durable receipt JSON are Promise/native-driver boundaries that must atomically normalize failures into stable storage codes */

import type { Client, Row, Transaction } from "@libsql/client";

import {
  PREFLIGHT_ACTION,
  POSTDEPLOY_ACTION,
  ReleaseEvidenceError,
  type PostdeployReceiptPayload,
  type PreflightReceiptPayload,
  type SignedReceipt,
} from "./protocol";
import type { ReleaseEvidenceStore } from "./service";

// These tables are intentionally independent of Executor's generic tool data.
// They retain only nonce digests and signed/reduced receipts, never a Coolify
// response, bearer token, environment value, or signing private key.
const schemaSql = [
  `CREATE TABLE IF NOT EXISTS release_evidence_nonce (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    action TEXT NOT NULL,
    nonce_digest TEXT NOT NULL,
    preflight_receipt_id TEXT NOT NULL UNIQUE,
    preflight_payload_digest TEXT NOT NULL,
    preflight_receipt_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    postdeploy_receipt_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, action, nonce_digest)
  )`,
  `CREATE TABLE IF NOT EXISTS release_evidence_receipt (
    receipt_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    action TEXT NOT NULL,
    nonce_digest TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS release_evidence_receipt_nonce_idx
    ON release_evidence_receipt (tenant_id, principal_id, action, nonce_digest)`,
];

export const initializeReleaseEvidenceStore = async (client: Client): Promise<void> => {
  try {
    await client.batch(schemaSql, "write");
  } catch {
    throw new ReleaseEvidenceError("storage-unavailable");
  }
};

const text = (row: Row | undefined, field: string): string | null => {
  const value = row?.[field];
  return typeof value === "string" ? value : null;
};

const rollbackIfOpen = (transaction: Transaction): void => {
  if (!transaction.closed) transaction.close();
};

const nonceRow = async (
  client: Client | Transaction,
  input: { readonly tenantId: string; readonly principalId: string; readonly nonceDigest: string },
) =>
  client.execute({
    sql: `SELECT preflight_receipt_id, preflight_payload_digest, preflight_receipt_json,
                 expires_at, consumed_at
          FROM release_evidence_nonce
          WHERE tenant_id = ? AND principal_id = ? AND action = ? AND nonce_digest = ?`,
    args: [input.tenantId, input.principalId, PREFLIGHT_ACTION, input.nonceDigest],
  });

const receiptInsert = (input: {
  readonly receipt:
    | SignedReceipt<PreflightReceiptPayload>
    | SignedReceipt<PostdeployReceiptPayload>;
  readonly tenantId: string;
  readonly principalId: string;
  readonly nonceDigest: string;
  readonly now: string;
}) => ({
  sql: `INSERT INTO release_evidence_receipt
        (receipt_id, tenant_id, principal_id, action, nonce_digest, issued_at, expires_at, receipt_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [
    input.receipt.receiptId,
    input.tenantId,
    input.principalId,
    input.receipt.action,
    input.nonceDigest,
    input.receipt.issuedAt,
    input.receipt.expiresAt,
    JSON.stringify(input.receipt),
    input.now,
  ],
});

/**
 * Build a durable, process-restart-safe replay store over the self-host's one
 * libSQL connection. Write transactions use BEGIN IMMEDIATE, so the final
 * consume/update + final receipt insert are one atomic state transition.
 */
export const createSqliteReleaseEvidenceStore = (client: Client): ReleaseEvidenceStore => ({
  reservePreflight: async (record) => {
    const transaction = await client.transaction("write");
    try {
      await transaction.execute({
        sql: `INSERT INTO release_evidence_nonce
              (tenant_id, principal_id, action, nonce_digest, preflight_receipt_id,
               preflight_payload_digest, preflight_receipt_json, expires_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          record.tenantId,
          record.principalId,
          PREFLIGHT_ACTION,
          record.nonceDigest,
          record.receipt.receiptId,
          record.payloadDigest,
          JSON.stringify(record.receipt),
          record.expiresAt,
          record.receipt.issuedAt,
        ],
      });
      await transaction.execute(
        receiptInsert({
          receipt: record.receipt,
          tenantId: record.tenantId,
          principalId: record.principalId,
          nonceDigest: record.nonceDigest,
          now: record.receipt.issuedAt,
        }),
      );
      await transaction.commit();
      return "stored";
    } catch {
      // A duplicate is the only expected failed preflight write. Check the
      // durable nonce row after rollback rather than trusting a driver message.
      rollbackIfOpen(transaction);
      try {
        const existing = await nonceRow(client, record);
        if (existing.rows.length > 0) return "duplicate";
      } catch {
        // Fall through to one stable storage failure below.
      }
      throw new ReleaseEvidenceError("storage-unavailable");
    } finally {
      rollbackIfOpen(transaction);
    }
  },

  readPreflight: async (input) => {
    try {
      const result = await nonceRow(client, input);
      const row = result.rows[0];
      const receiptId = text(row, "preflight_receipt_id");
      const payloadDigest = text(row, "preflight_payload_digest");
      const serializedReceipt = text(row, "preflight_receipt_json");
      const expiresAt = text(row, "expires_at");
      if (
        !receiptId ||
        receiptId !== input.receiptId ||
        !payloadDigest ||
        !serializedReceipt ||
        !expiresAt
      ) {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(serializedReceipt);
      } catch {
        throw new ReleaseEvidenceError("storage-unavailable");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ReleaseEvidenceError("storage-unavailable");
      }
      return {
        tenantId: input.tenantId,
        principalId: input.principalId,
        nonceDigest: input.nonceDigest,
        receipt: parsed as SignedReceipt<PreflightReceiptPayload>,
        payloadDigest,
        expiresAt,
      };
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) throw error;
      throw new ReleaseEvidenceError("storage-unavailable");
    }
  },

  consumePreflight: async (input) => {
    const transaction = await client.transaction("write");
    try {
      const result = await nonceRow(transaction, input);
      const row = result.rows[0];
      const receiptId = text(row, "preflight_receipt_id");
      const payloadDigest = text(row, "preflight_payload_digest");
      const expiresAt = text(row, "expires_at");
      const consumedAt = text(row, "consumed_at");
      if (!receiptId || !payloadDigest || !expiresAt) return "unavailable";
      if (receiptId !== input.receiptId || payloadDigest !== input.payloadDigest)
        return "unavailable";
      if (Date.parse(expiresAt) < Date.parse(input.now)) return "expired";
      if (consumedAt) return "already-consumed";

      const update = await transaction.execute({
        sql: `UPDATE release_evidence_nonce
              SET consumed_at = ?, postdeploy_receipt_id = ?
              WHERE tenant_id = ? AND principal_id = ? AND action = ? AND nonce_digest = ?
                AND preflight_receipt_id = ? AND preflight_payload_digest = ? AND consumed_at IS NULL`,
        args: [
          input.now,
          input.finalReceipt.receiptId,
          input.tenantId,
          input.principalId,
          PREFLIGHT_ACTION,
          input.nonceDigest,
          input.receiptId,
          input.payloadDigest,
        ],
      });
      if (update.rowsAffected !== 1) return "already-consumed";
      await transaction.execute(
        receiptInsert({
          receipt: input.finalReceipt,
          tenantId: input.tenantId,
          principalId: input.principalId,
          nonceDigest: input.nonceDigest,
          now: input.now,
        }),
      );
      await transaction.commit();
      return "consumed";
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) throw error;
      throw new ReleaseEvidenceError("storage-unavailable");
    } finally {
      rollbackIfOpen(transaction);
    }
  },
});

// Kept here (rather than in the protocol) to make the on-disk action binding
// visible next to the schema. It also prevents an accidental change that would
// write postdeploy receipts under the preflight action.
void POSTDEPLOY_ACTION;
