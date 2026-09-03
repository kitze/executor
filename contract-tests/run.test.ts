import { expect, test } from "bun:test";
import { normalizeToolCallResult, pointerMatches, scanOpaque } from "./run.ts";

test("normalizes an Executor structured MCP envelope", () => {
  const value = normalizeToolCallResult({ structuredContent: { ok: true, data: { items: [] } } });
  expect(value).toEqual({ ok: true, data: { items: [] } });
});

test("normalizes a legacy JSON text content envelope", () => {
  const value = normalizeToolCallResult({ content: [{ type: "text", text: JSON.stringify({ ok: true, data: [1] }) }] });
  expect(value).toEqual({ ok: true, data: [1] });
});

test("finds opaque values without exposing their ids", () => {
  const value = { ok: true, data: { safe: 1, nested: [{ _tag: "ExecutorOpaqueValue", id: "secret-id" }] } };
  expect(scanOpaque(value)).toEqual(["/data/nested/0"]);
});

test("supports wildcard JSON-pointer allowlists", () => {
  expect(pointerMatches("/items/0/secret", "/items/*/secret")).toBe(true);
  expect(pointerMatches("/items/0/secret", "/items/*/other")).toBe(false);
});
