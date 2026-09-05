import { describe, expect, it } from "@effect/vitest";

import { authToolFailure } from "./auth-tool-failure";

describe("OAuth recovery guidance", () => {
  it("directs refresh configuration failures to diagnosis without offering another login", () => {
    const result = authToolFailure({
      code: "oauth_refresh_failed",
      message: "The token endpoint rejected the request (invalid_client).",
      upstream: { details: { oauthErrorCode: "invalid_client" } },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        details: {
          recovery: {
            listConnectionsTool: "executor.coreTools.connections.list",
            refreshInstructions: expect.stringContaining("verbose: true"),
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("startOAuthTool");
    expect(JSON.stringify(result)).not.toContain("createConnectionTool");
  });

  it("still offers OAuth sign-in when the provider confirms the grant is invalid", () => {
    expect(
      authToolFailure({ code: "oauth_reauth_required", message: "Invalid grant." }),
    ).toMatchObject({
      ok: false,
      error: {
        details: { recovery: { startOAuthTool: "executor.coreTools.oauth.start" } },
      },
    });
  });
});
