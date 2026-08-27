import { describe, expect, it } from "@effect/vitest";
import { ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import {
  connectionHealthProbeKey,
  HEALTH_REVALIDATE_MS,
  nextConnectionHealthRevalidationAt,
} from "./use-connection-health";

describe("connectionHealthProbeKey", () => {
  it("keeps valid colon-containing tuples distinct", () => {
    const left = connectionHealthProbeKey({
      owner: "org",
      integration: IntegrationSlug.make("a:b"),
      name: ConnectionName.make("c"),
    });
    const right = connectionHealthProbeKey({
      owner: "org",
      integration: IntegrationSlug.make("a"),
      name: ConnectionName.make("b:c"),
    });

    expect(left).not.toBe(right);
  });
});

describe("nextConnectionHealthRevalidationAt", () => {
  it("checks an unseen connection immediately", () => {
    expect(nextConnectionHealthRevalidationAt(null)).toBe(0);
  });

  it("schedules every verdict from its checked epoch", () => {
    expect(nextConnectionHealthRevalidationAt({ status: "expired", checkedAt: 1_000 })).toBe(
      1_000 + HEALTH_REVALIDATE_MS,
    );
    expect(nextConnectionHealthRevalidationAt({ status: "healthy", checkedAt: 2_000 })).toBe(
      2_000 + HEALTH_REVALIDATE_MS,
    );
  });

  it("backs off from the latest attempt even when it failed or returned cached data", () => {
    expect(nextConnectionHealthRevalidationAt(null, 3_000)).toBe(3_000 + HEALTH_REVALIDATE_MS);
    expect(nextConnectionHealthRevalidationAt({ status: "healthy", checkedAt: 2_000 }, 4_000)).toBe(
      4_000 + HEALTH_REVALIDATE_MS,
    );
  });
});
