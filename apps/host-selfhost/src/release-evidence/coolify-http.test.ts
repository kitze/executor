import { expect, test } from "@effect/vitest";

import { createCoolifyHttpApplicationApi } from "./coolify-http";

test("uses only the fixed app/deployment-scoped Coolify runtime-image endpoint", async () => {
  const requests: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({
      application_uuid: "root-app-uuid",
      application_id: 1001,
      deployment_uuid: "release-deployment-uuid",
      deployment_id: 9001,
      image_digest: `sha256:${"ab".repeat(32)}`,
      opaque_provider_metadata: "must-not-leave-observer",
    });
  };
  const api = createCoolifyHttpApplicationApi({
    baseUrl: "https://coolify.example.invalid",
    token: "host-held-coolify-token",
    fetch: fetch as typeof globalThis.fetch,
  });

  const result = await api.getDeploymentRuntimeImageByUuid({
    uuid: "release-deployment-uuid",
  });
  expect(result).toMatchObject({ deployment_uuid: "release-deployment-uuid" });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe("GET");
  expect(new URL(request.url).pathname).toBe(
    "/api/v1/deployments/release-deployment-uuid/runtime-image",
  );
  expect(request.headers.get("authorization")).toBe("Bearer host-held-coolify-token");
  expect(request.cache).toBe("no-store");
});
