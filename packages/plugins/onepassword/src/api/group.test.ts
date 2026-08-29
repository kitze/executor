import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { HttpApi, HttpApiClient } from "effect/unstable/httpapi";

import { OnePasswordGroup } from "./group";

const Api = HttpApi.make("onepassword-transport-test").add(OnePasswordGroup);
const ListVaultsRequest = Schema.Struct({
  authKind: Schema.Literals(["desktop-app", "service-account"]),
  account: Schema.String,
});

describe("OnePasswordGroup listVaults transport", () => {
  it.effect("keeps a service-account token out of the request URL", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string; body: string }> = [];
      const client = yield* HttpApiClient.makeWith(Api, {
        baseUrl: "http://localhost",
        httpClient: HttpClient.make((request) =>
          Effect.sync(() => {
            const isJsonBody = Predicate.isTagged(request.body, "Uint8Array");
            expect(isJsonBody).toBe(true);
            requests.push({
              method: request.method,
              url: request.url,
              body: isJsonBody ? new TextDecoder().decode(request.body.body) : "",
            });
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
          }),
        ),
      });
      const serviceAccountToken = "ops_test_transport_token";

      yield* client.onepassword.listVaults({
        payload: { authKind: "service-account", account: serviceAccountToken },
        responseMode: "response-only",
      });

      const request = requests[0];
      expect(request?.method).toBe("POST");
      expect(new URL(request?.url ?? "", "http://localhost").pathname).toBe("/onepassword/vaults");
      expect(new URL(request?.url ?? "", "http://localhost").search).toBe("");
      expect(request?.url).not.toContain(serviceAccountToken);
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ListVaultsRequest))(
        request?.body ?? "",
      );
      expect(payload).toEqual({
        authKind: "service-account",
        account: serviceAccountToken,
      });
    }),
  );
});
