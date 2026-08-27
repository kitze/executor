// A rotating refresh token is single-use. Two overlapping self-host requests
// must therefore share one refresh grant even though each request builds a
// fresh Executor instance. If they submit the same old token independently,
// the loser gets invalid_grant and providers may revoke the winner's whole
// token family.
//
// This scenario connects a delegated Microsoft Graph account against a
// per-run hosted @executor-js/emulate instance. The emulator rotates refresh
// tokens and records every request. Two simultaneous executions are then made
// to receive delayed 401s; both recover, while the ledger proves that exactly
// one refresh grant reached the provider.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { connectEmulator, type EmulatorClient, type IssuedCredential } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-openapi/providers/microsoft";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { createEmulatorInstance } from "../src/emulator-instance";
import { scenario } from "../src/scenario";
import { Api, Browser, Target } from "../src/services";
import { visit } from "../src/surfaces/browser";

const api = composePluginApi([
  openApiHttpPlugin({ presets: microsoftCatalog, specFormats: [microsoftGraphAdapter] }),
] as const);

const unique = (prefix: string) => `${prefix}_${randomBytes(4).toString("hex")}`;

const decodeHtml = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const inputFields = (html: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) fields[decodeHtml(name)] = decodeHtml(value);
  }
  return fields;
};

const formAction = (html: string, fallback: string): string => {
  const action = html.match(/<form\b[^>]*\baction=["']([^"']+)["']/i)?.[1];
  return action ? decodeHtml(action) : fallback;
};

const completeMicrosoftConsent = (authorizationUrl: string) =>
  Effect.promise(async () => {
    const page = await fetch(authorizationUrl);
    if (!page.ok) throw new Error(`Microsoft emulator authorize failed: ${page.status}`);
    const html = await page.text();
    const callback = await fetch(formAction(html, authorizationUrl), {
      method: "POST",
      body: new URLSearchParams(inputFields(html)),
      redirect: "manual",
    });
    const location = callback.headers.get("location");
    if (callback.status !== 302 || !location) {
      throw new Error(`Microsoft emulator consent did not redirect: ${callback.status}`);
    }
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error("Microsoft emulator callback did not include a code");
    return code;
  });

const requireOAuthClientCredential = (credential: IssuedCredential) =>
  Effect.gen(function* () {
    if (
      credential.client_id &&
      credential.client_secret &&
      credential.authorization_url &&
      credential.token_url
    ) {
      return {
        clientId: credential.client_id,
        clientSecret: credential.client_secret,
        authorizationUrl: credential.authorization_url,
        tokenUrl: credential.token_url,
      };
    }
    return yield* Effect.die("Microsoft emulator returned incomplete OAuth client credentials.");
  });

const graphOperationCode = (integration: string, query: string, toolSuffix: string) => `
const found = await tools.search({ namespace: ${JSON.stringify(integration)}, query: ${JSON.stringify(query)}, limit: 20 });
const item = found.items.find((candidate) => candidate.path.endsWith(${JSON.stringify(toolSuffix)}));
if (!item) return { ok: false, error: ${JSON.stringify(`${toolSuffix} tool not found`)}, found };
let callable = tools;
for (const segment of item.path.split(".")) callable = callable[segment];
const result = await callable({});
return { ok: result.ok, path: item.path, result: result.ok ? result.data : result.error };
`;

const LIST_USERS_OPERATION = "graphUser_List";
const GET_MY_PROFILE_OPERATION = "graphUser_GetMyProfile";
const CONCURRENT_OPERATIONS = [LIST_USERS_OPERATION, GET_MY_PROFILE_OPERATION] as const;

const refreshRequests = (ledger: Awaited<ReturnType<EmulatorClient["ledger"]["list"]>>) =>
  ledger.filter(
    (entry) =>
      entry.path === "/oauth2/v2.0/token" &&
      (entry.request.body as { readonly grant_type?: string } | undefined)?.grant_type ===
        "refresh_token",
  );

scenario(
  "OAuth refresh · simultaneous self-host requests share one rotating-token grant",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(api, identity);

    const emulatorBase = yield* createEmulatorInstance("microsoft", "oauth-refresh-race");
    const emulator = yield* Effect.promise(() =>
      connectEmulator({ baseUrl: emulatorBase, service: "microsoft" }),
    );
    const redirectUri = new URL("/api/oauth/callback", target.baseUrl).toString();
    const credential = yield* Effect.promise(() =>
      emulator.credentials.mint({
        type: "oauth-authorization-code",
        name: "Executor refresh concurrency",
        redirect_uris: [redirectUri],
      }),
    );
    const oauth = yield* requireOAuthClientCredential(credential);

    const integration = IntegrationSlug.make(unique("ms_refresh_race"));
    const oauthClient = OAuthClientSlug.make(unique("ms_refresh_app"));
    const connection = ConnectionName.make("main");

    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* client.openapi.addSpec({
          payload: {
            spec: { kind: "url", url: emulator.openapiUrl },
            slug: integration,
            name: "Microsoft Graph refresh concurrency",
            baseUrl: emulator.baseUrl,
            family: "microsoft",
            authenticationTemplate: [
              {
                slug: MICROSOFT_AUTH_TEMPLATE_SLUG,
                kind: "oauth2",
                authorizationUrl: oauth.authorizationUrl,
                tokenUrl: oauth.tokenUrl,
                scopes: ["openid", "email", "profile", "offline_access", "User.Read"],
              },
            ],
          },
        });

        yield* client.oauth.createClient({
          payload: {
            owner: "org",
            slug: oauthClient,
            grant: "authorization_code",
            authorizationUrl: oauth.authorizationUrl,
            tokenUrl: oauth.tokenUrl,
            clientId: oauth.clientId,
            clientSecret: oauth.clientSecret,
            originIntegration: integration,
          },
        });

        const started = yield* client.oauth.start({
          payload: {
            client: oauthClient,
            clientOwner: "org",
            owner: "org",
            name: connection,
            integration,
            template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          },
        });
        expect(started.status, "OAuth starts with an emulator redirect").toBe("redirect");
        if (started.status !== "redirect") return yield* Effect.die("OAuth did not redirect");

        const code = yield* completeMicrosoftConsent(started.authorizationUrl);
        const completed = yield* client.oauth.complete({
          payload: { state: started.state, code },
        });
        expect(completed.integration, "OAuth completion creates the Graph connection").toBe(
          integration,
        );
        const visibleConnectionLabel = completed.identityLabel ?? String(connection);

        const listUsers = graphOperationCode(String(integration), "list users", "graphUserList");
        const getMyProfile = graphOperationCode(
          String(integration),
          "signed-in user profile",
          "graphUserGetMyProfile",
        );
        const execute = (code: string) => client.executions.execute({ payload: { code } });
        const baseline = yield* execute(listUsers);
        expect(baseline.status, "the freshly connected account can list users").toBe("completed");
        if (baseline.status !== "completed") return yield* Effect.die("baseline did not complete");
        expect(baseline.isError, baseline.text).toBe(false);
        expect((JSON.parse(baseline.text) as { readonly ok?: boolean }).ok, baseline.text).toBe(
          true,
        );

        yield* Effect.promise(() => emulator.ledger.clear());
        yield* Effect.promise(() =>
          Promise.all(
            CONCURRENT_OPERATIONS.map((operationId) =>
              emulator.faults.arm({
                match: { operationId },
                response: {
                  status: 401,
                  body: {
                    error: {
                      code: "InvalidAuthenticationToken",
                      message: "The access token is no longer accepted.",
                    },
                  },
                },
                // Hold both original requests at the auth wall while the test
                // confirms that each operation consumed its own fault. A retry
                // cannot consume the other caller's operation-specific fault.
                delayMs: 5_000,
              }),
            ),
          ),
        );

        const listUsersFiber = yield* Effect.forkChild(execute(listUsers));
        const getMyProfileFiber = yield* Effect.forkChild(execute(getMyProfile));
        const executionFibers = [listUsersFiber, getMyProfileFiber] as const;
        const remainingFaults = yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const faults = await emulator.faults.list();
            if (faults.length === 0) return faults;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return emulator.faults.list();
        });
        expect(
          remainingFaults,
          "both original calls reached their delayed auth walls before either retried",
        ).toHaveLength(0);

        const results = yield* Effect.all(
          executionFibers.map((fiber) => Fiber.join(fiber)),
          {
            concurrency: "unbounded",
          },
        );
        for (const result of results) {
          expect(result.status, "both simultaneous executions complete").toBe("completed");
          if (result.status !== "completed") continue;
          expect(result.isError, result.text).toBe(false);
          const parsed = JSON.parse(result.text) as { readonly ok?: boolean };
          expect(parsed.ok, result.text).toBe(true);
        }

        const ledger = yield* Effect.promise(() => emulator.ledger.list());
        for (const operationId of CONCURRENT_OPERATIONS) {
          expect(
            ledger.filter(
              (entry) => entry.operationId === operationId && entry.response.status === 401,
            ),
            `${operationId} independently reached the upstream auth wall`,
          ).toHaveLength(1);
        }
        expect(
          refreshRequests(ledger),
          "the two request-created Executors coalesced onto one rotating-token grant",
        ).toHaveLength(1);
        for (const operationId of CONCURRENT_OPERATIONS) {
          expect(
            ledger.filter(
              (entry) => entry.operationId === operationId && entry.response.status === 200,
            ),
            `${operationId} retried successfully with the shared new access token`,
          ).toHaveLength(1);
        }

        const health = yield* client.connections.checkHealth({
          params: { owner: "org", integration, name: connection },
          query: { ifStaleMs: 0 },
        });
        expect(health.status, health.detail).toBe("healthy");

        const finalCall = yield* execute(listUsers);
        expect(finalCall.status, "a later execution completes").toBe("completed");
        if (finalCall.status !== "completed")
          return yield* Effect.die("final call did not complete");
        expect(finalCall.isError, finalCall.text).toBe(false);
        expect((JSON.parse(finalCall.text) as { readonly ok?: boolean }).ok, finalCall.text).toBe(
          true,
        );
        const finalLedger = yield* Effect.promise(() => emulator.ledger.list());
        expect(
          refreshRequests(finalLedger),
          "later calls reuse the saved rotated grant instead of refreshing again",
        ).toHaveLength(1);

        yield* browser.session(identity, async ({ page, step }) => {
          const connections = page.locator("section").filter({
            has: page.getByRole("heading", { level: 3, name: "Connections" }),
          });

          await step("Open the connection after two simultaneous requests", async () => {
            await visit(page, `/integrations/${integration}`);
            await connections.getByText(visibleConnectionLabel, { exact: true }).waitFor();
          });

          await step("The rotating-token connection remains healthy", async () => {
            await connections.getByLabel("Status: Healthy").waitFor({ timeout: 30_000 });
          });
        });
      }),
      Effect.gen(function* () {
        yield* Effect.promise(() => emulator.faults.clear()).pipe(Effect.ignore);
        yield* client.connections
          .remove({ params: { owner: "org", integration, name: connection } })
          .pipe(Effect.ignore);
        yield* client.oauth
          .removeClient({ params: { slug: oauthClient }, payload: { owner: "org" } })
          .pipe(Effect.ignore);
        yield* client.openapi.removeSpec({ params: { slug: integration } }).pipe(Effect.ignore);
      }).pipe(Effect.ignore),
    );
  }),
);
