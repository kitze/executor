/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-tagged-error, executor/no-double-cast -- boundary: this fixed Promise-facing service normalizes observer, crypto, and durable-ledger failures into stable receipt codes before the HTTP adapter */

import { randomUUID } from "node:crypto";

import {
  PREFLIGHT_ACTION,
  POSTDEPLOY_ACTION,
  PUBLIC_BUILD_MANIFEST_STAGE,
  RELEASE_EVIDENCE_PROTOCOL_VERSION,
  ReleaseEvidenceError,
  canonicalJson,
  normalizeReleaseEvidenceVerificationKeys,
  nonceDigest,
  normalizeMainSha,
  payloadDigest,
  signReleaseEvidenceReceipt,
  startupMarkersDigest,
  verifyReleaseEvidenceReceipt,
  type AnySignedReceipt,
  type ApplicationConfigurationObservation,
  type ApplicationIdentity,
  type ApplicationReleaseObservation,
  type ApplicationTargetPolicy,
  type EnvironmentPolicyEvidence,
  type JsonValue,
  type PostdeployObservation,
  type PostdeployReceiptPayload,
  type PreflightObservation,
  type PreflightReceiptPayload,
  type ReleaseEvidenceCaller,
  type ReleaseEvidenceObserver,
  type ReleaseEvidencePolicy,
  type ReleaseEvidencePostdeployRequest,
  type ReleaseEvidencePreflightRequest,
  type ReleaseEvidenceSigner,
  type ReleaseEvidenceVerificationKey,
  type SignedReceipt,
} from "./protocol";

// ---------------------------------------------------------------------------
// Durable protocol state.
//
// The nonce itself is never stored: a SHA-256 digest is sufficient for replay
// protection. The signed, reduced receipt is stored so postdeploy can verify
// that the preflight record was not mutated before it is consumed.
// ---------------------------------------------------------------------------

export interface PersistedPreflight {
  readonly tenantId: string;
  readonly principalId: string;
  readonly nonceDigest: string;
  readonly receipt: SignedReceipt<PreflightReceiptPayload>;
  readonly payloadDigest: string;
  readonly expiresAt: string;
}

export interface ReleaseEvidenceStore {
  readonly reservePreflight: (record: PersistedPreflight) => Promise<"stored" | "duplicate">;
  readonly readPreflight: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly nonceDigest: string;
    readonly receiptId: string;
  }) => Promise<PersistedPreflight | null>;
  /** Atomically consumes preflight and records the final receipt. */
  readonly consumePreflight: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly nonceDigest: string;
    readonly receiptId: string;
    readonly payloadDigest: string;
    readonly now: string;
    readonly finalReceipt: SignedReceipt<PostdeployReceiptPayload>;
  }) => Promise<"consumed" | "unavailable" | "expired" | "already-consumed">;
}

export class MemoryReleaseEvidenceStore implements ReleaseEvidenceStore {
  readonly #preflights = new Map<string, PersistedPreflight & { consumed: boolean }>();
  readonly #receipts = new Map<string, AnySignedReceipt>();

  #key(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly nonceDigest: string;
  }): string {
    return `${input.tenantId}:${input.principalId}:${input.nonceDigest}`;
  }

  async reservePreflight(record: PersistedPreflight): Promise<"stored" | "duplicate"> {
    const key = this.#key(record);
    if (this.#preflights.has(key)) return "duplicate";
    this.#preflights.set(key, { ...record, consumed: false });
    this.#receipts.set(record.receipt.receiptId, record.receipt);
    return "stored";
  }

  async readPreflight(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly nonceDigest: string;
    readonly receiptId: string;
  }): Promise<PersistedPreflight | null> {
    const record = this.#preflights.get(this.#key(input));
    if (!record || record.receipt.receiptId !== input.receiptId) return null;
    const { consumed: _consumed, ...persisted } = record;
    return persisted;
  }

  async consumePreflight(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly nonceDigest: string;
    readonly receiptId: string;
    readonly payloadDigest: string;
    readonly now: string;
    readonly finalReceipt: SignedReceipt<PostdeployReceiptPayload>;
  }): Promise<"consumed" | "unavailable" | "expired" | "already-consumed"> {
    const record = this.#preflights.get(this.#key(input));
    if (
      !record ||
      record.receipt.receiptId !== input.receiptId ||
      record.payloadDigest !== input.payloadDigest
    ) {
      return "unavailable";
    }
    if (Date.parse(record.expiresAt) < Date.parse(input.now)) return "expired";
    if (record.consumed) return "already-consumed";
    record.consumed = true;
    this.#receipts.set(input.finalReceipt.receiptId, input.finalReceipt);
    return "consumed";
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const decimalIdentifier = /^[1-9][0-9]*$/u;
const safeIdentifier = /^[A-Za-z0-9._:-]{1,256}$/u;
const validIso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

const sameIdentity = (left: ApplicationIdentity, right: ApplicationIdentity): boolean =>
  left.uuid === right.uuid && left.applicationId === right.applicationId;

const samePolicy = (left: EnvironmentPolicyEvidence, right: EnvironmentPolicyEvidence): boolean =>
  canonicalJson(left as unknown as JsonValue) === canonicalJson(right as unknown as JsonValue);

const configurationMatches = (
  observed: ApplicationConfigurationObservation,
  policy: ApplicationTargetPolicy,
): boolean =>
  sameIdentity(observed, policy) &&
  observed.repository === policy.repository &&
  observed.branch === policy.branch &&
  observed.buildPack === policy.buildPack &&
  observed.startCommand === policy.startCommand &&
  observed.sourceLocation === policy.sourceLocation &&
  canonicalJson(observed.healthCheck as unknown as JsonValue) ===
    canonicalJson(policy.healthCheck as unknown as JsonValue) &&
  sha256Pattern.test(observed.configurationHash) &&
  validIso(observed.observedAt) &&
  typeof observed.reportedCommit === "string" &&
  typeof observed.reportedStatus === "string";

const markersMatch = (
  release: ApplicationReleaseObservation,
  policy: ApplicationTargetPolicy,
  publicBuildManifestDigest?: string,
): boolean => {
  const deployment = release.deployment;
  if (
    deployment.startupMarkers.length !== policy.requiredStartupMarkers.length ||
    deployment.startupMarkersDigest !== startupMarkersDigest(deployment.startupMarkers)
  ) {
    return false;
  }
  const start = Date.parse(deployment.createdAt);
  const finish = Date.parse(deployment.finishedAt);
  let previous = Number.NEGATIVE_INFINITY;
  return deployment.startupMarkers.every((marker, index) => {
    const expected = policy.requiredStartupMarkers[index];
    const observedAt = Date.parse(marker.observedAt);
    const expectsManifestDigest = expected?.stage === PUBLIC_BUILD_MANIFEST_STAGE;
    const matches =
      expected !== undefined &&
      marker.stage === expected.stage &&
      marker.marker === expected.marker &&
      (expectsManifestDigest
        ? marker.manifestDigest === publicBuildManifestDigest &&
          marker.manifestDigest !== undefined &&
          sha256Pattern.test(marker.manifestDigest)
        : marker.manifestDigest === undefined) &&
      validIso(marker.observedAt) &&
      start <= observedAt &&
      observedAt <= finish &&
      previous < observedAt;
    previous = observedAt;
    return matches;
  });
};

const releaseMatches = (input: {
  readonly observed: ApplicationReleaseObservation;
  readonly policy: ApplicationTargetPolicy;
  readonly proposedMainSha: string;
  readonly notBefore: string;
  readonly publicBuildManifestDigest?: string;
}): boolean => {
  const { observed, policy, proposedMainSha, notBefore } = input;
  const deployment = observed.deployment;
  return (
    configurationMatches(observed.application, policy) &&
    deployment.applicationUuid === policy.uuid &&
    deployment.applicationId === policy.applicationId &&
    safeIdentifier.test(deployment.uuid) &&
    (deployment.deploymentId === null || decimalIdentifier.test(deployment.deploymentId)) &&
    deployment.sourceCommit === proposedMainSha &&
    deployment.status === "finished" &&
    deployment.releaseKind === "webhook-main" &&
    deployment.restartOnly === false &&
    deployment.rollback === false &&
    validIso(deployment.createdAt) &&
    validIso(deployment.finishedAt) &&
    Date.parse(deployment.createdAt) >= Date.parse(notBefore) &&
    Date.parse(deployment.finishedAt) >= Date.parse(deployment.createdAt) &&
    sha256Pattern.test(deployment.configurationHash) &&
    deployment.configurationHash === observed.application.configurationHash &&
    sha256Pattern.test(deployment.deploymentHistoryDigest) &&
    Number.isSafeInteger(deployment.deploymentHistoryCount) &&
    deployment.deploymentHistoryCount > 0 &&
    markersMatch(observed, policy, input.publicBuildManifestDigest)
  );
};

const assertPreflightRequest = (
  request: ReleaseEvidencePreflightRequest,
  caller: ReleaseEvidenceCaller,
  policy: ReleaseEvidencePolicy,
): void => {
  if (
    request.action !== PREFLIGHT_ACTION ||
    request.protocolVersion !== RELEASE_EVIDENCE_PROTOCOL_VERSION ||
    request.tenantId !== caller.tenantId ||
    request.principalId !== caller.principalId ||
    normalizeMainSha(request.proposedMainSha) !== request.proposedMainSha ||
    !sameIdentity(request.root, policy.root) ||
    !sameIdentity(request.zero, policy.zero) ||
    !samePolicy(request.environmentPolicy, policy.environmentPolicy)
  ) {
    throw new ReleaseEvidenceError("invalid-request");
  }
};

const assertPreflightObservation = (
  observation: PreflightObservation,
  policy: ReleaseEvidencePolicy,
): void => {
  if (
    !configurationMatches(observation.root, policy.root) ||
    !configurationMatches(observation.zero, policy.zero) ||
    observation.publicBuildEnvironmentManifest.version !==
      policy.publicBuildEnvironmentManifest.version ||
    !sha256Pattern.test(observation.publicBuildEnvironmentManifest.expectedDigest) ||
    !samePolicy(observation.environmentPolicy, policy.environmentPolicy)
  ) {
    throw new ReleaseEvidenceError("evidence-rejected");
  }
};

const assertPostdeployObservation = (input: {
  readonly observation: PostdeployObservation;
  readonly policy: ReleaseEvidencePolicy;
  readonly proposedMainSha: string;
  readonly notBefore: string;
  readonly expectedManifestDigest: string;
}): void => {
  const { observation, policy, proposedMainSha, notBefore, expectedManifestDigest } = input;
  if (
    !sha256Pattern.test(observation.publicBuildEnvironmentManifest.actualDigest) ||
    observation.publicBuildEnvironmentManifest.actualDigest !== expectedManifestDigest ||
    !releaseMatches({
      observed: observation.root,
      policy: policy.root,
      proposedMainSha,
      notBefore,
      publicBuildManifestDigest: observation.publicBuildEnvironmentManifest.actualDigest,
    }) ||
    !releaseMatches({
      observed: observation.zero,
      policy: policy.zero,
      proposedMainSha,
      notBefore,
    }) ||
    !samePolicy(observation.environmentPolicy, policy.environmentPolicy)
  ) {
    throw new ReleaseEvidenceError("evidence-rejected");
  }
};

export interface CreateReleaseEvidenceServiceOptions {
  readonly caller: ReleaseEvidenceCaller;
  readonly policy: ReleaseEvidencePolicy;
  readonly signer: ReleaseEvidenceSigner;
  /** Prior public keys retained while their receipts can still be presented. */
  readonly verificationKeys?: readonly ReleaseEvidenceVerificationKey[];
  readonly store: ReleaseEvidenceStore;
  readonly observer: ReleaseEvidenceObserver;
  readonly now?: () => Date;
}

export interface ReleaseEvidenceService {
  readonly preflight: (
    request: ReleaseEvidencePreflightRequest,
  ) => Promise<SignedReceipt<PreflightReceiptPayload>>;
  readonly postdeploy: (
    request: ReleaseEvidencePostdeployRequest,
  ) => Promise<SignedReceipt<PostdeployReceiptPayload>>;
  readonly publicKeys: () => readonly ReleaseEvidenceVerificationKey[];
}

const safeObservation = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    // Deliberately discard raw provider/network diagnostics before the caller,
    // logger, tracing layer, or response serializer can see them.
    throw new ReleaseEvidenceError("observation-unavailable");
  }
};

/**
 * Dedicated release-evidence service. It has no executor/QuickJS execution
 * dependency; a caller can only invoke its two fixed protocol actions.
 */
export const createReleaseEvidenceService = (
  options: CreateReleaseEvidenceServiceOptions,
): ReleaseEvidenceService => {
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(options.policy.receiptTtlMs) || options.policy.receiptTtlMs <= 0) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  const verificationKeys = normalizeReleaseEvidenceVerificationKeys([
    { keyId: options.signer.keyId, publicKey: options.signer.publicKey },
    ...(options.verificationKeys ?? []),
  ]);

  const preflight = async (
    request: ReleaseEvidencePreflightRequest,
  ): Promise<SignedReceipt<PreflightReceiptPayload>> => {
    assertPreflightRequest(request, options.caller, options.policy);
    const issuedAt = now().toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + options.policy.receiptTtlMs).toISOString();
    const observation = await safeObservation(() =>
      options.observer.preflight({
        proposedMainSha: request.proposedMainSha,
        policy: options.policy,
      }),
    );
    assertPreflightObservation(observation, options.policy);
    const payload: PreflightReceiptPayload = {
      phase: "preflight",
      proposedMainSha: request.proposedMainSha,
      root: observation.root,
      zero: observation.zero,
      publicBuildEnvironmentManifest: {
        version: observation.publicBuildEnvironmentManifest.version,
        expectedDigest: observation.publicBuildEnvironmentManifest.expectedDigest,
      },
      environmentPolicy: observation.environmentPolicy,
    };
    const receipt = signReleaseEvidenceReceipt({
      signer: options.signer,
      caller: options.caller,
      receiptId: randomUUID().replace(/-/gu, ""),
      action: PREFLIGHT_ACTION,
      nonce: request.nonce,
      issuedAt,
      expiresAt,
      payload,
    });
    try {
      const result = await options.store.reservePreflight({
        tenantId: options.caller.tenantId,
        principalId: options.caller.principalId,
        nonceDigest: nonceDigest(request.nonce),
        receipt,
        payloadDigest: payloadDigest(payload as unknown as JsonValue),
        expiresAt,
      });
      if (result === "duplicate") throw new ReleaseEvidenceError("nonce-replayed");
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) throw error;
      throw new ReleaseEvidenceError("storage-unavailable");
    }
    return receipt;
  };

  const postdeploy = async (
    request: ReleaseEvidencePostdeployRequest,
  ): Promise<SignedReceipt<PostdeployReceiptPayload>> => {
    if (
      request.action !== POSTDEPLOY_ACTION ||
      request.protocolVersion !== RELEASE_EVIDENCE_PROTOCOL_VERSION ||
      request.tenantId !== options.caller.tenantId ||
      request.principalId !== options.caller.principalId ||
      normalizeMainSha(request.proposedMainSha) !== request.proposedMainSha
    ) {
      throw new ReleaseEvidenceError("invalid-request");
    }
    let persisted: PersistedPreflight | null;
    try {
      persisted = await options.store.readPreflight({
        tenantId: options.caller.tenantId,
        principalId: options.caller.principalId,
        nonceDigest: nonceDigest(request.nonce),
        receiptId: request.preflightReceiptId,
      });
    } catch {
      throw new ReleaseEvidenceError("storage-unavailable");
    }
    if (!persisted || Date.parse(persisted.expiresAt) < now().getTime()) {
      throw new ReleaseEvidenceError("preflight-unavailable");
    }
    const preflight = persisted.receipt;
    try {
      verifyReleaseEvidenceReceipt(preflight, {
        action: PREFLIGHT_ACTION,
        tenantId: options.caller.tenantId,
        principalId: options.caller.principalId,
        nonce: request.nonce,
        proposedMainSha: request.proposedMainSha,
        root: options.policy.root,
        zero: options.policy.zero,
        now: now().toISOString(),
        verificationKeys,
      });
    } catch {
      throw new ReleaseEvidenceError("preflight-unavailable");
    }
    if (
      preflight.payload.proposedMainSha !== request.proposedMainSha ||
      persisted.payloadDigest !== request.preflightPayloadDigest ||
      persisted.payloadDigest !== payloadDigest(preflight.payload as unknown as JsonValue)
    ) {
      throw new ReleaseEvidenceError("preflight-unavailable");
    }
    const observation = await safeObservation(() =>
      options.observer.postdeploy({
        proposedMainSha: request.proposedMainSha,
        notBefore: preflight.issuedAt,
        policy: options.policy,
      }),
    );
    assertPostdeployObservation({
      observation,
      policy: options.policy,
      proposedMainSha: request.proposedMainSha,
      notBefore: preflight.issuedAt,
      expectedManifestDigest: preflight.payload.publicBuildEnvironmentManifest.expectedDigest,
    });
    const issuedAt = now().toISOString();
    if (Date.parse(issuedAt) > Date.parse(persisted.expiresAt)) {
      throw new ReleaseEvidenceError("receipt-expired");
    }
    const payload: PostdeployReceiptPayload = {
      phase: "postdeploy",
      preflightReceiptId: preflight.receiptId,
      preflightPayloadDigest: persisted.payloadDigest,
      proposedMainSha: request.proposedMainSha,
      observedMainSha: request.proposedMainSha,
      root: observation.root,
      zero: observation.zero,
      publicBuildEnvironmentManifest: {
        version: preflight.payload.publicBuildEnvironmentManifest.version,
        expectedDigest: preflight.payload.publicBuildEnvironmentManifest.expectedDigest,
        actualDigest: observation.publicBuildEnvironmentManifest.actualDigest,
      },
      environmentPolicy: observation.environmentPolicy,
    };
    const receipt = signReleaseEvidenceReceipt({
      signer: options.signer,
      caller: options.caller,
      receiptId: randomUUID().replace(/-/gu, ""),
      action: POSTDEPLOY_ACTION,
      nonce: request.nonce,
      issuedAt,
      expiresAt: persisted.expiresAt,
      payload,
    });
    try {
      const result = await options.store.consumePreflight({
        tenantId: options.caller.tenantId,
        principalId: options.caller.principalId,
        nonceDigest: nonceDigest(request.nonce),
        receiptId: request.preflightReceiptId,
        payloadDigest: request.preflightPayloadDigest,
        now: issuedAt,
        finalReceipt: receipt,
      });
      if (result === "expired") throw new ReleaseEvidenceError("receipt-expired");
      if (result === "already-consumed") throw new ReleaseEvidenceError("preflight-consumed");
      if (result !== "consumed") throw new ReleaseEvidenceError("preflight-unavailable");
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) throw error;
      throw new ReleaseEvidenceError("storage-unavailable");
    }
    return receipt;
  };

  return {
    preflight,
    postdeploy,
    publicKeys: () => verificationKeys,
  };
};
