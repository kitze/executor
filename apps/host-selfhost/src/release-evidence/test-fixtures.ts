import { generateKeyPairSync } from "node:crypto";

import {
  GLINK_ROOT_STARTUP_MARKERS,
  GLINK_ZERO_STARTUP_MARKERS,
  createNodeEd25519Signer,
  publicBuildEnvironmentManifestDigest,
  startupMarkersDigest,
  type ApplicationConfigurationObservation,
} from "./protocol";
import type {
  ApplicationReleaseObservation,
  EnvironmentPolicyEvidence,
  PostdeployObservation,
  PreflightObservation,
  ReleaseEvidenceCaller,
  ReleaseEvidenceObserver,
  ReleaseEvidencePolicy,
  ReleaseEvidencePreflightRequest,
} from "./protocol";

export const MAIN_SHA = "0123456789abcdef0123456789abcdef01234567";
export const CONFIG_HASH = "ab".repeat(32);
export const ENVIRONMENT_POLICY_DIGEST = "ef".repeat(32);
export const ROOT_RUNTIME_IMAGE_DIGEST = `sha256:${"cd".repeat(32)}`;
export const ZERO_RUNTIME_IMAGE_DIGEST = `sha256:${"de".repeat(32)}`;
export const CALLER: ReleaseEvidenceCaller = {
  tenantId: "glink-tenant",
  principalId: "glink-release",
};
export const NONCE = "nonce_for_a_one_time_release_1234";

export const ENVIRONMENT_POLICY: EnvironmentPolicyEvidence = {
  digest: ENVIRONMENT_POLICY_DIGEST,
  flags: [
    {
      key: "NEXT_PUBLIC_ZERO_SERVER",
      isBuildtime: true,
      isRuntime: true,
      isLiteral: true,
      isPreview: false,
      isShownOnce: false,
    },
  ],
};

export const PUBLIC_BUILD_ENVIRONMENT_MANIFEST = {
  version: 1,
  defaults: [
    { name: "NEXT_PUBLIC_APP_DESCRIPTION", value: "Glink changelog platform" },
    { name: "NEXT_PUBLIC_APP_NAME", value: "Glink" },
    { name: "NEXT_PUBLIC_APP_URL", value: "" },
    { name: "NEXT_PUBLIC_AUTH_ENABLE_EMAIL_PASSWORD_AUTHENTICATION", value: "true" },
    { name: "NEXT_PUBLIC_AUTH_ENABLE_EMAIL_VERIFICATION", value: "true" },
    { name: "NEXT_PUBLIC_EMAIL_ENABLE_EMAIL_PREVIEW", value: "true" },
    { name: "NEXT_PUBLIC_EMAIL_PREVIEW_OPEN_SIMULATOR", value: "false" },
    { name: "NEXT_PUBLIC_EMAIL_PREVIEW_OPEN_TAB", value: "true" },
    { name: "NEXT_PUBLIC_EMAIL_PROVIDER", value: "nodemailer-app" },
    { name: "NEXT_PUBLIC_ENABLE_ABOUT_PAGE", value: "true" },
    { name: "NEXT_PUBLIC_ENABLE_BACKGROUND_JOBS", value: "false" },
    { name: "NEXT_PUBLIC_ENABLE_BLOG_PAGE", value: "true" },
    { name: "NEXT_PUBLIC_ENABLE_CHAT_PAGE", value: "true" },
    { name: "NEXT_PUBLIC_ENABLE_CRON", value: "false" },
    { name: "NEXT_PUBLIC_ENABLE_GITHUB_INTEGRATION", value: "false" },
    { name: "NEXT_PUBLIC_ENABLE_POLAR", value: "false" },
    { name: "NEXT_PUBLIC_ENABLE_PRICING_PAGE", value: "true" },
    { name: "NEXT_PUBLIC_POLAR_ENV", value: "sandbox" },
    { name: "NEXT_PUBLIC_POSTHOG_HOST", value: "" },
    { name: "NEXT_PUBLIC_POSTHOG_KEY", value: "" },
    { name: "NEXT_PUBLIC_S3_BUCKET_NAME", value: "" },
    { name: "NEXT_PUBLIC_S3_ENDPOINT", value: "" },
    { name: "NEXT_PUBLIC_SIZZY_ENDPOINT", value: "" },
    { name: "NEXT_PUBLIC_SIZZY_GRAPHQL_TOKEN", value: "" },
    { name: "NEXT_PUBLIC_ZERO_SERVER", value: "" },
  ],
} as const;

export const EXPECTED_MANIFEST_DIGEST = publicBuildEnvironmentManifestDigest(
  PUBLIC_BUILD_ENVIRONMENT_MANIFEST,
  { NEXT_PUBLIC_ZERO_SERVER: "https://public.example.invalid" },
);

export const POLICY: ReleaseEvidencePolicy = {
  root: {
    uuid: "root-app-uuid",
    applicationId: "1001",
    repository: "example/glink",
    branch: "main",
    buildPack: "dockerfile",
    startCommand: "",
    sourceLocation: "/Dockerfile",
    healthCheck: {
      enabled: true,
      method: "GET",
      path: "/api/health",
      port: "3000",
      scheme: "http",
      status: 200,
    },
    requiredStartupMarkers: GLINK_ROOT_STARTUP_MARKERS,
  },
  zero: {
    uuid: "zero-app-uuid",
    applicationId: "1002",
    repository: "example/glink",
    branch: "main",
    buildPack: "dockercompose",
    startCommand: "",
    sourceLocation: "/infra/zero/docker-compose.coolify.yml",
    healthCheck: {
      enabled: false,
      method: null,
      path: null,
      port: null,
      scheme: null,
      status: null,
    },
    requiredStartupMarkers: GLINK_ZERO_STARTUP_MARKERS,
  },
  publicBuildEnvironmentManifest: PUBLIC_BUILD_ENVIRONMENT_MANIFEST,
  environmentPolicy: ENVIRONMENT_POLICY,
  receiptTtlMs: 15 * 60_000,
};

const rootConfiguration = (reportedCommit: string): ApplicationConfigurationObservation => ({
  uuid: POLICY.root.uuid,
  applicationId: POLICY.root.applicationId,
  repository: POLICY.root.repository,
  branch: POLICY.root.branch,
  buildPack: POLICY.root.buildPack,
  startCommand: POLICY.root.startCommand,
  healthCheck: POLICY.root.healthCheck,
  sourceLocation: POLICY.root.sourceLocation,
  configurationHash: CONFIG_HASH,
  reportedCommit,
  reportedStatus: "running:unknown",
  observedAt: "2026-08-02T12:01:05.000Z",
});

const zeroConfiguration = (reportedCommit: string): ApplicationConfigurationObservation => ({
  uuid: POLICY.zero.uuid,
  applicationId: POLICY.zero.applicationId,
  repository: POLICY.zero.repository,
  branch: POLICY.zero.branch,
  buildPack: POLICY.zero.buildPack,
  startCommand: POLICY.zero.startCommand,
  healthCheck: POLICY.zero.healthCheck,
  sourceLocation: POLICY.zero.sourceLocation,
  configurationHash: CONFIG_HASH,
  reportedCommit,
  reportedStatus: "running:unknown",
  observedAt: "2026-08-02T12:01:05.000Z",
});

export const preflightObservation = (): PreflightObservation => ({
  root: rootConfiguration("HEAD"),
  zero: zeroConfiguration("HEAD"),
  publicBuildEnvironmentManifest: { version: 1, expectedDigest: EXPECTED_MANIFEST_DIGEST },
  environmentPolicy: ENVIRONMENT_POLICY,
});

const rootMarkers = [
  {
    stage: "prisma-migrate",
    marker: "Prisma migration deploy succeeded.",
    observedAt: "2026-08-02T12:01:01.000Z",
  },
  {
    stage: "public-build-environment-manifest",
    marker: "Public build environment manifest sha256 emitted.",
    observedAt: "2026-08-02T12:01:02.000Z",
  },
  {
    stage: "runtime-preflight",
    marker: "Runtime environment preflight passed.",
    observedAt: "2026-08-02T12:01:03.000Z",
  },
  {
    stage: "zero-public-readiness",
    marker: "Zero public readiness preflight passed.",
    observedAt: "2026-08-02T12:01:04.000Z",
  },
  { stage: "next-ready", marker: "Next.js server ready.", observedAt: "2026-08-02T12:01:05.000Z" },
] as const;

const zeroMarkers = [
  {
    stage: "zero-publication-apply",
    marker: "Zero publication glink_zero_publication is exact for 36 browser-safe tables (apply).",
    observedAt: "2026-08-02T12:01:01.000Z",
  },
  {
    stage: "zero-preflight",
    marker: "Zero publication glink_zero_publication is exact for 36 browser-safe tables (check).",
    observedAt: "2026-08-02T12:01:02.000Z",
  },
  {
    stage: "zero-ops-monitor",
    marker:
      "Zero publication glink_zero_publication is exact for 36 browser-safe tables (drift-check).",
    observedAt: "2026-08-02T12:01:03.000Z",
  },
] as const;

const release = (kind: "root" | "zero", reportedCommit: string): ApplicationReleaseObservation => {
  const policy = POLICY[kind];
  const markers = kind === "root" ? rootMarkers : zeroMarkers;
  return {
    application:
      kind === "root" ? rootConfiguration(reportedCommit) : zeroConfiguration(reportedCommit),
    deployment: {
      uuid: `${kind}-deployment-uuid`,
      deploymentId: kind === "root" ? "9001" : "9002",
      applicationUuid: policy.uuid,
      applicationId: policy.applicationId,
      sourceCommit: MAIN_SHA,
      status: "finished",
      releaseKind: "webhook-main",
      restartOnly: false,
      rollback: false,
      createdAt: "2026-08-02T12:01:00.000Z",
      finishedAt: "2026-08-02T12:01:10.000Z",
      configurationHash: CONFIG_HASH,
      deploymentHistoryDigest: "aa".repeat(32),
      deploymentHistoryCount: 2,
      startupMarkers: markers,
      startupMarkersDigest: startupMarkersDigest(markers),
      runtimeImage: {
        source: "coolify-deployment-runtime-image-v1",
        digest: kind === "root" ? ROOT_RUNTIME_IMAGE_DIGEST : ZERO_RUNTIME_IMAGE_DIGEST,
      },
    },
  };
};

export const postdeployObservation = (
  rootRuntimeImageDigest = ROOT_RUNTIME_IMAGE_DIGEST,
): PostdeployObservation => {
  const root = release("root", MAIN_SHA);
  return {
    root: {
      ...root,
      deployment: {
        ...root.deployment,
        runtimeImage: { ...root.deployment.runtimeImage, digest: rootRuntimeImageDigest },
      },
    },
    zero: release("zero", MAIN_SHA),
    environmentPolicy: ENVIRONMENT_POLICY,
  };
};

export const preflightRequest = (): ReleaseEvidencePreflightRequest => ({
  action: "coolify.glink.authorizeReleaseEnvironment.v1",
  protocolVersion: 1,
  tenantId: CALLER.tenantId,
  principalId: CALLER.principalId,
  nonce: NONCE,
  proposedMainSha: MAIN_SHA,
  root: { uuid: POLICY.root.uuid, applicationId: POLICY.root.applicationId },
  zero: { uuid: POLICY.zero.uuid, applicationId: POLICY.zero.applicationId },
  environmentPolicy: ENVIRONMENT_POLICY,
});

export const observer = (
  input: {
    readonly preflight?: PreflightObservation;
    readonly postdeploy?: PostdeployObservation;
  } = {},
): ReleaseEvidenceObserver => ({
  preflight: async () => input.preflight ?? preflightObservation(),
  postdeploy: async () => input.postdeploy ?? postdeployObservation(),
});

export const signer = (keyId = "glink-test-key-2026") => {
  const keys = generateKeyPairSync("ed25519");
  return createNodeEd25519Signer({
    keyId,
    privateKey: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  });
};
