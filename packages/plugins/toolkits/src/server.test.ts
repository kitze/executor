import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { toolkitsPlugin } from "./server";

describe("toolkitsPlugin", () => {
  it.effect("deduplicates connections and rejects duplicate visible slugs", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [toolkitsPlugin()] as const });
      const toolkit = yield* executor.toolkits.create({ owner: "org", name: "Deploy Kit" });
      expect(toolkit.slug).toBe("deploy-kit");
      const connection = yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "github.org.main.*",
      });
      const duplicate = yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "github.org.main.*",
      });
      expect(duplicate.id).toBe(connection.id);
      const error = yield* Effect.flip(
        executor.toolkits.create({ owner: "user", name: "Deploy Kit" }),
      );
      expect(Predicate.isTagged("ToolkitError")(error)).toBe(true);
    }),
  );

  it.effect("authorizes every connected operation regardless of defaults or stored policies", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [toolkitsPlugin()] as const });
      const toolkit = yield* executor.toolkits.create({ owner: "org", name: "Deploy Kit" });
      yield* executor.toolkits.createConnection(toolkit.id, { pattern: "github.org.main.*" });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "github.org.main.repos.delete",
        action: "block",
      });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "github.org.main.repos.create",
        action: "require_approval",
      });
      // Even a broad historical approve rule cannot expose an unassigned service.
      yield* executor.toolkits.createPolicy(toolkit.id, { pattern: "*", action: "approve" });
      const prepared = yield* executor.toolkits.preparePolicyResolverForSlug(toolkit.slug);
      for (const toolId of [
        "github.org.main.repos.list",
        "github.org.main.repos.create",
        "github.org.main.repos.delete",
      ]) {
        const policy = yield* executor.toolkits.resolvePolicyForSlug(toolkit.slug, toolId, true);
        expect(policy).toEqual({ action: "approve", source: "plugin-default" });
        expect(prepared({ toolId, defaultRequiresApproval: true })).toEqual(policy);
      }
      for (const toolId of ["github.org.other.repos.delete", "slack.org.main.chat.post"]) {
        expect(prepared({ toolId, defaultRequiresApproval: false }).action).toBe("block");
        expect((yield* executor.toolkits.resolvePolicyForSlug(toolkit.slug, toolId)).action).toBe(
          "block",
        );
      }
      expect(yield* executor.toolkits.policyRulesForSlug(toolkit.slug)).toEqual([]);
      // Legacy data remains available for migration; it is no longer an operation gate.
      expect((yield* executor.toolkits.listPolicies(toolkit.id)).length).toBe(3);
    }),
  );

  it.effect("preserves workspace ownership limits and missing-toolkit denial", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [toolkitsPlugin()] as const });
      const workspace = yield* executor.toolkits.create({ owner: "org", name: "Workspace Kit" });
      yield* executor.toolkits.createConnection(workspace.id, { pattern: "github.user.main.*" });
      const prepared = yield* executor.toolkits.preparePolicyResolverForSlug(workspace.slug);
      const toolId = "github.user.main.repos.delete";
      expect(prepared({ toolId }).action).toBe("block");
      expect((yield* executor.toolkits.resolvePolicyForSlug(workspace.slug, toolId)).action).toBe(
        "block",
      );
      const personal = yield* executor.toolkits.create({ owner: "user", name: "Personal Kit" });
      yield* executor.toolkits.createConnection(personal.id, { pattern: "github.user.main.*" });
      expect(
        (yield* executor.toolkits.resolvePolicyForSlug(personal.slug, toolId, true)).action,
      ).toBe("approve");
      expect((yield* executor.toolkits.resolvePolicyForSlug("missing", toolId)).action).toBe(
        "block",
      );
      const missing = yield* executor.toolkits.preparePolicyResolverForSlug("missing");
      expect(missing({ toolId }).action).toBe("block");
    }),
  );

  it.effect("does not turn historical policy patterns into connection grants", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [toolkitsPlugin()] as const });
      const toolkit = yield* executor.toolkits.create({ owner: "org", name: "Legacy Kit" });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "github.org.main.*",
        action: "approve",
      });
      yield* executor.toolkits.createConnection(toolkit.id, { pattern: "docs.org.main.*" });
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "docs.org.*",
        action: "approve",
      });
      const prepared = yield* executor.toolkits.preparePolicyResolverForSlug(toolkit.slug);
      expect(
        prepared({ toolId: "github.org.main.repos.delete", defaultRequiresApproval: true }).action,
      ).toBe("block");
      expect(
        prepared({ toolId: "docs.org.main.documents.delete", defaultRequiresApproval: true })
          .action,
      ).toBe("approve");
      expect(prepared({ toolId: "docs.org.other.documents.delete" }).action).toBe("block");
    }),
  );

  it.effect("revokes access after a connection or toolkit is removed", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({ plugins: [toolkitsPlugin()] as const });
      const toolkit = yield* executor.toolkits.create({ owner: "org", name: "Temporary Kit" });
      const connection = yield* executor.toolkits.createConnection(toolkit.id, {
        pattern: "github.org.main.*",
      });
      const toolId = "github.org.main.repos.delete";
      expect(
        (yield* executor.toolkits.resolvePolicyForSlug(toolkit.slug, toolId, true)).action,
      ).toBe("approve");
      yield* executor.toolkits.createPolicy(toolkit.id, {
        pattern: "github.org.main.*",
        action: "approve",
      });
      yield* executor.toolkits.removeConnection(toolkit.id, connection.id);
      const afterRemoval = yield* executor.toolkits.preparePolicyResolverForSlug(toolkit.slug);
      expect(afterRemoval({ toolId }).action).toBe("block");
      yield* executor.toolkits.remove(toolkit.id);
      expect((yield* executor.toolkits.resolvePolicyForSlug(toolkit.slug, toolId)).action).toBe(
        "block",
      );
    }),
  );
});
