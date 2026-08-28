import { OAUTH_POPUP_MESSAGE_TYPE, popupDocument } from "@executor-js/api";
import { decodeOAuthCallbackState } from "@executor-js/sdk";

export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

interface SessionAuth {
  readonly api: {
    readonly getSession: (input: { readonly headers: Headers }) => Promise<unknown | null>;
  };
}

/**
 * Render a terminal popup error for an OAuth callback that has neither an
 * ordinary Better Auth session nor a valid state capability.
 *
 * A callback is no longer recoverable by sending it through `/login`: current
 * sessions carry their original actor in server-side state, while malformed,
 * expired, cancelled, and pre-binding sessions must fail before any code
 * exchange. Returning the canonical popup document keeps that failure visible
 * instead of silently canonicalizing `/login` back to the dashboard.
 */
export const oauthCallbackUnauthenticatedFailureDocument = async (
  request: Request,
  auth: SessionAuth,
  hasCallbackStateCapability = false,
): Promise<string | null> => {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.pathname !== OAUTH_CALLBACK_PATH) return null;

  // An OAuth provider's top-level callback navigation cannot carry an
  // embedded browser's partitioned cookie. A valid server-side state
  // capability is enough to reach the protected callback handler, which then
  // binds the normal execution scope to the original actor.
  if (hasCallbackStateCapability) return null;

  const session = await auth.api.getSession({ headers: request.headers });
  if (session) return null;

  const callbackState = url.searchParams.get("state");
  const sessionId = decodeOAuthCallbackState(callbackState)?.state ?? callbackState ?? "";
  return popupDocument(
    {
      type: OAUTH_POPUP_MESSAGE_TYPE,
      ok: false,
      sessionId,
      error: "OAuth session expired or not found",
    },
    OAUTH_POPUP_MESSAGE_TYPE,
  );
};
