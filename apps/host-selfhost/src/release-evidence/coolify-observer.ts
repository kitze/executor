/* oxlint-disable executor/no-try-catch-or-throw, executor/no-double-cast, executor/no-json-parse -- boundary: this host-only reducer parses untrusted provider JSON and log payloads once, then returns only the typed secret-free observation model */

import {
  COOLIFY_RUNTIME_IMAGE_SOURCE,
  PUBLIC_BUILD_MANIFEST_STAGE,
  ReleaseEvidenceError,
  payloadDigest,
  publicBuildEnvironmentManifestDigest,
  startupMarkersDigest,
  type ApplicationConfigurationObservation,
  type ApplicationTargetPolicy,
  type DeploymentObservation,
  type EnvironmentPolicyEvidence,
  type JsonValue,
  type ReleaseEvidenceObserver,
  type ReleaseEvidencePolicy,
  type StartupMarker,
} from "./protocol";

// ---------------------------------------------------------------------------
// Fixed Coolify Application API seam.
//
// There is deliberately no generic `execute` / arbitrary URL capability here.
// The implementation may call only these app-scoped operations. It never asks
// Coolify for a global deployment list, and it returns no raw response object.
// ---------------------------------------------------------------------------

export interface CoolifyApplicationApi {
  readonly getApplicationByUuid: (input: { readonly uuid: string }) => Promise<unknown>;
  readonly listDeploymentsByAppUuid: (input: {
    readonly uuid: string;
    readonly skip: number;
    readonly take: number;
  }) => Promise<unknown>;
  readonly getDeploymentByUuid: (input: { readonly uuid: string }) => Promise<unknown>;
  /**
   * Fixed Coolify control-plane observation of the image currently attached to
   * one finished deployment. This is not a deployment log, app environment,
   * tag, or caller-supplied URL.
   */
  readonly getDeploymentRuntimeImageByUuid: (input: { readonly uuid: string }) => Promise<unknown>;
  readonly listEnvsByApplicationUuid: (input: { readonly uuid: string }) => Promise<unknown>;
}

export interface CreateCoolifyReleaseEvidenceObserverOptions {
  readonly api: CoolifyApplicationApi;
  readonly now?: () => Date;
  /** Bound complete-history reads; a longer history fails closed instead of truncating it. */
  readonly maxDeploymentHistory?: number;
  readonly deploymentPageSize?: number;
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const fullShaPattern = /^[0-9a-f]{40}$/u;
const decimalIdentifier = /^[1-9][0-9]*$/u;
const safeIdentifier = /^[A-Za-z0-9._:-]{1,256}$/u;
const environmentNamePattern = /^[A-Z][A-Z0-9_]{0,255}$/u;
const forbiddenProductionEnvironmentNames = new Set([
  "NEXT_TELEMETRY_DISABLED",
  "S3_ALLOW_LEGACY_UPLOAD_SIGNING_FOR_TESTS",
]);

const rejected = (): never => {
  throw new ReleaseEvidenceError("evidence-rejected");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : rejected());

const string = (value: unknown): string =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : rejected();

const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : rejected();

const positiveId = (value: unknown): string => {
  const result =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : string(value);
  return decimalIdentifier.test(result) ? result : rejected();
};

const uuid = (value: unknown): string => {
  const result = string(value);
  return safeIdentifier.test(result) ? result : rejected();
};

const environmentName = (value: unknown): string => {
  const result = string(value);
  return environmentNamePattern.test(result) ? result : rejected();
};

const digest = (value: unknown): string => {
  const result = string(value).toLowerCase();
  return sha256Pattern.test(result) ? result : rejected();
};

const runtimeImageDigest = (value: unknown): string => {
  const result = string(value).toLowerCase();
  return imageDigestPattern.test(result) ? result : rejected();
};

const commit = (value: unknown): string => {
  const result = string(value).toLowerCase();
  return fullShaPattern.test(result) ? result : rejected();
};

interface TimestampValue {
  /** Receipt-safe UTC milliseconds. */
  readonly value: string;
  /** Preserves Coolify's sub-millisecond ordering while reducing the payload. */
  readonly position: bigint;
}

/**
 * Coolify timestamps can have up to nanosecond precision. Receipts retain
 * canonical milliseconds, but ordering/interval checks must use the original
 * precision so two log rows in the same millisecond cannot be swapped.
 */
const timestampValue = (value: unknown): TimestampValue => {
  const raw = string(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u);
  if (!match) return rejected();
  const wholeSecond = Date.parse(`${match[1]}.000Z`);
  if (
    !Number.isFinite(wholeSecond) ||
    new Date(wholeSecond).toISOString().slice(0, 19) !== match[1]
  ) {
    return rejected();
  }
  const fractionalNanoseconds = BigInt((match[2] ?? "").padEnd(9, "0"));
  const millisecond = wholeSecond + Number(fractionalNanoseconds / 1_000_000n);
  return {
    value: new Date(millisecond).toISOString(),
    position: BigInt(wholeSecond) * 1_000_000n + fractionalNanoseconds,
  };
};

const canonicalRepository = (value: unknown, expected: string): string => {
  const normalized = string(value)
    .replace(/^git@github\.com:/u, "https://github.com/")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
  if (normalized !== expected && normalized !== `https://github.com/${expected}`) return rejected();
  return expected;
};

const sourceLocation = (
  application: Record<string, unknown>,
  policy: ApplicationTargetPolicy,
): string => {
  const raw =
    policy.buildPack === "dockerfile"
      ? application.dockerfile_location
      : application.docker_compose_location;
  return string(raw) === policy.sourceLocation ? policy.sourceLocation : rejected();
};

const configuredHealthCheck = (
  application: Record<string, unknown>,
  policy: ApplicationTargetPolicy,
): ApplicationConfigurationObservation["healthCheck"] => {
  const expected = policy.healthCheck;
  if (application.health_check_enabled !== expected.enabled) return rejected();
  const values = {
    method: nullableString(application.health_check_method),
    path: nullableString(application.health_check_path),
    port: nullableString(application.health_check_port),
    scheme: nullableString(application.health_check_scheme),
    status:
      application.health_check_return_code === null ||
      application.health_check_return_code === undefined
        ? null
        : typeof application.health_check_return_code === "number" &&
            Number.isSafeInteger(application.health_check_return_code)
          ? application.health_check_return_code
          : rejected(),
  };
  if (
    values.method !== expected.method ||
    values.path !== expected.path ||
    values.port !== expected.port ||
    values.scheme !== expected.scheme ||
    values.status !== expected.status
  ) {
    return rejected();
  }
  return expected;
};

const reportedCommit = (value: unknown, expectedCommit?: string): string => {
  const raw = string(value);
  // `HEAD` is a source-faithful application read before promotion, but it can
  // never prove that the running deployment is the caller's requested SHA.
  if (raw.toUpperCase() === "HEAD") {
    if (expectedCommit) return rejected();
    return "HEAD";
  }
  const normalized = commit(raw);
  if (expectedCommit && normalized !== expectedCommit) return rejected();
  return normalized;
};

const reportedStatus = (value: unknown): string => {
  const status = string(value).toLowerCase();
  return ["running", "running:healthy", "running:unknown"].includes(status) ? status : rejected();
};

const normalizeApplication = (input: {
  readonly raw: unknown;
  readonly policy: ApplicationTargetPolicy;
  readonly observedAt: string;
  readonly expectedCommit?: string;
}): ApplicationConfigurationObservation => {
  const application = record(input.raw);
  if (
    uuid(application.uuid) !== input.policy.uuid ||
    positiveId(application.id) !== input.policy.applicationId
  ) {
    return rejected();
  }
  if (
    string(application.git_branch) !== input.policy.branch ||
    string(application.build_pack) !== input.policy.buildPack ||
    application.start_command !== input.policy.startCommand
  ) {
    return rejected();
  }
  return {
    uuid: input.policy.uuid,
    applicationId: input.policy.applicationId,
    repository: canonicalRepository(application.git_repository, input.policy.repository),
    branch: input.policy.branch,
    buildPack: input.policy.buildPack,
    startCommand: input.policy.startCommand,
    healthCheck: configuredHealthCheck(application, input.policy),
    sourceLocation: sourceLocation(application, input.policy),
    configurationHash: digest(application.config_hash),
    reportedCommit: reportedCommit(application.git_commit_sha, input.expectedCommit),
    reportedStatus: reportedStatus(application.status),
    observedAt: input.observedAt,
  };
};

interface HistoryEntry {
  readonly uuid: string;
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly commit: string;
  readonly status: string;
  readonly createdAt: string;
  readonly finishedAt: string;
  readonly createdAtPosition: bigint;
  readonly finishedAtPosition: bigint;
  readonly configurationHash: string;
}

const historyEntry = (value: unknown): HistoryEntry => {
  const entry = record(value);
  const createdAt = timestampValue(entry.created_at);
  const finishedAt = timestampValue(entry.finished_at);
  if (finishedAt.position < createdAt.position) return rejected();
  return {
    uuid: uuid(entry.deployment_uuid),
    applicationId: positiveId(entry.application_id),
    // A deployment without its numeric Coolify id cannot be linked to the
    // runtime-image observation, so the receipt must fail closed.
    deploymentId: positiveId(entry.id),
    commit: commit(entry.commit),
    status: string(entry.status).toLowerCase(),
    createdAt: createdAt.value,
    finishedAt: finishedAt.value,
    createdAtPosition: createdAt.position,
    finishedAtPosition: finishedAt.position,
    configurationHash: digest(entry.configuration_hash),
  };
};

const historyDigest = (entries: readonly HistoryEntry[], count: number): string =>
  payloadDigest({
    count,
    deployments: entries.map((entry) => ({
      applicationId: entry.applicationId,
      commit: entry.commit,
      configurationHash: entry.configurationHash,
      createdAt: entry.createdAt,
      deploymentId: entry.deploymentId,
      finishedAt: entry.finishedAt,
      status: entry.status,
      uuid: entry.uuid,
    })),
  } as unknown as JsonValue);

const sameHistoryEntry = (left: HistoryEntry, right: HistoryEntry): boolean =>
  left.uuid === right.uuid &&
  left.applicationId === right.applicationId &&
  left.deploymentId === right.deploymentId &&
  left.commit === right.commit &&
  left.status === right.status &&
  left.createdAtPosition === right.createdAtPosition &&
  left.finishedAtPosition === right.finishedAtPosition &&
  left.configurationHash === right.configurationHash;

const historyEnvelope = (
  value: unknown,
): { readonly count: number; readonly deployments: readonly unknown[] } => {
  const envelope = record(value);
  const count = envelope.count;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Array.isArray(envelope.deployments)
  ) {
    return rejected();
  }
  return { count, deployments: envelope.deployments };
};

const selectDeployment = (input: {
  readonly entries: readonly HistoryEntry[];
  readonly policy: ApplicationTargetPolicy;
  readonly proposedMainSha: string;
  readonly notBefore: string;
}): HistoryEntry => {
  const notBeforePosition = timestampValue(input.notBefore).position;
  const candidates = input.entries
    .filter(
      (entry) =>
        entry.applicationId === input.policy.applicationId &&
        entry.commit === input.proposedMainSha &&
        entry.status === "finished" &&
        entry.createdAtPosition >= notBeforePosition,
    )
    .toSorted((left, right) =>
      left.finishedAtPosition === right.finishedAtPosition
        ? 0
        : left.finishedAtPosition > right.finishedAtPosition
          ? -1
          : 1,
    );
  const selected = candidates[0];
  if (!selected) return rejected();
  if (candidates[1] && candidates[1].finishedAtPosition === selected.finishedAtPosition)
    return rejected();
  // A later normal deployment, queued deployment, or running deployment means
  // this app no longer has one unambiguous release state at observation time.
  // The provider history is complete and app-scoped, so fail rather than pick a
  // convenient older completed row.
  if (
    input.entries.some(
      (entry) =>
        entry.uuid !== selected.uuid &&
        // Equal source timestamps are ambiguous rather than harmless. Coolify
        // commonly calls an active row `in_progress`; treat that synonym as a
        // running release as well.
        entry.createdAtPosition >= selected.createdAtPosition &&
        ["finished", "queued", "running", "in_progress", "in-progress"].includes(entry.status),
    )
  ) {
    return rejected();
  }
  return selected;
};

const isNonPrWebhookRelease = (detail: Record<string, unknown>): boolean => {
  const pullRequestId = detail.pull_request_id;
  const pullRequest = detail.pull_request;
  const isPullRequest = detail.is_pull_request;
  return (
    detail.is_api === false &&
    detail.is_webhook === true &&
    detail.restart_only === false &&
    detail.rollback === false &&
    (pullRequestId === undefined || pullRequestId === null || pullRequestId === "") &&
    (pullRequest === undefined || pullRequest === null || pullRequest === false) &&
    (isPullRequest === undefined || isPullRequest === null || isPullRequest === false)
  );
};

const ansiEscapePattern = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "gu");

const exactLogLine = (value: string): string => value.replaceAll(ansiEscapePattern, "").trim();

const prismaSucceeded = (line: string): boolean =>
  /^(?:No pending migrations to apply\.|All migrations have been successfully applied\.|The following migration\(s\) have been applied:)$/u.test(
    line,
  );

const nextReady = (line: string): boolean => /^✓\s+Ready in \d+(?:\.\d+)?(?:ms|s)$/u.test(line);

/**
 * Lifecycle logs prove ordering only. They never contribute an image or
 * build-environment digest to a receipt; runtime provenance has a separate
 * Coolify control-plane source below.
 */
const markerMatch = (input: {
  readonly stage: string;
  readonly marker: string;
  readonly line: string;
}): boolean => {
  const line = exactLogLine(input.line);
  if (input.stage === "prisma-migrate" && input.marker === "Prisma migration deploy succeeded.") {
    return prismaSucceeded(line);
  }
  if (
    input.stage === PUBLIC_BUILD_MANIFEST_STAGE &&
    input.marker === "Public build environment manifest sha256 emitted."
  ) {
    return /^Public build environment manifest sha256: [0-9a-f]{64}\.$/u.test(line);
  }
  if (input.stage === "next-ready" && input.marker === "Next.js server ready.") {
    return nextReady(line);
  }
  return line === input.marker;
};

interface SelectedStartupMarker extends StartupMarker {
  readonly recordIndex: number;
  readonly lineIndex: number;
  readonly position: bigint;
}

interface StartupMarkerObservation {
  readonly markers: readonly StartupMarker[];
  /** Internal-only source timestamp positions aligned with `markers`. */
  readonly positions: readonly bigint[];
}

/**
 * Parse Coolify's JSON-encoded logs only inside this observer. Each expected
 * marker must occur exactly once in one visible stdout row and form one strict
 * lifecycle stream. Raw output, commands, and log metadata never cross this
 * reduction boundary.
 */
const startupMarkers = (
  rawLogs: unknown,
  policy: ApplicationTargetPolicy,
): StartupMarkerObservation => {
  const serialized = string(rawLogs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return rejected();
  }
  if (!Array.isArray(parsed)) return rejected();
  const selected = new Map<string, SelectedStartupMarker>();
  for (const [recordIndex, candidate] of parsed.entries()) {
    if (!isRecord(candidate) || typeof candidate.output !== "string") continue;
    for (const [lineIndex, sourceLine] of candidate.output.split(/\r?\n/u).entries()) {
      for (const expected of policy.requiredStartupMarkers) {
        if (!markerMatch({ ...expected, line: sourceLine })) continue;
        // An absent or arbitrary row field must not be treated as deployment
        // stdout. Fail on a matching line instead of silently selecting a later
        // convenient marker.
        if (candidate.hidden !== false || candidate.type !== "stdout") return rejected();
        if (selected.has(expected.stage)) return rejected();
        const observed = timestampValue(candidate.timestamp);
        selected.set(expected.stage, {
          stage: expected.stage,
          marker: expected.marker,
          observedAt: observed.value,
          recordIndex,
          lineIndex,
          position: observed.position,
        });
      }
    }
  }
  if (selected.size !== policy.requiredStartupMarkers.length) return rejected();
  const ordered = policy.requiredStartupMarkers.map(
    (expected) => selected.get(expected.stage) ?? rejected(),
  );
  for (const [index, candidate] of ordered.entries()) {
    const previous = ordered[index - 1];
    if (
      previous &&
      (candidate.recordIndex < previous.recordIndex ||
        (candidate.recordIndex === previous.recordIndex &&
          candidate.lineIndex <= previous.lineIndex) ||
        candidate.position <= previous.position)
    ) {
      return rejected();
    }
  }
  const markers = ordered.map(
    ({ lineIndex: _lineIndex, position: _position, recordIndex: _recordIndex, ...marker }) =>
      marker,
  );
  return {
    markers,
    positions: ordered.map((candidate) => candidate.position),
  };
};

interface NormalizedDeployment {
  readonly deployment: Omit<
    DeploymentObservation,
    "deploymentHistoryDigest" | "deploymentHistoryCount"
  >;
}

const runtimeImage = (input: {
  readonly raw: unknown;
  readonly selected: HistoryEntry;
  readonly policy: ApplicationTargetPolicy;
}): DeploymentObservation["runtimeImage"] => {
  const observed = record(input.raw);
  // This response comes from the fixed Coolify runtime-image endpoint. Its
  // app/deployment identity is checked before its one safe digest crosses the
  // raw-provider boundary.
  if (
    uuid(observed.application_uuid) !== input.policy.uuid ||
    positiveId(observed.application_id) !== input.policy.applicationId ||
    uuid(observed.deployment_uuid) !== input.selected.uuid ||
    positiveId(observed.deployment_id) !== input.selected.deploymentId
  ) {
    return rejected();
  }
  return {
    source: COOLIFY_RUNTIME_IMAGE_SOURCE,
    digest: runtimeImageDigest(observed.image_digest),
  };
};

const normalizeDeployment = (input: {
  readonly raw: unknown;
  readonly runtimeImageRaw: unknown;
  readonly selected: HistoryEntry;
  readonly application: ApplicationConfigurationObservation;
  readonly policy: ApplicationTargetPolicy;
  readonly proposedMainSha: string;
}): NormalizedDeployment => {
  const detail = record(input.raw);
  const nestedApplication = record(detail.application);
  const createdAt = timestampValue(detail.created_at);
  const finishedAt = timestampValue(detail.finished_at);
  const detailDeploymentId = positiveId(detail.id);
  if (
    uuid(detail.deployment_uuid) !== input.selected.uuid ||
    commit(detail.commit) !== input.proposedMainSha ||
    string(detail.status).toLowerCase() !== "finished" ||
    positiveId(detail.application_id) !== input.policy.applicationId ||
    uuid(nestedApplication.uuid) !== input.policy.uuid ||
    positiveId(nestedApplication.id) !== input.policy.applicationId ||
    createdAt.position !== input.selected.createdAtPosition ||
    finishedAt.position !== input.selected.finishedAtPosition ||
    detailDeploymentId !== input.selected.deploymentId ||
    digest(detail.configuration_hash) !== input.selected.configurationHash ||
    digest(detail.configuration_hash) !== input.application.configurationHash ||
    !isNonPrWebhookRelease(detail)
  ) {
    return rejected();
  }
  const startup = startupMarkers(detail.logs, input.policy);
  for (const markerPosition of startup.positions) {
    if (markerPosition < createdAt.position || markerPosition > finishedAt.position)
      return rejected();
  }
  return {
    deployment: {
      uuid: input.selected.uuid,
      deploymentId: detailDeploymentId,
      applicationUuid: input.policy.uuid,
      applicationId: input.policy.applicationId,
      sourceCommit: input.proposedMainSha,
      status: "finished",
      releaseKind: "webhook-main",
      restartOnly: false,
      rollback: false,
      createdAt: input.selected.createdAt,
      finishedAt: input.selected.finishedAt,
      configurationHash: input.selected.configurationHash,
      startupMarkers: startup.markers,
      startupMarkersDigest: startupMarkersDigest(startup.markers),
      runtimeImage: runtimeImage({
        raw: input.runtimeImageRaw,
        selected: input.selected,
        policy: input.policy,
      }),
    },
  };
};

const withFinalHistory = (
  deployment: NormalizedDeployment["deployment"],
  history: readonly HistoryEntry[],
): DeploymentObservation => ({
  ...deployment,
  deploymentHistoryDigest: historyDigest(history, history.length),
  deploymentHistoryCount: history.length,
});

const environmentFlagMatches = (
  entry: Record<string, unknown>,
  expected: EnvironmentPolicyEvidence["flags"][number],
): boolean =>
  entry.key === expected.key &&
  entry.is_buildtime === expected.isBuildtime &&
  entry.is_runtime === expected.isRuntime &&
  entry.is_literal === expected.isLiteral &&
  entry.is_preview === expected.isPreview &&
  entry.is_shown_once === expected.isShownOnce;

const environmentRows = (value: unknown): readonly Record<string, unknown>[] => {
  if (!Array.isArray(value)) return rejected();
  return value.map(record);
};

/**
 * Preflight reads Root records only. The fixed policy represents the approved
 * production Root flags; it never includes a value or an environment UUID.
 */
const verifyRootEnvironmentPolicy = (input: {
  readonly root: readonly Record<string, unknown>[];
  readonly expected: EnvironmentPolicyEvidence;
}): EnvironmentPolicyEvidence => {
  for (const flag of input.expected.flags) {
    const matches = input.root.filter((entry) => environmentFlagMatches(entry, flag));
    if (matches.length !== 1) return rejected();
  }
  return input.expected;
};

/**
 * Derive the image writer's versioned Root manifest. This deliberately reads
 * only Coolify's `real_value` for literal, build-time, allowlisted Docker ARG
 * records. A missing or runtime-only public row resolves to the pinned Docker
 * default in `publicBuildEnvironmentManifestDigest`.
 */
const derivePublicBuildEnvironmentManifestDigest = (
  rootEnvs: readonly Record<string, unknown>[],
  policy: ReleaseEvidencePolicy["publicBuildEnvironmentManifest"],
): string => {
  const allowedNames = new Set(policy.defaults.map((entry) => entry.name));
  const supplied: Record<string, string> = {};
  const names = new Set<string>();
  for (const entry of rootEnvs) {
    if (entry.is_preview === true) continue;
    if (entry.is_preview !== false) return rejected();
    const name = environmentName(entry.key);
    if (names.has(name)) return rejected();
    names.add(name);
    if (forbiddenProductionEnvironmentNames.has(name)) return rejected();
    if (typeof entry.is_buildtime !== "boolean" || typeof entry.is_runtime !== "boolean") {
      return rejected();
    }
    // Every production Root record must be injected at runtime; a build-only
    // value cannot be faithfully observed after the promotion starts.
    if (entry.is_runtime !== true) return rejected();
    if (!entry.is_buildtime) continue;
    // The policy's complete default table is the only accepted Docker ARG
    // allowlist. In particular, an arbitrary NEXT_PUBLIC_* prefix is not a
    // permission to inject a build argument.
    if (!allowedNames.has(name) || entry.is_literal !== true) return rejected();
    if (typeof entry.real_value !== "string") return rejected();
    supplied[name] = entry.real_value;
  }
  return publicBuildEnvironmentManifestDigest(policy, supplied);
};

export const createCoolifyReleaseEvidenceObserver = (
  options: CreateCoolifyReleaseEvidenceObserverOptions,
): ReleaseEvidenceObserver => {
  const now = options.now ?? (() => new Date());
  const maxHistory = options.maxDeploymentHistory ?? 500;
  const pageSize = options.deploymentPageSize ?? 100;
  if (
    !Number.isSafeInteger(maxHistory) ||
    maxHistory <= 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0
  ) {
    throw new ReleaseEvidenceError("invalid-request");
  }

  const allHistory = async (applicationUuid: string): Promise<readonly HistoryEntry[]> => {
    const first = historyEnvelope(
      await options.api.listDeploymentsByAppUuid({
        uuid: applicationUuid,
        skip: 0,
        take: pageSize,
      }),
    );
    if (first.count > maxHistory || first.deployments.length > first.count) return rejected();
    const pages: unknown[] = [...first.deployments];
    for (let skip = first.deployments.length; skip < first.count; skip += pageSize) {
      const page = historyEnvelope(
        await options.api.listDeploymentsByAppUuid({ uuid: applicationUuid, skip, take: pageSize }),
      );
      if (page.count !== first.count || page.deployments.length === 0) return rejected();
      pages.push(...page.deployments);
    }
    if (pages.length !== first.count) return rejected();
    const entries = pages.map(historyEntry);
    if (new Set(entries.map((entry) => entry.uuid)).size !== entries.length) return rejected();
    return entries;
  };

  const applicationPair = async (policy: ApplicationTargetPolicy, expectedCommit?: string) =>
    normalizeApplication({
      raw: await options.api.getApplicationByUuid({ uuid: policy.uuid }),
      policy,
      observedAt: now().toISOString(),
      expectedCommit,
    });

  /**
   * The pre-promotion capability intentionally has one environment read: Root.
   * Zero and postdeploy configuration reads cannot influence the signed build
   * manifest expectation.
   */
  const preflightEnvironment = async (policy: ReleaseEvidencePolicy) => {
    const root = environmentRows(
      await options.api.listEnvsByApplicationUuid({ uuid: policy.root.uuid }),
    );
    return {
      policy: verifyRootEnvironmentPolicy({ root, expected: policy.environmentPolicy }),
      expectedDigest: derivePublicBuildEnvironmentManifestDigest(
        root,
        policy.publicBuildEnvironmentManifest,
      ),
    };
  };

  return {
    preflight: async ({ policy }) => {
      const [root, zero, environment] = await Promise.all([
        applicationPair(policy.root),
        applicationPair(policy.zero),
        preflightEnvironment(policy),
      ]);
      return {
        root,
        zero,
        publicBuildEnvironmentManifest: {
          version: policy.publicBuildEnvironmentManifest.version,
          expectedDigest: environment.expectedDigest,
        },
        environmentPolicy: environment.policy,
      };
    },

    postdeploy: async ({ proposedMainSha, notBefore, policy }) => {
      const [initialRoot, initialZero] = await Promise.all([
        applicationPair(policy.root),
        applicationPair(policy.zero),
      ]);
      const [rootHistory, zeroHistory] = await Promise.all([
        allHistory(policy.root.uuid),
        allHistory(policy.zero.uuid),
      ]);
      const selectedRoot = selectDeployment({
        entries: rootHistory,
        policy: policy.root,
        proposedMainSha,
        notBefore,
      });
      const selectedZero = selectDeployment({
        entries: zeroHistory,
        policy: policy.zero,
        proposedMainSha,
        notBefore,
      });
      const [rootDetail, zeroDetail, rootRuntimeImage, zeroRuntimeImage] = await Promise.all([
        options.api.getDeploymentByUuid({ uuid: selectedRoot.uuid }),
        options.api.getDeploymentByUuid({ uuid: selectedZero.uuid }),
        options.api.getDeploymentRuntimeImageByUuid({ uuid: selectedRoot.uuid }),
        options.api.getDeploymentRuntimeImageByUuid({ uuid: selectedZero.uuid }),
      ]);
      // These final application reads deliberately happen after selection.
      // They prove final configuration; runtime provenance is separately bound
      // to the fixed Coolify runtime-image read above.
      const [root, zero] = await Promise.all([
        applicationPair(policy.root, proposedMainSha),
        applicationPair(policy.zero, proposedMainSha),
      ]);
      // Reduce detail/log/runtime-image observations before taking the final
      // complete history snapshots below. A later active/finished deployment
      // must invalidate this release rather than being omitted from a receipt.
      const normalizedRootDeployment = normalizeDeployment({
        raw: rootDetail,
        runtimeImageRaw: rootRuntimeImage,
        selected: selectedRoot,
        application: root,
        policy: policy.root,
        proposedMainSha,
      });
      const normalizedZeroDeployment = normalizeDeployment({
        raw: zeroDetail,
        runtimeImageRaw: zeroRuntimeImage,
        selected: selectedZero,
        application: zero,
        policy: policy.zero,
        proposedMainSha,
      });
      // Keep the initial reads semantically meaningful: their identities and
      // static configuration must agree with the final observations, so a
      // target cannot change between selection and final configuration read.
      if (
        initialRoot.configurationHash !== root.configurationHash ||
        initialZero.configurationHash !== zero.configurationHash
      ) {
        return rejected();
      }
      const [finalRootHistory, finalZeroHistory] = await Promise.all([
        allHistory(policy.root.uuid),
        allHistory(policy.zero.uuid),
      ]);
      const finalRoot = selectDeployment({
        entries: finalRootHistory,
        policy: policy.root,
        proposedMainSha,
        notBefore,
      });
      const finalZero = selectDeployment({
        entries: finalZeroHistory,
        policy: policy.zero,
        proposedMainSha,
        notBefore,
      });
      if (
        !sameHistoryEntry(finalRoot, selectedRoot) ||
        !sameHistoryEntry(finalZero, selectedZero)
      ) {
        return rejected();
      }
      return {
        root: {
          application: root,
          deployment: withFinalHistory(normalizedRootDeployment.deployment, finalRootHistory),
        },
        zero: {
          application: zero,
          deployment: withFinalHistory(normalizedZeroDeployment.deployment, finalZeroHistory),
        },
        // This exact policy was checked in preflight and is not reread here.
        environmentPolicy: policy.environmentPolicy,
      };
    },
  };
};
