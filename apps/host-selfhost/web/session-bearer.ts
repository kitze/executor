import {
  getExecutorServerConnection,
  setExecutorServerConnection,
} from "@executor-js/react/api/server-connection";

// Better Auth normally keeps the browser signed in with its HttpOnly cookie.
// Some embedded browsers reject every cookie, though, so retain the opaque
// session token in this tab as a fallback and let the shared API clients send
// it as a bearer credential. sessionStorage survives the hard navigation after
// sign-in but is discarded with the tab; never put this credential in a URL or
// persistent storage.
const STORAGE_KEY = "executor.selfhost.sessionBearer";

const readStoredToken = (): string | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: browser storage can throw when disabled or unavailable
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
};

const writeStoredToken = (token: string): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: browser storage can throw when disabled or unavailable
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, token);
  } catch {
    // Best effort: the bearer remains active until the next page navigation.
  }
};

const removeStoredToken = (): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: browser storage can throw when disabled or unavailable
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Best effort: the server-side sign-out still revokes the session.
  }
};

const applySessionBearer = (token: string): void => {
  const connection = getExecutorServerConnection();
  setExecutorServerConnection({ ...connection, auth: { kind: "bearer", token } });
};

export const persistSessionBearer = (token: string): void => {
  writeStoredToken(token);
  applySessionBearer(token);
};

export const bootstrapSessionBearer = (): void => {
  const token = readStoredToken();
  if (token) applySessionBearer(token);
};

export const sessionBearerAuthorizationHeader = (): string | null => {
  const token = readStoredToken();
  return token ? `Bearer ${token}` : null;
};

export const clearSessionBearer = (): void => {
  removeStoredToken();

  const connection = getExecutorServerConnection();
  if (connection.auth?.kind !== "bearer") return;
  const { auth: _auth, ...withoutAuth } = connection;
  setExecutorServerConnection(withoutAuth);
};
