import { Suspense, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { PlusIcon } from "lucide-react";
import type { Integration } from "@executor-js/sdk/shared";
import { useIntegrationPlugins, type IntegrationPlugin } from "@executor-js/sdk/client";
import { integrationsOptimisticAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
import {
  integrationInferredUrl,
  integrationPresetIconUrl,
} from "../components/integration-favicon";
import { IntegrationHealthSummary } from "../components/integration-health-summary";
import { IntegrationIconWithAccount } from "../components/integration-icon-with-account";
import { Skeleton } from "../components/skeleton";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";
import {
  INTEGRATION_STATUS_FILTER_OPTIONS,
  useIntegrationHealthOverview,
  type IntegrationStatusFilter,
} from "../lib/integration-health-overview";

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "google",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationsPage() {
  useExecutorDocumentTitle("Integrations");
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);
  const {
    ready: connectionsReady,
    connectionsFailed,
    healthByIntegration,
    statusFilter,
    setStatusFilter,
  } = useIntegrationHealthOverview();

  const visibleIntegrations = useMemo(
    () =>
      !AsyncResult.isSuccess(integrations) || !connectionsReady || statusFilter === "all"
        ? AsyncResult.isSuccess(integrations)
          ? integrations.value
          : []
        : integrations.value.filter(
            (integration) =>
              healthByIntegration.get(String(integration.slug))?.status === statusFilter,
          ),
    [connectionsReady, healthByIntegration, integrations, statusFilter],
  );

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Integrations"
        description="Tool providers available in this workspace."
        actions={
          <Button asChild size="sm" className="gap-1.5">
            <Link
              to="/{-$orgSlug}/integrations/browse"
              onClick={() => trackEvent("integration_browse_opened", { via: "header" })}
            >
              <PlusIcon className="size-4" />
              Add integration
            </Link>
          </Button>
        }
      />

      <div className="mb-8">
        <McpInstallCard />
      </div>

      <div className="mb-8 border-t border-border/50" />

      {isAsyncResultLoading(integrations) ? (
        <IntegrationsGridSkeleton />
      ) : (
        AsyncResult.match(integrations, {
          onInitial: () => <IntegrationsGridSkeleton />,
          onFailure: () => (
            <ErrorState message="Failed to load integrations" onRetry={refreshIntegrations} />
          ),
          onSuccess: ({ value }) => {
            if (value.length === 0) {
              return <EmptyIntegrations />;
            }

            return (
              <div className="mb-8 space-y-3">
                {visibleIntegrations.length > 0 ? (
                  <IntegrationGrid
                    integrations={visibleIntegrations}
                    revalidateHealth={connectionsFailed}
                  />
                ) : (
                  <FilteredIntegrationsEmpty
                    filter={statusFilter}
                    onShowAll={() => setStatusFilter("all")}
                  />
                )}
              </div>
            );
          },
        })
      )}
    </PageContainer>
  );
}

function FilteredIntegrationsEmpty(props: {
  readonly filter: IntegrationStatusFilter;
  readonly onShowAll: () => void;
}) {
  const label = INTEGRATION_STATUS_FILTER_OPTIONS.find(
    (option) => option.value === props.filter,
  )?.label;
  return (
    <div
      data-testid="integration-filter-empty"
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-12 text-center"
    >
      <div>
        <p className="text-sm font-medium">No {label?.toLowerCase()} services</p>
        <p className="text-xs text-muted-foreground">Choose another status or show everything.</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={props.onShowAll}>
        Show all
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyIntegrations() {
  return (
    <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <PlusIcon className="size-5" />
      </div>
      <p className="mb-1 text-[14px] font-medium text-foreground/70">No integrations yet</p>
      <p className="mb-5 text-[13px] text-muted-foreground/60">
        Connect an integration to start curating tools.
      </p>
      <Button asChild size="sm" className="gap-1.5">
        <Link
          to="/{-$orgSlug}/integrations/browse"
          onClick={() => trackEvent("integration_browse_opened", { via: "empty-state" })}
        >
          <PlusIcon className="size-4" />
          Add an integration
        </Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integration grid — responsive cards, click-through to detail
// ---------------------------------------------------------------------------

function IntegrationGrid(props: {
  integrations: readonly Integration[];
  revalidateHealth: boolean;
}) {
  const integrationPlugins = useIntegrationPlugins();
  const pluginByKind = useMemo(() => {
    const out = new Map<string, IntegrationPlugin>();
    for (const plugin of integrationPlugins) out.set(plugin.key, plugin);
    return out;
  }, [integrationPlugins]);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {props.integrations.map((integration) => {
        const pluginKey = KIND_TO_PLUGIN_KEY[integration.kind] ?? integration.kind;
        const SummaryComponent = pluginByKind.get(pluginKey)?.summary;
        const slug = String(integration.slug);
        const name = integration.name || slug;

        return (
          <Link
            key={slug}
            to="/{-$orgSlug}/integrations/$namespace"
            params={{ namespace: slug }}
            data-testid={`integration-entry-${slug}`}
            className="group flex min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-card p-4 text-sm outline-none transition-[background-color,border-color,box-shadow] hover:border-border hover:bg-accent/40 hover:shadow-sm focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <IntegrationIconWithAccount
              icon={integrationPresetIconUrl(
                { id: slug, kind: integration.kind, name, url: integration.displayUrl },
                integrationPlugins,
              )}
              integrationId={slug}
              url={
                integration.displayUrl ?? integrationInferredUrl({ id: slug, name }) ?? undefined
              }
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="truncate text-sm font-medium leading-snug">{name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{slug}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
              {SummaryComponent && (
                <Suspense fallback={null}>
                  <SummaryComponent integrationId={slug} />
                </Suspense>
              )}
              <IntegrationHealthSummary
                integration={integration.slug}
                revalidate={props.revalidateHealth}
              />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function IntegrationsGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-card p-4"
        >
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4" style={{ width: `${40 + ((i * 11) % 30)}%` }} />
            <Skeleton className="h-3" style={{ width: `${25 + ((i * 7) % 20)}%` }} />
          </div>
          <Skeleton className="size-2 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}
