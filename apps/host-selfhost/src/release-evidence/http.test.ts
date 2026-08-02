/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-double-cast -- test boundary: web-handler lifecycle cleanup and a deliberately raw upstream failure verify the stable HTTP redaction envelope */

import { expect, test } from "@effect/vitest";
import { HttpRouter } from "effect/unstable/http";

import { makeReleaseEvidenceHttpRoutes, RELEASE_EVIDENCE_HTTP_PREFIX } from "./http";
import {
  payloadDigest,
  type JsonValue,
  type PreflightReceiptPayload,
  type SignedReceipt,
} from "./protocol";
import { MemoryReleaseEvidenceStore, createReleaseEvidenceService } from "./service";
import {
  CALLER,
  MAIN_SHA,
  NONCE,
  POLICY,
  observer,
  preflightRequest,
  signer,
} from "./test-fixtures";

const CALLER_TOKEN = "glink-release-evidence-test-token";

const makeHandler = (input: { readonly observer?: ReturnType<typeof observer> } = {}) => {
  const signing = signer();
  const service = createReleaseEvidenceService({
    caller: CALLER,
    policy: POLICY,
    signer: signing,
    store: new MemoryReleaseEvidenceStore(),
    observer: input.observer ?? observer(),
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  return {
    signing,
    web: HttpRouter.toWebHandler(
      makeReleaseEvidenceHttpRoutes({ service, callerToken: CALLER_TOKEN }),
      {
        disableLogger: true,
      },
    ),
  };
};

const request = (path: string, input: { readonly body?: unknown; readonly token?: string } = {}) =>
  new Request(`https://executor.example${path}`, {
    method: "POST",
    headers: {
      ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

test("the dedicated routes reject an unauthorized caller without invoking the service", async () => {
  const { web } = makeHandler();
  try {
    const response = await web.handler(
      request(`${RELEASE_EVIDENCE_HTTP_PREFIX}/preflight`, { body: preflightRequest() }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    await web.dispose();
  }
});

test("preflight rejects a caller-supplied public-manifest digest", async () => {
  const { web } = makeHandler();
  try {
    const response = await web.handler(
      request(`${RELEASE_EVIDENCE_HTTP_PREFIX}/preflight`, {
        token: CALLER_TOKEN,
        body: {
          ...preflightRequest(),
          publicBuildEnvironmentManifest: { expectedDigest: "ab".repeat(32) },
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-request" });
  } finally {
    await web.dispose();
  }
});

test("the fixed routes issue bound receipts and publish only the verification key", async () => {
  const { signing, web } = makeHandler();
  try {
    const preflightResponse = await web.handler(
      request(`${RELEASE_EVIDENCE_HTTP_PREFIX}/preflight`, {
        token: CALLER_TOKEN,
        body: preflightRequest(),
      }),
    );
    expect(preflightResponse.status).toBe(201);
    const preflightBody = (await preflightResponse.json()) as {
      readonly receipt: SignedReceipt<PreflightReceiptPayload>;
    };
    const preflight = preflightBody.receipt;

    const postdeployResponse = await web.handler(
      request(`${RELEASE_EVIDENCE_HTTP_PREFIX}/postdeploy`, {
        token: CALLER_TOKEN,
        body: {
          action: "coolify.glink.collectReleaseEvidence.v1",
          protocolVersion: 1,
          tenantId: CALLER.tenantId,
          principalId: CALLER.principalId,
          nonce: NONCE,
          proposedMainSha: MAIN_SHA,
          preflightReceiptId: preflight.receiptId,
          preflightPayloadDigest: payloadDigest(preflight.payload as unknown as JsonValue),
        },
      }),
    );
    expect(postdeployResponse.status).toBe(201);
    const postdeploy = (await postdeployResponse.json()) as {
      readonly receipt: { readonly payload: { readonly preflightReceiptId: string } };
    };
    expect(postdeploy.receipt.payload.preflightReceiptId).toBe(preflight.receiptId);

    const keyResponse = await web.handler(
      new Request(`https://executor.example${RELEASE_EVIDENCE_HTTP_PREFIX}/keys`),
    );
    expect(keyResponse.status).toBe(200);
    expect(await keyResponse.json()).toEqual({
      protocolVersion: 1,
      algorithm: "Ed25519",
      keys: [{ keyId: signing.keyId, publicKey: signing.publicKey }],
    });
  } finally {
    await web.dispose();
  }
});

test("a raw upstream failure is reduced to a stable, secret-free response", async () => {
  const upstreamSecret = "coolify-token-should-never-escape";
  const { web } = makeHandler({
    observer: {
      preflight: async () => {
        throw new Error(`https://coolify.example/api: ${upstreamSecret}`);
      },
      postdeploy: async () => {
        throw new Error(`https://coolify.example/api: ${upstreamSecret}`);
      },
    },
  });
  try {
    const response = await web.handler(
      request(`${RELEASE_EVIDENCE_HTTP_PREFIX}/preflight`, {
        token: CALLER_TOKEN,
        body: preflightRequest(),
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"observation-unavailable"}');
    expect(body).not.toContain(upstreamSecret);
    expect(body).not.toContain("coolify.example");
    expect(body).not.toContain(CALLER_TOKEN);
  } finally {
    await web.dispose();
  }
});
