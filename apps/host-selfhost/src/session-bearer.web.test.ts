import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  getExecutorServerAuthorizationHeader,
  setExecutorServerConnection,
} from "@executor-js/react/api/server-connection";

import {
  bootstrapSessionBearer,
  clearSessionBearer,
  persistSessionBearer,
  sessionBearerAuthorizationHeader,
} from "../web/session-bearer";

const values = new Map<string, string>();

const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};

const blockedStorageAccess = (): never => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test fixture reproduces the throwing browser Storage API
  throw new DOMException("blocked");
};

const resetConnection = (): void => {
  setExecutorServerConnection({ kind: "http", origin: "https://executor.test" });
};

beforeEach(() => {
  values.clear();
  resetConnection();
  vi.stubGlobal("sessionStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetConnection();
});

describe("self-host session bearer", () => {
  it("survives a same-tab reload and bootstraps API authorization", () => {
    persistSessionBearer("session-token");
    expect(sessionBearerAuthorizationHeader()).toBe("Bearer session-token");
    expect(getExecutorServerAuthorizationHeader()).toBe("Bearer session-token");

    resetConnection();
    expect(getExecutorServerAuthorizationHeader()).toBeNull();

    bootstrapSessionBearer();
    expect(getExecutorServerAuthorizationHeader()).toBe("Bearer session-token");
  });

  it("clears both tab storage and the active bearer", () => {
    persistSessionBearer("session-token");
    clearSessionBearer();

    expect(sessionBearerAuthorizationHeader()).toBeNull();
    expect(getExecutorServerAuthorizationHeader()).toBeNull();
  });

  it("keeps working in memory when browser storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: blockedStorageAccess,
      setItem: blockedStorageAccess,
      removeItem: blockedStorageAccess,
    });

    expect(() => persistSessionBearer("session-token")).not.toThrow();
    expect(getExecutorServerAuthorizationHeader()).toBe("Bearer session-token");
    expect(sessionBearerAuthorizationHeader()).toBeNull();
    expect(() => clearSessionBearer()).not.toThrow();
    expect(getExecutorServerAuthorizationHeader()).toBeNull();
  });
});
