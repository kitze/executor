import { describe, expect, it } from "@effect/vitest";

import { integrationHealthVerdict, worstHealthStatus } from "./health-display";

describe("worstHealthStatus", () => {
  it("orders expired above degraded above healthy", () => {
    expect(worstHealthStatus(["healthy", "degraded", "healthy"])).toBe("degraded");
    expect(worstHealthStatus(["degraded", "expired", "healthy"])).toBe("expired");
    expect(worstHealthStatus(["healthy", "healthy"])).toBe("healthy");
  });

  it("ignores unknown connections when aggregating", () => {
    expect(worstHealthStatus(["unknown", "healthy", "unknown"])).toBe("healthy");
    expect(worstHealthStatus(["unknown", "expired"])).toBe("expired");
  });

  it("has no verdict when nothing has been probed", () => {
    expect(worstHealthStatus([])).toBeNull();
    expect(worstHealthStatus(["unknown", "unknown"])).toBeNull();
  });
});

describe("integrationHealthVerdict", () => {
  it("maps integrations to the shared traffic-light semantics", () => {
    expect(integrationHealthVerdict("executor", [])).toEqual({
      status: "healthy",
      label: "Healthy",
    });
    expect(integrationHealthVerdict("unconnected", [])).toEqual({
      status: "expired",
      label: "Unconnected",
    });
    expect(integrationHealthVerdict("unchecked", ["unknown"])).toEqual({
      status: "degraded",
      label: "No health check",
    });
    expect(integrationHealthVerdict("partial", ["healthy", "unknown"])).toEqual({
      status: "degraded",
      label: "No health check",
    });
    expect(integrationHealthVerdict("broken", ["healthy", "expired"])).toEqual({
      status: "expired",
      label: "Expired",
    });
  });
});
