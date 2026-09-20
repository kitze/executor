import { useEffect, useState } from "react";
import { Effect, Exit, Schema } from "effect";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";
import {
  getExecutorApiBaseUrl,
  getExecutorOrganizationHeaders,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";

const Binding = Schema.Struct({
  toolkitId: Schema.NullOr(Schema.String),
  toolkits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      slug: Schema.String,
    }),
  ),
});
type Binding = typeof Binding.Type;

const requestScope = (url: string, init: RequestInit) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetch(url, init));
    if (!response.ok) return yield* Effect.fail("Key scope request failed");
    return response;
  });

const headers = () => {
  const result = new Headers({
    ...getExecutorOrganizationHeaders(),
    "content-type": "application/json",
  });
  const authorization = getExecutorServerAuthorizationHeader();
  if (authorization) result.set("authorization", authorization);
  return result;
};

export function ToolkitKeyBinding(props: { readonly keyId: string }) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const url = `${getExecutorApiBaseUrl()}/account/api-keys/${encodeURIComponent(props.keyId)}/toolkit`;

  useEffect(() => {
    const controller = new AbortController();
    void Effect.runPromiseExit(
      Effect.gen(function* () {
        const response = yield* requestScope(url, {
          headers: headers(),
          credentials: "include",
          signal: controller.signal,
        });
        const value = yield* Effect.tryPromise(() => response.json());
        return yield* Schema.decodeUnknownEffect(Binding)(value);
      }),
    ).then((exit) => {
      if (controller.signal.aborted) return;
      if (Exit.isSuccess(exit)) {
        setBinding(exit.value);
        setError(null);
      } else {
        setError("Failed to load key scope");
      }
    });
    return () => controller.abort();
  }, [url]);

  const save = async (toolkitId: string | null) => {
    setSaving(true);
    setError(null);
    const exit = await Effect.runPromiseExit(
      requestScope(url, {
        method: "PATCH",
        headers: headers(),
        credentials: "include",
        body: JSON.stringify({ toolkitId }),
      }),
    );
    if (Exit.isSuccess(exit)) {
      setBinding((current) => (current ? { ...current, toolkitId } : current));
    } else {
      setError("Failed to save key scope");
    }
    setSaving(false);
  };

  return (
    <div className="grid gap-1">
      <NativeSelect
        aria-label="API key toolkit"
        size="sm"
        value={binding?.toolkitId ?? ""}
        disabled={!binding || saving}
        onChange={(event) => void save(event.target.value || null)}
      >
        <NativeSelectOption value="">
          {binding ? "Account-wide" : "Loading scope…"}
        </NativeSelectOption>
        {binding?.toolkitId &&
          !binding.toolkits.some((toolkit) => toolkit.id === binding.toolkitId) && (
            <NativeSelectOption value={binding.toolkitId}>Unavailable toolkit</NativeSelectOption>
          )}
        {binding?.toolkits.map((toolkit) => (
          <NativeSelectOption key={toolkit.id} value={toolkit.id}>
            {toolkit.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
