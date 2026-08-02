import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  compileOpenApiSpec,
  openApiStoredOperationsFromCompiled,
  openApiToolDefsFromCompiled,
  resolveOpenApiBackedAnnotations,
} from "./backing";
import { streamOperationBindingsFromStructure } from "./extract";
import { structuralSplit } from "./split";

const spec = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Sensitivity fixture", version: "1.0.0" },
  servers: [{ url: "https://api.example.test" }],
  components: {
    schemas: {
      Common: {
        type: "object",
        properties: { token: { type: "string", "x-executor-sensitive": true } },
      },
      "Secret/Value~": { type: "string", "x-executor-sensitive": true },
      Input: {
        type: "object",
        properties: {
          left: { $ref: "#/components/schemas/Common" },
          right: { $ref: "#/components/schemas/Common" },
          encodedRef: { $ref: "#/components/schemas/Secret~1Value~0" },
          ignoredPasswordHint: { type: "string", format: "password" },
        },
      },
      OutputRecord: {
        type: "object",
        properties: { value: { type: "string", "x-executor-sensitive": true } },
      },
      Output: {
        type: "object",
        properties: {
          records: { type: "array", items: { $ref: "#/components/schemas/OutputRecord" } },
          "slash/name~": { type: "string", "x-executor-sensitive": true },
          labels: {
            type: "object",
            additionalProperties: { type: "string", "x-executor-sensitive": true },
          },
        },
      },
    },
  },
  paths: {
    "/transfer": {
      post: {
        operationId: "transfer",
        parameters: [
          {
            name: "header/name~",
            in: "header",
            schema: { type: "string", "x-executor-sensitive": true },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Input" } },
            "application/vnd.fixture+json": {
              schema: {
                type: "object",
                properties: { alternate: { type: "string", "x-executor-sensitive": true } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Output" } } },
          },
        },
      },
    },
    "/stream": {
      get: {
        operationId: "stream",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/stream+json": {
                schema: {
                  type: "object",
                  properties: { token: { type: "string", "x-executor-sensitive": true } },
                },
              },
            },
          },
        },
      },
    },
  },
});

const streamableSpec = `
openapi: 3.0.3
info:
  title: Streaming sensitivity fixture
  version: 1.0.0
servers:
  - url: https://api.example.test
components:
  schemas:
    Secret:
      type: string
      x-executor-sensitive: true
    Response:
      type: object
      properties:
        items:
          type: array
          items:
            type: object
            properties:
              token:
                $ref: '#/components/schemas/Secret'
paths:
  /records:
    get:
      operationId: listRecords
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Response'
`;

describe("OpenAPI explicit sensitivity metadata", () => {
  it.effect("keeps fresh compile, stored binding, and dynamic annotations in lockstep", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(spec);
      const transfer = compiled.definitions.find(
        (definition) => definition.operation.operationId === "transfer",
      );
      const stream = compiled.definitions.find(
        (definition) => definition.operation.operationId === "stream",
      );
      expect(transfer).toBeDefined();
      expect(stream).toBeDefined();
      if (!transfer || !stream) return;

      const expectedInput = [
        "/body/alternate",
        "/body/encodedRef",
        "/body/left/token",
        "/body/right/token",
        "/header~1name~0",
      ];
      const expectedOutput = ["/labels/*", "/records/*/value", "/slash~1name~0"];
      expect(transfer.operation.sensitiveInputPaths).toEqual(expectedInput);
      expect(transfer.operation.sensitiveOutputPaths).toEqual(expectedOutput);
      expect(transfer.operation.sensitiveInputPaths).not.toContain("/body/ignoredPasswordHint");
      expect(stream.operation.sensitiveOutputPaths).toEqual(["/*/token"]);

      const fresh = openApiToolDefsFromCompiled(compiled).find(
        (tool) => String(tool.name) === transfer.toolPath,
      );
      expect(fresh?.annotations).toMatchObject({
        requiresApproval: true,
        sensitiveInputPaths: expectedInput,
        sensitiveOutputPaths: expectedOutput,
      });

      const stored = openApiStoredOperationsFromCompiled("fixture", compiled);
      const storedTransfer = stored.find((operation) => operation.toolName === transfer.toolPath);
      expect(storedTransfer?.binding.sensitiveInputPaths).toEqual(expectedInput);
      expect(storedTransfer?.binding.sensitiveOutputPaths).toEqual(expectedOutput);
      if (!storedTransfer) return;

      const resolved = yield* resolveOpenApiBackedAnnotations({
        ctx: {
          storage: {
            getOperation: (_integration: string, toolName: string) =>
              Effect.succeed(toolName === storedTransfer.toolName ? storedTransfer : null),
          },
        } as never,
        integration: "fixture",
        toolRows: [{ name: storedTransfer.toolName }],
      });
      expect(resolved[storedTransfer.toolName]).toMatchObject({
        requiresApproval: true,
        sensitiveInputPaths: expectedInput,
        sensitiveOutputPaths: expectedOutput,
      });
    }),
  );

  it.effect(
    "follows component references without materializing all schemas in the streaming compiler",
    () =>
      Effect.gen(function* () {
        const structure = structuralSplit(streamableSpec);
        expect(structure).not.toBeNull();
        if (!structure) return;
        const chunks: Array<readonly { readonly toolName: string; readonly binding: unknown }[]> =
          [];

        yield* streamOperationBindingsFromStructure(structure, { chunkSize: 10 }, (chunk) =>
          Effect.sync(() => chunks.push(chunk)),
        );

        expect(chunks).toHaveLength(1);
        const binding = chunks[0]?.[0]?.binding as {
          readonly sensitiveOutputPaths?: readonly string[];
        };
        expect(binding.sensitiveOutputPaths).toEqual(["/items/*/token"]);
      }),
  );
});
