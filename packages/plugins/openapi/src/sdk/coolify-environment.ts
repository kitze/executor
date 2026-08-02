// ---------------------------------------------------------------------------
// Verified Coolify environment-operation fingerprints
// ---------------------------------------------------------------------------
//
// OpenAPI integrations are tenant-authored. A route name alone must never
// grant an opaque capability permission to enter a sink, so the few Coolify
// compatibility rules in this package share these strict identifiers, route
// signatures, and schemas. The accepted IDs cover the published hyphenated
// API and the older camelCase catalog form only.

export type CoolifyEnvironmentWriteKind = "single" | "batch";

export type CoolifyOperationIdentity = {
  readonly operationId: string;
  readonly method: string;
  readonly pathTemplate: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly location: string;
    readonly required: boolean;
  }[];
};

const SINGLE_WRITE_OPERATION_IDS = new Set([
  "create-env-by-application-uuid",
  "update-env-by-application-uuid",
  "createEnvByApplicationUuid",
  "updateEnvByApplicationUuid",
  "applications.createEnvByApplicationUuid",
  "applications.updateEnvByApplicationUuid",
]);

const BATCH_WRITE_OPERATION_IDS = new Set([
  "update-envs-by-application-uuid",
  "updateEnvsByApplicationUuid",
  "applications.updateEnvsByApplicationUuid",
]);

const LIST_OPERATION_IDS = new Set([
  "list-envs-by-application-uuid",
  "listEnvsByApplicationUuid",
  "applications.listEnvsByApplicationUuid",
]);

const APPLICATION_READ_OPERATION_IDS = new Set([
  "get-application-by-uuid",
  "getApplicationByUuid",
  "applications.getApplicationByUuid",
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasRequiredApplicationUuidPathParameter = (
  parameters: CoolifyOperationIdentity["parameters"],
): boolean =>
  parameters.some(
    (parameter) => parameter.name === "uuid" && parameter.location === "path" && parameter.required,
  );

const hasIdentity = (
  identity: CoolifyOperationIdentity,
  operationIds: ReadonlySet<string>,
  method: string,
  pathTemplate: string,
): boolean =>
  operationIds.has(identity.operationId) &&
  identity.method === method &&
  identity.pathTemplate === pathTemplate &&
  hasRequiredApplicationUuidPathParameter(identity.parameters);

export const coolifyEnvironmentWriteKind = (
  identity: CoolifyOperationIdentity,
): CoolifyEnvironmentWriteKind | undefined => {
  if (
    SINGLE_WRITE_OPERATION_IDS.has(identity.operationId) &&
    (identity.method === "post" || identity.method === "patch") &&
    identity.pathTemplate === "/applications/{uuid}/envs" &&
    hasRequiredApplicationUuidPathParameter(identity.parameters)
  ) {
    return "single";
  }
  if (
    BATCH_WRITE_OPERATION_IDS.has(identity.operationId) &&
    identity.method === "patch" &&
    identity.pathTemplate === "/applications/{uuid}/envs/bulk" &&
    hasRequiredApplicationUuidPathParameter(identity.parameters)
  ) {
    return "batch";
  }
  return undefined;
};

export const isVerifiedCoolifyEnvironmentListOperation = (
  identity: CoolifyOperationIdentity,
): boolean => hasIdentity(identity, LIST_OPERATION_IDS, "get", "/applications/{uuid}/envs");

export const isVerifiedCoolifyApplicationReadOperation = (
  identity: CoolifyOperationIdentity,
): boolean => hasIdentity(identity, APPLICATION_READ_OPERATION_IDS, "get", "/applications/{uuid}");

const ENVIRONMENT_REQUEST_FIELD_TYPES = {
  key: "string",
  value: "string",
  is_preview: "boolean",
  is_literal: "boolean",
  is_multiline: "boolean",
  is_shown_once: "boolean",
} as const;

const OPTIONAL_LIFECYCLE_FIELD_TYPES = {
  is_runtime: "boolean",
  is_buildtime: "boolean",
} as const;

/** Strictly recognize only the public Coolify request body shape. */
export const isCoolifyEnvironmentVariableRequestSchema = (schema: unknown): boolean => {
  const object = asRecord(schema);
  const properties = asRecord(object?.properties);
  if (object?.type !== "object" || !properties) return false;
  if (
    !Object.entries(ENVIRONMENT_REQUEST_FIELD_TYPES).every(
      ([name, type]) => asRecord(properties[name])?.type === type,
    )
  ) {
    return false;
  }
  const allowed = { ...ENVIRONMENT_REQUEST_FIELD_TYPES, ...OPTIONAL_LIFECYCLE_FIELD_TYPES };
  return Object.entries(properties).every(
    ([name, property]) => asRecord(property)?.type === allowed[name as keyof typeof allowed],
  );
};

export const isVerifiedCoolifyEnvironmentWriteRequest = (
  kind: CoolifyEnvironmentWriteKind,
  schemas: readonly unknown[],
): boolean => {
  if (schemas.length === 0) return false;
  if (kind === "single") return schemas.every(isCoolifyEnvironmentVariableRequestSchema);
  return schemas.every((schema) => {
    const body = asRecord(schema);
    const properties = asRecord(body?.properties);
    const data = asRecord(properties?.data);
    return (
      body?.type === "object" &&
      properties !== undefined &&
      Object.keys(properties).length === 1 &&
      data?.type === "array" &&
      isCoolifyEnvironmentVariableRequestSchema(data.items)
    );
  });
};

const isCoolifyEnvironmentVariableResponseSchema = (schema: unknown): boolean => {
  const object = asRecord(schema);
  const properties = asRecord(object?.properties);
  return (
    object?.type === "object" &&
    asRecord(properties?.value)?.type === "string" &&
    asRecord(properties?.real_value)?.type === "string"
  );
};

const ENVIRONMENT_SAFE_RESPONSE_FIELD_TYPES = {
  id: new Set(["integer", "number"]),
  uuid: new Set(["string"]),
  key: new Set(["string"]),
  is_preview: new Set(["boolean"]),
  is_literal: new Set(["boolean"]),
  is_multiline: new Set(["boolean"]),
  is_shown_once: new Set(["boolean"]),
  is_runtime: new Set(["boolean"]),
  is_buildtime: new Set(["boolean"]),
} as const;

const APPLICATION_SAFE_RESPONSE_FIELD_TYPES = {
  id: new Set(["integer", "number"]),
  uuid: new Set(["string"]),
  name: new Set(["string"]),
} as const;

const declaredSafeScalarFields = (
  schema: unknown,
  fields: Readonly<Record<string, ReadonlySet<string>>>,
): readonly string[] => {
  const properties = asRecord(asRecord(schema)?.properties);
  if (!properties) return [];
  return Object.entries(fields)
    .filter(([name, allowedTypes]) => {
      const type = asRecord(properties[name])?.type;
      return typeof type === "string" && allowedTypes.has(type);
    })
    .map(([name]) => name);
};

export const isCoolifyEnvironmentListResponseSchema = (schema: unknown): boolean => {
  const object = asRecord(schema);
  return object?.type === "array" && isCoolifyEnvironmentVariableResponseSchema(object.items);
};

export const isCoolifyEnvironmentWriteResponseSchema = (
  kind: CoolifyEnvironmentWriteKind,
  schema: unknown,
): boolean =>
  kind === "single"
    ? isCoolifyEnvironmentVariableResponseSchema(schema)
    : isCoolifyEnvironmentListResponseSchema(schema);

/** Exact scalar metadata fields that a verified environment response may keep
 * beside opaque values. Unknown response properties never become safe merely
 * because Coolify returned them. */
export const coolifyEnvironmentResponseSafeFields = (schema: unknown): readonly string[] => {
  const object = asRecord(schema);
  const itemSchema = object?.type === "array" ? object.items : schema;
  return isCoolifyEnvironmentVariableResponseSchema(itemSchema)
    ? declaredSafeScalarFields(itemSchema, ENVIRONMENT_SAFE_RESPONSE_FIELD_TYPES)
    : [];
};

export const isCoolifyApplicationResponseSchema = (schema: unknown): boolean => {
  const object = asRecord(schema);
  const properties = asRecord(object?.properties);
  if (object?.type !== "object" || !properties) return false;
  return [
    "manual_webhook_secret_github",
    "manual_webhook_secret_gitlab",
    "manual_webhook_secret_bitbucket",
    "manual_webhook_secret_gitea",
    "http_basic_auth_password",
  ].every((name) => asRecord(properties[name])?.type === "string");
};

/** Exact identifiers retained from a verified application read. */
export const coolifyApplicationResponseSafeFields = (schema: unknown): readonly string[] =>
  isCoolifyApplicationResponseSchema(schema)
    ? declaredSafeScalarFields(schema, APPLICATION_SAFE_RESPONSE_FIELD_TYPES)
    : [];
