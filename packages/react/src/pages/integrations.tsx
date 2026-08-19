import { Suspense, useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { PlusIcon } from "lucide-react";
import type { Connection, Integration, IntegrationDetectionResult } from "@executor-js/sdk/shared";
import {
  useIntegrationPlugins,
  type IntegrationPlugin,
  type IntegrationPreset,
} from "@executor-js/sdk/client";
import { connectionsAllAtom, detectIntegration, integrationsOptimisticAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryMedia,
  CardStackEntryTitle,
} from "../components/card-stack";
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
  HEALTH_INDICATOR_COLOR,
  integrationHealthVerdict,
  type IntegrationHealthVerdict,
} from "../lib/health-display";
import { useConnectionsHealth } from "../lib/use-connection-health";

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "google",
};

const detectionRank: Record<IntegrationDetectionResult["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const bestDetection = (
  results: readonly IntegrationDetectionResult[],
): IntegrationDetectionResult | undefined =>
  [...results].sort((a, b) => detectionRank[b.confidence] - detectionRank[a.confidence])[0];

type IntegrationStatusFilter = "all" | IntegrationHealthVerdict["status"];

interface IntegrationStatusCounts {
  readonly all: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly expired: number;
}

const NO_INTEGRATIONS: readonly Integration[] = [];
const NO_CONNECTIONS: readonly Connection[] = [];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationsPage() {
  useExecutorDocumentTitle("Integrations");
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const connectionsResult = useAtomValue(connectionsAllAtom);
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);
  const [connectOpen, setConnectOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<IntegrationStatusFilter>("all");

  const loadedIntegrations: readonly Integration[] = AsyncResult.isSuccess(integrations)
    ? integrations.value
    : NO_INTEGRATIONS;
  const connectionsReady = AsyncResult.isSuccess(connectionsResult);
  const connections: readonly Connection[] = connectionsReady
    ? connectionsResult.value
    : NO_CONNECTIONS;
  const probeFor = useConnectionsHealth(connections);

  const healthByIntegration = useMemo(() => {
    const verdicts = new Map<string, IntegrationHealthVerdict>();
    if (!connectionsReady) return verdicts;

    const byIntegration = new Map<string, Connection[]>();
    for (const connection of connections) {
      const slug = String(connection.integration);
      const group = byIntegration.get(slug) ?? [];
      group.push(connection);
      byIntegration.set(slug, group);
    }

    for (const integration of loadedIntegrations) {
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
  }, [connections, connectionsReady, loadedIntegrations, probeFor]);

  const statusCounts = useMemo<IntegrationStatusCounts>(() => {
    const counts = { all: loadedIntegrations.length, healthy: 0, degraded: 0, expired: 0 };
    if (!connectionsReady) return counts;
    for (const verdict of healthByIntegration.values()) counts[verdict.status] += 1;
    return counts;
  }, [connectionsReady, healthByIntegration, loadedIntegrations.length]);

  const visibleIntegrations = useMemo(
    () =>
      !connectionsReady || statusFilter === "all"
        ? loadedIntegrations
        : loadedIntegrations.filter(
            (integration) =>
              healthByIntegration.get(String(integration.slug))?.status === statusFilter,
          ),
    [connectionsReady, healthByIntegration, loadedIntegrations, statusFilter],
  );

  return (
    <PageContainer className="max-w-7xl">
      <PageHeader
        title="Integrations"
        description="Tool providers available in this workspace."
        actions={
          <Button
            onClick={() => {
              setConnectOpen(true);
              trackEvent("integration_connect_dialog_opened");
            }}
            size="sm"
            className="gap-1.5"
          >
            <PlusIcon className="size-4" />
            Connect
          </Button>
        }
      />

      {loadedIntegrations.length > 0 && (
        <IntegrationStatusSummary
          counts={statusCounts}
          ready={connectionsReady}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      )}

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
              return (
                <EmptyIntegrations
                  onConnect={() => {
                    setConnectOpen(true);
                    trackEvent("integration_connect_dialog_opened");
                  }}
                />
              );
            }

            return (
              <div className="mb-8 space-y-3">
                {visibleIntegrations.length > 0 ? (
                  <IntegrationGrid
                    integrations={visibleIntegrations}
                    revalidateHealth={AsyncResult.isFailure(connectionsResult)}
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

      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Traffic-light summary + filter
// ---------------------------------------------------------------------------

const STATUS_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: IntegrationStatusFilter;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "all", label: "All", description: "All services" },
  { value: "healthy", label: "Green", description: "Healthy services" },
  { value: "degraded", label: "Yellow", description: "Services needing attention" },
  { value: "expired", label: "Red", description: "Expired or unconnected services" },
];

function IntegrationStatusSummary(props: {
  readonly counts: IntegrationStatusCounts;
  readonly ready: boolean;
  readonly value: IntegrationStatusFilter;
  readonly onChange: (filter: IntegrationStatusFilter) => void;
}) {
  return (
    <section
      data-testid="integration-health-overview"
      aria-label="Integration status summary"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium">Service health</p>
        <p className="truncate text-xs text-muted-foreground">
          {props.ready
            ? `${props.counts.healthy} green · ${props.counts.degraded} yellow · ${props.counts.expired} red`
            : "Checking saved connections…"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Filter services by status">
        {STATUS_FILTER_OPTIONS.map((option) => {
          const active = props.value === option.value;
          const disabled = !props.ready && option.value !== "all";
          return (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={active ? "secondary" : "outline"}
              data-testid={`integration-status-filter-${option.value}`}
              aria-pressed={active}
              title={option.description}
              disabled={disabled}
              onClick={() => props.onChange(option.value)}
              className="h-8 gap-1.5 px-2.5"
            >
              {option.value !== "all" && (
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${HEALTH_INDICATOR_COLOR[option.value].dot}`}
                />
              )}
              <span>{option.label}</span>
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {props.ready || option.value === "all" ? props.counts[option.value] : "—"}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function FilteredIntegrationsEmpty(props: {
  readonly filter: IntegrationStatusFilter;
  readonly onShowAll: () => void;
}) {
  const label = STATUS_FILTER_OPTIONS.find((option) => option.value === props.filter)?.label;
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
// Connect dialog — URL detection + manual plugin chooser + presets
// ---------------------------------------------------------------------------

// Heuristic: the input either looks like a URL (auto-detect) or a free-text
// search query (filter the preset list). Anything with a scheme, slash, or
// host-with-TLD is treated as a URL; everything else is search.
const looksLikeUrl = (raw: string): boolean => {
  const v = raw.trim();
  if (v.length === 0) return false;
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(v)) return true;
  if (v.includes("/")) return true;
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?$/i.test(v)) return true;
  return false;
};

function ConnectDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const integrationPlugins = useIntegrationPlugins();
  const doDetect = useAtomSet(detectIntegration, { mode: "promiseExit" });
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUrl = looksLikeUrl(query);
  const presetSearch = isUrl ? "" : query;

  const closeAndReset = useCallback(() => {
    setQuery("");
    setError(null);
    setDetecting(false);
    props.onOpenChange(false);
  }, [props]);

  const handleDetect = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setDetecting(true);
    setError(null);
    // Detection is read-only — it inspects a URL and returns candidates without
    // mutating the catalog, so it invalidates nothing.
    const exit = await doDetect({
      payload: { url: trimmed },
      reactivityKeys: [],
    });
    if (Exit.isFailure(exit)) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Detection failed. Try adding an integration manually.");
      setDetecting(false);
      return;
    }
    const results = exit.value;
    if (results.length === 0) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Could not detect an integration type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    const detected = bestDetection(results);
    if (!detected) {
      trackEvent("integration_detect_submitted", { success: false });
      setError("Could not detect an integration type from this URL. Try adding manually.");
      setDetecting(false);
      return;
    }
    trackEvent("integration_detect_submitted", {
      success: true,
      detected_kind: detected.kind,
      confidence: detected.confidence,
    });
    const pluginKey = KIND_TO_PLUGIN_KEY[detected.kind] ?? detected.kind;
    if (integrationPlugins.some((p) => p.key === pluginKey)) {
      trackEvent("integration_add_started", { plugin_key: pluginKey, via: "detect" });
      closeAndReset();
      void navigate({
        to: "/{-$orgSlug}/integrations/add/$pluginKey",
        params: { pluginKey },
        search: { url: trimmed, namespace: detected.slug },
      });
    } else {
      setError(`Detected integration type "${detected.kind}" but no plugin is available for it.`);
      setDetecting(false);
    }
  }, [query, doDetect, navigate, integrationPlugins, closeAndReset]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) closeAndReset();
        else props.onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Connect an integration</DialogTitle>
          <DialogDescription>
            Search the preset library, or paste a URL to auto-detect.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <Input
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery((e.target as HTMLInputElement).value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isUrl) void handleDetect();
                }}
                placeholder="Search or paste a URL…"
                disabled={detecting}
                className="flex-1"
              />
              {isUrl && (
                <Button onClick={() => void handleDetect()} disabled={detecting || !query.trim()}>
                  {detecting ? "Detecting..." : "Detect"}
                </Button>
              )}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-foreground/80">Or add manually</p>
            <div className="flex flex-wrap gap-2">
              {integrationPlugins.map((p) => (
                <Link
                  key={p.key}
                  to="/{-$orgSlug}/integrations/add/$pluginKey"
                  params={{ pluginKey: p.key }}
                  onClick={() => {
                    trackEvent("integration_add_started", { plugin_key: p.key, via: "manual" });
                    closeAndReset();
                  }}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {p.label}
                </Link>
              ))}
            </div>
          </div>

          <PresetGrid
            plugins={integrationPlugins}
            onPick={closeAndReset}
            searchQuery={presetSearch}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyIntegrations(props: { onConnect: () => void }) {
  return (
    <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <PlusIcon className="size-5" />
      </div>
      <p className="mb-1 text-[14px] font-medium text-foreground/70">No integrations yet</p>
      <p className="mb-5 text-[13px] text-muted-foreground/60">
        Connect an integration to start curating tools.
      </p>
      <Button onClick={props.onConnect} size="sm" className="gap-1.5">
        <PlusIcon className="size-4" />
        Connect an integration
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset grid (for inside the Connect dialog)
// ---------------------------------------------------------------------------

type PresetEntry = {
  preset: IntegrationPreset;
  pluginKey: string;
  pluginLabel: string;
};

function PresetGrid(props: {
  plugins: readonly IntegrationPlugin[];
  onPick: () => void;
  /** Controlled filter query forwarded from the dialog's unified
   *  search/URL input. Empty string disables filtering. */
  searchQuery?: string;
}) {
  const allPresets = useMemo(() => {
    const entries: PresetEntry[] = [];
    for (const plugin of props.plugins) {
      for (const preset of plugin.presets ?? []) {
        entries.push({
          preset,
          pluginKey: plugin.key,
          pluginLabel: plugin.label,
        });
      }
    }
    return entries;
  }, [props.plugins]);

  const filtered = useMemo(() => {
    const q = (props.searchQuery ?? "").trim().toLowerCase();
    if (q.length === 0) return allPresets;
    return allPresets.filter(({ preset, pluginLabel }) => {
      const corpus =
        `${preset.name} ${preset.summary ?? ""} ${preset.family ?? ""} ${preset.specFormat ?? ""} ${pluginLabel}`.toLowerCase();
      return corpus.includes(q);
    });
  }, [allPresets, props.searchQuery]);

  if (allPresets.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-foreground/80">Popular integrations</p>
      <CardStack className="min-w-0">
        {/* Fixed height keeps the dialog stable as the user filters; the
         *  inner area scrolls when the list overflows and shows an empty
         *  state when no presets match. */}
        <CardStackContent className="h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">No matching presets</p>
              <p className="text-xs text-muted-foreground/70">
                Paste a URL above to auto-detect, or pick an integration type manually.
              </p>
            </div>
          ) : (
            filtered.map(({ preset, pluginKey, pluginLabel }) => {
              const search: Record<string, string> = { preset: preset.id };
              if (preset.url) search.url = preset.url;
              return (
                <CardStackEntry key={`${pluginKey}-${preset.id}`} asChild>
                  <Link
                    to="/{-$orgSlug}/integrations/add/$pluginKey"
                    params={{ pluginKey }}
                    search={search}
                    onClick={() => {
                      trackEvent("integration_add_started", {
                        plugin_key: pluginKey,
                        via: "preset",
                        preset_id: preset.id,
                      });
                      props.onPick();
                    }}
                  >
                    <CardStackEntryMedia>
                      {preset.icon ? (
                        <img
                          src={preset.icon}
                          alt=""
                          className="size-5 object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                        </svg>
                      )}
                    </CardStackEntryMedia>
                    <CardStackEntryContent>
                      <CardStackEntryTitle>{preset.name}</CardStackEntryTitle>
                      <CardStackEntryDescription>{preset.summary}</CardStackEntryDescription>
                    </CardStackEntryContent>
                    <CardStackEntryActions>
                      <Badge variant="secondary">{pluginLabel}</Badge>
                    </CardStackEntryActions>
                  </Link>
                </CardStackEntry>
              );
            })
          )}
        </CardStackContent>
      </CardStack>
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
