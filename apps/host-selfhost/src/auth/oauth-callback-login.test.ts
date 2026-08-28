import { describe, expect, it } from "@effect/vitest";

import { oauthCallbackUnauthenticatedFailureDocument } from "./oauth-callback-login";

const auth = (session: unknown | null) => ({
  api: {
    getSession: async () => session,
  },
});

describe("oauthCallbackUnauthenticatedFailureDocument", () => {
  it("renders the canonical popup failure for an unauthenticated invalid callback", async () => {
    const html = await oauthCallbackUnauthenticatedFailureDocument(
      new Request("http://selfhost.test/api/oauth/callback?state=s1&code=c1"),
      auth(null),
    );

    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("OAuth session expired or not found");
  });

  it("does not intercept a signed-in OAuth callback", async () => {
    await expect(
      oauthCallbackUnauthenticatedFailureDocument(
        new Request("http://selfhost.test/api/oauth/callback?state=s1&code=c1"),
        auth({ user: { id: "user_1" } }),
      ),
    ).resolves.toBeNull();
  });

  it("does not intercept a callback authenticated by a server-side state capability", async () => {
    await expect(
      oauthCallbackUnauthenticatedFailureDocument(
        new Request("http://selfhost.test/api/oauth/callback?state=s1&code=c1"),
        auth(null),
        true,
      ),
    ).resolves.toBeNull();
  });

  it("ignores other paths and non-browser methods", async () => {
    await expect(
      oauthCallbackUnauthenticatedFailureDocument(
        new Request("http://selfhost.test/api/oauth/callback?state=s1", { method: "POST" }),
        auth(null),
      ),
    ).resolves.toBeNull();
    await expect(
      oauthCallbackUnauthenticatedFailureDocument(
        new Request("http://selfhost.test/api/oauth/callback/extra?state=s1"),
        auth(null),
      ),
    ).resolves.toBeNull();
  });
});
