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
  it("keeps the built-in Executor integration green", () => {
    expect(integrationHealthVerdict("executor", [])).toEqual({
      status: "healthy",
      label: "Healthy",
    });
  });

  it("classifies unconnected and unchecked integrations for the traffic light", () => {
    expect(integrationHealthVerdict("stripe", [])).toEqual({
      status: "expired",
      label: "Unconnected",
    });
    expect(integrationHealthVerdict("stripe", ["unknown"])).toEqual({
      status: "degraded",
      label: "No health check",
    });
    expect(integrationHealthVerdict("stripe", ["healthy", "unknown"])).toEqual({
      status: "degraded",
      label: "No health check",
    });
  });

  it("uses the worst known connection verdict", () => {
    expect(integrationHealthVerdict("stripe", ["healthy", "expired"])).toEqual({
      status: "expired",
      label: "Expired",
    });
    expect(integrationHealthVerdict("stripe", ["healthy", "degraded"])).toEqual({
      status: "degraded",
      label: "Degraded",
    });
  });
});
