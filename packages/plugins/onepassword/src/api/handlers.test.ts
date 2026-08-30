import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { addGroup, observabilityMiddleware } from "@executor-js/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor-js/api/server";

import type { OnePasswordExtension } from "../sdk/plugin";
import type { OnePasswordAuth } from "../sdk/types";
import { OnePasswordExtensionService, OnePasswordHandlers } from "./handlers";
import { OnePasswordGroup } from "./group";

const unused = Effect.die("unused");
const Api = addGroup(OnePasswordGroup);
const UnusedExecutor = Layer.succeed(ExecutorService)({} as ExecutorService["Service"]);
const UnusedExecutionEngine = Layer.succeed(ExecutionEngineService)(
  {} as ExecutionEngineService["Service"],
);

const makeStubExtension = (
  onListVaults: (auth: OnePasswordAuth) => void,
): OnePasswordExtension => ({
  configure: () => unused,
  getConfig: () => Effect.succeed(null),
  removeConfig: () => unused,
  status: () => Effect.succeed({ connected: false, accounts: [], error: "Not configured" }),
  listVaults: (auth) =>
    Effect.sync(() => {
      onListVaults(auth);
      return [{ id: "vault-dedicated", name: "Dedicated" }];
    }),
  resolve: () => unused,
});

const webHandlerFor = (extension: OnePasswordExtension) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(Api).pipe(
          Layer.provide(CoreHandlers),
          Layer.provide(OnePasswordHandlers),
          Layer.provide(observabilityMiddleware(Api)),
          Layer.provide(UnusedExecutor),
          Layer.provide(UnusedExecutionEngine),
          Layer.provide(Layer.succeed(OnePasswordExtensionService, extension)),
          Layer.provideMerge(HttpServer.layerServices),
          Layer.provideMerge(Layer.succeed(HttpRouter.RouterConfig)({ maxParamLength: 1000 })),
        ),
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

const postVaults = (
  web: { handler: (request: Request) => Promise<Response> },
  body: { authKind: "desktop-app" | "service-account"; account: string },
) =>
  Effect.promise(() =>
    web.handler(
      new Request("http://localhost/onepassword/vaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

describe("OnePasswordHandlers listVaults", () => {
  it.effect("reads both authentication modes from a POST JSON body", () =>
    Effect.gen(function* () {
      const received: OnePasswordAuth[] = [];
      const extension = makeStubExtension((auth) => received.push(auth));
      const web = yield* webHandlerFor(extension);
      const handlerContext = Context.make(ExecutorService, {} as ExecutorService["Service"]).pipe(
        Context.add(ExecutionEngineService, {} as ExecutionEngineService["Service"]),
        Context.add(OnePasswordExtensionService, extension),
      );
      const handler = (request: Request) => web.handler(request, handlerContext);

      const serviceAccountToken = "ops_test_handler_token";
      const serviceAccountResponse = yield* postVaults(
        { handler },
        {
          authKind: "service-account",
          account: serviceAccountToken,
        },
      );
      const desktopResponse = yield* postVaults(
        { handler },
        {
          authKind: "desktop-app",
          account: "my.1password.com",
        },
      );

      expect(serviceAccountResponse.status).toBe(200);
      expect(desktopResponse.status).toBe(200);
      expect(received).toEqual([
        { kind: "service-account", token: serviceAccountToken },
        { kind: "desktop-app", accountName: "my.1password.com" },
      ]);
    }),
  );
});
