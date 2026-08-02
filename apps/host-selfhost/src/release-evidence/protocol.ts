/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-tagged-error, executor/no-double-cast -- boundary: the portable receipt protocol deliberately exposes synchronous Node-crypto signing and offline verification with stable thrown failure codes, outside an Effect runtime */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// The protocol deliberately has no HTTP, tracing, logging, or Coolify imports.
// Raw provider responses are reduced by the host-only observer before crossing
// this boundary, and neither credentials nor raw response fields fit these
// types.

export const RELEASE_EVIDENCE_PROTOCOL_VERSION = 1 as const;
export const RELEASE_EVIDENCE_RECEIPT_VERSION = "v1" as const;
export const RELEASE_EVIDENCE_ALGORITHM = "Ed25519" as const;
export const PREFLIGHT_ACTION = "coolify.glink.authorizeReleaseEnvironment.v1" as const;
export const POSTDEPLOY_ACTION = "coolify.glink.collectReleaseEvidence.v1" as const;
export const PUBLIC_BUILD_MANIFEST_STAGE = "public-build-environment-manifest" as const;
/**
 * The runtime image digest is returned by Coolify's fixed, app/deployment
 * scoped runtime-image observation. It is deliberately distinct from an app
 * log line, a build argument, a tag, or a mutable application configuration.
 */
export const COOLIFY_RUNTIME_IMAGE_SOURCE = "coolify-deployment-runtime-image-v1" as const;

export const GLINK_ROOT_STARTUP_MARKERS = [
  { stage: "prisma-migrate", marker: "Prisma migration deploy succeeded." },
  {
    stage: PUBLIC_BUILD_MANIFEST_STAGE,
    marker: "Public build environment manifest sha256 emitted.",
  },
  { stage: "runtime-preflight", marker: "Runtime environment preflight passed." },
  { stage: "zero-public-readiness", marker: "Zero public readiness preflight passed." },
  { stage: "next-ready", marker: "Next.js server ready." },
] as const;

export const GLINK_ZERO_STARTUP_MARKERS = [
  {
    stage: "zero-publication-apply",
    marker: "Zero publication glink_zero_publication is exact for 36 browser-safe tables (apply).",
  },
  {
    stage: "zero-preflight",
    marker: "Zero publication glink_zero_publication is exact for 36 browser-safe tables (check).",
  },
  {
    stage: "zero-ops-monitor",
    marker:
      "Zero publication glink_zero_publication is exact for 36 browser-safe tables (drift-check).",
  },
] as const;

export type ReleaseEvidenceAction = typeof PREFLIGHT_ACTION | typeof POSTDEPLOY_ACTION;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ReleaseEvidenceFailureCode =
  | "invalid-request"
  | "invalid-receipt"
  | "invalid-signature"
  | "receipt-expired"
  | "receipt-replayed"
  | "receipt-constraint-mismatch"
  | "preflight-unavailable"
  | "preflight-consumed"
  | "nonce-replayed"
  | "evidence-rejected"
  | "storage-unavailable"
  | "observation-unavailable";

/** A stable code only: never attach an upstream error/body/token/value here. */
export class ReleaseEvidenceError extends Error {
  readonly code: ReleaseEvidenceFailureCode;

  constructor(code: ReleaseEvidenceFailureCode) {
    super(code);
    this.name = "ReleaseEvidenceError";
    this.code = code;
  }
}

export interface ApplicationIdentity {
  readonly uuid: string;
  /** Decimal text avoids losing precision for a provider numeric identifier. */
  readonly applicationId: string;
}

export interface HealthCheckConfiguration {
  readonly enabled: boolean;
  readonly method: string | null;
  readonly path: string | null;
  readonly port: string | null;
  readonly scheme: string | null;
  readonly status: number | null;
}

/** Flags only. Environment values are deliberately absent. */
export interface EnvironmentPolicyFlag {
  readonly key: string;
  readonly isBuildtime: boolean;
  readonly isRuntime: boolean;
  readonly isLiteral: boolean;
  readonly isPreview: boolean;
  readonly isShownOnce: boolean;
}

export interface EnvironmentPolicyEvidence {
  readonly digest: string;
  readonly flags: readonly EnvironmentPolicyFlag[];
}

export interface StartupMarker {
  readonly stage: string;
  readonly marker: string;
  readonly observedAt: string;
}

/** Pinned public Docker ARG defaults used for a versioned manifest digest. */
export interface PublicBuildEnvironmentManifestPolicy {
  readonly version: number;
  readonly defaults: readonly { readonly name: string; readonly value: string }[];
}

export interface ApplicationTargetPolicy extends ApplicationIdentity {
  readonly repository: string;
  readonly branch: string;
  readonly buildPack: string;
  readonly startCommand: string;
  readonly healthCheck: HealthCheckConfiguration;
  /** E.g. /Dockerfile for root or the checked-in Compose file for Zero. */
  readonly sourceLocation: string;
  readonly requiredStartupMarkers: readonly Pick<StartupMarker, "stage" | "marker">[];
}

export interface ReleaseEvidencePolicy {
  readonly root: ApplicationTargetPolicy;
  readonly zero: ApplicationTargetPolicy;
  readonly publicBuildEnvironmentManifest: PublicBuildEnvironmentManifestPolicy;
  readonly environmentPolicy: EnvironmentPolicyEvidence;
  readonly receiptTtlMs: number;
}

export interface ReleaseEvidenceCaller {
  readonly tenantId: string;
  readonly principalId: string;
}

export interface ReleaseEvidencePreflightRequest extends ReleaseEvidenceCaller {
  readonly action: typeof PREFLIGHT_ACTION;
  readonly protocolVersion: typeof RELEASE_EVIDENCE_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly proposedMainSha: string;
  readonly root: ApplicationIdentity;
  readonly zero: ApplicationIdentity;
  readonly environmentPolicy: EnvironmentPolicyEvidence;
}

export interface ReleaseEvidencePostdeployRequest extends ReleaseEvidenceCaller {
  readonly action: typeof POSTDEPLOY_ACTION;
  readonly protocolVersion: typeof RELEASE_EVIDENCE_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly proposedMainSha: string;
  readonly preflightReceiptId: string;
  readonly preflightPayloadDigest: string;
}

export interface ApplicationConfigurationObservation extends ApplicationIdentity {
  readonly repository: string;
  readonly branch: string;
  readonly buildPack: string;
  readonly startCommand: string;
  readonly healthCheck: HealthCheckConfiguration;
  readonly sourceLocation: string;
  readonly configurationHash: string;
  /** Source-faithful Coolify value (including the supported HEAD alias). */
  readonly reportedCommit: string;
  readonly reportedStatus: string;
  readonly observedAt: string;
}

export interface DeploymentObservation {
  readonly uuid: string;
  /** Coolify's non-null numeric deployment identifier. */
  readonly deploymentId: string;
  readonly applicationUuid: string;
  readonly applicationId: string;
  readonly sourceCommit: string;
  readonly status: "finished";
  readonly releaseKind: "webhook-main";
  readonly restartOnly: false;
  readonly rollback: false;
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly configurationHash: string;
  /** Digest of the complete app-scoped deployment-list decision. */
  readonly deploymentHistoryDigest: string;
  readonly deploymentHistoryCount: number;
  /** Fixed, sanitized lifecycle markers; never raw Coolify log records. */
  readonly startupMarkers: readonly StartupMarker[];
  readonly startupMarkersDigest: string;
  /**
   * Immutable digest of the image attached to this deployed container, read
   * from Coolify's fixed runtime-image observation. It is not app stdout.
   */
  readonly runtimeImage: {
    readonly source: typeof COOLIFY_RUNTIME_IMAGE_SOURCE;
    readonly digest: string;
  };
}

export interface ApplicationReleaseObservation {
  readonly application: ApplicationConfigurationObservation;
  readonly deployment: DeploymentObservation;
}

export interface PreflightObservation {
  readonly root: ApplicationConfigurationObservation;
  readonly zero: ApplicationConfigurationObservation;
  readonly publicBuildEnvironmentManifest: {
    readonly version: number;
    readonly expectedDigest: string;
  };
  readonly environmentPolicy: EnvironmentPolicyEvidence;
}

export interface PostdeployObservation {
  readonly root: ApplicationReleaseObservation;
  readonly zero: ApplicationReleaseObservation;
  readonly environmentPolicy: EnvironmentPolicyEvidence;
}

/** A host-only seam; it may read raw Coolify JSON but must return only these types. */
export interface ReleaseEvidenceObserver {
  readonly preflight: (input: {
    readonly proposedMainSha: string;
    readonly policy: ReleaseEvidencePolicy;
  }) => Promise<PreflightObservation>;
  readonly postdeploy: (input: {
    readonly proposedMainSha: string;
    readonly notBefore: string;
    readonly policy: ReleaseEvidencePolicy;
  }) => Promise<PostdeployObservation>;
}

export interface PreflightReceiptPayload {
  readonly phase: "preflight";
  readonly proposedMainSha: string;
  readonly root: ApplicationConfigurationObservation;
  readonly zero: ApplicationConfigurationObservation;
  readonly publicBuildEnvironmentManifest: {
    readonly version: number;
    readonly expectedDigest: string;
  };
  readonly environmentPolicy: EnvironmentPolicyEvidence;
}

export interface PostdeployReceiptPayload {
  readonly phase: "postdeploy";
  readonly preflightReceiptId: string;
  readonly preflightPayloadDigest: string;
  readonly proposedMainSha: string;
  readonly observedMainSha: string;
  readonly root: ApplicationReleaseObservation;
  readonly zero: ApplicationReleaseObservation;
  readonly publicBuildEnvironmentManifest: {
    readonly version: number;
    readonly expectedDigest: string;
  };
  readonly environmentPolicy: EnvironmentPolicyEvidence;
}

export interface UnsignedReceipt<TPayload> extends ReleaseEvidenceCaller {
  readonly receiptVersion: typeof RELEASE_EVIDENCE_RECEIPT_VERSION;
  readonly receiptId: string;
  readonly action: ReleaseEvidenceAction;
  readonly protocolVersion: typeof RELEASE_EVIDENCE_PROTOCOL_VERSION;
  readonly algorithm: typeof RELEASE_EVIDENCE_ALGORITHM;
  readonly keyId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly payload: TPayload;
}

export interface SignedReceipt<TPayload> extends UnsignedReceipt<TPayload> {
  /** Base64url Ed25519 signature of the canonical unsigned receipt bytes. */
  readonly signature: string;
}

export type AnySignedReceipt =
  | SignedReceipt<PreflightReceiptPayload>
  | SignedReceipt<PostdeployReceiptPayload>;

export interface ReleaseEvidenceSigner {
  readonly keyId: string;
  /** Base64url DER SubjectPublicKeyInfo. Safe to publish. */
  readonly publicKey: string;
  readonly sign: (bytes: Uint8Array) => Uint8Array;
}

export interface ReleaseEvidenceVerificationKey {
  readonly keyId: string;
  readonly publicKey: string;
}

const asciiIdentifier = /^[A-Za-z0-9._:-]{1,256}$/u;
const decimalIdentifier = /^[1-9][0-9]*$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const fullMainShaPattern = /^[0-9a-f]{40}$/u;
const noncePattern = /^[A-Za-z0-9_-]{22,256}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new ReleaseEvidenceError("invalid-request");
  return value;
};

const requireExactKeys = (record: Record<string, unknown>, keys: readonly string[]): void => {
  const expected = new Set(keys);
  if (
    Object.keys(record).some((key) => !expected.has(key)) ||
    keys.some((key) => !(key in record))
  ) {
    throw new ReleaseEvidenceError("invalid-request");
  }
};

const requireString = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new ReleaseEvidenceError("invalid-request");
  return value;
};

const requireIdentifier = (value: unknown): string => {
  const result = requireString(value);
  if (!asciiIdentifier.test(result)) throw new ReleaseEvidenceError("invalid-request");
  return result;
};

const requireApplicationId = (value: unknown): string => {
  const result = requireString(value);
  if (!decimalIdentifier.test(result)) throw new ReleaseEvidenceError("invalid-request");
  return result;
};

export const normalizeMainSha = (value: unknown): string => {
  const result = requireString(value).toLowerCase();
  if (!fullMainShaPattern.test(result)) throw new ReleaseEvidenceError("invalid-request");
  return result;
};

const requireDigest = (value: unknown): string => {
  const result = requireString(value).toLowerCase();
  if (!sha256Pattern.test(result)) throw new ReleaseEvidenceError("invalid-request");
  return result;
};

const requireNonce = (value: unknown): string => {
  const result = requireString(value);
  if (!noncePattern.test(result)) throw new ReleaseEvidenceError("invalid-request");
  return result;
};

const parseIdentity = (value: unknown): ApplicationIdentity => {
  const record = requireRecord(value);
  requireExactKeys(record, ["uuid", "applicationId"]);
  return {
    uuid: requireIdentifier(record.uuid),
    applicationId: requireApplicationId(record.applicationId),
  };
};

const parseEnvironmentFlag = (value: unknown): EnvironmentPolicyFlag => {
  const record = requireRecord(value);
  requireExactKeys(record, [
    "key",
    "isBuildtime",
    "isRuntime",
    "isLiteral",
    "isPreview",
    "isShownOnce",
  ]);
  if (
    typeof record.isBuildtime !== "boolean" ||
    typeof record.isRuntime !== "boolean" ||
    typeof record.isLiteral !== "boolean" ||
    typeof record.isPreview !== "boolean" ||
    typeof record.isShownOnce !== "boolean"
  ) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  return {
    key: requireIdentifier(record.key),
    isBuildtime: record.isBuildtime,
    isRuntime: record.isRuntime,
    isLiteral: record.isLiteral,
    isPreview: record.isPreview,
    isShownOnce: record.isShownOnce,
  };
};

export const parseEnvironmentPolicyEvidence = (value: unknown): EnvironmentPolicyEvidence => {
  const record = requireRecord(value);
  requireExactKeys(record, ["digest", "flags"]);
  if (!Array.isArray(record.flags)) throw new ReleaseEvidenceError("invalid-request");
  const flags = record.flags
    .map(parseEnvironmentFlag)
    .toSorted((left, right) => left.key.localeCompare(right.key));
  if (new Set(flags.map((flag) => flag.key)).size !== flags.length) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  return { digest: requireDigest(record.digest), flags };
};

export const parsePreflightRequest = (value: unknown): ReleaseEvidencePreflightRequest => {
  const record = requireRecord(value);
  requireExactKeys(record, [
    "action",
    "protocolVersion",
    "tenantId",
    "principalId",
    "nonce",
    "proposedMainSha",
    "root",
    "zero",
    "environmentPolicy",
  ]);
  if (
    record.action !== PREFLIGHT_ACTION ||
    record.protocolVersion !== RELEASE_EVIDENCE_PROTOCOL_VERSION
  ) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  return {
    action: PREFLIGHT_ACTION,
    protocolVersion: RELEASE_EVIDENCE_PROTOCOL_VERSION,
    tenantId: requireIdentifier(record.tenantId),
    principalId: requireIdentifier(record.principalId),
    nonce: requireNonce(record.nonce),
    proposedMainSha: normalizeMainSha(record.proposedMainSha),
    root: parseIdentity(record.root),
    zero: parseIdentity(record.zero),
    environmentPolicy: parseEnvironmentPolicyEvidence(record.environmentPolicy),
  };
};

export const parsePostdeployRequest = (value: unknown): ReleaseEvidencePostdeployRequest => {
  const record = requireRecord(value);
  requireExactKeys(record, [
    "action",
    "protocolVersion",
    "tenantId",
    "principalId",
    "nonce",
    "proposedMainSha",
    "preflightReceiptId",
    "preflightPayloadDigest",
  ]);
  if (
    record.action !== POSTDEPLOY_ACTION ||
    record.protocolVersion !== RELEASE_EVIDENCE_PROTOCOL_VERSION
  ) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  return {
    action: POSTDEPLOY_ACTION,
    protocolVersion: RELEASE_EVIDENCE_PROTOCOL_VERSION,
    tenantId: requireIdentifier(record.tenantId),
    principalId: requireIdentifier(record.principalId),
    nonce: requireNonce(record.nonce),
    proposedMainSha: normalizeMainSha(record.proposedMainSha),
    preflightReceiptId: requireIdentifier(record.preflightReceiptId),
    preflightPayloadDigest: requireDigest(record.preflightPayloadDigest),
  };
};

/** Canonical JSON bytes: sorted keys, finite numbers, JSON-only values. */
export const canonicalJson = (value: JsonValue): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReleaseEvidenceError("invalid-receipt");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new ReleaseEvidenceError("invalid-receipt");
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
};

export const canonicalBytes = (value: JsonValue): Uint8Array =>
  new TextEncoder().encode(canonicalJson(value));
export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const nonceDigest = (nonce: string): string => sha256Hex(nonce);
export const payloadDigest = (payload: JsonValue): string => sha256Hex(canonicalBytes(payload));
export const startupMarkersDigest = (markers: readonly StartupMarker[]): string =>
  payloadDigest(markers as unknown as JsonValue);

/**
 * The image writer's exact v1 serialization. This intentionally uses the
 * pinned `{ values, version }` JSON shape rather than the receipt canonical
 * JSON format: changing either byte sequence is a new manifest version.
 */
export const publicBuildEnvironmentManifestDigest = (
  policy: PublicBuildEnvironmentManifestPolicy,
  supplied: Readonly<Record<string, string>>,
): string => {
  const values = policy.defaults
    .map((entry) => ({ name: entry.name, value: supplied[entry.name] ?? entry.value }))
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return sha256Hex(JSON.stringify({ values, version: policy.version }));
};

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const fromBase64Url = (value: string): Buffer => Buffer.from(value, "base64url");

export const createNodeEd25519Signer = (input: {
  readonly keyId: string;
  /** Base64url PKCS#8 DER; the private bytes stay at the host boundary. */
  readonly privateKey: string;
}): ReleaseEvidenceSigner => {
  if (!asciiIdentifier.test(input.keyId) || !base64UrlPattern.test(input.privateKey)) {
    throw new ReleaseEvidenceError("invalid-request");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: fromBase64Url(input.privateKey),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new ReleaseEvidenceError("invalid-request");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new ReleaseEvidenceError("invalid-request");
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    keyId: input.keyId,
    publicKey: toBase64Url(publicKey),
    sign: (bytes) => sign(null, bytes, privateKey),
  };
};

/**
 * Validate and de-duplicate the public keys that can verify unexpired
 * receipts. The active signing key is added by the service; hosts may provide
 * prior public keys during a planned rotation.
 */
export const normalizeReleaseEvidenceVerificationKeys = (
  input: readonly ReleaseEvidenceVerificationKey[],
): readonly ReleaseEvidenceVerificationKey[] => {
  const keys = new Map<string, ReleaseEvidenceVerificationKey>();
  for (const candidate of input) {
    if (!asciiIdentifier.test(candidate.keyId) || !base64UrlPattern.test(candidate.publicKey)) {
      throw new ReleaseEvidenceError("invalid-request");
    }
    try {
      const key = createPublicKey({
        key: fromBase64Url(candidate.publicKey),
        format: "der",
        type: "spki",
      });
      if (key.asymmetricKeyType !== "ed25519") throw new ReleaseEvidenceError("invalid-request");
    } catch (error) {
      if (error instanceof ReleaseEvidenceError) throw error;
      throw new ReleaseEvidenceError("invalid-request");
    }
    const existing = keys.get(candidate.keyId);
    if (existing && existing.publicKey !== candidate.publicKey) {
      throw new ReleaseEvidenceError("invalid-request");
    }
    keys.set(candidate.keyId, { keyId: candidate.keyId, publicKey: candidate.publicKey });
  }
  return [...keys.values()];
};

const unsignedReceipt = <TPayload>(
  receipt: SignedReceipt<TPayload> | UnsignedReceipt<TPayload>,
): UnsignedReceipt<TPayload> => {
  const { signature: _signature, ...unsigned } = receipt as SignedReceipt<TPayload>;
  return unsigned;
};

export const canonicalReceiptBytes = <TPayload>(
  receipt: SignedReceipt<TPayload> | UnsignedReceipt<TPayload>,
): Uint8Array => canonicalBytes(unsignedReceipt(receipt) as unknown as JsonValue);

export const signReleaseEvidenceReceipt = <TPayload>(input: {
  readonly signer: ReleaseEvidenceSigner;
  readonly caller: ReleaseEvidenceCaller;
  readonly receiptId: string;
  readonly action: ReleaseEvidenceAction;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly payload: TPayload;
}): SignedReceipt<TPayload> => {
  const unsigned: UnsignedReceipt<TPayload> = {
    receiptVersion: RELEASE_EVIDENCE_RECEIPT_VERSION,
    receiptId: input.receiptId,
    action: input.action,
    protocolVersion: RELEASE_EVIDENCE_PROTOCOL_VERSION,
    algorithm: RELEASE_EVIDENCE_ALGORITHM,
    keyId: input.signer.keyId,
    tenantId: input.caller.tenantId,
    principalId: input.caller.principalId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    payload: input.payload,
  };
  return {
    ...unsigned,
    signature: toBase64Url(input.signer.sign(canonicalReceiptBytes(unsigned))),
  };
};

const validIso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

const identityMatches = (left: ApplicationIdentity, right: ApplicationIdentity): boolean =>
  left.uuid === right.uuid && left.applicationId === right.applicationId;

interface ReceiptVerificationBase extends ReleaseEvidenceCaller {
  readonly nonce: string;
  readonly proposedMainSha: string;
  readonly root: ApplicationIdentity;
  readonly zero: ApplicationIdentity;
  readonly now?: string;
  readonly verificationKeys: readonly ReleaseEvidenceVerificationKey[];
}

export interface DeploymentVerificationExpectation {
  readonly deploymentUuid: string;
  readonly deploymentId: string;
  /** Exact `sha256:<64 lowercase hex>` runtime image digest expected by the verifier. */
  readonly runtimeImageDigest: string;
}

export interface PreflightReceiptVerificationInput extends ReceiptVerificationBase {
  readonly action: typeof PREFLIGHT_ACTION;
}

export interface PostdeployReceiptVerificationInput extends ReceiptVerificationBase {
  readonly action: typeof POSTDEPLOY_ACTION;
  /**
   * Expected deployment identities come from the release caller, not fields
   * copied back out of the signed receipt.
   */
  readonly rootDeployment: DeploymentVerificationExpectation;
  readonly zeroDeployment: DeploymentVerificationExpectation;
}

export type ReceiptVerificationInput =
  | PreflightReceiptVerificationInput
  | PostdeployReceiptVerificationInput;

const assertReceiptEnvelope = (receipt: AnySignedReceipt): void => {
  if (
    receipt.receiptVersion !== RELEASE_EVIDENCE_RECEIPT_VERSION ||
    receipt.protocolVersion !== RELEASE_EVIDENCE_PROTOCOL_VERSION ||
    receipt.algorithm !== RELEASE_EVIDENCE_ALGORITHM ||
    !asciiIdentifier.test(receipt.receiptId) ||
    !asciiIdentifier.test(receipt.keyId) ||
    !asciiIdentifier.test(receipt.tenantId) ||
    !asciiIdentifier.test(receipt.principalId) ||
    !noncePattern.test(receipt.nonce) ||
    !validIso(receipt.issuedAt) ||
    !validIso(receipt.expiresAt) ||
    Date.parse(receipt.expiresAt) < Date.parse(receipt.issuedAt) ||
    typeof receipt.signature !== "string" ||
    !base64UrlPattern.test(receipt.signature)
  ) {
    throw new ReleaseEvidenceError("invalid-receipt");
  }
};

const expectedDeployment = (value: DeploymentVerificationExpectation): boolean =>
  asciiIdentifier.test(value.deploymentUuid) &&
  decimalIdentifier.test(value.deploymentId) &&
  imageDigestPattern.test(value.runtimeImageDigest);

const expectedLifecycle = (
  deployment: DeploymentObservation,
  expectedMarkers: readonly Pick<StartupMarker, "stage" | "marker">[],
): boolean => {
  if (
    deployment.startupMarkers.length !== expectedMarkers.length ||
    deployment.startupMarkersDigest !== startupMarkersDigest(deployment.startupMarkers)
  ) {
    return false;
  }
  const startedAt = Date.parse(deployment.createdAt);
  const finishedAt = Date.parse(deployment.finishedAt);
  let previous = Number.NEGATIVE_INFINITY;
  return deployment.startupMarkers.every((marker, index) => {
    const expected = expectedMarkers[index];
    const observedAt = Date.parse(marker.observedAt);
    const matches =
      expected !== undefined &&
      marker.stage === expected.stage &&
      marker.marker === expected.marker &&
      validIso(marker.observedAt) &&
      startedAt <= observedAt &&
      observedAt <= finishedAt &&
      previous < observedAt;
    previous = observedAt;
    return matches;
  });
};

const expectedRelease = (input: {
  readonly release: ApplicationReleaseObservation;
  readonly application: ApplicationIdentity;
  readonly deployment: DeploymentVerificationExpectation;
  readonly proposedMainSha: string;
  readonly markers: readonly Pick<StartupMarker, "stage" | "marker">[];
}): boolean => {
  const { release, application, deployment, proposedMainSha, markers } = input;
  const observedDeployment = release.deployment;
  return (
    expectedDeployment(deployment) &&
    identityMatches(release.application, application) &&
    release.application.reportedCommit === proposedMainSha &&
    observedDeployment.applicationUuid === application.uuid &&
    observedDeployment.applicationId === application.applicationId &&
    observedDeployment.uuid === deployment.deploymentUuid &&
    observedDeployment.deploymentId === deployment.deploymentId &&
    observedDeployment.sourceCommit === proposedMainSha &&
    observedDeployment.status === "finished" &&
    observedDeployment.releaseKind === "webhook-main" &&
    observedDeployment.restartOnly === false &&
    observedDeployment.rollback === false &&
    validIso(observedDeployment.createdAt) &&
    validIso(observedDeployment.finishedAt) &&
    Date.parse(observedDeployment.finishedAt) >= Date.parse(observedDeployment.createdAt) &&
    sha256Pattern.test(observedDeployment.configurationHash) &&
    sha256Pattern.test(observedDeployment.deploymentHistoryDigest) &&
    Number.isSafeInteger(observedDeployment.deploymentHistoryCount) &&
    observedDeployment.deploymentHistoryCount > 0 &&
    observedDeployment.runtimeImage?.source === COOLIFY_RUNTIME_IMAGE_SOURCE &&
    observedDeployment.runtimeImage.digest === deployment.runtimeImageDigest &&
    imageDigestPattern.test(observedDeployment.runtimeImage.digest) &&
    expectedLifecycle(observedDeployment, markers)
  );
};

/**
 * Verify the Ed25519 signature and caller-supplied immutable constraints.
 * This primitive does not accept a release; production acceptance must use
 * `verifyAndConsumePostdeployBinding`, which atomically consumes its nonce in
 * a durable verifier-owned ledger.
 */
export const verifyReleaseEvidenceReceipt = (
  receipt: AnySignedReceipt,
  input: ReceiptVerificationInput,
): AnySignedReceipt => {
  try {
    assertReceiptEnvelope(receipt);
    const key = input.verificationKeys.find((candidate) => candidate.keyId === receipt.keyId);
    if (!key || !base64UrlPattern.test(key.publicKey))
      throw new ReleaseEvidenceError("invalid-signature");
    const publicKey = createPublicKey({
      key: fromBase64Url(key.publicKey),
      format: "der",
      type: "spki",
    });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        canonicalReceiptBytes(receipt as unknown as SignedReceipt<JsonValue>),
        publicKey,
        fromBase64Url(receipt.signature),
      )
    ) {
      throw new ReleaseEvidenceError("invalid-signature");
    }
    const now = input.now ?? new Date().toISOString();
    if (!validIso(now) || Date.parse(receipt.expiresAt) <= Date.parse(now)) {
      throw new ReleaseEvidenceError("receipt-expired");
    }
    if (
      receipt.action !== input.action ||
      receipt.tenantId !== input.tenantId ||
      receipt.principalId !== input.principalId ||
      receipt.nonce !== input.nonce
    ) {
      throw new ReleaseEvidenceError("receipt-constraint-mismatch");
    }
    if (receipt.action === PREFLIGHT_ACTION) {
      if (input.action !== PREFLIGHT_ACTION) {
        throw new ReleaseEvidenceError("receipt-constraint-mismatch");
      }
      const payload = receipt.payload as PreflightReceiptPayload;
      if (
        payload.phase !== "preflight" ||
        payload.proposedMainSha !== input.proposedMainSha ||
        !identityMatches(payload.root, input.root) ||
        !identityMatches(payload.zero, input.zero) ||
        payload.publicBuildEnvironmentManifest.version !== 1 ||
        !sha256Pattern.test(payload.publicBuildEnvironmentManifest.expectedDigest)
      ) {
        throw new ReleaseEvidenceError("receipt-constraint-mismatch");
      }
    } else {
      if (input.action !== POSTDEPLOY_ACTION) {
        throw new ReleaseEvidenceError("receipt-constraint-mismatch");
      }
      const payload = receipt.payload as PostdeployReceiptPayload;
      if (
        payload.phase !== "postdeploy" ||
        payload.proposedMainSha !== input.proposedMainSha ||
        payload.observedMainSha !== input.proposedMainSha ||
        !identityMatches(payload.root.application, input.root) ||
        !identityMatches(payload.zero.application, input.zero) ||
        !asciiIdentifier.test(payload.preflightReceiptId) ||
        !sha256Pattern.test(payload.preflightPayloadDigest) ||
        payload.publicBuildEnvironmentManifest.version !== 1 ||
        !sha256Pattern.test(payload.publicBuildEnvironmentManifest.expectedDigest) ||
        !expectedRelease({
          release: payload.root,
          application: input.root,
          deployment: input.rootDeployment,
          proposedMainSha: input.proposedMainSha,
          markers: GLINK_ROOT_STARTUP_MARKERS,
        }) ||
        !expectedRelease({
          release: payload.zero,
          application: input.zero,
          deployment: input.zeroDeployment,
          proposedMainSha: input.proposedMainSha,
          markers: GLINK_ZERO_STARTUP_MARKERS,
        })
      ) {
        throw new ReleaseEvidenceError("receipt-constraint-mismatch");
      }
    }
    return receipt;
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    throw new ReleaseEvidenceError("invalid-receipt");
  }
};

export interface PostdeployBindingVerificationInput extends ReleaseEvidenceCaller {
  readonly preflight: SignedReceipt<PreflightReceiptPayload>;
  readonly postdeploy: SignedReceipt<PostdeployReceiptPayload>;
  readonly verificationKeys: readonly ReleaseEvidenceVerificationKey[];
  readonly nonce: string;
  readonly proposedMainSha: string;
  readonly root: ApplicationIdentity;
  readonly zero: ApplicationIdentity;
  readonly rootDeployment: DeploymentVerificationExpectation;
  readonly zeroDeployment: DeploymentVerificationExpectation;
  readonly now?: string;
}

/** Verify both signatures and their one-way, caller-constrained binding. */
export const verifyPostdeployBinding = (
  input: PostdeployBindingVerificationInput,
): SignedReceipt<PostdeployReceiptPayload> => {
  verifyReleaseEvidenceReceipt(input.preflight, {
    action: PREFLIGHT_ACTION,
    tenantId: input.tenantId,
    principalId: input.principalId,
    nonce: input.nonce,
    proposedMainSha: input.proposedMainSha,
    root: input.root,
    zero: input.zero,
    now: input.now,
    verificationKeys: input.verificationKeys,
  });
  const preflightPayload = input.preflight.payload;
  const verified = verifyReleaseEvidenceReceipt(input.postdeploy, {
    action: POSTDEPLOY_ACTION,
    tenantId: input.tenantId,
    principalId: input.principalId,
    nonce: input.nonce,
    proposedMainSha: input.proposedMainSha,
    root: input.root,
    zero: input.zero,
    rootDeployment: input.rootDeployment,
    zeroDeployment: input.zeroDeployment,
    now: input.now,
    verificationKeys: input.verificationKeys,
  }) as SignedReceipt<PostdeployReceiptPayload>;
  if (
    verified.payload.preflightReceiptId !== input.preflight.receiptId ||
    verified.payload.preflightPayloadDigest !==
      payloadDigest(preflightPayload as unknown as JsonValue) ||
    verified.payload.publicBuildEnvironmentManifest.version !==
      preflightPayload.publicBuildEnvironmentManifest.version ||
    verified.payload.publicBuildEnvironmentManifest.expectedDigest !==
      preflightPayload.publicBuildEnvironmentManifest.expectedDigest
  ) {
    throw new ReleaseEvidenceError("receipt-constraint-mismatch");
  }
  return verified;
};

/**
 * Durable, verifier-owned one-time nonce ledger. The receipt issuer's nonce
 * table prevents endpoint replay; this independent ledger prevents a copied
 * signed receipt chain from being accepted twice by the release verifier.
 */
export interface ReleaseEvidenceVerifierLedger {
  readonly consumeNonce: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly nonceDigest: string;
    readonly expiresAt: string;
    readonly now: string;
  }) => Promise<"consumed" | "replayed" | "full">;
}

export interface PostdeployBindingAcceptanceInput extends PostdeployBindingVerificationInput {
  readonly ledger: ReleaseEvidenceVerifierLedger;
}

/**
 * The only accepting verifier entry point. It validates exact caller-provided
 * app/deployment/image constraints, then atomically spends the nonce.
 */
export const verifyAndConsumePostdeployBinding = async (
  input: PostdeployBindingAcceptanceInput,
): Promise<SignedReceipt<PostdeployReceiptPayload>> => {
  const now = input.now ?? new Date().toISOString();
  const verified = verifyPostdeployBinding({ ...input, now });
  let result: "consumed" | "replayed" | "full";
  try {
    result = await input.ledger.consumeNonce({
      tenantId: input.tenantId,
      principalId: input.principalId,
      nonceDigest: nonceDigest(input.nonce),
      expiresAt: verified.expiresAt,
      now,
    });
  } catch {
    throw new ReleaseEvidenceError("storage-unavailable");
  }
  if (result === "replayed") throw new ReleaseEvidenceError("receipt-replayed");
  if (result !== "consumed") throw new ReleaseEvidenceError("storage-unavailable");
  return verified;
};
