import { readFileSync } from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("self-host Dockerfile", () => {
  it("uses an exec-form healthcheck in the distroless runtime", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain("FROM gcr.io/distroless/cc-debian12 AS runtime");
    expect(dockerfile).toContain(
      `CMD ["bun", "-e", "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]`,
    );
    expect(dockerfile).toContain(
      "COPY --from=prod-deps /app/.selfhost-runtime/onepassword-core_bg.wasm /usr/local/bin/onepassword-core_bg.wasm",
    );
    expect(dockerfile).not.toContain(`CMD bun -e "fetch('http://127.0.0.1:4788/api/health')`);
  });
});
