import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { revisit, visit } from "../src/surfaces/browser";

const isAccountMe = (url: string): boolean => new URL(url).pathname === "/api/account/me";

scenario(
  "Authentication · self-host login survives a browser that rejects every session cookie",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();
    const email = identity.credentials?.email ?? "";
    const password = identity.credentials?.password ?? "";

    expect(email, "the self-host identity supplies login credentials").not.toBe("");
    expect(password, "the self-host identity supplies login credentials").not.toBe("");

    yield* browser.session({ label: "cookie-blocked" }, async ({ page, step }) => {
      // `credentials: omit` reproduces Codex's embedded browser: the sign-in
      // response succeeds, but Chromium refuses its Set-Cookie. Install before
      // the app loads so Better Auth and every API client see the same browser.
      await page.addInitScript(() => {
        const browserFetch = window.fetch.bind(window);
        window.fetch = (input, init) =>
          browserFetch(input, {
            ...init,
            credentials: "omit",
          });
      });
      await page.context().clearCookies();

      let sessionToken: string | null = null;

      await step("Open Executor with no browser session", async () => {
        await visit(page, "/");
        await page.getByRole("heading", { name: "Sign in" }).waitFor();
      });

      await step("Sign in while Chromium rejects the session cookie", async () => {
        await page.getByLabel("Email").fill(email);
        await page.getByLabel("Password").fill(password);

        const authenticatedMe = page.waitForResponse(
          (response) => isAccountMe(response.url()) && response.status() === 200,
        );
        await page.getByRole("button", { name: "Sign in" }).click();
        const me = await authenticatedMe;

        expect(
          me.request().headers()["authorization"],
          "the first authenticated account request uses the tab bearer",
        ).toMatch(/^Bearer .+/);
        expect(
          me.request().headers()["cookie"],
          "authentication does not depend on a Cookie header",
        ).toBeUndefined();
        await page.getByRole("link", { name: "Integrations" }).first().waitFor();

        sessionToken = await page.evaluate(() =>
          window.sessionStorage.getItem("executor.selfhost.sessionBearer"),
        );
        expect(sessionToken, "the opaque session is retained only in this tab").toBeTruthy();
        expect(page.url(), "the session credential never leaks into the URL").not.toContain(
          sessionToken ?? "__missing_session__",
        );

        const betterAuthCookies = (await page.context().cookies()).filter((cookie) =>
          cookie.name.includes("session_token"),
        );
        expect(betterAuthCookies, "Chromium accepted no Better Auth session cookie").toHaveLength(
          0,
        );
      });

      await step("Reload the tab and remain signed in without cookies", async () => {
        await page.context().clearCookies();
        const authenticatedMe = page.waitForResponse(
          (response) => isAccountMe(response.url()) && response.status() === 200,
        );
        await revisit(page);
        const me = await authenticatedMe;

        expect(me.request().headers()["authorization"]).toMatch(/^Bearer .+/);
        expect(me.request().headers()["cookie"]).toBeUndefined();
        await page.getByRole("link", { name: "Integrations" }).first().waitFor();
      });

      await step("Sign out and revoke the cookie-free session", async () => {
        await page.locator("aside").getByRole("button", { name: /Admin/ }).click();
        const signedOut = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/auth/sign-out",
        );
        await page.getByRole("menuitem", { name: "Sign out" }).click();
        expect((await signedOut).status(), "Better Auth revokes the bearer session").toBe(200);
        await page.getByRole("heading", { name: "Sign in" }).waitFor();

        expect(
          await page.evaluate(() =>
            window.sessionStorage.getItem("executor.selfhost.sessionBearer"),
          ),
          "sign-out clears the tab credential",
        ).toBeNull();
      });

      const replay = await page.request.get("/api/account/me", {
        headers: { authorization: `Bearer ${sessionToken ?? ""}` },
      });
      expect(replay.status(), "the signed-out bearer cannot be replayed").toBe(401);
    });
  }),
);
