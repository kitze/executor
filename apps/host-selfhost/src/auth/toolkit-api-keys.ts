import { Effect, Option, Predicate, Schema } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { withQueryContext } from "@executor-js/fumadb/query";

import type { SelfHostDbHandle } from "../db/self-host-db";
import type { BetterAuthHandle } from "./better-auth";

const SCOPE_FIELD = "executorToolkitId";
const Toolkit = Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String });
const decodeToolkit = Schema.decodeUnknownOption(
  Schema.Union([Toolkit, Schema.fromJsonString(Toolkit)]),
);
const BindingBody = Schema.Struct({ toolkitId: Schema.NullOr(Schema.String) });
const decodeBindingBody = Schema.decodeUnknownOption(Schema.fromJsonString(BindingBody));

type ToolkitEntry = typeof Toolkit.Type;
type Options = { readonly db: SelfHostDbHandle; readonly betterAuth: BetterAuthHandle };
type Denial = { readonly status: number; readonly error: string };

const metadataObject = (value: unknown): Record<string, unknown> | null => {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const bearerToken = (headers: Headers): string | null => {
  const value = headers.get("authorization");
  return value?.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() || null : null;
};

const visibleToolkits = async (options: Options, userId: string): Promise<ToolkitEntry[]> => {
  const db = withQueryContext(options.db.db, {
    tenant: options.betterAuth.organizationId,
    subject: userId,
    writes: "denied" as const,
  });
  const rows = await db.findMany("plugin_storage", {
    where: (b) => b.and(b("plugin_id", "=", "toolkits"), b("collection", "=", "toolkits")),
  });
  return rows.flatMap((row) => {
    const toolkit = Option.getOrNull(decodeToolkit(row.data));
    return toolkit ? [toolkit] : [];
  });
};

/** Every HTTP surface passes here, including Better Auth and account/admin routes.
 * A toolkit key cannot mint a wider credential or escape by changing the URL.
 * Nothing is cached: binding edits, toolkit removal, expiry and revocation apply
 * to the next request, including requests on an existing MCP session.
 */
export const authorizeToolkitApiKey = async (
  options: Options,
  request: { readonly url: string; readonly headers: Headers },
): Promise<Denial | null> => {
  const headerKey = request.headers.get("x-api-key")?.trim() || null;
  const bearer = bearerToken(request.headers);
  const candidates = [...new Set([headerKey, bearer].filter(Predicate.isNotNull))];
  for (const token of candidates) {
    const result = await options.betterAuth.auth.api.verifyApiKey({ body: { key: token } });
    if (!result.valid || !result.key) {
      // Bearers also include OAuth/session tokens, authenticated by the normal
      // provider below. An explicit API-key header cannot fall back to a cookie.
      if (token === headerKey) return { status: 401, error: "Invalid API key" };
      continue;
    }
    const metadata = metadataObject(result.key.metadata);
    if (!metadata) return { status: 403, error: "Invalid API key scope" };
    if (!Object.hasOwn(metadata, SCOPE_FIELD)) continue;
    const toolkitId = metadata[SCOPE_FIELD];
    if (typeof toolkitId !== "string" || toolkitId.length === 0) {
      return { status: 403, error: "Invalid API key scope" };
    }
    if (candidates.length !== 1 || request.headers.has("cookie")) {
      return { status: 403, error: "Toolkit API keys cannot be combined with other credentials" };
    }
    const context = await options.betterAuth.auth.$context;
    const member = await context.adapter.findOne({
      model: "member",
      where: [
        { field: "userId", value: result.key.referenceId },
        { field: "organizationId", value: options.betterAuth.organizationId },
      ],
    });
    if (!member) return { status: 403, error: "API key owner is not a workspace member" };
    const toolkit = (await visibleToolkits(options, result.key.referenceId)).find(
      (entry) => entry.id === toolkitId,
    );
    if (!toolkit) return { status: 403, error: "Assigned toolkit is unavailable" };
    const pathname = new URL(request.url, "http://localhost").pathname;
    const resource = `/mcp/toolkits/${toolkit.slug}`;
    if (
      pathname !== resource &&
      pathname !== `/${options.betterAuth.organizationSlug}${resource}`
    ) {
      return { status: 403, error: "API key is restricted to its assigned toolkit" };
    }
  }
  return null;
};

export const toolkitApiKeyMiddleware = (options: Options) =>
  HttpRouter.middleware()((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const denial = yield* Effect.tryPromise(() =>
        authorizeToolkitApiKey(options, {
          url: request.url,
          headers: new Headers({ ...request.headers }),
        }),
      ).pipe(
        Effect.orElseSucceed(() => ({ status: 503, error: "API key authorization unavailable" })),
      );
      if (denial)
        return HttpServerResponse.jsonUnsafe({ error: denial.error }, { status: denial.status });
      return yield* httpEffect;
    }),
  ).layer;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Owner-side binding management. The outer middleware excludes scoped keys. */
export const toolkitApiKeyRoutes = (options: Options) =>
  HttpRouter.add(
    "*",
    "/api/account/api-keys/:apiKeyId/toolkit",
    HttpEffect.fromWebHandler(async (request) => {
      if (request.method !== "GET" && request.method !== "PATCH")
        return json({ error: "Method not allowed" }, 405);
      const session = await options.betterAuth.auth.api.getSession({ headers: request.headers });
      if (!session) return json({ error: "Unauthorized" }, 401);
      const id = decodeURIComponent(new URL(request.url).pathname.split("/").at(-2) ?? "");
      const keys = await options.betterAuth.auth.api.listApiKeys({ headers: request.headers });
      const key = keys.apiKeys.find((entry) => entry.id === id);
      if (!key) return json({ error: "API key not found" }, 404);
      const toolkits = await visibleToolkits(options, session.user.id);
      const metadata = metadataObject(key.metadata);
      if (!metadata) return json({ error: "Invalid API key metadata" }, 400);
      if (request.method === "GET") {
        return json({ toolkitId: metadata[SCOPE_FIELD] ?? null, toolkits });
      }
      const body = Option.getOrNull(decodeBindingBody(await request.text()));
      if (!body) return json({ error: "Invalid toolkit binding" }, 400);
      if (body.toolkitId !== null && !toolkits.some((entry) => entry.id === body.toolkitId)) {
        return json({ error: "Toolkit not found" }, 404);
      }
      const next = { ...metadata };
      if (body.toolkitId === null) delete next[SCOPE_FIELD];
      else next[SCOPE_FIELD] = body.toolkitId;
      await options.betterAuth.auth.api.updateApiKey({
        headers: request.headers,
        body: { keyId: id, metadata: next },
      });
      return json({ toolkitId: body.toolkitId });
    }),
  );
