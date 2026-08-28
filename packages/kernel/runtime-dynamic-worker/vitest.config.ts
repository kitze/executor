import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { runtimeDynamicWorkerDatabaseUrl } from "./scripts/test-context";

export default defineConfig({
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DATABASE_URL: inject(runtimeDynamicWorkerDatabaseUrl),
        },
      },
    })),
  ],
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./scripts/test-globalsetup.ts"],
    testTimeout: 60_000,
    onUnhandledError(error) {
      // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: Vitest passes unknown host errors to this hook
      if (error && (error as Error).message === "Stream was cancelled.") {
        return false;
      }
    },
  },
});
