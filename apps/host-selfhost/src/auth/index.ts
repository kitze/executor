import { Layer } from "effect";

import { IdentityProvider } from "@executor-js/api/server";

import { loadConfig } from "../config";
import type { SelfHostDbHandle } from "../db/self-host-db";
import { BetterAuth, buildBetterAuth, type BetterAuthHandle } from "./better-auth";
import { makeBetterAuthIdentityLayer } from "./identity";
import {
  makeOAuthCallbackPrincipalResolver,
  type OAuthCallbackPrincipalResolver,
} from "./oauth-callback-principal";
import { consentRedirectClientId, withClientName, withForcedMcpConsent } from "./force-mcp-consent";
import { rewriteInvalidOrigin } from "./invalid-origin-help";
import { mcpTransitionJsonResponse } from "./mcp-transition-json";

export { BetterAuth, buildBetterAuth, type BetterAuthHandle } from "./better-auth";
export { betterAuthIdentityLayer, makeBetterAuthIdentityLayer } from "./identity";
export {
  makeOAuthCallbackPrincipalResolver,
  type OAuthCallbackPrincipalResolver,
} from "./oauth-callback-principal";

// ---------------------------------------------------------------------------
// Resolve the self-host auth providers.
//
// Build the Better Auth instance over the shared libSQL file, expose its
// `IdentityProvider` (cookie/bearer/api-key) and its web handler (mounted at
// /api/auth/*). Returns the live `BetterAuthHandle` so the composition root can
// build the account API and the Better Auth MCP OAuth seam.
//
// This is the one and only production auth path. Tests that need a fake identity
// (single-admin / header-driven) compose `ExecutorApp.make` directly through
// `makeSelfHostTestApp` (src/testing/test-app.ts) rather than passing through
// here, so this resolution is unconditional.
// ---------------------------------------------------------------------------

export interface ResolvedAuthProviders {
  /** The resolved Better Auth `IdentityProvider` seam (cookie/bearer/api-key). */
  readonly identityLayer: Layer.Layer<IdentityProvider>;
  /** Better Auth's web handler (`/api/auth/*`). */
  readonly authHandler: (request: Request) => Promise<Response>;
  /** The live Better Auth handle (account API + Better Auth MCP OAuth seam). */
  readonly betterAuth: BetterAuthHandle;
  /** Resolve a wrapped, unexpired OAuth callback state to its acting member. */
  readonly oauthCallbackPrincipalResolver: OAuthCallbackPrincipalResolver;
}

export const resolveAuthProviders = async (
  dbHandle: SelfHostDbHandle,
): Promise<ResolvedAuthProviders> => {
  const betterAuth = await buildBetterAuth(dbHandle.client);
  const betterAuthLayer = Layer.succeed(BetterAuth)(betterAuth);
  const oauthCallbackPrincipalResolver = makeOAuthCallbackPrincipalResolver({
    db: dbHandle,
    betterAuth,
  });

  // The consent redirect from Better Auth's authorize only carries the opaque
  // client_id; look the registered client_name up (its adapter sees the
  // just-written DCR row) so the approval screen reads "Connect Codex?" not a
  // random id. Self-declared at open DCR — a label, not a trust signal.
  const lookupClientName = async (clientId: string): Promise<string | null> => {
    const ctx = await betterAuth.auth.$context;
    const app = await ctx.adapter.findOne<{ name?: string | null }>({
      model: "oauthApplication",
      where: [{ field: "clientId", value: clientId }],
    });
    return app?.name ?? null;
  };

  // Force the MCP approval screen: inject `prompt=consent` on every MCP
  // authorize so a connecting client is gated on /mcp-consent rather than
  // silently granted a token (see ./force-mcp-consent), and enrich the
  // resulting consent redirect with the registered client name.
  const config = loadConfig();
  const authHandler = async (request: Request): Promise<Response> => {
    let response = await betterAuth.handler(withForcedMcpConsent(request));
    // Turn Better Auth's bare 403 "Invalid origin" into a setup instruction —
    // on a fresh deploy it almost always means the public URL needs configuring.
    const friendlier = await rewriteInvalidOrigin(request, response, config.webBaseUrl);
    if (friendlier) return friendlier;
    if (response.status === 302) {
      const clientId = consentRedirectClientId(response.headers.get("location"));
      if (clientId) {
        const name = await lookupClientName(clientId);
        if (name) {
          // Preserve the rest of the response — notably the session/consent
          // cookies and the tab bearer produced by Better Auth's hooks.
          const headers = new Headers(response.headers);
          headers.set("location", withClientName(response.headers.get("location")!, name));
          response = new Response(null, { status: 302, headers });
        }
      }
    }
    return mcpTransitionJsonResponse(request, response);
  };

  return {
    identityLayer: makeBetterAuthIdentityLayer(oauthCallbackPrincipalResolver).pipe(
      Layer.provide(betterAuthLayer),
    ),
    authHandler,
    betterAuth,
    oauthCallbackPrincipalResolver,
  };
};
