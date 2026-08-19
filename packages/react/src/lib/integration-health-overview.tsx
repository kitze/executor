import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { Connection, Integration } from "@executor-js/sdk/shared";

import { connectionsAllAtom, integrationsOptimisticAtom } from "../api/atoms";
import { integrationHealthVerdict, type IntegrationHealthVerdict } from "./health-display";
import { useConnectionsHealth } from "./use-connection-health";

export type IntegrationStatusFilter = "all" | IntegrationHealthVerdict["status"];

export interface IntegrationStatusCounts {
  readonly all: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly expired: number;
}

export const INTEGRATION_STATUS_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: IntegrationStatusFilter;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "all", label: "All", description: "All services" },
  { value: "healthy", label: "Green", description: "Healthy services" },
  { value: "degraded", label: "Yellow", description: "Services needing attention" },
  { value: "expired", label: "Red", description: "Expired or unconnected services" },
];

interface IntegrationHealthOverviewValue {
  readonly ready: boolean;
  readonly connectionsFailed: boolean;
  readonly counts: IntegrationStatusCounts;
  readonly healthByIntegration: ReadonlyMap<string, IntegrationHealthVerdict>;
  readonly statusFilter: IntegrationStatusFilter;
  readonly setStatusFilter: (filter: IntegrationStatusFilter) => void;
}

const IntegrationHealthOverviewContext = createContext<IntegrationHealthOverviewValue | null>(null);

const NO_INTEGRATIONS: readonly Integration[] = [];
const NO_CONNECTIONS: readonly Connection[] = [];

/**
 * Persistent shell-level health model. It owns list revalidation so the
 * sidebar summary stays current on every route, while cards and sidebar rows
 * read the exact same traffic-light verdicts and filter selection.
 */
export function IntegrationHealthOverviewProvider(props: { readonly children: ReactNode }) {
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const [statusFilter, setStatusFilter] = useState<IntegrationStatusFilter>("all");

  const integrations: readonly Integration[] = AsyncResult.isSuccess(integrationsResult)
    ? integrationsResult.value
    : NO_INTEGRATIONS;
  const ready = AsyncResult.isSuccess(connectionsResult);
  const connections: readonly Connection[] = ready ? connectionsResult.value : NO_CONNECTIONS;
  const probeFor = useConnectionsHealth(connections);

  const healthByIntegration = useMemo(() => {
    const verdicts = new Map<string, IntegrationHealthVerdict>();
    if (!ready) return verdicts;

    const byIntegration = new Map<string, Connection[]>();
    for (const connection of connections) {
      const slug = String(connection.integration);
      const group = byIntegration.get(slug) ?? [];
      group.push(connection);
      byIntegration.set(slug, group);
    }

    for (const integration of integrations) {
      const slug = String(integration.slug);
      const integrationConnections = byIntegration.get(slug) ?? [];
      verdicts.set(
        slug,
        integrationHealthVerdict(
          slug,
          integrationConnections.map((connection) => probeFor(connection)?.status ?? "unknown"),
        ),
      );
    }
    return verdicts;
  }, [connections, integrations, probeFor, ready]);

  const counts = useMemo<IntegrationStatusCounts>(() => {
    const next = { all: integrations.length, healthy: 0, degraded: 0, expired: 0 };
    if (!ready) return next;
    for (const verdict of healthByIntegration.values()) next[verdict.status] += 1;
    return next;
  }, [healthByIntegration, integrations.length, ready]);

  const value = useMemo<IntegrationHealthOverviewValue>(
    () => ({
      ready,
      connectionsFailed: AsyncResult.isFailure(connectionsResult),
      counts,
      healthByIntegration,
      statusFilter,
      setStatusFilter,
    }),
    [connectionsResult, counts, healthByIntegration, ready, statusFilter],
  );

  return (
    <IntegrationHealthOverviewContext.Provider value={value}>
      {props.children}
    </IntegrationHealthOverviewContext.Provider>
  );
}

export function useIntegrationHealthOverview(): IntegrationHealthOverviewValue {
  const value = useContext(IntegrationHealthOverviewContext);
  if (value === null) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- developer invariant: every routed integrations surface is rendered inside the shared Shell provider
    throw new Error("useIntegrationHealthOverview must be used inside the shared Shell");
  }
  return value;
}
