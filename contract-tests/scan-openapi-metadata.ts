#!/usr/bin/env bun

/**
 * Local, read-only guard for the ExecutorOpaqueValue regression.
 *
 * The active OpenAPI resolver treats an operation without sensitivityVersion 2
 * as whole-output sensitive.  This scan joins the active connections to the
 * stored operation catalog and reports exactly which connected integrations
 * still have that old metadata.  It never reads or prints credential values.
 */

import { Database } from "bun:sqlite";

type Row = {
  integration: string;
  plugin_id: string | null;
  connections: number;
  operations: number;
  v2: number;
  stale: number;
};

function candidatePaths(): string[] {
  const configured = process.env.EXECUTOR_DB_PATH;
  return [
    ...(configured ? [configured] : []),
    "/data/data.db",
    "/var/lib/docker/volumes/executor-data/_data/data.db",
  ];
}

function openDatabase(): { db: Database; path: string } {
  let lastError: unknown;
  for (const path of candidatePaths()) {
    try {
      return { db: new Database(path, { readonly: true }), path };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not open Executor SQLite data in read-only mode${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

function main(): void {
  const jsonOnly = Bun.argv.includes("--json");
  let opened: { db: Database; path: string };
  try {
    opened = openDatabase();
  } catch (error) {
    console.log(JSON.stringify({ status: "unavailable", error: { code: "database_unavailable" } }, null, 2));
    process.exitCode = 2;
    return;
  }

  const { db, path } = opened;
  try {
    const active = db.query(`
      SELECT c.integration, i.plugin_id, COUNT(*) AS connections
      FROM connection c
      LEFT JOIN integration i ON i.slug = c.integration
      WHERE i.plugin_id = 'openapi'
      GROUP BY c.integration, i.plugin_id
      ORDER BY c.integration
    `).all() as Array<{ integration: string; plugin_id: string | null; connections: number }>;

    const operations = new Map<string, { operations: number; v2: number; stale: number }>();
    const rows = db.query(`
      SELECT data
      FROM plugin_storage
      WHERE plugin_id = 'openapi' AND collection = 'operation'
    `).all() as Array<{ data: Uint8Array }>;
    const decoder = new TextDecoder();
    for (const row of rows) {
      let operation: { integration?: string; binding?: { sensitivityVersion?: number } };
      try {
        operation = JSON.parse(decoder.decode(row.data));
      } catch {
        continue;
      }
      if (typeof operation.integration !== "string") continue;
      const current = operations.get(operation.integration) ?? { operations: 0, v2: 0, stale: 0 };
      current.operations += 1;
      if (operation.binding?.sensitivityVersion === 2) current.v2 += 1;
      else current.stale += 1;
      operations.set(operation.integration, current);
    }

    const reportRows: Row[] = active.map((connection) => ({
      integration: connection.integration,
      plugin_id: connection.plugin_id,
      connections: Number(connection.connections),
      ...(operations.get(connection.integration) ?? { operations: 0, v2: 0, stale: 0 }),
    }));
    const staleRows = reportRows.filter((row) => row.stale > 0);
    const report = {
      status: staleRows.length === 0 ? "passed" : "failed",
      database: path,
      summary: {
        activeOpenApiIntegrations: reportRows.length,
        staleIntegrations: staleRows.length,
        staleOperations: staleRows.reduce((total, row) => total + row.stale, 0),
      },
      integrations: reportRows,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!jsonOnly) console.error(staleRows.length === 0 ? "OpenAPI metadata scan: clean" : `OpenAPI metadata scan: ${staleRows.length} connected integration(s) still have stale operation metadata`);
    process.exitCode = staleRows.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

main();
