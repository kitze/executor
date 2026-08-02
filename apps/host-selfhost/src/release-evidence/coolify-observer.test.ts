import { expect, test } from "@effect/vitest";

import { createCoolifyReleaseEvidenceObserver } from "./coolify-observer";
import { publicBuildEnvironmentManifestDigest } from "./protocol";
import { EXPECTED_MANIFEST_DIGEST, MAIN_SHA, POLICY } from "./test-fixtures";

const CONFIG_HASH = "ab".repeat(32);

const stdout = (timestamp: string, output: string) => ({
  hidden: false,
  output,
  timestamp,
  type: "stdout",
});

const rootLogRecords = (manifestDigest = EXPECTED_MANIFEST_DIGEST) => [
  stdout(
    "2026-08-02T12:01:01.123456Z",
    "untrusted-provider-output secret-from-log\nNo pending migrations to apply.",
  ),
  stdout(
    "2026-08-02T12:01:02.123456Z",
    `untrusted-provider-output secret-from-log\nPublic build environment manifest sha256: ${manifestDigest}.`,
  ),
  stdout(
    "2026-08-02T12:01:03.123456Z",
    "untrusted-provider-output secret-from-log\nRuntime environment preflight passed.",
  ),
  stdout(
    "2026-08-02T12:01:04.123456Z",
    "untrusted-provider-output secret-from-log\nZero public readiness preflight passed.",
  ),
  stdout(
    "2026-08-02T12:01:05.123456Z",
    "untrusted-provider-output secret-from-log\n✓ Ready in 42ms",
  ),
];

const zeroLogRecords = () => [
  stdout(
    "2026-08-02T12:01:01.123456Z",
    "Zero publication glink_zero_publication is exact for 36 browser-safe tables (apply).",
  ),
  stdout(
    "2026-08-02T12:01:02.123456Z",
    "Zero publication glink_zero_publication is exact for 36 browser-safe tables (check).",
  ),
  stdout(
    "2026-08-02T12:01:03.123456Z",
    "Zero publication glink_zero_publication is exact for 36 browser-safe tables (drift-check).",
  ),
];

const application = (kind: "root" | "zero") => {
  const policy = POLICY[kind];
  return {
    uuid: policy.uuid,
    id: Number(policy.applicationId),
    git_branch: "main",
    build_pack: policy.buildPack,
    git_repository: `https://github.com/${policy.repository}.git`,
    git_commit_sha: "HEAD",
    start_command: "",
    config_hash: CONFIG_HASH,
    status: "running:unknown",
    dockerfile_location: kind === "root" ? policy.sourceLocation : undefined,
    docker_compose_location: kind === "zero" ? policy.sourceLocation : undefined,
    health_check_enabled: policy.healthCheck.enabled,
    health_check_method: policy.healthCheck.method,
    health_check_path: policy.healthCheck.path,
    health_check_port: policy.healthCheck.port,
    health_check_scheme: policy.healthCheck.scheme,
    health_check_return_code: policy.healthCheck.status,
  };
};

const listEntry = (kind: "root" | "zero") => ({
  id: kind === "root" ? 9001 : 9002,
  application_id: POLICY[kind].applicationId,
  deployment_uuid: `${kind}-deployment-uuid`,
  commit: MAIN_SHA,
  status: "finished",
  created_at: "2026-08-02T12:01:00.000000Z",
  finished_at: "2026-08-02T12:01:10.000000Z",
  configuration_hash: CONFIG_HASH,
});

const detail = (kind: "root" | "zero") => ({
  id: kind === "root" ? 9001 : 9002,
  deployment_uuid: `${kind}-deployment-uuid`,
  application_id: POLICY[kind].applicationId,
  application: { uuid: POLICY[kind].uuid, id: POLICY[kind].applicationId },
  commit: MAIN_SHA,
  status: "finished",
  created_at: "2026-08-02T12:01:00.000000Z",
  finished_at: "2026-08-02T12:01:10.000000Z",
  configuration_hash: CONFIG_HASH,
  is_api: false,
  is_webhook: true,
  restart_only: false,
  rollback: false,
  logs: JSON.stringify(kind === "root" ? rootLogRecords() : zeroLogRecords()),
});

const rootEnvironment = () => ({
  key: "NEXT_PUBLIC_ZERO_SERVER",
  // The production image receives this field; `value` is intentionally not
  // trusted for a build-time manifest calculation.
  value: "https://untrusted-value.example.invalid",
  real_value: "https://public.example.invalid",
  is_buildtime: true,
  is_runtime: true,
  is_literal: true,
  is_preview: false,
  is_shown_once: false,
});

const zeroEnvironment = () => ({
  key: "GLINK_ZERO_UPSTREAM_DB",
  value: "postgresql://secret-from-environment",
  real_value: "postgresql://secret-from-environment",
  is_buildtime: false,
  is_runtime: true,
  is_literal: true,
  is_preview: false,
  is_shown_once: true,
});

const rawApi = () => {
  const calls: string[] = [];
  const details = { root: detail("root"), zero: detail("zero") };
  const environments = { root: [rootEnvironment()], zero: [zeroEnvironment()] };
  return {
    calls,
    details,
    environments,
    api: {
      getApplicationByUuid: async ({ uuid }: { readonly uuid: string }) => {
        calls.push(`application:${uuid}`);
        return uuid === POLICY.root.uuid ? application("root") : application("zero");
      },
      listDeploymentsByAppUuid: async ({
        uuid,
        skip,
        take,
      }: {
        readonly uuid: string;
        readonly skip: number;
        readonly take: number;
      }) => {
        calls.push(`deployments:${uuid}:${skip}:${take}`);
        const kind = uuid === POLICY.root.uuid ? "root" : "zero";
        return { count: 1, deployments: [listEntry(kind)] };
      },
      getDeploymentByUuid: async ({ uuid }: { readonly uuid: string }) => {
        calls.push(`deployment:${uuid}`);
        return uuid === "root-deployment-uuid" ? details.root : details.zero;
      },
      listEnvsByApplicationUuid: async ({ uuid }: { readonly uuid: string }) => {
        calls.push(`environments:${uuid}`);
        return uuid === POLICY.root.uuid ? environments.root : environments.zero;
      },
    },
  };
};

const postdeploy = async (raw: ReturnType<typeof rawApi>) =>
  createCoolifyReleaseEvidenceObserver({
    api: raw.api,
    now: () => new Date("2026-08-02T12:01:15.000Z"),
  }).postdeploy({
    proposedMainSha: MAIN_SHA,
    notBefore: "2026-08-02T12:00:00.000Z",
    policy: POLICY,
  });

test("derives a Root-only expected digest and reduces secret-free app-scoped evidence", async () => {
  const raw = rawApi();
  const observer = createCoolifyReleaseEvidenceObserver({
    api: raw.api,
    now: () => new Date("2026-08-02T12:01:15.000Z"),
  });
  const preflight = await observer.preflight({ proposedMainSha: MAIN_SHA, policy: POLICY });
  const postdeployObservation = await observer.postdeploy({
    proposedMainSha: MAIN_SHA,
    notBefore: "2026-08-02T12:00:00.000Z",
    policy: POLICY,
  });

  expect(preflight.root.applicationId).toBe(POLICY.root.applicationId);
  expect(preflight.publicBuildEnvironmentManifest).toEqual({
    version: 1,
    expectedDigest: EXPECTED_MANIFEST_DIGEST,
  });
  expect(postdeployObservation.root.deployment.deploymentId).toBe("9001");
  expect(postdeployObservation.zero.deployment.deploymentId).toBe("9002");
  expect(postdeployObservation.root.deployment.startupMarkers.map((entry) => entry.stage)).toEqual([
    "prisma-migrate",
    "public-build-environment-manifest",
    "runtime-preflight",
    "zero-public-readiness",
    "next-ready",
  ]);
  expect(postdeployObservation.zero.deployment.startupMarkers.map((entry) => entry.stage)).toEqual([
    "zero-publication-apply",
    "zero-preflight",
    "zero-ops-monitor",
  ]);
  expect(postdeployObservation.root.deployment.deploymentHistoryCount).toBe(1);
  expect(postdeployObservation.root.deployment.deploymentHistoryDigest).toMatch(/^[0-9a-f]{64}$/u);
  expect(postdeployObservation.publicBuildEnvironmentManifest.actualDigest).toBe(
    EXPECTED_MANIFEST_DIGEST,
  );
  const serialized = JSON.stringify({ preflight, postdeployObservation });
  expect(serialized).not.toContain("secret-from-environment");
  expect(serialized).not.toContain("secret-from-log");
  expect(serialized).not.toContain("untrusted-provider-output");
  expect(raw.calls).toContain(`environments:${POLICY.root.uuid}`);
  expect(raw.calls).not.toContain(`environments:${POLICY.zero.uuid}`);
  expect(raw.calls.filter((call) => call.startsWith("environments:"))).toHaveLength(1);
  expect(raw.calls.every((call) => !call.includes("global"))).toBe(true);
  expect(raw.calls).toContain(`deployments:${POLICY.root.uuid}:0:100`);
  expect(raw.calls).toContain(`deployments:${POLICY.zero.uuid}:0:100`);
});

test("rejects a non-webhook/PR-like deployment before any raw diagnostic is exposed", async () => {
  const raw = rawApi();
  raw.details.root.is_webhook = false;
  await expect(postdeploy(raw)).rejects.toMatchObject({ code: "evidence-rejected" });
});

test("uses the pinned Docker default when a public Root variable is runtime-only", async () => {
  const raw = rawApi();
  raw.environments.root[0] = {
    ...raw.environments.root[0]!,
    is_buildtime: false,
    is_literal: false,
  };
  const policy = {
    ...POLICY,
    environmentPolicy: {
      ...POLICY.environmentPolicy,
      flags: [
        {
          ...POLICY.environmentPolicy.flags[0]!,
          isBuildtime: false,
          isLiteral: false,
        },
      ],
    },
  };
  const preflight = await createCoolifyReleaseEvidenceObserver({ api: raw.api }).preflight({
    proposedMainSha: MAIN_SHA,
    policy,
  });
  expect(preflight.publicBuildEnvironmentManifest.expectedDigest).toBe(
    publicBuildEnvironmentManifestDigest(policy.publicBuildEnvironmentManifest, {}),
  );
});

test("rejects a non-allowlisted Root build-time input without returning its value", async () => {
  const raw = rawApi();
  const secret = "server-secret-must-not-escape";
  raw.environments.root.push({
    key: "DATABASE_URL",
    value: secret,
    real_value: secret,
    is_buildtime: true,
    is_runtime: true,
    is_literal: true,
    is_preview: false,
    is_shown_once: true,
  });
  const observer = createCoolifyReleaseEvidenceObserver({ api: raw.api });
  await expect(
    observer.preflight({ proposedMainSha: MAIN_SHA, policy: POLICY }),
  ).rejects.toMatchObject({
    code: "evidence-rejected",
  });
});

test.each([
  [
    "hidden Root marker",
    (records: ReturnType<typeof rootLogRecords>) => (records[2]!.hidden = true),
  ],
  [
    "non-stdout Root marker",
    (records: ReturnType<typeof rootLogRecords>) => (records[2]!.type = "stderr"),
  ],
  [
    "duplicate Root marker",
    (records: ReturnType<typeof rootLogRecords>) =>
      records.push(stdout("2026-08-02T12:01:06.123456Z", "✓ Ready in 1ms")),
  ],
  [
    "out-of-order Root marker",
    (records: ReturnType<typeof rootLogRecords>) => {
      [records[3], records[4]] = [records[4]!, records[3]!];
    },
  ],
  [
    "out-of-order Root timestamp",
    (records: ReturnType<typeof rootLogRecords>) =>
      (records[4]!.timestamp = "2026-08-02T12:01:03.999999Z"),
  ],
])("rejects %s", async (_name, mutate) => {
  const raw = rawApi();
  const records = rootLogRecords();
  mutate(records);
  raw.details.root.logs = JSON.stringify(records);
  await expect(postdeploy(raw)).rejects.toMatchObject({ code: "evidence-rejected" });
});

test("rejects a duplicate Zero lifecycle marker", async () => {
  const raw = rawApi();
  const records = zeroLogRecords();
  records.push(
    stdout(
      "2026-08-02T12:01:04.123456Z",
      "Zero publication glink_zero_publication is exact for 36 browser-safe tables (check).",
    ),
  );
  raw.details.zero.logs = JSON.stringify(records);
  await expect(postdeploy(raw)).rejects.toMatchObject({ code: "evidence-rejected" });
});

test("retains an emitted digest for the service to compare against preflight", async () => {
  const raw = rawApi();
  raw.details.root.logs = JSON.stringify(rootLogRecords("ab".repeat(32)));
  const observation = await postdeploy(raw);
  expect(observation.publicBuildEnvironmentManifest.actualDigest).toBe("ab".repeat(32));
});
