import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Connection, IntegrationSlug } from "@executor-js/sdk/shared";

import { connectionsForIntegrationAtom } from "../api/atoms";
import {
  HEALTH_INDICATOR_COLOR,
  HEALTH_TEXT_CLASS,
  integrationHealthVerdict,
} from "../lib/health-display";
import { useConnectionsHealth } from "../lib/use-connection-health";

// ---------------------------------------------------------------------------
// Integration health summary: the at-a-glance verdict on an integrations-list
// row. Reads the integration's connections across BOTH owners, revalidates
// each one stale-while-revalidate (the same automatic check the detail page
// runs), and collapses them to the worst status: one dot per row, however
// many connections back it.
//
// Display only: the row is a Link, so this must never introduce a nested
// interactive element. The compact form is used in the sidebar; its caller
// disables duplicate background probes because the integrations page already
// owns list revalidation.
// ---------------------------------------------------------------------------

export function IntegrationHealthSummary(props: {
  readonly integration: IntegrationSlug;
  readonly compact?: boolean;
  readonly revalidate?: boolean;
}) {
  const org = useAtomValue(
    connectionsForIntegrationAtom({ integration: props.integration, owner: "org" }),
  );
  const user = useAtomValue(
    connectionsForIntegrationAtom({ integration: props.integration, owner: "user" }),
  );

  const connections = useMemo<readonly Connection[]>(
    () => [
      ...(AsyncResult.isSuccess(org) ? org.value : []),
      ...(AsyncResult.isSuccess(user) ? user.value : []),
    ],
    [org, user],
  );

  const probeFor = useConnectionsHealth(connections, { revalidate: props.revalidate });
  const isExecutor = String(props.integration) === "executor";
  const loaded = AsyncResult.isSuccess(org) && AsyncResult.isSuccess(user);
  if (!isExecutor && !loaded) return null;

  const verdict = integrationHealthVerdict(
    String(props.integration),
    connections.map((connection) => probeFor(connection)?.status ?? "unknown"),
  );
  const { status, label } = verdict;
  return (
    <span className="flex shrink-0 items-center gap-1.5" title={`Status: ${label}`}>
      {!props.compact && status !== "healthy" ? (
        <span
          className={`font-mono text-[11px] font-medium uppercase tracking-[0.08em] ${HEALTH_TEXT_CLASS[status]}`}
        >
          {label}
        </span>
      ) : null}
      <span
        aria-label={`Status: ${label}`}
        className={`size-2 rounded-full ${HEALTH_INDICATOR_COLOR[status].dot}`}
      />
    </span>
  );
}
