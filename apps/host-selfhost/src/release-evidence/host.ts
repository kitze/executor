import type { Client } from "@libsql/client";

import { createCoolifyHttpApplicationApi } from "./coolify-http";
import { createCoolifyReleaseEvidenceObserver } from "./coolify-observer";
import { makeReleaseEvidenceHttpRoutes } from "./http";
import {
  createNodeEd25519Signer,
  type ReleaseEvidenceCaller,
  type ReleaseEvidencePolicy,
  type ReleaseEvidenceVerificationKey,
} from "./protocol";
import { createReleaseEvidenceService, type ReleaseEvidenceService } from "./service";
import { createSqliteReleaseEvidenceStore, initializeReleaseEvidenceStore } from "./sqlite-store";

/**
 * All secret-bearing fields are supplied by the host composition boundary.
 * This capability never consults Executor's sandbox credential system.
 */
export interface ReleaseEvidenceHostConfig {
  readonly caller: ReleaseEvidenceCaller;
  /** Authenticates Glink's fixed HTTP caller. */
  readonly callerToken: string;
  readonly signing: {
    readonly keyId: string;
    /** Base64url PKCS#8 Ed25519 private key, held by this server only. */
    readonly privateKey: string;
    /** Old public keys kept available during a planned key rotation. */
    readonly verificationKeys: readonly ReleaseEvidenceVerificationKey[];
  };
  readonly coolify: {
    readonly baseUrl: string;
    /** Server-held Coolify API token, never exposed outside the transport. */
    readonly token: string;
  };
  readonly policy: ReleaseEvidencePolicy;
}

export interface ReleaseEvidenceCapability {
  readonly routes: ReturnType<typeof makeReleaseEvidenceHttpRoutes>;
  readonly service: ReleaseEvidenceService;
}

export const createReleaseEvidenceCapability = async (input: {
  readonly client: Client;
  readonly config: ReleaseEvidenceHostConfig;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}): Promise<ReleaseEvidenceCapability> => {
  await initializeReleaseEvidenceStore(input.client);
  const signer = createNodeEd25519Signer(input.config.signing);
  const observer = createCoolifyReleaseEvidenceObserver({
    api: createCoolifyHttpApplicationApi({
      baseUrl: input.config.coolify.baseUrl,
      token: input.config.coolify.token,
      fetch: input.fetch,
    }),
    now: input.now,
  });
  const service = createReleaseEvidenceService({
    caller: input.config.caller,
    policy: input.config.policy,
    signer,
    verificationKeys: input.config.signing.verificationKeys,
    store: createSqliteReleaseEvidenceStore(input.client),
    observer,
    now: input.now,
  });
  return {
    routes: makeReleaseEvidenceHttpRoutes({ service, callerToken: input.config.callerToken }),
    service,
  };
};
