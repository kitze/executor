/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-tagged-error, executor/no-json-parse -- boundary: the fixed Web Request adapter must parse bounded untrusted JSON and emit a stable secret-free HTTP envelope */

import { timingSafeEqual } from "node:crypto";

import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { Layer } from "effect";

import {
  ReleaseEvidenceError,
  parsePostdeployRequest,
  parsePreflightRequest,
  type ReleaseEvidenceFailureCode,
} from "./protocol";
import type { ReleaseEvidenceService } from "./service";

export const RELEASE_EVIDENCE_HTTP_PREFIX = "/api/release-evidence/v1";

export interface ReleaseEvidenceHttpOptions {
  readonly service: ReleaseEvidenceService;
  /** Host-held service credential for Glink; it is never echoed or logged. */
  readonly callerToken: string;
  readonly maxBodyBytes?: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });

const authorizationToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
};

const isAuthorized = (request: Request, expected: string): boolean => {
  const received = authorizationToken(request);
  if (!received) return false;
  const actualBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

const statusByCode = {
  "invalid-request": 400,
  "invalid-receipt": 400,
  "invalid-signature": 400,
  "receipt-constraint-mismatch": 400,
  "nonce-replayed": 409,
  "preflight-consumed": 409,
  "receipt-replayed": 409,
  "preflight-unavailable": 422,
  "receipt-expired": 422,
  "evidence-rejected": 422,
  "storage-unavailable": 503,
  "observation-unavailable": 503,
} satisfies Record<ReleaseEvidenceFailureCode, number>;

const statusFor = (code: ReleaseEvidenceFailureCode): number => statusByCode[code];

const failure = (error: unknown): Response => {
  const code = error instanceof ReleaseEvidenceError ? error.code : "observation-unavailable";
  // The error body intentionally contains a stable code only. In particular it
  // never includes request JSON, raw Coolify response text, a token, a URL, or
  // a signing/key error from a lower layer.
  return json(statusFor(code), { error: code });
};

const requestJson = async (request: Request, maxBodyBytes: number): Promise<unknown> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maxBodyBytes)) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new ReleaseEvidenceError("invalid-request");
  }
  if (Buffer.byteLength(body) > maxBodyBytes) throw new ReleaseEvidenceError("invalid-request");
  try {
    return JSON.parse(body);
  } catch {
    throw new ReleaseEvidenceError("invalid-request");
  }
};

/**
 * The dedicated server route. It is explicitly not registered as an Executor
 * tool and cannot execute caller-provided code, URLs, headers, or scripts.
 */
export const makeReleaseEvidenceHttpRoutes = (options: ReleaseEvidenceHttpOptions) => {
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (options.callerToken.length < 16 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  const preflight = HttpEffect.fromWebHandler(async (request) => {
    if (!isAuthorized(request, options.callerToken)) return json(401, { error: "unauthorized" });
    try {
      const receipt = await options.service.preflight(
        parsePreflightRequest(await requestJson(request, maxBodyBytes)),
      );
      return json(201, { receipt });
    } catch (error) {
      return failure(error);
    }
  });
  const postdeploy = HttpEffect.fromWebHandler(async (request) => {
    if (!isAuthorized(request, options.callerToken)) return json(401, { error: "unauthorized" });
    try {
      const receipt = await options.service.postdeploy(
        parsePostdeployRequest(await requestJson(request, maxBodyBytes)),
      );
      return json(201, { receipt });
    } catch (error) {
      return failure(error);
    }
  });
  const publicKeys = HttpEffect.fromWebHandler(async () =>
    json(200, {
      protocolVersion: 1,
      algorithm: "Ed25519",
      keys: options.service.publicKeys(),
    }),
  );
  return Layer.mergeAll(
    HttpRouter.add("POST", `${RELEASE_EVIDENCE_HTTP_PREFIX}/preflight`, preflight),
    HttpRouter.add("POST", `${RELEASE_EVIDENCE_HTTP_PREFIX}/postdeploy`, postdeploy),
    HttpRouter.add("GET", `${RELEASE_EVIDENCE_HTTP_PREFIX}/keys`, publicKeys),
  );
};
