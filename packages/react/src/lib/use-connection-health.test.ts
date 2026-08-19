import { describe, expect, it } from "@effect/vitest";
import {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  IntegrationSlug,
  ProviderKey,
  type Connection,
} from "@executor-js/sdk/shared";

import { HEALTH_REVALIDATE_MS, runConnectionHealthCheck } from "./use-connection-health";

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  owner: "user",
  name: ConnectionName.make("personal/account"),
  integration: IntegrationSlug.make("google drive"),
  template: AuthTemplateSlug.make("oauth"),
  provider: ProviderKey.make("default"),
  address: ConnectionAddress.make("tools.google-drive.user.personal-account"),
  identityLabel: null,
  expiresAt: null,
  oauthClient: null,
  lastHealth: null,
  ...overrides,
});

const withRecordingFetch = async <A>(
  response: Response,
  run: (calls: Array<{ readonly url: string; readonly init?: RequestInit }>) => Promise<A>,
): Promise<A> => {
  const original = globalThis.fetch;
  const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response.clone();
  }) as typeof globalThis.fetch;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test fixture must restore the process-global browser fetch shim after the async assertion
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const healthyResponse = () =>
  new Response(JSON.stringify({ status: "healthy", checkedAt: 123 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("runConnectionHealthCheck", () => {
  it("encodes the connection path and preserves stale-while-revalidate semantics", async () => {
    await withRecordingFetch(healthyResponse(), async (calls) => {
      const result = await runConnectionHealthCheck(
        connection({
          lastHealth: {
            status: "healthy",
            checkedAt: Date.now() - HEALTH_REVALIDATE_MS - 1,
          },
        }),
      );

      expect(result).toEqual({ status: "healthy", checkedAt: 123 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        `/api/connections/user/google%20drive/personal%2Faccount/health?ifStaleMs=${HEALTH_REVALIDATE_MS}`,
      );
      expect(calls[0]?.init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
      });
    });
  });

  it("forces an unconditional probe without the stale query", async () => {
    await withRecordingFetch(healthyResponse(), async (calls) => {
      await runConnectionHealthCheck(connection(), { force: true });
      expect(calls[0]?.url).toBe("/api/connections/user/google%20drive/personal%2Faccount/health");
    });
  });

  it("rejects non-success responses", async () => {
    await withRecordingFetch(new Response("unavailable", { status: 503 }), async () => {
      await expect(runConnectionHealthCheck(connection())).rejects.toThrow(
        "Health check failed (503)",
      );
    });
  });
});
