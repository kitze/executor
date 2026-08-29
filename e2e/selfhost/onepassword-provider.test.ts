// Selfhost-only (browser, recorded): the dedicated-vault 1Password provider
// is shipped in the self-host console and ready for its service-account token.
// This deliberately stops before entering a credential: the recording proves
// availability without putting a secret into an e2e artifact.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";
import { clickToReveal, visit } from "../src/surfaces/browser";

scenario(
  "1Password · self-host exposes a dedicated-vault provider without storing a token",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const identity = yield* target.newIdentity();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("Open the self-host credential providers", async () => {
        await visit(page, "/default/secrets");
        await page.getByRole("heading", { name: "Providers" }).waitFor({ timeout: 30_000 });
        await page.getByText("1Password credential provider.", { exact: true }).waitFor();
      });

      await step("Open the dedicated-vault 1Password setup", async () => {
        const dialog = page.getByRole("dialog", { name: "Connect 1Password" });
        await clickToReveal(page.getByRole("button", { name: "Add 1Password" }), dialog);

        await dialog.getByRole("heading", { name: "Connect 1Password" }).waitFor();
        expect(await dialog.getByPlaceholder("my.1password.com").inputValue()).toBe("");
        await dialog.getByRole("combobox").click();
        await page.getByRole("option", { name: "Service Account" }).click();
        await dialog.getByText("Service account token", { exact: true }).waitFor();
        expect(await dialog.getByPlaceholder("ops_...").getAttribute("type")).toBe("password");
        expect(
          await dialog.getByText("Vaults", { exact: true }).count(),
          "the setup includes a vault selector",
        ).toBe(1);
      });
    });
  }),
);
