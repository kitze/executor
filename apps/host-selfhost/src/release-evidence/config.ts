/* oxlint-disable executor/no-try-catch-or-throw, executor/no-instanceof-tagged-error, executor/no-json-parse -- boundary: process environment is untyped boot input; this opt-in host configuration fails closed before the Effect app is assembled */

import {
  GLINK_ROOT_STARTUP_MARKERS,
  GLINK_ZERO_STARTUP_MARKERS,
  ReleaseEvidenceError,
  normalizeReleaseEvidenceVerificationKeys,
  parseEnvironmentPolicyEvidence,
  type PublicBuildEnvironmentManifestPolicy,
  type ReleaseEvidenceVerificationKey,
} from "./protocol";
import type {
  ApplicationTargetPolicy,
  HealthCheckConfiguration,
  ReleaseEvidencePolicy,
  StartupMarker,
} from "./protocol";
import type { ReleaseEvidenceHostConfig } from "./host";

type Environment = Readonly<Record<string, string | undefined>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (): never => {
  throw new ReleaseEvidenceError("invalid-request");
};

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : invalid());

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !(key in value)))
    invalid();
};

const nonEmpty = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : invalid();

const optionalString = (value: unknown): string | null =>
  value === null ? null : typeof value === "string" ? value : invalid();

const healthCheck = (value: unknown): HealthCheckConfiguration => {
  const source = record(value);
  exactKeys(source, ["enabled", "method", "path", "port", "scheme", "status"]);
  if (
    typeof source.enabled !== "boolean" ||
    (source.status !== null &&
      (!Number.isSafeInteger(source.status) || typeof source.status !== "number"))
  ) {
    return invalid();
  }
  return {
    enabled: source.enabled,
    method: optionalString(source.method),
    path: optionalString(source.path),
    port: optionalString(source.port),
    scheme: optionalString(source.scheme),
    status: source.status,
  };
};

const requiredStartupMarkers = (
  value: unknown,
): readonly Pick<StartupMarker, "stage" | "marker">[] => {
  if (!Array.isArray(value)) return invalid();
  return value.map((entry) => {
    const marker = record(entry);
    exactKeys(marker, ["stage", "marker"]);
    return { stage: nonEmpty(marker.stage), marker: nonEmpty(marker.marker) };
  });
};

const sameStartupMarkers = (
  actual: readonly Pick<StartupMarker, "stage" | "marker">[],
  expected: readonly Pick<StartupMarker, "stage" | "marker">[],
): boolean =>
  actual.length === expected.length &&
  actual.every(
    (entry, index) =>
      entry.stage === expected[index]?.stage && entry.marker === expected[index]?.marker,
  );

const publicBuildEnvironmentManifest = (value: unknown): PublicBuildEnvironmentManifestPolicy => {
  const source = record(value);
  exactKeys(source, ["version", "defaults"]);
  if (source.version !== 1 || !Array.isArray(source.defaults)) return invalid();
  const defaults = source.defaults.map((entry) => {
    const defaultEntry = record(entry);
    exactKeys(defaultEntry, ["name", "value"]);
    const name = nonEmpty(defaultEntry.name);
    if (!/^NEXT_PUBLIC_[A-Z0-9_]+$/u.test(name) || typeof defaultEntry.value !== "string") {
      return invalid();
    }
    return { name, value: defaultEntry.value };
  });
  if (
    defaults.length === 0 ||
    new Set(defaults.map((entry) => entry.name)).size !== defaults.length
  ) {
    return invalid();
  }
  return { version: 1, defaults };
};

const applicationPolicy = (value: unknown): ApplicationTargetPolicy => {
  const source = record(value);
  exactKeys(source, [
    "uuid",
    "applicationId",
    "repository",
    "branch",
    "buildPack",
    "startCommand",
    "healthCheck",
    "sourceLocation",
    "requiredStartupMarkers",
  ]);
  const applicationId = nonEmpty(source.applicationId);
  if (!/^[1-9][0-9]*$/u.test(applicationId) || nonEmpty(source.branch) !== "main") return invalid();
  return {
    uuid: nonEmpty(source.uuid),
    applicationId,
    repository: nonEmpty(source.repository),
    branch: "main",
    buildPack: nonEmpty(source.buildPack),
    // Empty start command is a valid, intentional Coolify configuration.
    startCommand: typeof source.startCommand === "string" ? source.startCommand : invalid(),
    healthCheck: healthCheck(source.healthCheck),
    sourceLocation: nonEmpty(source.sourceLocation),
    requiredStartupMarkers: requiredStartupMarkers(source.requiredStartupMarkers),
  };
};

const policy = (value: unknown): ReleaseEvidencePolicy => {
  const source = record(value);
  exactKeys(source, [
    "root",
    "zero",
    "publicBuildEnvironmentManifest",
    "environmentPolicy",
    "receiptTtlMs",
  ]);
  if (
    typeof source.receiptTtlMs !== "number" ||
    !Number.isSafeInteger(source.receiptTtlMs) ||
    source.receiptTtlMs < 60_000 ||
    source.receiptTtlMs > 30 * 60_000
  ) {
    return invalid();
  }
  const root = applicationPolicy(source.root);
  const zero = applicationPolicy(source.zero);
  if (
    !sameStartupMarkers(root.requiredStartupMarkers, GLINK_ROOT_STARTUP_MARKERS) ||
    !sameStartupMarkers(zero.requiredStartupMarkers, GLINK_ZERO_STARTUP_MARKERS)
  ) {
    return invalid();
  }
  return {
    root,
    zero,
    publicBuildEnvironmentManifest: publicBuildEnvironmentManifest(
      source.publicBuildEnvironmentManifest,
    ),
    environmentPolicy: parseEnvironmentPolicyEvidence(source.environmentPolicy),
    receiptTtlMs: source.receiptTtlMs,
  };
};

const requiredEnvironment = (environment: Environment, name: string): string => {
  const value = environment[name]?.trim();
  return value ? value : invalid();
};

const verificationKeys = (environment: Environment): readonly ReleaseEvidenceVerificationKey[] => {
  const serialized = environment.EXECUTOR_RELEASE_EVIDENCE_ED25519_VERIFICATION_KEYS_JSON;
  if (serialized === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid();
  }
  if (!Array.isArray(parsed)) return invalid();
  return normalizeReleaseEvidenceVerificationKeys(
    parsed.map((entry) => {
      const key = record(entry);
      exactKeys(key, ["keyId", "publicKey"]);
      return { keyId: nonEmpty(key.keyId), publicKey: nonEmpty(key.publicKey) };
    }),
  );
};

/**
 * Opt-in only. Normal Executor self-host installations do not expose this
 * privileged route or create its receipt tables. When enabled, incomplete
 * configuration fails boot rather than silently serving an unsigned endpoint.
 */
export const loadReleaseEvidenceConfig = (
  environment: Environment = process.env,
): ReleaseEvidenceHostConfig | null => {
  if (environment.EXECUTOR_RELEASE_EVIDENCE_ENABLED !== "true") return null;
  let parsedPolicy: unknown;
  try {
    parsedPolicy = JSON.parse(
      requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_POLICY_JSON"),
    );
  } catch (error) {
    if (error instanceof ReleaseEvidenceError) throw error;
    return invalid();
  }
  return {
    caller: {
      tenantId: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_TENANT_ID"),
      principalId: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_PRINCIPAL_ID"),
    },
    callerToken: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_CALLER_TOKEN"),
    signing: {
      keyId: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_ED25519_KEY_ID"),
      privateKey: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_ED25519_PRIVATE_KEY"),
      verificationKeys: verificationKeys(environment),
    },
    coolify: {
      baseUrl: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_COOLIFY_BASE_URL"),
      token: requiredEnvironment(environment, "EXECUTOR_RELEASE_EVIDENCE_COOLIFY_TOKEN"),
    },
    policy: policy(parsedPolicy),
  };
};
