import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";
import { serveOAuthTestServer } from "@executor-js/sdk/testing";

import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([openApiHttpPlugin()] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const isAccountMe = (url: string): boolean => new URL(url).pathname === "/api/account/me";

const BrowserOAuthStart = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("redirect"),
    authorizationUrl: Schema.String,
    state: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("connected") }),
]);
type BrowserOAuthStart = typeof BrowserOAuthStart.Type;

const decodeBrowserOAuthStart = Schema.decodeUnknownSync(BrowserOAuthStart);

const oauthIntegrationSpec = (oauth: {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}) =>
  ({
    spec: {
      kind: "blob" as const,
      value: JSON.stringify({
        openapi: "3.0.3",
        info: { title: "OAuth-protected API", version: "1.0.0" },
        paths: {
          "/me": {
            get: {
              operationId: "getMe",
              tags: ["default"],
              responses: { "200": { description: "the caller" } },
            },
          },
        },
      }),
    },
    baseUrl: "http://127.0.0.1:59999",
    authenticationTemplate: [
      {
        slug: "oauth",
        kind: "oauth2" as const,
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        scopes: ["read"],
      },
    ],
  }) as const;

const tokenRequests = (
  requests: ReadonlyArray<{
    readonly path: string;
    readonly method: string;
    readonly body: string;
  }>,
) => requests.filter((request) => request.path === "/token" && request.method === "POST");

const tokenExchangeRequests = (
  requests: ReadonlyArray<{
    readonly path: string;
    readonly method: string;
    readonly body: string;
  }>,
) =>
  tokenRequests(requests).filter((request) =>
    request.body.includes("grant_type=authorization_code"),
  );

// The e2e OAuth test server presents an HTTP-Basic consent endpoint. Drive
// exactly its two provider redirects, but stop before its callback so the test
// browser is the only client that can navigate Executor's callback URL.
const providerCallbackUrl = async (authorizationUrl: string): Promise<string> => {
  const authorize = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorize.status, "the provider asks the user to log in").toBe(302);
  const loginUrl = authorize.headers.get("location");

  const consent = await fetch(loginUrl ?? authorizationUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
    },
  });
  expect(consent.status, "provider consent redirects back to Executor").toBe(302);
  const callbackUrl = consent.headers.get("location");
  expect(callbackUrl, "provider consent supplies an Executor callback URL").toBeTruthy();
  return callbackUrl ?? "";
};

// The OAuth provider returns in a top-level navigation. That navigation has
// neither a tab-scoped Authorization bearer nor a cookie in a cookie-blocked
// embedded browser, so a valid state itself is the one-time server-side
// capability for the callback. It must complete directly: an old recovery
// flow incorrectly redirected this valid, signed-out callback through /login.
scenario(
  "OAuth callback · a valid signed-out self-host callback completes directly from state",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const oauth = yield* serveOAuthTestServer();
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = IntegrationSlug.make(unique("selfhostsignedoutcb"));
    yield* client.openapi.addSpec({
      payload: { ...oauthIntegrationSpec(oauth), slug: integration },
    });
    yield* Effect.addFinalizer(() =>
      client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
    );

    const clientSlug = OAuthClientSlug.make(unique("selfhostsignedoutc"));
    yield* client.oauth.createClient({
      payload: {
        owner: "org",
        slug: clientSlug,
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        grant: "authorization_code",
        clientId: "test-client",
        clientSecret: "test-secret",
      },
    });
    yield* Effect.addFinalizer(() =>
      client.oauth
        .removeClient({
          params: { slug: clientSlug },
          payload: { owner: "org" },
        })
        .pipe(Effect.ignore),
    );

    const connection = ConnectionName.make("main");
    yield* Effect.addFinalizer(() =>
      client.connections
        .remove({ params: { owner: "org", integration, name: connection } })
        .pipe(Effect.ignore),
    );

    const started = yield* client.oauth.start({
      payload: {
        client: clientSlug,
        clientOwner: "org",
        owner: "org",
        name: connection,
        integration,
        template: AuthTemplateSlug.make("oauth"),
      },
    });
    expect(started.status, "oauth.start begins at the provider").toBe("redirect");
    if (started.status !== "redirect") return yield* Effect.die("OAuth start did not redirect");

    const callbackUrl = yield* Effect.promise(() => providerCallbackUrl(started.authorizationUrl));
    const observedCallbackRequests: Array<{
      readonly method: string;
      readonly authorization: string | undefined;
      readonly cookie: string | undefined;
    }> = [];
    const observedCallbackResponses: Array<{
      readonly status: number;
      readonly location: string | undefined;
    }> = [];

    yield* browser.session({ label: "anonymous" }, async ({ page, step }) => {
      await page.context().clearCookies();
      page.context().on("request", (request) => {
        if (request.url() !== callbackUrl) return;
        observedCallbackRequests.push({
          method: request.method(),
          authorization: request.headers()["authorization"],
          cookie: request.headers()["cookie"],
        });
      });
      page.context().on("response", (response) => {
        if (response.url() !== callbackUrl) return;
        observedCallbackResponses.push({
          status: response.status(),
          location: response.headers()["location"],
        });
      });

      await step("Provider returns to Executor without a browser credential", async () => {
        const response = await page.goto(callbackUrl, { waitUntil: "commit" });
        expect(response?.status(), "the callback itself succeeds without a redirect").toBe(200);
        expect(
          response?.headers()["location"],
          "the callback does not send a signed-out user through login",
        ).toBeUndefined();
        await page.waitForFunction(() => document.title === "Connected", undefined, {
          timeout: 30_000,
        });
      });

      expect(new URL(page.url()).pathname, "the browser stays on the callback document").toBe(
        "/api/oauth/callback",
      );
      expect(await page.title(), "the callback renders its popup success page").toBe("Connected");
    });

    expect(
      observedCallbackRequests,
      "the initial state-authorized navigation is the only callback request",
    ).toEqual([
      {
        method: "GET",
        authorization: undefined,
        cookie: undefined,
      },
    ]);
    expect(
      observedCallbackResponses,
      "the callback itself is a single direct success response, never a login redirect",
    ).toEqual([{ status: 200, location: undefined }]);
    expect(
      tokenExchangeRequests(yield* oauth.requests),
      "the valid one-time state authorizes exactly one authorization-code exchange",
    ).toHaveLength(1);
  }).pipe(Effect.scoped),
);

// This is the user journey behind the reported embedded-browser failure:
// Better Auth mints a bearer but Chromium refuses every session cookie. The
// actual tab starts OAuth with that bearer; the provider popup later returns
// with neither credential. The direct callback must use only its persisted
// one-time state — it must not redirect to /login or make JavaScript replay the
// bearer into the callback URL.
scenario(
  "OAuth callback · a cookie-blocked self-host popup completes directly from OAuth state",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const browser = yield* Browser;
    const oauth = yield* serveOAuthTestServer();
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const integration = IntegrationSlug.make(unique("selfhostcookieblockedcb"));
    yield* client.openapi.addSpec({
      payload: { ...oauthIntegrationSpec(oauth), slug: integration },
    });
    yield* Effect.addFinalizer(() =>
      client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore),
    );

    const clientSlug = OAuthClientSlug.make(unique("selfhostcookieblockedc"));
    yield* client.oauth.createClient({
      payload: {
        owner: "org",
        slug: clientSlug,
        authorizationUrl: oauth.authorizationEndpoint,
        tokenUrl: oauth.tokenEndpoint,
        grant: "authorization_code",
        clientId: "test-client",
        clientSecret: "test-secret",
      },
    });
    yield* Effect.addFinalizer(() =>
      client.oauth
        .removeClient({
          params: { slug: clientSlug },
          payload: { owner: "org" },
        })
        .pipe(Effect.ignore),
    );

    const connection = ConnectionName.make("main");
    yield* Effect.addFinalizer(() =>
      client.connections
        .remove({ params: { owner: "org", integration, name: connection } })
        .pipe(Effect.ignore),
    );

    const anonymous = { label: "cookie-blocked-oauth-callback" };
    yield* browser.session(anonymous, async ({ page, step }) => {
      // `credentials: omit` reproduces Codex's embedded browser: Better Auth
      // can mint a session, but Chromium declines its Set-Cookie. Install it
      // before loading the app so sign-in and every app request see the same
      // constraint.
      await page.context().addInitScript(() => {
        const browserFetch = window.fetch.bind(window);
        window.fetch = (input, init) =>
          browserFetch(input, {
            ...init,
            credentials: "omit",
          });
      });
      await page.context().clearCookies();

      await step("Sign in while the embedded browser rejects Better Auth cookies", async () => {
        await visit(page, "/");
        await page.getByRole("heading", { name: "Sign in" }).waitFor();
        await page.getByLabel("Email").fill(identity.credentials!.email);
        await page.getByLabel("Password").fill(identity.credentials!.password);

        const authenticatedMe = page.waitForResponse(
          (response) => isAccountMe(response.url()) && response.status() === 200,
          { timeout: 30_000 },
        );
        await page.getByRole("button", { name: "Sign in" }).click();
        const me = await authenticatedMe;

        expect(
          me.request().headers()["authorization"],
          "the app uses its tab bearer for the first authenticated request",
        ).toMatch(/^Bearer .+/);
        expect(
          me.request().headers()["cookie"],
          "the authenticated request has no browser cookie",
        ).toBeUndefined();
        expect(
          await page.evaluate(() =>
            window.sessionStorage.getItem("executor.selfhost.sessionBearer"),
          ),
          "the opaque session is retained in the initiating tab",
        ).toBeTruthy();
        const betterAuthCookies = (await page.context().cookies()).filter((cookie) =>
          cookie.name.includes("session_token"),
        );
        expect(betterAuthCookies, "Chromium accepted no Better Auth session cookie").toHaveLength(
          0,
        );
        await page.getByRole("link", { name: "Integrations" }).first().waitFor();
      });

      await step("Start OAuth from the bearer-only browser tab", async () => {
        const sessionBearer = await page.evaluate(() =>
          window.sessionStorage.getItem("executor.selfhost.sessionBearer"),
        );
        expect(sessionBearer, "the initiating tab has a bearer for oauth.start").toBeTruthy();

        const startRequest = page.waitForRequest(
          (request) => {
            const url = new URL(request.url());
            return request.method() === "POST" && url.pathname === "/api/oauth/start";
          },
          { timeout: 30_000 },
        );
        const startResponse = await page.evaluate(
          async (payload) => {
            const bearer = window.sessionStorage.getItem("executor.selfhost.sessionBearer");
            const response = await fetch("/api/oauth/start", {
              method: "POST",
              credentials: "omit",
              headers: {
                authorization: `Bearer ${bearer ?? ""}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(payload),
            });
            return { status: response.status, body: await response.json() };
          },
          {
            client: String(clientSlug),
            clientOwner: "org",
            owner: "org",
            name: String(connection),
            integration: String(integration),
            template: "oauth",
          },
        );
        const request = await startRequest;
        expect(startResponse.status, "the bearer-only tab can start OAuth").toBe(200);
        expect(
          request.headers()["authorization"],
          "oauth.start receives the tab bearer rather than a cookie session",
        ).toBe(`Bearer ${sessionBearer}`);
        expect(
          request.headers()["cookie"],
          "oauth.start receives no browser cookie",
        ).toBeUndefined();

        const started: BrowserOAuthStart = decodeBrowserOAuthStart(startResponse.body);
        expect(started.status, "the browser start reaches the provider").toBe("redirect");
        if (started.status !== "redirect") return;

        // The emulator drives its HTTP Basic consent exchange and returns the
        // exact provider callback URL. Open that URL through an actual popup
        // link instead of navigating an `about:blank` window: it preserves the
        // top-level browser-navigation boundary that strips the tab bearer.
        const callbackUrl = await providerCallbackUrl(started.authorizationUrl);
        const observedCallbackRequests: Array<{
          readonly method: string;
          readonly authorization: string | undefined;
          readonly cookie: string | undefined;
        }> = [];
        const observedCallbackResponses: Array<{
          readonly status: number;
          readonly location: string | undefined;
        }> = [];
        page.context().on("request", (callbackRequest) => {
          if (callbackRequest.url() !== callbackUrl) return;
          observedCallbackRequests.push({
            method: callbackRequest.method(),
            authorization: callbackRequest.headers()["authorization"],
            cookie: callbackRequest.headers()["cookie"],
          });
        });
        page.context().on("response", (callbackResponse) => {
          if (callbackResponse.url() !== callbackUrl) return;
          observedCallbackResponses.push({
            status: callbackResponse.status(),
            location: callbackResponse.headers()["location"],
          });
        });

        await page.evaluate((url) => {
          const link = document.createElement("a");
          link.href = url;
          link.target = "oauth-callback";
          link.textContent = "Open OAuth callback";
          document.body.append(link);
        }, callbackUrl);
        const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
        await page.getByRole("link", { name: "Open OAuth callback" }).click();
        const popup = await popupPromise;
        await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 });
        await popup.waitForFunction(() => document.title === "Connected", undefined, {
          timeout: 30_000,
        });

        expect(
          observedCallbackRequests,
          "the popup callback is not replayed with a browser bearer",
        ).toEqual([
          {
            method: "GET",
            authorization: undefined,
            cookie: undefined,
          },
        ]);
        expect(
          observedCallbackResponses,
          "the valid state completes directly instead of redirecting through login",
        ).toEqual([{ status: 200, location: undefined }]);
        expect(await popup.title(), "the popup renders the connection success document").toBe(
          "Connected",
        );
      });
    });

    expect(
      tokenExchangeRequests(yield* oauth.requests),
      "the valid state authorizes exactly its one authorization-code exchange",
    ).toHaveLength(1);

    // A made-up state must be rejected before Executor can select an OAuth
    // client/token endpoint. It cannot turn this public callback into a
    // token-exchange oracle by supplying an attacker-controlled code.
    yield* oauth.clearRequests;
    const bogusCallback = yield* Effect.promise(async () => {
      const response = await fetch(
        new URL(
          "/api/oauth/callback?state=not-an-oauth-session&code=untrusted-code",
          target.baseUrl,
        ),
        { redirect: "manual" },
      );
      return {
        status: response.status,
        location: response.headers.get("location"),
        html: await response.text(),
      };
    });
    expect(bogusCallback.status, "a bogus state returns the callback failure document").toBe(200);
    expect(bogusCallback.location, "a bogus state does not redirect to login").toBeNull();
    expect(bogusCallback.html, "the bogus-state popup explains that connection failed").toContain(
      "<title>Connection failed</title>",
    );
    expect(
      tokenRequests(yield* oauth.requests),
      "a bogus state performs no token request",
    ).toHaveLength(0);

    // There is no clock-control surface in a black-box self-host run. Public
    // cancellation is the short way to make an issued state non-redeemable; it
    // reaches the same expired/not-found callback branch without waiting 15
    // minutes and proves an already-issued provider code stays unredeemed.
    const expired = yield* client.oauth.start({
      payload: {
        client: clientSlug,
        clientOwner: "org",
        owner: "org",
        name: ConnectionName.make("expired"),
        integration,
        template: AuthTemplateSlug.make("oauth"),
      },
    });
    expect(expired.status, "the expiring flow reaches the provider").toBe("redirect");
    if (expired.status !== "redirect") return yield* Effect.die("OAuth start did not redirect");
    const expiredCallbackUrl = yield* Effect.promise(() =>
      providerCallbackUrl(expired.authorizationUrl),
    );
    yield* client.oauth.cancel({ payload: { state: expired.state } });
    yield* oauth.clearRequests;

    const expiredCallback = yield* Effect.promise(async () => {
      const response = await fetch(expiredCallbackUrl, {
        redirect: "manual",
      });
      return {
        status: response.status,
        location: response.headers.get("location"),
        html: await response.text(),
      };
    });
    expect(expiredCallback.status, "an expired state returns the callback failure document").toBe(
      200,
    );
    expect(expiredCallback.location, "an expired state does not redirect to login").toBeNull();
    expect(
      expiredCallback.html,
      "the expired-state popup explains that connection failed",
    ).toContain("<title>Connection failed</title>");
    expect(
      tokenRequests(yield* oauth.requests),
      "an expired state performs no token request",
    ).toHaveLength(0);
  }).pipe(Effect.scoped),
);
