// Selfhost (browser, recorded): an MCP client starts authorization while the
// owner is signed out. One email/password sign-in must preserve and complete
// that exact request, including in an embedded browser that rejects cookies.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

interface AuthServerMetadata {
  readonly authorization_endpoint: string;
  readonly registration_endpoint: string;
}

interface RegisteredClient {
  readonly client_id: string;
}

interface AuthorizationRequest {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly state: string;
}

const prepareAuthorization = async (
  baseUrl: string,
  clientName: string,
): Promise<AuthorizationRequest> => {
  const metadataResponse = await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl));
  expect(metadataResponse.status, "the instance publishes MCP OAuth discovery").toBe(200);
  const metadata = (await metadataResponse.json()) as AuthServerMetadata;

  const redirectUri = new URL("/", baseUrl).toString();
  const registrationResponse = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201], "dynamic client registration succeeds").toContain(registrationResponse.status);
  const registered = (await registrationResponse.json()) as RegisteredClient;
  expect(registered.client_id, "the client receives an id to authorize").toBeTruthy();

  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set("client_id", registered.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("scope", "openid");

  return {
    authorizeUrl: authorizeUrl.toString(),
    clientId: registered.client_id,
    clientName,
    redirectUri,
    state,
  };
};

const assertLoginPreservedRequest = (url: URL, request: AuthorizationRequest): void => {
  expect(url.pathname, "authorization sends the signed-out owner to sign in").toBe("/login");
  expect(url.searchParams.get("client_id"), "login keeps the requesting client").toBe(
    request.clientId,
  );
  expect(url.searchParams.get("redirect_uri"), "login keeps the callback address").toBe(
    request.redirectUri,
  );
  expect(url.searchParams.get("state"), "login keeps the client's CSRF state").toBe(request.state);
};

const assertCallback = (url: URL, request: AuthorizationRequest): void => {
  expect(url.origin + url.pathname, "approval returns to the registered callback").toBe(
    request.redirectUri,
  );
  expect(url.searchParams.get("state"), "the original client state returns unchanged").toBe(
    request.state,
  );
  expect(url.searchParams.get("code"), "approval returns an authorization code").toBeTruthy();
};

scenario(
  "MCP OAuth · signing in once resumes a signed-out client's approval",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const owner = yield* target.newIdentity();
    const credentials = owner.credentials;
    if (!credentials) {
      return yield* Effect.die("self-host identity did not provide email/password credentials");
    }
    const request = yield* Effect.promise(() => prepareAuthorization(target.baseUrl, "Grok (MCP)"));

    yield* browser.session({ label: "signed-out MCP owner" }, async ({ page, step }) => {
      await step("Open Grok's authorization request while signed out", async () => {
        await page.goto(request.authorizeUrl, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 30_000 });
        assertLoginPreservedRequest(new URL(page.url()), request);
      });

      await step("Sign in once and return to Grok's approval screen", async () => {
        await page.getByLabel("Email").fill(credentials.email);
        await page.getByLabel("Password").fill(credentials.password);
        const consent = page.waitForURL((url) => url.pathname === "/mcp-consent", {
          timeout: 30_000,
        });
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await consent;
        await page.locator("#mcp-consent-allow").waitFor({ timeout: 30_000 });
        await page.getByText(`Connect ${request.clientName}?`).waitFor();
      });

      await step("Allow and return the authorization code to Grok", async () => {
        await page.locator("#mcp-consent-allow").click();
        await page.waitForURL((url) => url.searchParams.has("code"), { timeout: 30_000 });
        assertCallback(new URL(page.url()), request);
      });
    });
  }),
);

scenario(
  "MCP OAuth · cookie-blocked embedded login resumes and approves with the tab bearer",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const owner = yield* target.newIdentity();
    const credentials = owner.credentials;
    if (!credentials) {
      return yield* Effect.die("self-host identity did not provide email/password credentials");
    }
    const request = yield* Effect.promise(() =>
      prepareAuthorization(target.baseUrl, "Grok embedded (MCP)"),
    );

    yield* browser.session({ label: "cookie-blocked Grok owner" }, async ({ page, step }) => {
      // Grok's embedded browser can accept a navigation but reject every cookie
      // attached to the app's fetches. Install this before the login app loads,
      // matching the existing cookie-blocked login scenario.
      await page.addInitScript(() => {
        const browserFetch = window.fetch.bind(window);
        window.fetch = (input, init) =>
          browserFetch(input, {
            ...init,
            credentials: "omit",
          });
      });
      await page.context().clearCookies();

      await step("Open Grok's authorization request with no browser session", async () => {
        await page.goto(request.authorizeUrl, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Sign in" }).waitFor({ timeout: 30_000 });
        assertLoginPreservedRequest(new URL(page.url()), request);
      });

      await step("Sign in once even though the embedded browser rejects cookies", async () => {
        await page.getByLabel("Email").fill(credentials.email);
        await page.getByLabel("Password").fill(credentials.password);
        const consent = page.waitForURL((url) => url.pathname === "/mcp-consent", {
          timeout: 30_000,
        });
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await consent;
        await page.locator("#mcp-consent-allow").waitFor({ timeout: 30_000 });

        expect(
          await page.evaluate(() =>
            window.sessionStorage.getItem("executor.selfhost.sessionBearer"),
          ),
          "the full session bearer stays in this tab instead of a URL",
        ).toBeTruthy();
        const sessionCookies = (await page.context().cookies()).filter((cookie) =>
          cookie.name.includes("session_token"),
        );
        expect(sessionCookies, "the embedded browser retained no session cookie").toHaveLength(0);
      });

      await step("Allow with the tab bearer and return the code to Grok", async () => {
        const consentResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/auth/oauth2/consent" &&
            response.request().method() === "POST",
        );
        await page.locator("#mcp-consent-allow").click();
        const response = await consentResponse;
        expect(response.status(), "the cookie-free consent decision succeeds").toBe(200);
        expect(
          response.request().headers()["authorization"],
          "consent authenticates with the tab bearer",
        ).toMatch(/^Bearer .+/);
        expect(
          response.request().headers()["cookie"],
          "consent does not depend on a Cookie header",
        ).toBeUndefined();

        await page.waitForURL((url) => url.searchParams.has("code"), { timeout: 30_000 });
        assertCallback(new URL(page.url()), request);
      });
    });
  }),
);
