#!/usr/bin/env bun

/**
 * Read-only contract checks for the services mounted in Executor.
 *
 * This deliberately talks MCP instead of importing Executor internals.  The
 * thing we care about is the result an agent receives after authentication,
 * tool dispatch, OpenAPI projection, and opaque-value protection have all run.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };

type ConnectionHealthExpectation = {
  failStatuses?: string[];
  warnStatuses?: string[];
  missing?: "fail" | "warn" | "ignore";
};

type Expectation = {
  dataType?: "any" | "array" | "object" | "string" | "number" | "boolean" | "null";
  requiredPaths?: string[];
  minItems?: number;
  maxItems?: number;
  contentMinItems?: number;
  maxBytes?: number;
  maxLatencyMs?: number;
  allowedOpaquePaths?: string[];
  allowErrorCodes?: string[];
  connectionHealth?: ConnectionHealthExpectation;
};

type ContractCase = {
  id: string;
  description?: string;
  tool: string;
  args?: JsonRecord;
  readOnly: true;
  enabled?: boolean;
  requiresEnv?: string[];
  timeoutMs?: number;
  expect?: Expectation;
};

type Manifest = {
  version: 1;
  defaults?: {
    timeoutMs?: number;
    maxBytes?: number;
  };
  tests: ContractCase[];
};

type ToolEnvelope =
  | { ok: true; data: unknown; http?: { status?: number } }
  | { ok: false; error: { code?: string; status?: number } };

type TestReport = {
  id: string;
  tool: string;
  status: "passed" | "failed" | "skipped";
  latencyMs?: number;
  httpStatus?: number;
  opaquePaths?: string[];
  warnings?: string[];
  checks?: string[];
  error?: { code: string; status?: number; message?: string };
};

type HealthReport = {
  target: string;
  status: "passed" | "failed" | "skipped";
  httpStatus?: number;
  latencyMs?: number;
  error?: { code: string; status?: number };
};

const DEFAULT_MCP_URL = "https://executor.server.kitze.io/mcp";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2_000_000;

const MUTATING_TOOL_PART = /(?:^|[._-])(create|update|patch|delete|remove|write|send|charge|pay|cancel|deploy|restart|start|stop|enable|disable|revoke|modify|trash|untrash|watch|connect|disconnect|sync|trigger|reboot|upgrade|rename|toggle|power|authorize|unauthorize)(?:$|[._-])/i;

class McpError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(?:sk|rk|pk|ghp|github_pat|xoxb|xoxp|eyJ)[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function getPointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = root;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function jsonType(value: unknown): Expectation["dataType"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value;
  return "any";
}

export function pointerMatches(path: string, pattern: string): boolean {
  const actual = pointerSegments(path);
  const expected = pointerSegments(pattern);
  return actual.length === expected.length && expected.every((segment, index) => segment === "*" || segment === actual[index]);
}

export function scanOpaque(value: unknown): string[] {
  const paths: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string) => {
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    if (!Array.isArray(current) && current._tag === "ExecutorOpaqueValue") {
      paths.push(path || "");
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    Object.entries(current).forEach(([key, item]) => {
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      visit(item, `${path}/${escaped}`);
    });
  };
  visit(value, "");
  return paths;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isToolEnvelope(value: unknown): value is ToolEnvelope {
  return isRecord(value) && typeof value.ok === "boolean" && (value.ok ? Object.hasOwn(value, "data") : Object.hasOwn(value, "error"));
}

/** Normalize both JSON MCP results and legacy content-only MCP results. */
export function normalizeToolCallResult(value: unknown, depth = 0): ToolEnvelope {
  if (depth > 6) return { ok: true, data: value };
  if (isToolEnvelope(value)) return value;

  if (isRecord(value) && value.status === "completed" && Object.hasOwn(value, "result")) {
    return normalizeToolCallResult(value.result, depth + 1);
  }
  if (isRecord(value) && Object.hasOwn(value, "toolResult")) {
    return normalizeToolCallResult(value.toolResult, depth + 1);
  }
  if (isRecord(value) && Object.hasOwn(value, "structuredContent")) {
    return normalizeToolCallResult(value.structuredContent, depth + 1);
  }

  if (isRecord(value) && Array.isArray(value.content)) {
    for (const block of value.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        const parsed = parseJsonText(block.text);
        if (parsed !== undefined) {
          const normalized = normalizeToolCallResult(parsed, depth + 1);
          if (isToolEnvelope(parsed) || isToolEnvelope(normalized)) return normalized;
        }
      }
    }
    if (value.isError === true) return { ok: false, error: { code: "mcp_tool_error" } };
  }

  return { ok: true, data: value };
}

function parseSseBody(body: string, wantedId: string | number | undefined): unknown {
  const events: unknown[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const parsed = parseJsonText(dataLines.join("\n"));
    if (parsed !== undefined) events.push(parsed);
    dataLines = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      flush();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  const matching = events.find((event) => isRecord(event) && String(event.id) === String(wantedId));
  return matching ?? events.at(-1);
}

function parseResponseBody(body: string, contentType: string | null, wantedId?: string | number): unknown {
  if (!body.trim()) return undefined;
  if (contentType?.toLowerCase().includes("text/event-stream")) return parseSseBody(body, wantedId);
  return parseJsonText(body);
}

class McpClient {
  private requestId = 0;
  private sessionId?: string;
  private negotiatedProtocol?: string;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly preferredProtocol: string,
  ) {}

  private async post(payload: Record<string, unknown>, timeoutMs: number): Promise<{ value: unknown; response: Response }> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "MCP-Protocol-Version": this.negotiatedProtocol ?? this.preferredProtocol,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new McpError("transport_error", sanitizeMessage(error instanceof Error ? error.message : error) ?? "MCP transport failed");
    }

    const session = response.headers.get("Mcp-Session-Id");
    if (session) this.sessionId = session;
    const body = await response.text();
    const value = parseResponseBody(body, response.headers.get("content-type"), payload.id as string | number | undefined);
    if (!response.ok) throw new McpError("http_error", "MCP request failed", response.status);
    return { value, response };
  }

  private async request(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    const id = ++this.requestId;
    const { value } = await this.post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, timeoutMs);
    if (!isRecord(value)) throw new McpError("protocol_error", "MCP returned no JSON-RPC response");
    if (isRecord(value.error)) {
      throw new McpError(
        String(value.error.code ?? "rpc_error"),
        sanitizeMessage(value.error.message) ?? "MCP returned an error",
      );
    }
    return value.result;
  }

  private async notify(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, timeoutMs);
  }

  async initialize(timeoutMs: number): Promise<{ protocolVersion?: string }> {
    const result = await this.request("initialize", {
      protocolVersion: this.preferredProtocol,
      capabilities: {},
      clientInfo: { name: "executor-service-contracts", version: "1.0.0" },
    }, timeoutMs);
    if (isRecord(result) && typeof result.protocolVersion === "string") this.negotiatedProtocol = result.protocolVersion;
    await this.notify("notifications/initialized", {}, timeoutMs);
    return isRecord(result) ? { protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : undefined } : {};
  }

  async callTool(name: string, args: JsonRecord, timeoutMs: number): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async listTools(timeoutMs: number): Promise<number> {
    let cursor: string | undefined;
    let count = 0;
    for (let page = 0; page < 100; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : undefined, timeoutMs);
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new McpError("protocol_error", "MCP tools/list returned an invalid shape");
      count += result.tools.length;
      cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) return count;
    }
    throw new McpError("protocol_error", "MCP tools/list exceeded the page limit");
  }
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeError(error: unknown): { code: string; status?: number; message?: string } {
  if (error instanceof McpError) return { code: error.code, ...(error.status === undefined ? {} : { status: error.status }), ...(sanitizeMessage(error.message) ? { message: sanitizeMessage(error.message) } : {}) };
  return { code: "runner_error", ...(sanitizeMessage(error instanceof Error ? error.message : error) ? { message: sanitizeMessage(error instanceof Error ? error.message : error) } : {}) };
}

function validateManifestCase(test: ContractCase): string | undefined {
  if (test.readOnly !== true) return "case is not explicitly marked readOnly";
  if (MUTATING_TOOL_PART.test(test.tool)) return "tool name is classified as mutating by the read-only guard";
  if (!test.id || !test.tool) return "case requires id and tool";
  return undefined;
}

function healthChecks(data: unknown, expectation: ConnectionHealthExpectation): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const connections = getPointer(data, "/connections");
  if (!connections.found || !Array.isArray(connections.value)) return { failures: ["/connections is not an array"], warnings };

  const failStatuses = new Set(expectation.failStatuses ?? ["expired", "degraded"]);
  const warnStatuses = new Set(expectation.warnStatuses ?? ["unknown"]);
  const missing = expectation.missing ?? "warn";
  for (const [index, connection] of connections.value.entries()) {
    const address = isRecord(connection) && typeof connection.address === "string" ? connection.address : `connection[${index}]`;
    const lastHealth = isRecord(connection) ? connection.lastHealth : undefined;
    const status = isRecord(lastHealth) && typeof lastHealth.status === "string" ? lastHealth.status : undefined;
    if (!status) {
      if (missing === "fail") failures.push(`${address}: missing health verdict`);
      else if (missing === "warn") warnings.push(`${address}: missing health verdict`);
    } else if (failStatuses.has(status)) {
      failures.push(`${address}: ${status}`);
    } else if (warnStatuses.has(status)) {
      warnings.push(`${address}: ${status}`);
    }
  }
  return { failures, warnings };
}

async function runCase(client: McpClient, test: ContractCase, defaults: Manifest["defaults"]): Promise<TestReport> {
  const base: TestReport = { id: test.id, tool: test.tool, status: "failed" };
  if (test.enabled === false) return { ...base, status: "skipped", checks: ["disabled"] };
  const missingEnv = (test.requiresEnv ?? []).filter((name) => !process.env[name]);
  if (missingEnv.length > 0) return { ...base, status: "skipped", checks: [`missing environment: ${missingEnv.join(",")}`] };

  const manifestError = validateManifestCase(test);
  if (manifestError) return { ...base, error: { code: "unsafe_manifest", message: manifestError } };

  const expectation = test.expect ?? {};
  const timeoutMs = test.timeoutMs ?? defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  try {
    const raw = await client.callTool(test.tool, test.args ?? {}, timeoutMs);
    const latencyMs = Math.round(performance.now() - started);
    const envelope = normalizeToolCallResult(raw);
    const opaquePaths = scanOpaque(envelope);
    const warnings: string[] = [];
    const checks: string[] = [];
    const failures: string[] = [];
    const allowedOpaque = expectation.allowedOpaquePaths ?? [];
    const unexpectedOpaque = opaquePaths.filter((path) => !allowedOpaque.some((pattern) => pointerMatches(path, pattern)));
    if (unexpectedOpaque.length > 0) failures.push(`unexpected ExecutorOpaqueValue at ${unexpectedOpaque.slice(0, 5).join(", ")}`);
    if (latencyMs > (expectation.maxLatencyMs ?? Number.POSITIVE_INFINITY)) failures.push(`latency ${latencyMs}ms exceeded limit`);
    const size = byteLength(envelope);
    const maxBytes = expectation.maxBytes ?? defaults?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (size > maxBytes) failures.push(`result size ${size} bytes exceeded limit`);

    const httpStatus = envelope.ok ? envelope.http?.status : envelope.error.status;
    if (!envelope.ok) {
      const code = typeof envelope.error.code === "string" ? envelope.error.code : "tool_error";
      if (!(expectation.allowErrorCodes ?? []).includes(code)) failures.push(`tool returned ${code}`);
      else checks.push(`expected error: ${code}`);
    } else {
      const data = envelope.data;
      if (expectation.dataType && expectation.dataType !== "any" && jsonType(data) !== expectation.dataType) failures.push(`data type was ${jsonType(data)}, expected ${expectation.dataType}`);
      for (const pointer of expectation.requiredPaths ?? []) if (!getPointer(data, pointer).found) failures.push(`missing required path ${pointer}`);
      if (Array.isArray(data)) {
        if (expectation.minItems !== undefined && data.length < expectation.minItems) failures.push(`item count ${data.length} below minimum`);
        if (expectation.maxItems !== undefined && data.length > expectation.maxItems) failures.push(`item count ${data.length} above maximum`);
      }
      if (expectation.contentMinItems !== undefined) {
        const content = getPointer(data, "/content");
        if (!content.found || !Array.isArray(content.value) || content.value.length < expectation.contentMinItems) failures.push("content did not contain the expected number of blocks");
      }
      if (expectation.connectionHealth) {
        const health = healthChecks(data, expectation.connectionHealth);
        failures.push(...health.failures);
        warnings.push(...health.warnings);
      }
    }
    if (opaquePaths.length > 0 && unexpectedOpaque.length === 0) checks.push(`allowed opaque values: ${opaquePaths.length}`);
    if (failures.length > 0) return { ...base, status: "failed", latencyMs, ...(httpStatus === undefined ? {} : { httpStatus }), opaquePaths, warnings, checks, error: { code: "contract_failed", message: failures.join("; ") } };
    return { ...base, status: "passed", latencyMs, ...(httpStatus === undefined ? {} : { httpStatus }), ...(opaquePaths.length > 0 ? { opaquePaths } : {}), ...(warnings.length > 0 ? { warnings } : {}), ...(checks.length > 0 ? { checks } : {}) };
  } catch (error) {
    return { ...base, status: "failed", latencyMs: Math.round(performance.now() - started), error: safeError(error) };
  }
}

async function checkHealth(url: string, timeoutMs: number): Promise<HealthReport> {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    const passed = response.ok && isRecord(body) && body.status === "ok";
    return { target: url, status: passed ? "passed" : "failed", httpStatus: response.status, latencyMs: Math.round(performance.now() - started), ...(passed ? {} : { error: { code: "health_failed", status: response.status } }) };
  } catch (error) {
    return { target: url, status: "failed", latencyMs: Math.round(performance.now() - started), error: safeError(error) };
  }
}

function argumentValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function loadManifest(path: string): Promise<Manifest> {
  const value = await Bun.file(path).json();
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tests)) throw new Error("manifest must contain version 1 and tests[]");
  return value as unknown as Manifest;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const manifestPath = argumentValue(argv, "--manifest") ?? `${import.meta.dir}/manifest.json`;
  const jsonOnly = argv.includes("--json");
  const noHealth = argv.includes("--no-health");
  const discover = argv.includes("--discover");
  const timeoutMs = Number(process.env.EXECUTOR_CONTRACT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const endpoint = process.env.EXECUTOR_MCP_URL ?? DEFAULT_MCP_URL;
  const token = process.env.EXECUTOR_MCP_TOKEN;

  if (!token) {
    const report = { status: "failed", error: { code: "missing_token", message: "Set EXECUTOR_MCP_TOKEN in the monitor environment; never put it in runtime.env or the manifest." } };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }

  let manifest: Manifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", error: { code: "manifest_error", message: sanitizeMessage(error instanceof Error ? error.message : error) } }, null, 2));
    process.exitCode = 2;
    return;
  }

  const health: HealthReport[] = [];
  if (!noHealth) {
    const base = endpoint.replace(/\/mcp\/?$/, "");
    health.push(await checkHealth(`${base}/api/health`, timeoutMs));
    if (process.env.EXECUTOR_ADAPTER_HEALTH_URL) health.push(await checkHealth(process.env.EXECUTOR_ADAPTER_HEALTH_URL, timeoutMs));
  }

  const client = new McpClient(endpoint, token, process.env.EXECUTOR_MCP_PROTOCOL_VERSION ?? DEFAULT_PROTOCOL_VERSION);
  let initialization: { protocolVersion?: string } = {};
  const reports: TestReport[] = [];
  let suiteError: { code: string; message?: string } | undefined;
  try {
    initialization = await client.initialize(timeoutMs);
    if (discover) reports.push({ id: "executor.tools.list", tool: "tools/list", status: "passed", checks: [`catalog size: ${await client.listTools(timeoutMs)}`] });
    for (const test of manifest.tests) reports.push(await runCase(client, test, manifest.defaults));
  } catch (error) {
    suiteError = { code: safeError(error).code, ...(safeError(error).message ? { message: safeError(error).message } : {}) };
  }

  const passed = reports.filter((report) => report.status === "passed").length;
  const failed = reports.filter((report) => report.status === "failed").length + (suiteError ? 1 : 0) + health.filter((item) => item.status === "failed").length;
  const skipped = reports.filter((report) => report.status === "skipped").length;
  const report = {
    status: failed === 0 ? "passed" : "failed",
    target: endpoint,
    protocolVersion: initialization.protocolVersion ?? null,
    summary: { passed, failed, skipped, healthFailed: health.filter((item) => item.status === "failed").length },
    health,
    ...(suiteError ? { suiteError } : {}),
    tests: reports,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!jsonOnly) console.error(`Executor contract suite: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (import.meta.main) await main();
