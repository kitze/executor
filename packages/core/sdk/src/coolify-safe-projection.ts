import { Option, Schema } from "effect";
import { ToolResult, isToolResult, type ToolResult as ToolResultValue } from "./tool-result";

const TOOL_ADDRESS_PREFIX = "tools.";
const COOLIFY_PATH_PREFIX = "coolify.";

type SafeRecord = Record<string, unknown>;
type CoolifyProjector = (value: unknown) => unknown;

const isRecord = (value: unknown): value is SafeRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const coolifyPath = (path: string): string =>
  path.startsWith(TOOL_ADDRESS_PREFIX) ? path.slice(TOOL_ADDRESS_PREFIX.length) : path;

const coolifySafePick = (value: unknown, keys: readonly string[]): SafeRecord => {
  if (!isRecord(value)) return {};
  const out: SafeRecord = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key)) out[key] = value[key];
  }
  return out;
};

// A repository can be part of useful release evidence, but Coolify also
// permits credential-bearing clone URLs. Keep only an ordinary owner/repo
// reference; everything else is deliberately opaque.
const coolifySafeRepository = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)
    ? value
    : "[redacted]";

const coolifySafeProjectApplication = (value: unknown): SafeRecord => {
  const projected = coolifySafePick(value, [
    "id",
    "uuid",
    "name",
    "description",
    "status",
    "git_repository",
    "git_branch",
    "git_commit_sha",
    "build_pack",
    "base_directory",
    "dockerfile_location",
    "docker_compose_location",
    "instant_deploy",
    "is_preserve_repository_enabled",
    "is_raw_compose_deployment_enabled",
    "inject_build_args_to_dockerfile",
    "use_build_server",
    "watch_paths",
    "start_command",
    "config_hash",
    "environment_id",
    "source_id",
    "destination_id",
    "health_check_enabled",
    "health_check_path",
    "health_check_port",
    "health_check_method",
    "health_check_return_code",
    "health_check_scheme",
    "health_check_type",
    "created_at",
    "updated_at",
  ]);
  if (Object.hasOwn(projected, "git_repository")) {
    projected.git_repository = coolifySafeRepository(projected.git_repository);
  }
  if (isRecord(value) && isRecord(value.settings)) {
    projected.settings = coolifySafePick(value.settings, [
      "is_auto_deploy_enabled",
      "connect_to_docker_network",
      "include_source_commit_in_build",
      "is_preserve_repository_enabled",
      "is_raw_compose_deployment_enabled",
      "inject_build_args_to_dockerfile",
    ]);
  }
  return projected;
};

const coolifySafeProjectDeployment = (value: unknown): SafeRecord => {
  const projected = coolifySafePick(value, [
    "id",
    "deployment_uuid",
    "application_id",
    "commit",
    "status",
    "created_at",
    "finished_at",
    "is_api",
    "is_webhook",
    "restart_only",
    "rollback",
    "configuration_hash",
    "logs",
  ]);
  if (isRecord(value) && isRecord(value.application)) {
    projected.application = coolifySafePick(value.application, ["id", "uuid", "config_hash"]);
  }
  return projected;
};

const coolifySafeProjectEnvironment = (value: unknown): SafeRecord => {
  const projected = coolifySafePick(value, [
    "id",
    "uuid",
    "key",
    "is_literal",
    "is_multiline",
    "is_preview",
    "is_runtime",
    "is_buildtime",
    "is_shared",
    "is_shown_once",
    "created_at",
    "updated_at",
  ]);
  if (
    isRecord(value) &&
    value.key === "NEXT_PUBLIC_ZERO_SERVER" &&
    value.value === "https://zero.glink.so"
  ) {
    projected.value = value.value;
  }
  return projected;
};

const coolifySafeProjectGithubApp = (value: unknown): SafeRecord =>
  coolifySafePick(value, [
    "id",
    "uuid",
    "name",
    "organization",
    "is_system_wide",
    "is_public",
    "team_id",
    "type",
  ]);

const coolifySafeProjectProject = (value: unknown): SafeRecord =>
  coolifySafePick(value, ["id", "uuid", "name", "description", "created_at", "updated_at"]);

const coolifySafeProjectEnvironmentRecord = (value: unknown): SafeRecord =>
  coolifySafePick(value, ["id", "uuid", "name", "project_id", "created_at", "updated_at"]);

const coolifySafeProjectServer = (value: unknown): SafeRecord =>
  coolifySafePick(value, [
    "id",
    "uuid",
    "name",
    "description",
    "is_reachable",
    "is_usable",
    "validation_logs",
    "created_at",
    "updated_at",
  ]);

const coolifySafeProjectDestination = (value: unknown): SafeRecord =>
  coolifySafePick(value, [
    "id",
    "uuid",
    "name",
    "network",
    "server_id",
    "created_at",
    "updated_at",
  ]);

const coolifySafeProjectList = (
  value: unknown,
  projector: CoolifyProjector,
  wrapperKeys: readonly string[],
): unknown => {
  if (Array.isArray(value)) return value.map(projector);
  if (!isRecord(value)) return null;
  const out: SafeRecord = {};
  for (const key of wrapperKeys) {
    if (Array.isArray(value[key])) out[key] = value[key].map(projector);
  }
  for (const key of ["count", "total", "skip", "take"]) {
    if (typeof value[key] === "number") out[key] = value[key];
  }
  return out;
};

// These are identifiers the caller already knows from the request schema.
// Never return the upstream values or validation messages themselves.
const COOLIFY_SAFE_APPLICATION_CONFIGURATION_FIELDS = new Set([
  "base_directory",
  "body",
  "build_pack",
  "docker_compose_location",
  "environment_name",
  "environment_uuid",
  "git_branch",
  "git_repository",
  "github_app_uuid",
  "instant_deploy",
  "is_auto_deploy_enabled",
  "is_preserve_repository_enabled",
  "is_raw_compose_deployment_enabled",
  "inject_build_args_to_dockerfile",
  "name",
  "project_uuid",
  "server_uuid",
]);

const decodeCoolifyJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const coolifySafeMaybeParseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  let candidate = trimmed;
  if (
    !(
      (candidate.startsWith("{") && candidate.endsWith("}")) ||
      (candidate.startsWith("[") && candidate.endsWith("]"))
    )
  ) {
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");
    if (objectStart !== -1 && objectEnd > objectStart) {
      candidate = candidate.slice(objectStart, objectEnd + 1);
    } else if (arrayStart !== -1 && arrayEnd > arrayStart) {
      candidate = candidate.slice(arrayStart, arrayEnd + 1);
    } else {
      return value;
    }
  }
  if (
    !(
      (candidate.startsWith("{") && candidate.endsWith("}")) ||
      (candidate.startsWith("[") && candidate.endsWith("]"))
    )
  ) {
    return value;
  }
  return decodeCoolifyJson(candidate).pipe(Option.getOrElse(() => value));
};

const coolifySafeApplicationValidationFields = (value: unknown): readonly string[] => {
  const fields = new Set<string>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof candidate === "string") {
      const parsed = coolifySafeMaybeParseJson(candidate);
      if (parsed !== candidate) {
        visit(parsed, depth + 1);
        return;
      }
      for (const key of COOLIFY_SAFE_APPLICATION_CONFIGURATION_FIELDS) {
        if (candidate.includes(key)) fields.add(key);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (COOLIFY_SAFE_APPLICATION_CONFIGURATION_FIELDS.has(key)) fields.add(key);
      else visit(nested, depth + 1);
    }
  };
  visit(coolifySafeMaybeParseJson(value), 0);
  return [...fields].sort();
};

const coolifySafeApplicationValidationReason = (value: unknown, field: string): string => {
  const messages: string[] = [];
  const collectStrings = (candidate: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof candidate === "string") {
      const parsed = coolifySafeMaybeParseJson(candidate);
      if (parsed !== candidate) {
        collectStrings(parsed, depth + 1);
        return;
      }
      messages.push(candidate.toLowerCase());
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) collectStrings(item, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const nested of Object.values(candidate)) collectStrings(nested, depth + 1);
  };
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof candidate === "string") {
      const parsed = coolifySafeMaybeParseJson(candidate);
      if (parsed !== candidate) {
        visit(parsed, depth + 1);
        return;
      }
      if (candidate.includes(field)) messages.push(candidate.toLowerCase());
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === field) collectStrings(nested, 0);
      else visit(nested, depth + 1);
    }
  };
  const parsed = coolifySafeMaybeParseJson(value);
  collectStrings(parsed, 0);
  visit(parsed, 0);
  if (messages.some((message) => message.includes("not allowed"))) return "not_allowed";
  if (
    messages.some((message) => message.includes("boolean") || message.includes("true or false"))
  ) {
    return "must_be_boolean";
  }
  if (
    messages.some(
      (message) => message.includes("docker compose") || message.includes("dockercompose"),
    )
  ) {
    return "requires_dockercompose";
  }
  if (
    messages.some(
      (message) => message.includes("not supported") || message.includes("does not exist"),
    )
  ) {
    return "unsupported";
  }
  if (
    messages.some(
      (message) => message.includes("cannot update") || message.includes("can't update"),
    )
  ) {
    return "immutable";
  }
  if (messages.some((message) => message.includes("invalid"))) return "invalid";
  return "rejected";
};

const coolifySafeProjectApplicationUpdateError = (
  value: ToolResultValue<unknown>,
): ToolResultValue<unknown> | undefined => {
  if (value.ok || value.error.status !== 422) return undefined;
  const validationFields = coolifySafeApplicationValidationFields(value.error.details);
  const validationIssues = validationFields.map((field) => ({
    field,
    reason: coolifySafeApplicationValidationReason(value.error.details, field),
  }));
  return ToolResult.fail({
    code: "UPSTREAM_VALIDATION_FAILED",
    message: "Coolify rejected the application configuration request.",
    status: 422,
    ...(validationIssues.length > 0 ? { details: { validationIssues } } : {}),
  });
};

/**
 * Project the small, explicitly safe subset of Coolify tool results that a
 * release workflow needs. Coolify application schemas contain credential
 * fields, so do not weaken generic sensitive-transport masking; this helper
 * is the narrow exception for these known application observations.
 */
export const coolifySafeProjectToolResult = (
  path: string,
  value: unknown,
): ToolResultValue<unknown> | undefined => {
  const normalizedPath = coolifyPath(path);
  if (!normalizedPath.startsWith(COOLIFY_PATH_PREFIX) || !isToolResult(value)) return undefined;

  if (!value.ok) {
    if (
      normalizedPath.endsWith(".applications.updateApplicationByUuid") ||
      normalizedPath.endsWith(".applications.createPrivateGithubAppApplication")
    ) {
      return coolifySafeProjectApplicationUpdateError(value);
    }
    return undefined;
  }

  let projected: unknown;
  if (normalizedPath.endsWith(".applications.getApplicationByUuid")) {
    projected = coolifySafeProjectApplication(value.data);
  } else if (normalizedPath.endsWith(".applications.listApplications")) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectApplication, [
      "applications",
      "data",
    ]);
  } else if (normalizedPath.endsWith(".deployments.listDeploymentsByAppUuid")) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectDeployment, [
      "deployments",
      "data",
    ]);
  } else if (normalizedPath.endsWith(".deployments.getDeploymentByUuid")) {
    projected = coolifySafeProjectDeployment(value.data);
  } else if (
    normalizedPath.endsWith(".applications.listEnvsByApplicationUuid") ||
    normalizedPath.endsWith(".databases.listEnvsByDatabaseUuid")
  ) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectEnvironment, [
      "environments",
      "data",
    ]);
  } else if (normalizedPath.endsWith(".gitHubApps.listGithubApps")) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectGithubApp, [
      "github_apps",
      "data",
    ]);
  } else if (normalizedPath.endsWith(".projects.listProjects")) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectProject, ["projects", "data"]);
  } else if (
    normalizedPath.endsWith(".projects.getEnvironments") ||
    normalizedPath.endsWith(".projects.getEnvironmentByNameOrUuid")
  ) {
    projected = Array.isArray(value.data)
      ? value.data.map(coolifySafeProjectEnvironmentRecord)
      : coolifySafeProjectEnvironmentRecord(value.data);
  } else if (normalizedPath.endsWith(".servers.listServers")) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectServer, ["servers", "data"]);
  } else if (normalizedPath.endsWith(".destinations.listServerDestinations")) {
    projected = coolifySafeProjectList(value.data, coolifySafeProjectDestination, [
      "destinations",
      "data",
    ]);
  } else if (
    normalizedPath.endsWith(".applications.createEnvByApplicationUuid") ||
    normalizedPath.endsWith(".applications.updateEnvByApplicationUuid") ||
    normalizedPath.endsWith(".applications.deleteEnvByApplicationUuid") ||
    normalizedPath.endsWith(".databases.createEnvByDatabaseUuid") ||
    normalizedPath.endsWith(".databases.updateEnvByDatabaseUuid") ||
    normalizedPath.endsWith(".databases.deleteEnvByDatabaseUuid")
  ) {
    projected = null;
  } else {
    return undefined;
  }

  return ToolResult.ok(
    projected,
    value.http ? { http: { status: value.http.status, headers: {} } } : undefined,
  );
};
