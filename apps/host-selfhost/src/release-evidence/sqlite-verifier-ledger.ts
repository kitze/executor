/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-tagged-error -- libSQL is the durable, verifier-owned boundary; all driver failures are reduced to the stable receipt storage code */

import type { Client, Row, Transaction } from "@libsql/client";

import { ReleaseEvidenceError, type ReleaseEvidenceVerifierLedger } from "./protocol";

const NONCE_LEDGER = "postdeploy-nonce-v1";
const nonceDigestPattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[A-Za-z0-9._:-]{1,256}$/u;
const validIso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

const schemaSql = [
  `CREATE TABLE IF NOT EXISTS release_evidence_verifier_nonce (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    nonce_digest TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    retained_until TEXT NOT NULL,
    consumed_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, nonce_digest)
  )`,
  `CREATE INDEX IF NOT EXISTS release_evidence_verifier_nonce_retained_idx
    ON release_evidence_verifier_nonce (retained_until)`,
  `CREATE TABLE IF NOT EXISTS release_evidence_verifier_maintenance (
    ledger_name TEXT PRIMARY KEY,
    last_cleanup_at TEXT NOT NULL
  )`,
];

export const initializeReleaseEvidenceVerifierLedger = async (client: Client): Promise<void> => {
  try {
    await client.batch(schemaSql, "write");
  } catch {
    throw new ReleaseEvidenceError("storage-unavailable");
  }
};

export interface SqliteReleaseEvidenceVerifierLedgerOptions {
  /** Keep a spent nonce after its receipt expires to tolerate verifier clock skew. */
  readonly retentionMs?: number;
  /** Hard bound on retained nonce rows; exhaustion fails closed. */
  readonly maxEntries?: number;
  /** Persistent minimum interval between bounded cleanup passes. */
  readonly cleanupIntervalMs?: number;
  /** Maximum expired rows a single accepting verification may delete. */
  readonly cleanupBatchSize?: number;
}

const rollbackIfOpen = (transaction: Transaction): void => {
  if (!transaction.closed) transaction.close();
};

const text = (row: Row | undefined, field: string): string | null => {
  const value = row?.[field];
  return typeof value === "string" ? value : null;
};

const rowCount = (row: Row | undefined): number => {
  const value = row?.count;
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(count) || count < 0)
    throw new ReleaseEvidenceError("storage-unavailable");
  return count;
};

const retainedUntil = (expiresAt: string, retentionMs: number): string =>
  new Date(Date.parse(expiresAt) + retentionMs).toISOString();

const validOptions = (input: Required<SqliteReleaseEvidenceVerifierLedgerOptions>): boolean =>
  Number.isSafeInteger(input.retentionMs) &&
  input.retentionMs > 0 &&
  Number.isSafeInteger(input.maxEntries) &&
  input.maxEntries > 0 &&
  Number.isSafeInteger(input.cleanupIntervalMs) &&
  input.cleanupIntervalMs > 0 &&
  Number.isSafeInteger(input.cleanupBatchSize) &&
  input.cleanupBatchSize > 0 &&
  input.cleanupBatchSize <= input.maxEntries;

/**
 * A persistent verifier ledger. It never stores a raw nonce, receipt, secret,
 * Coolify record, or image reference—only a nonce digest and bounded expiry
 * metadata. Cleanup is persisted and rate controlled so hostile traffic cannot
 * turn accepted-receipt verification into an unbounded deletion loop.
 */
export const createSqliteReleaseEvidenceVerifierLedger = (
  client: Client,
  options: SqliteReleaseEvidenceVerifierLedgerOptions = {},
): ReleaseEvidenceVerifierLedger => {
  const settings = {
    retentionMs: options.retentionMs ?? 5 * 60_000,
    maxEntries: options.maxEntries ?? 10_000,
    cleanupIntervalMs: options.cleanupIntervalMs ?? 60_000,
    cleanupBatchSize: options.cleanupBatchSize ?? 100,
  };
  if (!validOptions(settings)) throw new ReleaseEvidenceError("invalid-request");

  return {
    consumeNonce: async (input) => {
      if (
        !identifierPattern.test(input.tenantId) ||
        !identifierPattern.test(input.principalId) ||
        !nonceDigestPattern.test(input.nonceDigest) ||
        !validIso(input.expiresAt) ||
        !validIso(input.now) ||
        Date.parse(input.expiresAt) <= Date.parse(input.now)
      ) {
        throw new ReleaseEvidenceError("invalid-request");
      }
      const transaction = await client.transaction("write");
      try {
        const maintenance = await transaction.execute({
          sql: `SELECT last_cleanup_at
                FROM release_evidence_verifier_maintenance
                WHERE ledger_name = ?`,
          args: [NONCE_LEDGER],
        });
        const previousCleanup = text(maintenance.rows[0], "last_cleanup_at");
        if (
          !previousCleanup ||
          !validIso(previousCleanup) ||
          Date.parse(input.now) - Date.parse(previousCleanup) >= settings.cleanupIntervalMs
        ) {
          await transaction.execute({
            // SQLite/libSQL supports this portable bounded rowid subquery even
            // where DELETE ... LIMIT is not compiled in.
            sql: `DELETE FROM release_evidence_verifier_nonce
                  WHERE rowid IN (
                    SELECT rowid FROM release_evidence_verifier_nonce
                    WHERE retained_until < ?
                    ORDER BY retained_until ASC
                    LIMIT ?
                  )`,
            args: [input.now, settings.cleanupBatchSize],
          });
          await transaction.execute({
            sql: `INSERT INTO release_evidence_verifier_maintenance (ledger_name, last_cleanup_at)
                  VALUES (?, ?)
                  ON CONFLICT(ledger_name) DO UPDATE SET last_cleanup_at = excluded.last_cleanup_at`,
            args: [NONCE_LEDGER, input.now],
          });
        }

        const existing = await transaction.execute({
          sql: `SELECT nonce_digest FROM release_evidence_verifier_nonce
                WHERE tenant_id = ? AND principal_id = ? AND nonce_digest = ?`,
          args: [input.tenantId, input.principalId, input.nonceDigest],
        });
        if (existing.rows.length > 0) {
          await transaction.commit();
          return "replayed";
        }
        const size = await transaction.execute(
          "SELECT COUNT(*) AS count FROM release_evidence_verifier_nonce",
        );
        if (rowCount(size.rows[0]) >= settings.maxEntries) {
          await transaction.commit();
          return "full";
        }
        const inserted = await transaction.execute({
          sql: `INSERT OR IGNORE INTO release_evidence_verifier_nonce
                (tenant_id, principal_id, nonce_digest, expires_at, retained_until, consumed_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            input.tenantId,
            input.principalId,
            input.nonceDigest,
            input.expiresAt,
            retainedUntil(input.expiresAt, settings.retentionMs),
            input.now,
          ],
        });
        await transaction.commit();
        return inserted.rowsAffected === 1 ? "consumed" : "replayed";
      } catch (error) {
        if (error instanceof ReleaseEvidenceError) throw error;
        throw new ReleaseEvidenceError("storage-unavailable");
      } finally {
        rollbackIfOpen(transaction);
      }
    },
  };
};
