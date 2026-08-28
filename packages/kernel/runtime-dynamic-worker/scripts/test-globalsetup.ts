import { collectTables } from "@executor-js/sdk";
import type { TestProject } from "vitest/node";
import { runtimeDynamicWorkerDatabaseUrl } from "./test-context";
import { createPgliteRuntime, type PgliteRuntime } from "./pglite";

const DATABASE_NAMESPACE = "executor_worker_test";

let runtime: PgliteRuntime | undefined;

export default async function setup(project: TestProject) {
  runtime = await createPgliteRuntime({
    tables: collectTables(),
    namespace: DATABASE_NAMESPACE,
    host: "127.0.0.1",
    port: 0,
  });
  project.provide(
    runtimeDynamicWorkerDatabaseUrl,
    `postgresql://postgres:postgres@${runtime.server.getServerConn()}/postgres`,
  );

  return async () => {
    await runtime?.close();
  };
}
