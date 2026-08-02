/* oxlint-disable executor/no-try-catch-or-throw -- boundary: the host-only Coolify transport wraps throwing URL/fetch/JSON APIs and reduces every upstream failure to one stable observation code */

import { ReleaseEvidenceError } from "./protocol";
import type { CoolifyApplicationApi } from "./coolify-observer";

/**
 * Fixed endpoint paths for Coolify's Application API. Hosts can override a
 * path builder during an upstream API migration, but callers cannot supply a
 * URL, operation name, headers, or request body.
 */
export interface CoolifyEndpointPaths {
  readonly application: (uuid: string) => string;
  readonly deployments: (input: {
    readonly uuid: string;
    readonly skip: number;
    readonly take: number;
  }) => string;
  readonly deployment: (uuid: string) => string;
  /**
   * Coolify's control-plane runtime-image inspection for one deployment. The
   * observer fails closed when this fixed read capability is unavailable.
   */
  readonly deploymentRuntimeImage: (uuid: string) => string;
  readonly environments: (uuid: string) => string;
}

export interface CreateCoolifyHttpApplicationApiOptions {
  readonly baseUrl: string;
  /** Host-held Coolify API token. It is never returned or logged. */
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly paths?: Partial<CoolifyEndpointPaths>;
}

const defaultPaths: CoolifyEndpointPaths = {
  application: (uuid) => `/api/v1/applications/${encodeURIComponent(uuid)}`,
  deployments: ({ uuid, skip, take }) => {
    const params = new URLSearchParams({ uuid, skip: String(skip), take: String(take) });
    return `/api/v1/deployments?${params.toString()}`;
  },
  deployment: (uuid) => `/api/v1/deployments/${encodeURIComponent(uuid)}`,
  deploymentRuntimeImage: (uuid) => `/api/v1/deployments/${encodeURIComponent(uuid)}/runtime-image`,
  environments: (uuid) => `/api/v1/applications/${encodeURIComponent(uuid)}/envs`,
};

const resolvedBaseUrl = (value: string): URL => {
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    throw new ReleaseEvidenceError("invalid-request");
  }
  // A bearer token must never follow an untrusted redirect or ride a URL with
  // embedded credentials. HTTP is intentionally rejected here; use HTTPS at
  // the host boundary, including for the private Coolify control plane.
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  return base;
};

const stableUpstreamFailure = (): never => {
  throw new ReleaseEvidenceError("observation-unavailable");
};

/**
 * Host-side adapter only. It reads a raw JSON response into memory and returns
 * it directly to the reducer; no raw object reaches a sandbox, log, trace, or
 * HTTP result. Non-OK bodies are deliberately not read at all.
 */
export const createCoolifyHttpApplicationApi = (
  options: CreateCoolifyHttpApplicationApiOptions,
): CoolifyApplicationApi => {
  const base = resolvedBaseUrl(options.baseUrl);
  const token = options.token;
  if (token.length < 16) throw new ReleaseEvidenceError("invalid-request");
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new ReleaseEvidenceError("invalid-request");
  const paths: CoolifyEndpointPaths = { ...defaultPaths, ...options.paths };

  const get = async (path: string): Promise<unknown> => {
    let target: URL;
    try {
      target = new URL(path, base);
      if (target.origin !== base.origin) return stableUpstreamFailure();
    } catch {
      return stableUpstreamFailure();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImplementation(target, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return stableUpstreamFailure();
      try {
        return await response.json();
      } catch {
        return stableUpstreamFailure();
      }
    } catch {
      return stableUpstreamFailure();
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    getApplicationByUuid: ({ uuid }) => get(paths.application(uuid)),
    listDeploymentsByAppUuid: (input) => get(paths.deployments(input)),
    getDeploymentByUuid: ({ uuid }) => get(paths.deployment(uuid)),
    getDeploymentRuntimeImageByUuid: ({ uuid }) => get(paths.deploymentRuntimeImage(uuid)),
    listEnvsByApplicationUuid: ({ uuid }) => get(paths.environments(uuid)),
  };
};
