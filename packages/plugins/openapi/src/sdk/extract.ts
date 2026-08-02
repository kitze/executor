import { Effect, Option, Predicate } from "effect";
import type { SensitiveOutputSafeScalar } from "@executor-js/sdk/core";

import { planToolPaths, type OperationPathInput, type PlannedToolPath } from "./definitions";
import {
  coolifyApplicationResponseSafeFields,
  coolifyEnvironmentResponseSafeFields,
  coolifyEnvironmentWriteKind,
  isCoolifyApplicationListResponseSchema,
  isCoolifyApplicationResponseSchema,
  isCoolifyEnvironmentListResponseSchema,
  isCoolifyEnvironmentWriteResponseSchema,
  isVerifiedCoolifyApplicationReadOperation,
  isVerifiedCoolifyApplicationListOperation,
  isVerifiedCoolifyEnvironmentListOperation,
  isVerifiedCoolifyEnvironmentWriteRequest,
  type CoolifyOperationIdentity,
} from "./coolify-environment";
import { OpenApiExtractionError } from "./errors";
import type { ParsedDocument } from "./parse";
import {
  parseEntry,
  parseHead,
  parseSmallComponents,
  indexSchemas,
  type ByteRange,
  type KeepPathItem,
  type SpecStructure,
} from "./split";
import {
  declaredContents,
  DocResolver,
  type HeaderObject,
  isNdjsonMediaType,
  ndjsonArrayOutputSchema,
  preferredResponseContent,
  type OperationObject,
  type ParameterObject,
  type PathItemObject,
  type RequestBodyObject,
  type ResponseObject,
  type ServerObject,
} from "./openapi-utils";
import {
  EncodingObject,
  ExtractedOperation,
  ExtractionResult,
  type HttpMethod,
  MediaBinding,
  OperationBinding,
  OperationFileHint,
  OperationId,
  OperationParameter,
  OperationRequestBody,
  OperationResponseBody,
  type ParameterLocation,
  ServerInfo,
  ServerVariable,
} from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_METHODS: readonly HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
];

const VALID_PARAM_LOCATIONS = new Set<string>(["path", "query", "header", "cookie"]);

/** Parameter Objects may use either `schema` or a single media entry in
 * `content`. Preserve the latter's schema so validation and opaque-sink
 * metadata describe the same value the invoker serializes. */
const parameterSchema = (parameter: ParameterObject): unknown =>
  parameter.schema ?? declaredContents(parameter.content)[0]?.media.schema;

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

const extractParameters = (
  pathItem: PathItemObject,
  operation: OperationObject,
  r: DocResolver,
): OperationParameter[] => {
  const merged = new Map<string, ParameterObject>();

  for (const raw of pathItem.parameters ?? []) {
    const p = r.resolve<ParameterObject>(raw);
    if (!p) continue;
    merged.set(`${p.in}:${p.name}`, p);
  }
  for (const raw of operation.parameters ?? []) {
    const p = r.resolve<ParameterObject>(raw);
    if (!p) continue;
    merged.set(`${p.in}:${p.name}`, p);
  }

  return [...merged.values()]
    .filter((p) => VALID_PARAM_LOCATIONS.has(p.in))
    .map((p) =>
      OperationParameter.make({
        name: p.name,
        location: p.in as ParameterLocation,
        required: p.in === "path" ? true : p.required === true,
        schema: Option.fromNullishOr(parameterSchema(p)),
        style: Option.fromNullishOr(p.style),
        explode: Option.fromNullishOr(p.explode),
        allowReserved: Option.fromNullishOr("allowReserved" in p ? p.allowReserved : undefined),
        description: Option.fromNullishOr(p.description),
      }),
    );
};

// ---------------------------------------------------------------------------
// Request body extraction
// ---------------------------------------------------------------------------

const buildEncodingRecord = (
  encoding: Record<string, unknown> | undefined,
): Record<string, EncodingObject> | undefined => {
  if (!encoding) return undefined;
  const out: Record<string, EncodingObject> = {};
  for (const [prop, raw] of Object.entries(encoding)) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as {
      contentType?: string;
      style?: string;
      explode?: boolean;
      allowReserved?: boolean;
    };
    out[prop] = EncodingObject.make({
      contentType: Option.fromNullishOr(e.contentType),
      style: Option.fromNullishOr(e.style),
      explode: Option.fromNullishOr(e.explode),
      allowReserved: Option.fromNullishOr(e.allowReserved),
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const extractRequestBody = (
  operation: OperationObject,
  r: DocResolver,
): OperationRequestBody | undefined => {
  if (!operation.requestBody) return undefined;

  const body = r.resolve<RequestBodyObject>(operation.requestBody);
  if (!body) return undefined;

  const contents = declaredContents(body.content).map(({ mediaType, media }) =>
    MediaBinding.make({
      contentType: mediaType,
      schema: Option.fromNullishOr(media.schema),
      encoding: Option.fromNullishOr(
        buildEncodingRecord((media as { encoding?: Record<string, unknown> }).encoding),
      ),
    }),
  );
  if (contents.length === 0) return undefined;

  // Default = first declared (spec author's preferred order). Callers can
  // override at invoke time with a `contentType` arg.
  const defaultContent = contents[0]!;

  return OperationRequestBody.make({
    required: body.required === true,
    contentType: defaultContent.contentType,
    schema: defaultContent.schema,
    contents: Option.some(contents),
  });
};

// ---------------------------------------------------------------------------
// Response schema extraction
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Explicit opt-in is strongest, but OpenAPI's standardized secret semantics
// also form deterministic safety metadata. This is intentionally conservative:
// extra opacity is safe, while one plaintext credential field is not.
const SENSITIVE_SCHEMA_EXTENSION = "x-executor-sensitive";

const SCHEMA_WILDCARD = Symbol("openapi-sensitive-wildcard");
type SchemaPathSegment = string | typeof SCHEMA_WILDCARD;

const pointerEscape = (segment: string): string =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1").replaceAll("*", "~2");

const pointerAt = (segments: readonly SchemaPathSegment[]): string =>
  segments.length === 0
    ? ""
    : `/${segments
        .map((segment) => (segment === SCHEMA_WILDCARD ? "*" : pointerEscape(segment)))
        .join("/")}`;

const hasSensitiveSchemaSemantics = (schema: Record<string, unknown>): boolean => {
  if (schema[SENSITIVE_SCHEMA_EXTENSION] === true) return true;
  if (schema.writeOnly === true || schema["x-secret"] === true || schema["x-sensitive"] === true) {
    return true;
  }
  const format = typeof schema.format === "string" ? schema.format.toLowerCase() : "";
  return ["password", "secret", "token", "api-key", "api_key"].includes(format);
};

const SCHEMA_REFERENCE_KEYS = ["$ref", "$dynamicRef", "$recursiveRef"] as const;

type SensitivityDirection = "input" | "output";

/** Collect every exact schema marker as an RFC 6901 pointer. References are
 * resolved through the current document and guarded as an active recursion
 * stack, rather than de-duplicated globally: the same component may appear at
 * several operation paths and every occurrence needs its own pointer. Unknown
 * output references seal their enclosing value; unknown inputs cannot become
 * secret-capable sinks. Array and map members use the shared `/*` wildcard
 * convention. */
const collectSensitiveSchemaPaths = (
  schema: unknown,
  resolver: DocResolver,
  direction: SensitivityDirection,
  path: readonly SchemaPathSegment[] = [],
  out = new Set<string>(),
  activeRefs = new Set<string>(),
): Set<string> => {
  if (!isRecord(schema)) return out;
  if (hasSensitiveSchemaSemantics(schema)) out.add(pointerAt(path));

  for (const key of SCHEMA_REFERENCE_KEYS) {
    const ref: unknown = schema[key];
    if (ref === undefined) continue;
    if (typeof ref !== "string") {
      if (direction === "output") out.add(pointerAt(path));
      continue;
    }
    const resolved: unknown = resolver.resolveReference<unknown>(ref);
    if (activeRefs.has(ref) || !isRecord(resolved) || resolved === schema) {
      // A cycle has no finite leaf projection. It is safe to seal an unknown
      // output. Never turn that fallback into an input sink: only a concrete
      // marker at a finite schema path authorizes opaque-value resolution.
      if (direction === "output") out.add(pointerAt(path));
      continue;
    }
    activeRefs.add(ref);
    collectSensitiveSchemaPaths(resolved, resolver, direction, path, out, activeRefs);
    activeRefs.delete(ref);
  }

  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const [name, nested] of Object.entries(properties)) {
      collectSensitiveSchemaPaths(nested, resolver, direction, [...path, name], out, activeRefs);
    }
  }
  const patternProperties = schema.patternProperties;
  if (isRecord(patternProperties)) {
    for (const nested of Object.values(patternProperties)) {
      collectSensitiveSchemaPaths(
        nested,
        resolver,
        direction,
        [...path, SCHEMA_WILDCARD],
        out,
        activeRefs,
      );
    }
  }
  if (Array.isArray(schema.items)) {
    // OpenAPI 3.0 / legacy JSON Schema tuple form. OpenAPI 3.1 uses
    // `prefixItems`, but persisted specs can still contain the older shape.
    for (let index = 0; index < schema.items.length; index += 1) {
      collectSensitiveSchemaPaths(
        schema.items[index],
        resolver,
        direction,
        [...path, String(index)],
        out,
        activeRefs,
      );
    }
  } else if (schema.items !== undefined) {
    collectSensitiveSchemaPaths(
      schema.items,
      resolver,
      direction,
      [...path, SCHEMA_WILDCARD],
      out,
      activeRefs,
    );
  }
  if (Array.isArray(schema.prefixItems)) {
    for (let index = 0; index < schema.prefixItems.length; index += 1) {
      collectSensitiveSchemaPaths(
        schema.prefixItems[index],
        resolver,
        direction,
        [...path, String(index)],
        out,
        activeRefs,
      );
    }
  }
  for (const key of ["additionalItems", "additionalProperties", "unevaluatedProperties"] as const) {
    if (!isRecord(schema[key])) continue;
    collectSensitiveSchemaPaths(
      schema[key],
      resolver,
      direction,
      [...path, SCHEMA_WILDCARD],
      out,
      activeRefs,
    );
  }
  for (const key of ["contains", "unevaluatedItems"] as const) {
    if (schema[key] !== undefined) {
      collectSensitiveSchemaPaths(
        schema[key],
        resolver,
        direction,
        [...path, SCHEMA_WILDCARD],
        out,
        activeRefs,
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      collectSensitiveSchemaPaths(variant, resolver, direction, path, out, activeRefs);
    }
  }
  for (const key of ["if", "then", "else", "not"] as const) {
    if (schema[key] !== undefined) {
      collectSensitiveSchemaPaths(schema[key], resolver, direction, path, out, activeRefs);
    }
  }
  for (const key of ["dependentSchemas", "dependencies"] as const) {
    const schemas = schema[key];
    if (!isRecord(schemas)) continue;
    for (const nested of Object.values(schemas)) {
      collectSensitiveSchemaPaths(nested, resolver, direction, path, out, activeRefs);
    }
  }

  // These schemas constrain a property name or encoded content rather than a
  // JSON child that can be named with a pointer. If either carries sensitive
  // semantics, seal the enclosing instance rather than invent an inaccurate
  // child path.
  for (const key of ["propertyNames", "contentSchema"] as const) {
    if (schema[key] === undefined) continue;
    const nested = new Set<string>();
    collectSensitiveSchemaPaths(
      schema[key],
      resolver,
      direction,
      path,
      nested,
      new Set(activeRefs),
    );
    if (nested.size > 0) out.add(pointerAt(path));
  }
  return out;
};

const withPointerPrefix = (prefix: string, path: string): string => `${prefix}${path}`;

const parameterInputPrefixes = (parameter: OperationParameter): readonly string[] => {
  const name = pointerEscape(parameter.name);
  const direct = `/${name}`;
  const prefixes = {
    path: [`/path/${name}`, `/pathParams/${name}`, `/params/${name}`],
    query: [`/query/${name}`, `/queryParams/${name}`, `/params/${name}`],
    header: [`/headers/${name}`, `/header/${name}`],
    cookie: [`/cookies/${name}`, `/cookie/${name}`],
  } satisfies Record<OperationParameter["location"], readonly string[]>;
  return [direct, ...prefixes[parameter.location]];
};

const rawServerVariablePaths = (servers: readonly ServerObject[]): readonly string[] => {
  const paths = new Set<string>();
  for (const server of servers) {
    const variables = server.variables;
    if (!isRecord(variables)) continue;
    for (const [name, raw] of Object.entries(variables)) {
      if (isRecord(raw) && hasSensitiveSchemaSemantics(raw)) {
        paths.add(`/server/variables/${pointerEscape(name)}`);
      }
    }
  }
  return [...paths];
};

/** Collect every response schema, rather than only the preferred display
 * schema. The HTTP runtime accepts every 2xx response and exposes error
 * bodies, so a secret in a 201/default/alternate media type must drive the
 * same source sealing and trace suppression as a secret in the preferred 200.
 */
const collectResponseSensitivity = (
  operation: OperationObject,
  resolver: DocResolver,
): {
  readonly paths: Set<string>;
  readonly hasSensitiveHeaders: boolean;
} => {
  const paths = new Set<string>();
  let hasSensitiveHeaders = false;
  if (!operation.responses) return { paths, hasSensitiveHeaders };

  for (const rawResponse of Object.values(operation.responses)) {
    const response = resolver.resolve<ResponseObject>(rawResponse);
    if (!response) {
      // A referenced response could contain either a body or headers. Do not
      // let a missing local target turn that unknown output into plaintext.
      paths.add("");
      hasSensitiveHeaders = true;
      continue;
    }
    for (const { mediaType, media } of declaredContents(response.content)) {
      const prefix = isNdjsonMediaType(mediaType) ? "/*" : "";
      for (const path of collectSensitiveSchemaPaths(media.schema, resolver, "output")) {
        paths.add(withPointerPrefix(prefix, path));
      }
    }
    for (const rawHeader of Object.values(response.headers ?? {})) {
      const header = resolver.resolve<HeaderObject>(rawHeader);
      if (!header) {
        hasSensitiveHeaders = true;
        continue;
      }
      const schemas = [
        header.schema,
        ...declaredContents(header.content).map(({ media }) => media.schema),
      ];
      if (
        schemas.some((schema) => collectSensitiveSchemaPaths(schema, resolver, "output").size > 0)
      ) {
        hasSensitiveHeaders = true;
      }
    }
  }
  return { paths, hasSensitiveHeaders };
};

const resolveSchemaReference = (schema: unknown, resolver: DocResolver): unknown =>
  isRecord(schema) && typeof schema.$ref === "string"
    ? (resolver.resolveReference<unknown>(schema.$ref) ?? schema)
    : schema;

const schemasForRequestBody = (
  requestBody: OperationRequestBody | undefined,
  resolver: DocResolver,
): readonly unknown[] => {
  if (!requestBody) return [];
  const schemas = [
    Option.getOrUndefined(requestBody.schema),
    ...(Option.getOrUndefined(requestBody.contents) ?? []).map((content) =>
      Option.getOrUndefined(content.schema),
    ),
  ].filter(Predicate.isNotUndefined);
  return schemas.map((schema) => resolveSchemaReference(schema, resolver));
};

const schemasForResponses = (
  operation: OperationObject,
  resolver: DocResolver,
): readonly unknown[] => {
  if (!operation.responses) return [];
  const schemas: unknown[] = [];
  for (const rawResponse of Object.values(operation.responses)) {
    const response = resolver.resolve<ResponseObject>(rawResponse);
    if (!response) continue;
    for (const { media } of declaredContents(response.content)) {
      if (media.schema !== undefined) schemas.push(resolveSchemaReference(media.schema, resolver));
    }
  }
  return schemas;
};

/** Coolify's published schemas omit the semantic credential annotations. This
 * narrowly recognizes only its known operation IDs, exact routes, required
 * UUID parameter, and request/response fingerprints. A similarly-shaped
 * tenant endpoint therefore cannot gain an opaque secret sink. */
const addCoolifySensitivity = (
  input: {
    readonly identity: CoolifyOperationIdentity;
    readonly requestSchemas: readonly unknown[];
    readonly responseSchemas: readonly unknown[];
  },
  sensitiveInputPaths: Set<string>,
  sensitiveOutputPaths: Set<string>,
  sensitiveOutputSafeScalars: Map<string, SensitiveOutputSafeScalar>,
): void => {
  const addSafeScalar = (
    path: string,
    field: { readonly type: "number" | "integer" | "boolean" },
  ): void => {
    const projection: SensitiveOutputSafeScalar = { path, type: field.type };
    sensitiveOutputSafeScalars.set(`${path}\u0000${field.type}`, projection);
  };
  const writeKind = coolifyEnvironmentWriteKind(input.identity);
  if (writeKind && isVerifiedCoolifyEnvironmentWriteRequest(writeKind, input.requestSchemas)) {
    if (writeKind === "single") {
      sensitiveInputPaths.add("/body/value");
      sensitiveInputPaths.add("/input/value");
    } else {
      sensitiveInputPaths.add("/body/data/*/value");
      sensitiveInputPaths.add("/input/data/*/value");
    }

    // Coolify's create, update, and bulk-update operations can all return the
    // newly written environment value. Keep the compatibility rule as narrow
    // as the sink rule above: operation identity + exact request fingerprint
    // are not enough on their own; at least one declared response must also
    // match Coolify's environment response shape before output paths are
    // sealed. This covers POST create as well as PATCH update without turning a
    // similarly named tenant endpoint's arbitrary response into a capability.
    if (
      input.responseSchemas.some((schema) =>
        isCoolifyEnvironmentWriteResponseSchema(writeKind, schema),
      )
    ) {
      if (writeKind === "single") {
        sensitiveOutputPaths.add("/value");
        sensitiveOutputPaths.add("/real_value");
      } else {
        sensitiveOutputPaths.add("/*/value");
        sensitiveOutputPaths.add("/*/real_value");
      }
      for (const schema of input.responseSchemas) {
        for (const field of coolifyEnvironmentResponseSafeFields(schema)) {
          addSafeScalar(writeKind === "single" ? `/${field.name}` : `/*/${field.name}`, field);
        }
      }
    }
  }

  if (
    isVerifiedCoolifyEnvironmentListOperation(input.identity) &&
    input.responseSchemas.some(isCoolifyEnvironmentListResponseSchema)
  ) {
    sensitiveOutputPaths.add("/*/value");
    sensitiveOutputPaths.add("/*/real_value");
    for (const schema of input.responseSchemas) {
      for (const field of coolifyEnvironmentResponseSafeFields(schema)) {
        addSafeScalar(`/*/${field.name}`, field);
      }
    }
  }

  if (
    isVerifiedCoolifyApplicationReadOperation(input.identity) &&
    input.responseSchemas.some(isCoolifyApplicationResponseSchema)
  ) {
    for (const field of [
      "manual_webhook_secret_github",
      "manual_webhook_secret_gitlab",
      "manual_webhook_secret_bitbucket",
      "manual_webhook_secret_gitea",
      "http_basic_auth_password",
    ]) {
      sensitiveOutputPaths.add(`/${field}`);
    }
    for (const schema of input.responseSchemas) {
      for (const field of coolifyApplicationResponseSafeFields(schema)) {
        addSafeScalar(`/${field.name}`, field);
      }
    }
  }

  if (
    isVerifiedCoolifyApplicationListOperation(input.identity) &&
    input.responseSchemas.some(isCoolifyApplicationListResponseSchema)
  ) {
    for (const field of [
      "manual_webhook_secret_github",
      "manual_webhook_secret_gitlab",
      "manual_webhook_secret_bitbucket",
      "manual_webhook_secret_gitea",
      "http_basic_auth_password",
    ]) {
      sensitiveOutputPaths.add(`/*/${field}`);
    }
    for (const schema of input.responseSchemas) {
      for (const field of coolifyApplicationResponseSafeFields(schema)) {
        // Repository slugs and URLs are intentionally absent from the safe
        // projection. Coolify has returned credential-bearing URL userinfo in
        // these fields, so they remain provenance-tainted and are dropped.
        addSafeScalar(`/*/${field.name}`, field);
      }
    }
  }
};

const operationSensitivity = (input: {
  readonly parameters: readonly OperationParameter[];
  readonly requestBody: OperationRequestBody | undefined;
  readonly rawOperation: OperationObject;
  readonly resolver: DocResolver;
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly pathTemplate: string;
  readonly rawServers: readonly ServerObject[];
}): {
  readonly sensitiveInputPaths?: readonly string[];
  readonly sensitiveOutputPaths?: readonly string[];
  readonly sensitiveOutputSafeScalars?: readonly SensitiveOutputSafeScalar[];
  readonly sensitiveResponseHeaders?: boolean;
} => {
  const sensitiveInputPaths = new Set<string>();
  for (const parameter of input.parameters) {
    const schema = Option.getOrUndefined(parameter.schema);
    for (const path of collectSensitiveSchemaPaths(schema, input.resolver, "input")) {
      for (const prefix of parameterInputPrefixes(parameter)) {
        sensitiveInputPaths.add(withPointerPrefix(prefix, path));
      }
    }
  }
  if (input.requestBody) {
    const schemas = [
      Option.getOrUndefined(input.requestBody.schema),
      ...(Option.getOrUndefined(input.requestBody.contents) ?? []).map((content) =>
        Option.getOrUndefined(content.schema),
      ),
    ];
    for (const schema of schemas) {
      for (const path of collectSensitiveSchemaPaths(schema, input.resolver, "input")) {
        sensitiveInputPaths.add(withPointerPrefix("/body", path));
        // `input` is a documented legacy alias for request bodies in the
        // OpenAPI invoker and must have identical capability semantics.
        sensitiveInputPaths.add(withPointerPrefix("/input", path));
      }
    }
  }
  for (const path of rawServerVariablePaths(input.rawServers)) sensitiveInputPaths.add(path);

  const sensitiveOutputPaths = new Set<string>();
  const sensitiveOutputSafeScalars = new Map<string, SensitiveOutputSafeScalar>();
  const responseSensitivity = collectResponseSensitivity(input.rawOperation, input.resolver);
  for (const path of responseSensitivity.paths) sensitiveOutputPaths.add(path);

  addCoolifySensitivity(
    {
      identity: {
        operationId: input.operationId,
        method: input.method,
        pathTemplate: input.pathTemplate,
        parameters: input.parameters,
      },
      requestSchemas: schemasForRequestBody(input.requestBody, input.resolver),
      responseSchemas: schemasForResponses(input.rawOperation, input.resolver),
    },
    sensitiveInputPaths,
    sensitiveOutputPaths,
    sensitiveOutputSafeScalars,
  );

  return {
    ...(sensitiveInputPaths.size > 0
      ? { sensitiveInputPaths: [...sensitiveInputPaths].sort() }
      : {}),
    ...(sensitiveOutputPaths.size > 0
      ? { sensitiveOutputPaths: [...sensitiveOutputPaths].sort() }
      : {}),
    ...(sensitiveOutputSafeScalars.size > 0
      ? {
          sensitiveOutputSafeScalars: [...sensitiveOutputSafeScalars.values()].sort((left, right) =>
            left.path === right.path
              ? left.type.localeCompare(right.type)
              : left.path.localeCompare(right.path),
          ),
        }
      : {}),
    ...(responseSensitivity.hasSensitiveHeaders ? { sensitiveResponseHeaders: true } : {}),
  };
};

/**
 * The streaming compiler intentionally never materializes all component
 * schemas. Sensitivity extraction still has to follow a referenced schema, so
 * expose a lazy `components.schemas` record that parses one named range on its
 * first lookup. `DocResolver` only indexes named pointer segments, so no
 * operation can accidentally enumerate or retain the full schema set.
 */
const lazySchemasFromStructure = (structure: SpecStructure): Record<string, unknown> => {
  const ranges = indexSchemas(structure);
  const parsed = new Map<string, unknown>();
  return new Proxy<Record<string, unknown>>(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string") return undefined;
        const existing = parsed.get(property);
        if (existing !== undefined) return existing;
        const range = ranges.get(property);
        if (!range) return undefined;
        const entry = parseEntry(structure.text, range, 4);
        const schema = entry?.[1];
        if (schema === undefined) return undefined;
        parsed.set(property, schema);
        return schema;
      },
      has: (_target, property) => typeof property === "string" && ranges.has(property),
      getOwnPropertyDescriptor: (_target, property) =>
        typeof property === "string" && ranges.has(property)
          ? { configurable: true, enumerable: true }
          : undefined,
    },
  );
};

const stringType = (schema: Record<string, unknown>): boolean =>
  schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"));

const numericType = (schema: Record<string, unknown>): boolean =>
  schema.type === "integer" ||
  schema.type === "number" ||
  (Array.isArray(schema.type) &&
    (schema.type.includes("integer") || schema.type.includes("number")));

const normalizedMediaType = (mediaType: string): string =>
  mediaType.split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonMediaType = (mediaType: string): boolean => {
  const normalized = normalizedMediaType(mediaType);
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

const binaryStringSchema = (schema: Record<string, unknown>): boolean =>
  stringType(schema) && (schema.format === "binary" || schema.format === "byte");

const base64EncodingFromDescription = (schema: Record<string, unknown>): "base64" | "base64url" =>
  typeof schema.description === "string" &&
  /base64url|base64-url|url[- ]safe/i.test(schema.description)
    ? "base64url"
    : "base64";

const detectFileHint = (
  schema: unknown,
  mediaType: string,
  r: DocResolver,
): OperationFileHint | undefined => {
  const resolved = isRecord(schema) ? r.resolve<Record<string, unknown>>(schema) : null;
  if (!resolved) return undefined;

  if (!isJsonMediaType(mediaType) && binaryStringSchema(resolved)) {
    return OperationFileHint.make({
      kind: "binaryResponse",
      mimeType: Option.some(mediaType),
      dataField: Option.none(),
      sizeField: Option.none(),
      encoding: Option.none(),
    });
  }

  if (!isJsonMediaType(mediaType)) return undefined;

  const properties = resolved.properties;
  if (!isRecord(properties)) return undefined;
  const data = properties.data;
  const dataSchema = isRecord(data) ? r.resolve<Record<string, unknown>>(data) : null;
  if (!dataSchema || !binaryStringSchema(dataSchema)) return undefined;

  const size = properties.size;
  const sizeSchema = isRecord(size) ? r.resolve<Record<string, unknown>>(size) : null;
  const sizeField = sizeSchema && numericType(sizeSchema) ? "size" : undefined;

  return OperationFileHint.make({
    kind: "byteField",
    mimeType: Option.some("application/octet-stream"),
    dataField: Option.some("data"),
    sizeField: sizeField ? Option.some(sizeField) : Option.none(),
    encoding: Option.some(base64EncodingFromDescription(dataSchema)),
  });
};

const extractResponseBody = (
  operation: OperationObject,
  r: DocResolver,
): OperationResponseBody | undefined => {
  if (!operation.responses) return undefined;

  // Success responses may use exact codes ("200"), the OpenAPI wildcard status
  // key ("2XX" — Microsoft Graph declares every success response this way), or
  // fall through to "default". Prefer exact codes, then the wildcard, then default.
  const entries = Object.entries(operation.responses);
  const preferred = [
    ...entries.filter(([s]) => /^2\d\d$/.test(s)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([s]) => /^2xx$/i.test(s)),
    ...entries.filter(([s]) => s === "default"),
  ];

  for (const [, ref] of preferred) {
    const resp = r.resolve<ResponseObject>(ref);
    if (!resp) continue;
    const content = preferredResponseContent(resp.content);
    if (content?.media.schema) {
      return OperationResponseBody.make({
        contentType: content.mediaType,
        schema: Option.some(content.media.schema),
        fileHint: Option.fromNullishOr(detectFileHint(content.media.schema, content.mediaType, r)),
      });
    }
  }

  return undefined;
};

/**
 * Derive an operation's output schema from its response body. NDJSON bodies
 * (`application/stream+json` and friends) are spec'd per LINE but returned by
 * the invoke path as an array of parsed lines, so the advertised schema wraps
 * the line schema in an array; otherwise describe previews promise a single
 * object that invocations never return. Used by both the whole-tree extract
 * and the serve path's stored-binding rebuild so the two stay in lockstep.
 */
export const outputSchemaFromResponseBody = (
  responseBody: OperationResponseBody,
): unknown | undefined => {
  const schema = Option.getOrUndefined(responseBody.schema);
  if (schema === undefined) return undefined;
  return isNdjsonMediaType(responseBody.contentType) ? ndjsonArrayOutputSchema(schema) : schema;
};

// ---------------------------------------------------------------------------
// Input schema builder
// ---------------------------------------------------------------------------

// Optional `server` input — host selection + server-URL variables. Undefined
// when there's nothing to configure (a single server with no variables).
const buildServerInputProperty = (
  servers: readonly ServerInfo[],
): Record<string, unknown> | undefined => {
  const variableDefs: Record<string, ServerVariable> = {};
  for (const server of servers) {
    for (const [name, v] of Object.entries(Option.getOrUndefined(server.variables) ?? {})) {
      if (!(name in variableDefs)) variableDefs[name] = v;
    }
  }
  const hasMultiple = servers.length > 1;
  const variableNames = Object.keys(variableDefs);
  if (!hasMultiple && variableNames.length === 0) return undefined;

  const properties: Record<string, unknown> = {};
  if (hasMultiple) {
    properties.url = {
      type: "string",
      enum: servers.map((server) => server.url),
      default: servers[0]!.url,
      description: "Which of the spec's servers to send the request to.",
    };
  }
  if (variableNames.length > 0) {
    properties.variables = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(variableDefs).map(([name, v]) => [
          name,
          {
            type: "string",
            default: v.default,
            ...(Option.isSome(v.enum) ? { enum: v.enum.value } : {}),
            ...(Option.isSome(v.description) ? { description: v.description.value } : {}),
          },
        ]),
      ),
      description: "Values for the server URL `{variables}`; spec defaults apply when omitted.",
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    description: "Optional host selection and server-URL variables for this request.",
  };
};

export const buildInputSchema = (
  parameters: readonly OperationParameter[],
  requestBody: OperationRequestBody | undefined,
  servers: readonly ServerInfo[],
): Record<string, unknown> | undefined => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  let requiredBodyAlternatives: readonly { readonly required: readonly string[] }[] | undefined;

  for (const param of parameters) {
    properties[param.name] = Option.getOrElse(param.schema, () => ({ type: "string" }));
    if (param.required) required.push(param.name);
  }

  // A path/query parameter named `server` takes precedence over the host input.
  const serverProperty = buildServerInputProperty(servers);
  if (serverProperty && !("server" in properties)) properties.server = serverProperty;

  if (requestBody) {
    // When the spec declares multiple media types for this requestBody,
    // expose `contentType` so the model can pick. Default = first declared.
    // For mixed bodies, `body` schema tracks the default; the model is
    // responsible for supplying a body shape that matches whichever
    // contentType it picks. Octet-only operations use `bodyBase64` instead.
    const contents = Option.getOrUndefined(requestBody.contents);
    const defaultIsOctetStream =
      requestBody.contentType.split(";")[0]?.trim().toLowerCase() === "application/octet-stream";
    const acceptsOctetStream =
      defaultIsOctetStream ||
      contents?.some(
        (content) =>
          content.contentType.split(";")[0]?.trim().toLowerCase() === "application/octet-stream",
      ) === true;
    const acceptsBody =
      !defaultIsOctetStream ||
      contents?.some(
        (content) =>
          content.contentType.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream",
      ) === true;
    if (acceptsBody) {
      properties.body = Option.getOrElse(requestBody.schema, () => ({ type: "object" }));
    }
    if (acceptsOctetStream) {
      properties.bodyBase64 = {
        type: "string",
        contentEncoding: "base64",
        contentMediaType: "application/octet-stream",
        description:
          "Base64-encoded bytes for application/octet-stream request bodies. When contentType is omitted, this selects application/octet-stream.",
      };
    }
    if (requestBody.required) {
      if (acceptsOctetStream && acceptsBody) {
        requiredBodyAlternatives = [{ required: ["body"] }, { required: ["bodyBase64"] }];
      } else {
        required.push(acceptsOctetStream ? "bodyBase64" : "body");
      }
    }
    if (contents && contents.length > 1) {
      properties.contentType = {
        type: "string",
        enum: contents.map((c) => c.contentType),
        default: requestBody.contentType,
        description:
          "Content-Type for the request body. Declared media types for this operation, in spec order.",
      };
    }
  }

  if (Object.keys(properties).length === 0) return undefined;

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(requiredBodyAlternatives ? { anyOf: requiredBodyAlternatives } : {}),
    additionalProperties: false,
  };
};

// ---------------------------------------------------------------------------
// Operation ID derivation
// ---------------------------------------------------------------------------

const deriveOperationId = (
  method: HttpMethod,
  pathTemplate: string,
  operation: OperationObject,
): string =>
  operation.operationId ??
  (`${method}_${pathTemplate.replace(/[^a-zA-Z0-9]+/g, "_")}`.replace(/^_+|_+$/g, "") ||
    `${method}_operation`);

const explicitToolPath = (operation: OperationObject): string | undefined => {
  const value = (operation as Record<string, unknown>)["x-executor-toolPath"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const explicitPathTemplate = (operation: OperationObject): string | undefined => {
  const value = (operation as Record<string, unknown>)["x-executor-pathTemplate"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

// ---------------------------------------------------------------------------
// Server extraction
// ---------------------------------------------------------------------------

const extractServerList = (servers: readonly ServerObject[] | undefined): ServerInfo[] =>
  (servers ?? []).flatMap((server) => {
    if (!server.url) return [];
    const serverVariables = server.variables as
      | Record<
          string,
          {
            readonly default?: string;
            readonly enum?: readonly string[];
            readonly description?: string;
          }
        >
      | undefined;
    const vars = serverVariables
      ? Object.fromEntries(
          Object.entries(serverVariables).flatMap(([name, v]) => {
            if (v.default === undefined || v.default === null) return [];
            const enumValues = Array.isArray(v.enum)
              ? v.enum.filter((x): x is string => typeof x === "string")
              : undefined;
            return [
              [
                name,
                ServerVariable.make({
                  default: String(v.default),
                  enum:
                    enumValues && enumValues.length > 0 ? Option.some(enumValues) : Option.none(),
                  description: Option.fromNullishOr(v.description),
                }),
              ],
            ];
          }),
        )
      : undefined;
    return [
      ServerInfo.make({
        url: server.url,
        description: Option.fromNullishOr(server.description),
        variables: vars && Object.keys(vars).length > 0 ? Option.some(vars) : Option.none(),
      }),
    ];
  });

const extractServers = (doc: ParsedDocument): ServerInfo[] => extractServerList(doc.servers);

const operationServers = (
  pathItem: PathItemObject,
  operation: OperationObject,
  docServers: readonly ServerInfo[],
): readonly ServerInfo[] => {
  const operationLevel = extractServerList(operation.servers);
  if (operationLevel.length > 0) return operationLevel;
  const pathLevel = extractServerList(pathItem.servers);
  if (pathLevel.length > 0) return pathLevel;
  return docServers;
};

/** OAuth scope requirements an operation declares via `security`, with the
 *  spec's semantics preserved (OpenAPI 3.x Security Requirement Objects):
 *
 *  - Each requirement object is one acceptable ALTERNATIVE; the array is an
 *    OR. Alternatives stay separate — unioning them would tell a user to
 *    grant scopes from mutually alternative schemes at once.
 *  - Within one requirement object the schemes are ANDed, so their scopes
 *    union into that alternative's set (sorted, deduped).
 *  - An ABSENT operation `security` inherits the document-level default;
 *    an explicit `security: []` disables auth. Both yield `undefined` only
 *    when nothing (or nothing scoped) is genuinely declared. */
const securityScopeAlternatives = (
  operation: OperationObject,
  documentSecurity: unknown,
): readonly (readonly string[])[] | undefined => {
  const security = operation.security !== undefined ? operation.security : documentSecurity;
  if (!Array.isArray(security) || security.length === 0) return undefined;
  const alternatives: (readonly string[])[] = [];
  const seen = new Set<string>();
  for (const requirement of security) {
    if (requirement === null || typeof requirement !== "object") continue;
    const scopes = new Set<string>();
    for (const schemeScopes of Object.values(requirement)) {
      if (!Array.isArray(schemeScopes)) continue;
      for (const scope of schemeScopes) {
        if (typeof scope === "string" && scope.trim().length > 0) scopes.add(scope);
      }
    }
    if (scopes.size === 0) continue;
    const alternative = [...scopes].sort();
    const key = alternative.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push(alternative);
  }
  return alternatives.length > 0 ? alternatives : undefined;
};

const documentSecurityOf = (doc: unknown): unknown =>
  doc !== null && typeof doc === "object" && !Array.isArray(doc)
    ? (doc as Record<string, unknown>).security
    : undefined;

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/** Extract all operations from a bundled OpenAPI 3.x document */
export const extract = Effect.fn("OpenApi.extract")(function* (doc: ParsedDocument) {
  const paths = doc.paths;
  if (!paths) {
    return yield* new OpenApiExtractionError({
      message: "OpenAPI document has no paths defined",
    });
  }

  const r = new DocResolver(doc);
  const docServers = extractServers(doc);
  const operations: ExtractedOperation[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(paths).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const parameters = extractParameters(pathItem, operation, r);
      const requestBody = extractRequestBody(operation, r);
      const responseBody = extractResponseBody(operation, r);
      const servers = operationServers(pathItem, operation, docServers);
      const operationPathTemplate = explicitPathTemplate(operation) ?? pathTemplate;
      const operationId = deriveOperationId(method, pathTemplate, operation);
      const sensitivity = operationSensitivity({
        parameters,
        requestBody,
        rawOperation: operation,
        resolver: r,
        operationId,
        method,
        pathTemplate: operationPathTemplate,
        rawServers: operation.servers ?? pathItem.servers ?? doc.servers ?? [],
      });
      const inputSchema = buildInputSchema(parameters, requestBody, servers);
      const outputSchema = responseBody ? outputSchemaFromResponseBody(responseBody) : undefined;
      const tags = (operation.tags ?? []).filter((t) => t.trim().length > 0);

      const requiredScopeAlternatives = securityScopeAlternatives(
        operation,
        documentSecurityOf(doc),
      );
      operations.push(
        ExtractedOperation.make({
          operationId: OperationId.make(operationId),
          toolPath: Option.fromNullishOr(explicitToolPath(operation)),
          method,
          servers,
          pathTemplate: operationPathTemplate,
          summary: Option.fromNullishOr(operation.summary),
          description: Option.fromNullishOr(operation.description),
          tags,
          parameters,
          requestBody: Option.fromNullishOr(requestBody),
          responseBody: Option.fromNullishOr(responseBody),
          inputSchema: Option.fromNullishOr(inputSchema),
          outputSchema: Option.fromNullishOr(outputSchema),
          deprecated: operation.deprecated === true,
          ...sensitivity,
          ...(requiredScopeAlternatives ? { requiredScopeAlternatives } : {}),
        }),
      );
    }
  }

  return ExtractionResult.make({
    title: Option.fromNullishOr(doc.info?.title),
    description: Option.fromNullishOr(doc.info?.description),
    version: Option.fromNullishOr(doc.info?.version),
    servers: docServers,
    operations,
  });
});

// ---------------------------------------------------------------------------
// Streaming binding extraction
// ---------------------------------------------------------------------------

/** One persisted invocation binding plus the tool name and description it
 *  backs. The description is the resolved operation description / summary /
 *  method+path fallback, persisted so the serve path needs no re-parse. */
export interface OperationBindingChunk {
  readonly toolName: string;
  readonly description: string;
  readonly binding: OperationBinding;
}

interface OperationRef {
  readonly pathItem: PathItemObject;
  readonly operation: OperationObject;
  readonly operationId: string;
  readonly method: HttpMethod;
  /** Resolved path template (`x-executor-pathTemplate` override or the key). */
  readonly pathTemplate: string;
}

/**
 * Stream invocation bindings out of a parsed document in bounded chunks,
 * persisting each chunk via `onChunk` before building the next.
 *
 * This is the memory-safe compile path for huge specs (e.g. Microsoft Graph,
 * 16.5k operations / 37MB). It differs from `extract` + `compileToolDefinitions`
 * in two ways that keep peak memory at parse level rather than ~doubling it:
 *
 *   1. It never builds `hoistedDefs` or per-operation `inputSchema`/`outputSchema`
 *      (the add path only needs invocation bindings, which carry `$ref`s, not
 *      inlined schemas).
 *   2. It never holds all bindings at once. Tool-path planning needs a global
 *      view, but only of lightweight metadata (`planToolPaths`, schema-free);
 *      the heavy per-operation bindings are built, flushed, and dropped one
 *      chunk at a time.
 *
 * Bindings reference subtrees of the parsed document rather than copying them,
 * so `onChunk` must sever those references (its storage layer JSON-serializes
 * the binding) before the chunk is dropped. Returns the resolved tool names in
 * sorted order, matching `compileToolDefinitions`.
 */
export const streamOperationBindings = <E, R>(
  doc: ParsedDocument,
  chunkSize: number,
  onChunk: (chunk: readonly OperationBindingChunk[]) => Effect.Effect<void, E, R>,
): Effect.Effect<
  { readonly toolCount: number; readonly toolNames: readonly string[] },
  OpenApiExtractionError | E,
  R
> =>
  Effect.gen(function* () {
    const paths = doc.paths;
    if (!paths) {
      return yield* new OpenApiExtractionError({
        message: "OpenAPI document has no paths defined",
      });
    }

    const r = new DocResolver(doc);
    const docServers = extractServers(doc);

    // Pass 1 (light): collect schema-free path metadata + a parallel array of
    // references back into the tree. Both are small (no schemas copied).
    const inputs: OperationPathInput[] = [];
    const opRefs: OperationRef[] = [];
    for (const [pathTemplate, pathItem] of Object.entries(paths).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!pathItem) continue;
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const resolvedPathTemplate = explicitPathTemplate(operation) ?? pathTemplate;
        const tags = (operation.tags ?? []).filter((t) => t.trim().length > 0);
        inputs.push({
          operationId: deriveOperationId(method, pathTemplate, operation),
          explicitToolPath: explicitToolPath(operation),
          method,
          pathTemplate: resolvedPathTemplate,
          tag0: tags[0],
        });
        opRefs.push({
          pathItem,
          operation,
          operationId: deriveOperationId(method, pathTemplate, operation),
          method,
          pathTemplate: resolvedPathTemplate,
        });
      }
    }

    // Global, schema-free collision resolution + sort. Cheap relative to the
    // parsed tree; returns plans sorted by toolPath with an index back into
    // `opRefs`.
    const plans = planToolPaths(inputs);

    // Pass 2 (heavy, streamed): build a binding per operation, flush a chunk
    // once it fills, then drop it. Bindings reference tree subtrees; `onChunk`
    // serializes them, so peak stays at parse level.
    let chunk: OperationBindingChunk[] = [];
    for (const plan of plans) {
      const ref = opRefs[plan.operationIndex]!;
      const parameters = extractParameters(ref.pathItem, ref.operation, r);
      const requestBody = extractRequestBody(ref.operation, r);
      const responseBody = extractResponseBody(ref.operation, r);
      const servers = operationServers(ref.pathItem, ref.operation, docServers);
      const sensitivity = operationSensitivity({
        parameters,
        requestBody,
        rawOperation: ref.operation,
        resolver: r,
        operationId: ref.operationId,
        method: ref.method,
        pathTemplate: ref.pathTemplate,
        rawServers: ref.operation.servers ?? ref.pathItem.servers ?? doc.servers ?? [],
      });
      const requiredScopeAlternatives = securityScopeAlternatives(
        ref.operation,
        documentSecurityOf(doc),
      );
      chunk.push({
        toolName: plan.toolPath,
        description:
          ref.operation.description ??
          ref.operation.summary ??
          `${ref.method.toUpperCase()} ${ref.pathTemplate}`,
        binding: OperationBinding.make({
          method: ref.method,
          servers,
          pathTemplate: ref.pathTemplate,
          parameters,
          requestBody: Option.fromNullishOr(requestBody),
          responseBody: Option.fromNullishOr(responseBody),
          sensitivityVersion: 1,
          ...sensitivity,
          ...(requiredScopeAlternatives ? { requiredScopeAlternatives } : {}),
        }),
      });
      if (chunk.length >= chunkSize) {
        yield* onChunk(chunk);
        chunk = [];
      }
    }
    if (chunk.length > 0) yield* onChunk(chunk);

    return { toolCount: plans.length, toolNames: plans.map((plan) => plan.toolPath) };
  }).pipe(Effect.withSpan("OpenApi.streamOperationBindings"));

const isPathItemValue = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Stream invocation bindings straight from a `SpecStructure` (the structural
 * split of a large spec) without ever materializing the whole-document tree.
 *
 * This is the fully-streaming compile path: it never parses the spec whole.
 * Each path-item is parsed in isolation twice (pass 1 for light tool-path
 * planning metadata, pass 2 to build the heavy binding) and discarded, so peak
 * memory stays near the size of a single path-item plus the raw text, even for
 * the 37MB / 16.5k-operation Microsoft Graph spec that OOMs a whole-tree parse.
 * Re-parsing in pass 2 (rather than holding pass-1 tree references) is the
 * deliberate CPU-for-memory trade that keeps peak at one-path-item level.
 *
 * `keepPathItem`, when given, filters (and may trim) each path-item, so the same
 * primitive serves both a full-spec compile (no filter) and a selection (e.g.
 * the Microsoft Graph scope filter) with identical streaming guarantees. It is
 * applied identically in both passes so the per-operation index stays aligned.
 *
 * Schemas are never resolved here: parameter / requestBody / response component
 * `$ref`s resolve against the small (schema-free) components built from the
 * structure; `#/components/schemas/X` refs stay as strings in the binding and
 * are normalized + served from the content-addressed defs blob. Returns the
 * resolved tool names in sorted order, matching `compileToolDefinitions`.
 */
export const streamOperationBindingsFromStructure = <E, R>(
  structure: SpecStructure,
  options: { readonly chunkSize: number; readonly keepPathItem?: KeepPathItem },
  onChunk: (chunk: readonly OperationBindingChunk[]) => Effect.Effect<void, E, R>,
): Effect.Effect<{ readonly toolCount: number; readonly toolNames: readonly string[] }, E, R> =>
  Effect.gen(function* () {
    const { chunkSize, keepPathItem } = options;

    // Parse one path-item range to its kept (optionally trimmed) value, applying
    // `keepPathItem` identically in both passes so the operation index aligns.
    const keptPathItem = (range: ByteRange): readonly [string, PathItemObject] | null => {
      const entry = parseEntry(structure.text, range, 2);
      if (!entry) return null;
      const [path, rawValue] = entry;
      if (!isPathItemValue(rawValue)) return null;
      if (!keepPathItem) return [path, rawValue as PathItemObject];
      const kept = keepPathItem(path, rawValue);
      return kept ? [path, kept as PathItemObject] : null;
    };

    // Pass 1 (light): collect schema-free tool-path planning metadata in
    // document order. No bindings, no schemas; one path-item resident at a time.
    const inputs: OperationPathInput[] = [];
    for (const range of structure.pathItems) {
      const kept = keptPathItem(range);
      if (!kept) continue;
      const [path, pathItem] = kept;
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const resolvedPathTemplate = explicitPathTemplate(operation) ?? path;
        const tags = (operation.tags ?? []).filter((t) => t.trim().length > 0);
        inputs.push({
          operationId: deriveOperationId(method, path, operation),
          explicitToolPath: explicitToolPath(operation),
          method,
          pathTemplate: resolvedPathTemplate,
          tag0: tags[0],
        });
      }
    }

    // Global, schema-free collision resolution + sort. `plan.operationIndex`
    // indexes back into `inputs` (document order), so a flat array recovers each
    // operation's assigned tool path during the document-order pass 2.
    const plans = planToolPaths(inputs);
    const planByOpIndex: (PlannedToolPath | undefined)[] = new Array(inputs.length);
    for (const plan of plans) planByOpIndex[plan.operationIndex] = plan;

    // Pass 2 (heavy, streamed): re-parse each path-item in the same document
    // order, build a binding per operation, flush a chunk once it fills, then
    // drop it. The resolver is schema-free (small components only); schema refs
    // stay as `$ref` strings in the bindings.
    // oxlint-disable-next-line executor/no-double-cast -- boundary: parseHead/parseSmallComponents return Record<string, unknown>, which does not structurally match the OpenAPIV3 Document union; the schema-free resolver doc (head + small components, empty paths) is only read for .servers (extractServers) and .components ($ref resolution).
    const resolverDoc = {
      ...parseHead(structure),
      paths: {},
      components: {
        ...parseSmallComponents(structure),
        schemas: lazySchemasFromStructure(structure),
      },
    } as unknown as ParsedDocument;
    const r = new DocResolver(resolverDoc);
    const docServers = extractServers(resolverDoc);

    let opIndex = 0;
    let chunk: OperationBindingChunk[] = [];
    for (const range of structure.pathItems) {
      const kept = keptPathItem(range);
      if (!kept) continue;
      const [path, pathItem] = kept;
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) continue;
        const plan = planByOpIndex[opIndex];
        opIndex += 1;
        if (!plan) continue;
        const resolvedPathTemplate = explicitPathTemplate(operation) ?? path;
        const parameters = extractParameters(pathItem, operation, r);
        const requestBody = extractRequestBody(operation, r);
        const responseBody = extractResponseBody(operation, r);
        const servers = operationServers(pathItem, operation, docServers);
        const sensitivity = operationSensitivity({
          parameters,
          requestBody,
          rawOperation: operation,
          resolver: r,
          operationId: deriveOperationId(method, path, operation),
          method,
          pathTemplate: resolvedPathTemplate,
          rawServers: operation.servers ?? pathItem.servers ?? resolverDoc.servers ?? [],
        });
        const requiredScopeAlternatives = securityScopeAlternatives(
          operation,
          documentSecurityOf(resolverDoc),
        );
        chunk.push({
          toolName: plan.toolPath,
          description:
            operation.description ??
            operation.summary ??
            `${method.toUpperCase()} ${resolvedPathTemplate}`,
          binding: OperationBinding.make({
            method,
            servers,
            pathTemplate: resolvedPathTemplate,
            parameters,
            requestBody: Option.fromNullishOr(requestBody),
            responseBody: Option.fromNullishOr(responseBody),
            sensitivityVersion: 1,
            ...sensitivity,
            ...(requiredScopeAlternatives ? { requiredScopeAlternatives } : {}),
          }),
        });
        if (chunk.length >= chunkSize) {
          yield* onChunk(chunk);
          chunk = [];
        }
      }
    }
    if (chunk.length > 0) yield* onChunk(chunk);

    return { toolCount: plans.length, toolNames: plans.map((plan) => plan.toolPath) };
  }).pipe(Effect.withSpan("OpenApi.streamOperationBindingsFromStructure"));
