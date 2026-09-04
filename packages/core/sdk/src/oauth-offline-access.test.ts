import { describe, expect, it } from "@effect/vitest";

import { withOfflineAccessIfAdvertised } from "./oauth-service";

// RFC 9728 protected-resource metadata lists RESOURCE scopes only; the
// authorization-server lifecycle scope `offline_access` never appears there.
// Servers built on better-auth's OIDC provider (Glink among them) issue a
// refresh token ONLY when `offline_access` is requested, so a client that asks
// for exactly the PRM list gets a one-hour access token with no way to renew it.
// The service therefore appends `offline_access` when the AS advertises it.
describe("withOfflineAccessIfAdvertised", () => {
  const resourceScopes = ["glink:read", "glink:write"];

  it("appends offline_access when the AS advertises it and the refresh_token grant", () => {
    expect(
      withOfflineAccessIfAdvertised(resourceScopes, {
        scopes_supported: ["openid", "offline_access", "glink:read", "glink:write"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      }),
    ).toEqual(["glink:read", "glink:write", "offline_access"]);
  });

  it("appends offline_access when the AS is silent on grant types (RFC 8414 default includes refresh_token)", () => {
    expect(
      withOfflineAccessIfAdvertised(resourceScopes, {
        scopes_supported: ["offline_access"],
      }),
    ).toEqual(["glink:read", "glink:write", "offline_access"]);
  });

  it("leaves scopes untouched when the AS does not advertise offline_access", () => {
    expect(
      withOfflineAccessIfAdvertised(resourceScopes, {
        scopes_supported: ["glink:read", "glink:write"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      }),
    ).toEqual(resourceScopes);
  });

  it("leaves scopes untouched when the AS advertises offline_access but not the refresh_token grant", () => {
    expect(
      withOfflineAccessIfAdvertised(resourceScopes, {
        scopes_supported: ["offline_access"],
        grant_types_supported: ["authorization_code"],
      }),
    ).toEqual(resourceScopes);
  });

  it("leaves scopes untouched when no AS metadata is readable", () => {
    expect(withOfflineAccessIfAdvertised(resourceScopes, null)).toEqual(resourceScopes);
  });

  it("does not duplicate offline_access when the resource already lists it", () => {
    const already = ["glink:read", "offline_access"];
    expect(
      withOfflineAccessIfAdvertised(already, {
        scopes_supported: ["offline_access"],
        grant_types_supported: ["refresh_token"],
      }),
    ).toEqual(already);
  });
});
