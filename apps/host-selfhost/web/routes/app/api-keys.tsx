import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysPage } from "@executor-js/react/pages/api-keys";
import { ToolkitKeyBinding } from "../../components/toolkit-key-binding";

function SelfHostApiKeysPage() {
  return <ApiKeysPage renderKeyScope={(keyId) => <ToolkitKeyBinding keyId={keyId} />} />;
}

export const Route = createFileRoute("/{-$orgSlug}/api-keys")({
  component: SelfHostApiKeysPage,
});
