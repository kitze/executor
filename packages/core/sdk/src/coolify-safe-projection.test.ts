import { describe, expect, it } from "@effect/vitest";

import { ToolResult } from "./tool-result";
import { coolifySafeProjectToolResult } from "./coolify-safe-projection";

const MARKER = "coolify-projection-secret-marker";

describe("coolifySafeProjectToolResult", () => {
  it("projects application evidence, nested settings, and no credential-bearing repository URL", () => {
    const result = coolifySafeProjectToolResult(
      "tools.coolify.user.production.applications.getApplicationByUuid",
      ToolResult.ok(
        {
          uuid: "app_123",
          name: "Glink",
          git_repository: `https://fixture-user:${MARKER}@example.invalid/kitze/glink2.git`,
          settings: {
            is_auto_deploy_enabled: true,
            connect_to_docker_network: true,
            include_source_commit_in_build: true,
            is_preserve_repository_enabled: true,
            is_raw_compose_deployment_enabled: true,
            inject_build_args_to_dockerfile: false,
            database_password: MARKER,
          },
          git_full_url: `https://fixture-user:${MARKER}@example.invalid/kitze/glink2.git`,
          environment: { value: MARKER },
        },
        { http: { status: 200, headers: { authorization: `Bearer ${MARKER}` } } },
      ),
    );

    expect(result).toEqual({
      ok: true,
      data: {
        uuid: "app_123",
        name: "Glink",
        git_repository: "[redacted]",
        settings: {
          is_auto_deploy_enabled: true,
          connect_to_docker_network: true,
          include_source_commit_in_build: true,
          is_preserve_repository_enabled: true,
          is_raw_compose_deployment_enabled: true,
          inject_build_args_to_dockerfile: false,
        },
      },
      http: { status: 200, headers: {} },
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("keeps a plain repository reference while projecting application lists", () => {
    const result = coolifySafeProjectToolResult(
      "coolify.user.production.applications.listApplications",
      ToolResult.ok({
        applications: [
          {
            uuid: "app_123",
            name: "Glink",
            git_repository: "kitze/glink2",
            settings: {
              is_preserve_repository_enabled: true,
              is_raw_compose_deployment_enabled: true,
              inject_build_args_to_dockerfile: true,
            },
            access_token: MARKER,
          },
        ],
        total: 1,
        next_page_token: MARKER,
      }),
    );

    expect(result).toEqual({
      ok: true,
      data: {
        applications: [
          {
            uuid: "app_123",
            name: "Glink",
            git_repository: "kitze/glink2",
            settings: {
              is_preserve_repository_enabled: true,
              is_raw_compose_deployment_enabled: true,
              inject_build_args_to_dockerfile: true,
            },
          },
        ],
        total: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("returns only fixed configuration-validation identifiers for an application update 422", () => {
    const result = coolifySafeProjectToolResult(
      "coolify.user.production.applications.updateApplicationByUuid",
      ToolResult.fail({
        code: "upstream_http_error",
        message: `The upstream validator echoed ${MARKER}`,
        status: 422,
        details: {
          errors: {
            is_raw_compose_deployment_enabled: [
              "The is_raw_compose_deployment_enabled field must be boolean.",
              MARKER,
            ],
          },
          api_token: MARKER,
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UPSTREAM_VALIDATION_FAILED",
        message: "Coolify rejected the application configuration request.",
        status: 422,
        details: {
          validationIssues: [
            {
              field: "is_raw_compose_deployment_enabled",
              reason: "must_be_boolean",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("does not make other Coolify failures or non-422 application updates actionable", () => {
    const failure = ToolResult.fail({
      code: "upstream_http_error",
      message: MARKER,
      status: 422,
      details: { is_raw_compose_deployment_enabled: MARKER },
    });

    expect(
      coolifySafeProjectToolResult(
        "coolify.user.production.applications.restartApplicationByUuid",
        failure,
      ),
    ).toBeUndefined();
    expect(
      coolifySafeProjectToolResult(
        "coolify.user.production.applications.updateApplicationByUuid",
        ToolResult.fail({
          code: "upstream_http_error",
          message: MARKER,
          status: 409,
          details: { is_raw_compose_deployment_enabled: MARKER },
        }),
      ),
    ).toBeUndefined();
    expect(
      coolifySafeProjectToolResult(
        "github.user.production.applications.updateApplicationByUuid",
        failure,
      ),
    ).toBeUndefined();
  });
});
