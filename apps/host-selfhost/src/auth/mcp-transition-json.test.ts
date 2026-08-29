import { describe, expect, it } from "@effect/vitest";

import { MCP_TRANSITION_JSON_HEADER, mcpTransitionJsonResponse } from "./mcp-transition-json";

const request = (headers?: HeadersInit): Request =>
  new Request("https://executor.test/api/auth/sign-in/email", { headers });

const consentRedirect = (location: string): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location,
      "set-auth-token": "signed-session-token",
      "set-cookie": "better-auth.session_token=signed-session-token; HttpOnly",
    },
  });

describe("mcpTransitionJsonResponse", () => {
  it("represents an opted-in same-origin consent redirect as JSON", async () => {
    const response = mcpTransitionJsonResponse(
      request({ [MCP_TRANSITION_JSON_HEADER]: "json" }),
      consentRedirect("/mcp-consent?consent_code=code&client_id=client"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(await response.json()).toEqual({
      redirect: false,
      url: "/mcp-consent?consent_code=code&client_id=client",
      token: "signed-session-token",
    });
  });

  it("can represent a bearer-authenticated authorize redirect with no new token", async () => {
    const response = mcpTransitionJsonResponse(
      request({ [MCP_TRANSITION_JSON_HEADER]: "json" }),
      new Response(null, {
        status: 302,
        headers: { location: "/mcp-consent?consent_code=code" },
      }),
    );

    expect(await response.json()).toEqual({
      redirect: false,
      url: "/mcp-consent?consent_code=code",
    });
  });

  it("leaves redirects untouched without opt-in or for an unsafe target", () => {
    const redirect = consentRedirect("/mcp-consent?consent_code=code");
    expect(mcpTransitionJsonResponse(request(), redirect)).toBe(redirect);

    const crossOrigin = consentRedirect("https://attacker.test/mcp-consent?consent_code=code");
    expect(
      mcpTransitionJsonResponse(request({ [MCP_TRANSITION_JSON_HEADER]: "json" }), crossOrigin),
    ).toBe(crossOrigin);

    const lookalike = consentRedirect("/mcp-consent/extra?consent_code=code");
    expect(
      mcpTransitionJsonResponse(request({ [MCP_TRANSITION_JSON_HEADER]: "json" }), lookalike),
    ).toBe(lookalike);
  });
});
