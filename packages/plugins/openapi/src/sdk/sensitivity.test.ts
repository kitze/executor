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
          {
            name: "contentToken",
            in: "query",
            content: {
              "application/json": {
                schema: { type: "string", "x-executor-sensitive": true },
              },
            },
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

const openApi31Spec = `
openapi: 3.1.0
info:
  title: OpenAPI 3.1 sensitivity fixture
  version: 1.0.0
servers:
  - url: https://{tenant}.example.test
    variables:
      tenant:
        default: public
        x-secret: true
components:
  schemas:
    Recursive:
      type: object
      properties:
        token:
          type: string
          format: token
        next:
          $ref: '#/components/schemas/Recursive'
    Advanced:
      type: object
      properties:
        '*':
          type: string
          format: secret
        tuple:
          type: array
          prefixItems:
            - type: string
              format: password
        collection:
          type: array
          contains:
            type: string
            x-sensitive: true
          unevaluatedItems:
            type: string
            x-secret: true
        conditional:
          type: object
          if:
            properties:
              mode:
                const: private
          then:
            properties:
              thenSecret:
                type: string
                writeOnly: true
          else:
            properties:
              elseSecret:
                type: string
                format: api-key
          not:
            properties:
              forbiddenSecret:
                type: string
                format: token
          dependentSchemas:
            account:
              properties:
                dependentSecret:
                  type: string
                  x-executor-sensitive: true
        recursive:
          $ref: '#/components/schemas/Recursive'
paths:
  /advanced:
    post:
      operationId: advanced
      parameters:
        - name: queryToken
          in: query
          schema:
            type: string
            format: token
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Advanced'
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Advanced'
`;

const failClosedDirectionSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Direction-aware recursion fixture", version: "1.0.0" },
  components: {
    schemas: {
      PublicRecursive: {
        type: "object",
        properties: { next: { $ref: "#/components/schemas/PublicRecursive" } },
      },
    },
  },
  paths: {
    "/direction-aware": {
      post: {
        operationId: "directionAware",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  recursive: { $ref: "#/components/schemas/PublicRecursive" },
                  unresolved: { $ref: "#/components/schemas/DoesNotExist" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    recursive: { $ref: "#/components/schemas/PublicRecursive" },
                    unresolved: { $ref: "#/components/schemas/DoesNotExist" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const schemaDialectSpec = `
openapi: 3.1.0
info:
  title: Schema dialect sensitivity fixture
  version: 1.0.0
components:
  schemas:
    DynamicSecret:
      type: string
      format: secret
      $dynamicAnchor: secret
    PublicRecursive:
      type: object
      properties:
        next:
          $recursiveRef: '#/components/schemas/PublicRecursive'
    Dialect:
      type: object
      properties:
        pattern:
          type: object
          patternProperties:
            '^credential_':
              type: string
              format: token
        unevaluated:
          type: object
          unevaluatedProperties:
            type: string
            format: password
        tupleLegacy:
          type: array
          items:
            - type: string
            - type: string
              format: api-key
        dependencies:
          type: object
          dependencies:
            account:
              type: object
              properties:
                dependencySecret:
                  type: string
                  format: secret
        dynamic:
          $dynamicRef: '#/components/schemas/DynamicSecret'
        recursivePublic:
          $recursiveRef: '#/components/schemas/PublicRecursive'
paths:
  /schema-dialect:
    post:
      operationId: schemaDialect
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Dialect'
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Dialect'
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
        "/body/ignoredPasswordHint",
        "/body/left/token",
        "/body/right/token",
        "/contentToken",
        "/header/header~1name~0",
        "/headers/header~1name~0",
        "/header~1name~0",
        "/input/alternate",
        "/input/encodedRef",
        "/input/ignoredPasswordHint",
        "/input/left/token",
        "/input/right/token",
        "/params/contentToken",
        "/query/contentToken",
        "/queryParams/contentToken",
      ];
      const expectedOutput = ["/labels/*", "/records/*/value", "/slash~1name~0"];
      expect(transfer.operation.sensitiveInputPaths).toEqual(expectedInput);
      expect(transfer.operation.sensitiveOutputPaths).toEqual(expectedOutput);
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

  it.effect("covers OpenAPI 3.1 schema branches identically in full and structural compilers", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(openApi31Spec);
      const advanced = compiled.definitions.find(
        (definition) => definition.operation.operationId === "advanced",
      );
      expect(advanced).toBeDefined();
      if (!advanced) return;

      const expectedInputBodyPaths = [
        "/body/~2",
        "/body/collection/*",
        "/body/conditional/dependentSecret",
        "/body/conditional/elseSecret",
        "/body/conditional/forbiddenSecret",
        "/body/conditional/thenSecret",
        "/body/recursive/token",
        "/body/tuple/0",
      ];
      // A recursive output cannot be projected to a finite token leaf at
      // every depth, so seal the recursive edge. The same fallback must not
      // become an input sink: it would authorize an opaque value in an
      // otherwise public object position.
      const expectedOutputBodyPaths = ["/body/recursive/next", ...expectedInputBodyPaths];
      const expectedInput = [
        ...expectedInputBodyPaths,
        "/input/~2",
        "/input/collection/*",
        "/input/conditional/dependentSecret",
        "/input/conditional/elseSecret",
        "/input/conditional/forbiddenSecret",
        "/input/conditional/thenSecret",
        "/input/recursive/token",
        "/input/tuple/0",
        "/params/queryToken",
        "/query/queryToken",
        "/queryParams/queryToken",
        "/queryToken",
        "/server/variables/tenant",
      ].sort();
      const expectedOutput = expectedOutputBodyPaths
        .map((path) => path.slice("/body".length))
        .sort();
      expect(advanced.operation.sensitiveInputPaths).toEqual(expectedInput);
      expect(advanced.operation.sensitiveOutputPaths).toEqual(expectedOutput);

      const structure = structuralSplit(openApi31Spec);
      expect(structure).not.toBeNull();
      if (!structure) return;
      const chunks: Array<readonly { readonly toolName: string; readonly binding: unknown }[]> = [];
      yield* streamOperationBindingsFromStructure(structure, { chunkSize: 1 }, (chunk) =>
        Effect.sync(() => chunks.push(chunk)),
      );

      expect(chunks).toHaveLength(1);
      const binding = chunks[0]?.[0]?.binding as {
        readonly sensitiveInputPaths?: readonly string[];
        readonly sensitiveOutputPaths?: readonly string[];
      };
      expect(binding.sensitiveInputPaths).toEqual(expectedInput);
      expect(binding.sensitiveOutputPaths).toEqual(expectedOutput);
    }),
  );

  it.effect("seals unresolved and recursive outputs without authorizing public input sinks", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(failClosedDirectionSpec);
      const operation = compiled.definitions.find(
        (definition) => definition.operation.operationId === "directionAware",
      );
      expect(operation).toBeDefined();
      if (!operation) return;

      expect(operation.operation.sensitiveInputPaths).toBeUndefined();
      expect(operation.operation.sensitiveOutputPaths).toEqual(["/recursive/next", "/unresolved"]);
    }),
  );

  it.effect("covers pattern, legacy tuple/dependency, unevaluated, and dynamic schemas", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(schemaDialectSpec);
      const operation = compiled.definitions.find(
        (definition) => definition.operation.operationId === "schemaDialect",
      );
      expect(operation).toBeDefined();
      if (!operation) return;

      const expectedInput = [
        "/body/dependencies/dependencySecret",
        "/body/dynamic",
        "/body/pattern/*",
        "/body/tupleLegacy/1",
        "/body/unevaluated/*",
        "/input/dependencies/dependencySecret",
        "/input/dynamic",
        "/input/pattern/*",
        "/input/tupleLegacy/1",
        "/input/unevaluated/*",
      ];
      const expectedOutput = [
        "/dependencies/dependencySecret",
        "/dynamic",
        "/pattern/*",
        "/recursivePublic/next",
        "/tupleLegacy/1",
        "/unevaluated/*",
      ];
      expect(operation.operation.sensitiveInputPaths).toEqual(expectedInput);
      expect(operation.operation.sensitiveOutputPaths).toEqual(expectedOutput);

      const structure = structuralSplit(schemaDialectSpec);
      expect(structure).not.toBeNull();
      if (!structure) return;
      const chunks: Array<readonly { readonly binding: unknown }[]> = [];
      yield* streamOperationBindingsFromStructure(structure, { chunkSize: 1 }, (chunk) =>
        Effect.sync(() => chunks.push(chunk)),
      );
      const binding = chunks[0]?.[0]?.binding as {
        readonly sensitiveInputPaths?: readonly string[];
        readonly sensitiveOutputPaths?: readonly string[];
      };
      expect(binding.sensitiveInputPaths).toEqual(expectedInput);
      expect(binding.sensitiveOutputPaths).toEqual(expectedOutput);
    }),
  );

  it.effect("fails closed for persisted pre-sensitivity bindings without creating new sinks", () =>
    Effect.gen(function* () {
      const compiled = yield* compileOpenApiSpec(spec);
      const transferDefinition = compiled.definitions.find(
        (definition) => definition.operation.operationId === "transfer",
      );
      expect(transferDefinition).toBeDefined();
      if (!transferDefinition) return;
      const stored = openApiStoredOperationsFromCompiled("fixture", compiled);
      const transfer = stored.find(
        (operation) => operation.toolName === transferDefinition.toolPath,
      );
      expect(transfer).toBeDefined();
      if (!transfer) return;

      const legacy = {
        ...transfer,
        binding: {
          ...transfer.binding,
          sensitivityVersion: undefined,
          sensitiveInputPaths: undefined,
          sensitiveOutputPaths: undefined,
          sensitiveResponseHeaders: undefined,
        },
      };
      const resolved = yield* resolveOpenApiBackedAnnotations({
        ctx: {
          storage: {
            getOperation: () => Effect.succeed(legacy),
          },
        } as never,
        integration: "fixture",
        toolRows: [{ name: transfer.toolName }],
      });

      expect(resolved[transfer.toolName]).toEqual({
        requiresApproval: true,
        approvalDescription: "POST /transfer",
        sensitiveOutputPaths: [""],
        sensitiveResponseHeaders: true,
      });
    }),
  );
});
