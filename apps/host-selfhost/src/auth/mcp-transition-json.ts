// Browser Fetch intentionally hides manual redirect status and Location, even
// for same-origin requests. The self-host login page needs both the consent
// target and the session bearer when Better Auth turns a successful sign-in
// into an MCP consent redirect, so its two same-origin requests opt into this
// small JSON representation at the serving boundary.

export const MCP_TRANSITION_JSON_HEADER = "x-executor-mcp-transition";

const MCP_CONSENT_PATH = "/mcp-consent";

export const mcpTransitionJsonResponse = (request: Request, response: Response): Response => {
  if (request.headers.get(MCP_TRANSITION_JSON_HEADER) !== "json") return response;
  if (response.status !== 302) return response;

  const location = response.headers.get("location");
  const requestOrigin = new URL(request.url).origin;
  if (!location || !URL.canParse(location, requestOrigin)) return response;
  const target = new URL(location, requestOrigin);
  if (target.origin !== requestOrigin || target.pathname !== MCP_CONSENT_PATH) return response;

  const token = response.headers.get("set-auth-token");
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("location");
  headers.set("content-type", "application/json");
  return new Response(
    JSON.stringify({
      redirect: false,
      url: `${target.pathname}${target.search}`,
      ...(token ? { token } : {}),
    }),
    { status: 200, headers },
  );
};
