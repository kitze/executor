# Self-hosted Executor

This directory is the runtime home for a self-hosted instance of [Executor](https://github.com/UsefulSoftwareCo/executor), a web-based integration and MCP server. It is not the application source tree. It contains the runtime environment plus a small derived-image override for authentication, OAuth scope discovery, and integrations-list health checks.

## What is running

- Public URL: `https://executor.server.kitze.io`
- Public routing: exact Cloudflare A record `195.201.4.76` -> Coolify Traefik -> `http://100.127.73.44:4788`
- Active public Traefik route: `/data/coolify/proxy/dynamic/executor.yaml` on the Coolify host
- Standby local Traefik route: `/root/traefik/dynamic/executor.yml` (the host's public 443 path is currently unreachable upstream)
- Docker container: `executor`
- Image: local `executor-selfhost:1.5.42-kitze-842b480-ui419aead-scheduledtasks2`, based on `ghcr.io/usefulsoftwareco/executor-selfhost:1.5.42@sha256:3fb4e7fdcd639dd5c8d3de51d168e6d3b78654a156a4f5f323a2f986565cb4dc`
- Local artifact hashes: server `1d8f798e8e58153336a93285a34de5dd167259c658aee0cda98f5a44fb9540ad`; UI index `419aeadf010f9dc80d8096b26a2c72d49bdaffd4890473abf53764dfddbae5bf`
- Image command: `bun run dist-server/serve.js`
- Container working directory: `/app/apps/host-selfhost`
- Host/container port: `4788`
- Docker network mode: `host`
- Persistent data: named volume `executor-data`, mounted at `/data`
- Health endpoint: `GET /api/health` → `{"status":"ok"}`

### Authentication cookie override

Upstream 1.5.42 uses Better Auth's generic `better-auth` cookie prefix. A parent-domain `kitze.io` application can set a cookie with the same name, causing Executor to accept a password, create a session, and then return `401` from `/api/account/me` because the wrong cookie is parsed.

The bundled `serve.js` override changes Better Auth's cookie prefix to `executor`, producing a host-specific `__Secure-executor.session_token` cookie. It also lets OAuth-backed MCP connections run the MCP plugin's real liveness probe instead of stopping after credential resolution; this makes GitHub, Notion, Stripe, and future OAuth MCP integrations actually dial their MCP server and list tools during a health check. OAuth scope discovery additionally merges `offline_access` from the authorization-server metadata when that server advertises it, instead of stopping at the protected resource's API-only scopes; this is required for refresh-token-backed Glink connections. Withings OAuth compatibility uses comma-separated authorization scopes, omits PKCE fields unsupported by Withings, adds the required `action=requesttoken` form field for code and refresh grants, unwraps Withings' `{status, body}` token envelope, maps its HTTP-200 error envelopes to OAuth errors, and normalizes comma-delimited granted scopes. OpenAPI sensitivity extraction preserves public recursive response models such as Gmail's `MessagePart`, while unresolved references and recursive components containing real sensitive semantics remain fail-closed. This is a global OpenAPI fix, not a Gmail-only special case, and applies to Calendar, Drive, Docs, Sheets, and other integrations after their stored spec is refreshed. Cross-request console approvals are routed back to the exact live paused engine, scoped to the owning account and organization; they are bounded, expire after 15 minutes, and are cancelled on eviction instead of persisting or replaying approved code with blanket approval. The bundle also carries the current local security/recovery stack: opaque secret handoff hardening, session-backed approvals, alternate-encoding redaction, self-host secret recovery, Coolify OpenAPI environment/database repairs, safe Coolify service and scheduled-task result projections, and defensive execute-log normalization. `Dockerfile` packages those overrides into the local image. It also replaces the upstream shell-form healthcheck with an exec-form Bun healthcheck because the distroless image has no `/bin/sh`.

The 1.5.42 runtime serves the new MCP `2026-07-28` protocol alongside the legacy transport, including upstream SSE keepalive, replay, and dead-session reliability fixes. `MCP_2026_07_28_ENABLED=false` is the emergency rollback flag for the modern inbound path and is currently unset. Leave it unset unless the modern protocol itself is causing an incident.

### Local UI overrides

The upstream integrations list runs automatic row health checks through a shared Effect HTTP operation. Parallel calls can cancel one another, leaving almost every row on its stale `Expired` state until its detail page is opened and checked alone.

`ui-dist/` is a production frontend build from the exact upstream 1.5.42 release revision plus the local runtime commits, with these local changes:

- automatic integrations-list probes use independent same-origin `fetch` requests, while detail/manual checks retain the upstream typed client;
- every integration in the sidebar has a compact right-aligned health dot: green for healthy, orange for degraded or connected-without-a-probe, and red for expired, broken, or unconnected;
- the built-in Executor integration always renders green because a running UI proves the local service is available;
- a `Refresh` button beside the sidebar heading forces a fresh, independent health check for every saved connection, then reloads all persisted verdicts;
- a compact service-health summary sits directly below the sidebar's `Integrations` heading and stays sticky while the service list scrolls; its All/Green/Yellow/Red counts filter both the sidebar services and the integration cards using the same verdict logic as the dots, and selecting a color from another page returns to the filtered integrations view;
- the integrations page uses a responsive two-, three-, or four-column card grid instead of stacked list groups.

The whole generated frontend is copied into the derived image so its hashed asset graph remains internally consistent.

The stopped `executor-before-sidebar-378494b` container is the immediate pre-sidebar-summary rollback container running the prior 1.5.42 image `executor-selfhost:1.5.42-kitze-842b480-ui378494b`. The stopped `executor-before-1542-ad83f51` container is the pre-1.5.42 rollback container running image `executor-selfhost:1.5.41-kitze-ad83f51`. The stopped `executor-before-1541-a73ae669ce22` container is the older pre-1.5.41 rollback container running image `executor-selfhost:1.5.40-kitze-withings-a73ae669ce22`. The stopped `executor-before-withings-a73ae669ce22` container is the older pre-Withings rollback container running image `executor-selfhost:1.5.40-kitze-coolify-raw-v13-20260810`. The stopped `executor-before-gmail-2e84137` container is the older pre-Gmail-fix rollback container running image `executor-selfhost:1.5.40-kitze-ba79a73`. The older stopped `executor-before-1540-ba79a73` container is the 1.5.37 rollback container. Other older rollback containers may also exist; all should normally remain stopped. They share the same persistent `executor-data` volume. Never start two Executor containers together because each binds host port 4788.

The stopped `executor-before-scheduledtasks-v1-20260820` container is the immediate pre-service-inventory-projection rollback running `executor-selfhost:1.5.42-kitze-842b480-ui419aead-scheduledtasks`. The stopped `executor-before-scheduledtasks-20260820` container is the pre-scheduled-task-fix rollback running `executor-selfhost:1.5.42-kitze-842b480-ui419aead`. Both should remain stopped and share `executor-data` only as rollback references; never start one alongside `executor`.

The immediate pre-sidebar state backup is `/root/services/executor-backups/20260819T171416Z-pre-sidebar-state/data.db.sqlite-backup`; it is a live SQLite-consistent backup with integrity `ok`, stored mode 600 under a mode-700 directory. The prior UI, Dockerfile, server bundle, and handoff are under `/root/services/executor-backups/20260819T171416Z-pre-sidebar-artifacts`. The pre-1.5.42 state backups remain under `/root/services/executor-backups/20260819T164449Z-pre-1542-state`: `data.db.sqlite-backup` is the live SQLite-consistent backup, and `executor-data-stopped.tar.gz` is the complete stopped-volume snapshot. The immediate pre-1.5.42 deployment artifacts are under `/root/services/executor-backups/20260819T143956Z-pre-1542-artifacts`. The older pre-1.5.41 state backup remains under `/root/services/executor-backups/20260818T162855Z-pre-1541-state`. Restore volume data only while every Executor container is stopped.

The Executor UI is served from `/`. The service also exposes an authenticated MCP endpoint at `/mcp`, with OAuth-style discovery under `/.well-known/`. Clients authenticate with a bearer token; unauthenticated MCP requests return `401`.

## How it works

```text
MCP client or browser
        |
        v
executor.server.kitze.io:443 (195.201.4.76)
        |
        v
Coolify Traefik -> http://100.127.73.44:4788 over Tailscale
        |
        +-- Executor UI and API
        +-- authenticated MCP endpoint (/mcp)
        +-- configured integrations and toolkits
        |
        +-- persistent state in /data -> Docker volume executor-data
        |
        +-- optional local/private network access
```

`executor.server.kitze.io` is the sole canonical hostname. The former
development alias is retired: an exact DNS node suppresses the broader
development wildcard, and its old self-host-hetzner Traefik route was
removed. Do not reintroduce a development hostname in clients, OAuth callbacks,
or deployment configuration.

Executor stores its configuration, accounts, integrations, and other application state in `/data`; this survives container replacement because `/data` is backed by `executor-data`. The current volume is approximately 128 MB, but its size will grow with usage.

`EXECUTOR_ALLOW_LOCAL_NETWORK=true` permits integrations to reach local/private network services. Treat this instance as a trusted administrative service and avoid exposing it without authentication and HTTPS.

### Google Workspace OAuth

Gmail, Google Calendar, Drive, Docs, and Sheets all use the same Google Cloud
project and the same canonical Executor callback:

```text
https://executor.server.kitze.io/api/oauth/callback
```

Use the shared workspace-owned OAuth app whose Executor slug is `gmail` for all
five integrations. The slug is legacy; it is the working Google Workspace app,
not a Gmail-only client. The `personalgooglecalendar` connection was migrated to
this shared app. The older `google-calendar` OAuth app is retained only as a
rollback record and must not be selected because its Google-side redirect URI is
not registered. New Drive, Docs, and Sheets connections should also select the
shared `gmail` app. Never add the retired development hostname or a per-service
callback: Executor has one shared OAuth callback for every integration.

The application source fix for public recursive response schemas is global, but
stored OpenAPI tool metadata is regenerated only when an integration spec is
refreshed. After an Executor bundle update, refresh `google_calendar`,
`google_drive`, `google_docs`, `google_sheets`, and `google_gmail` before testing
their tools.

### Withings OAuth

Use Withings' official OpenAPI document at
`https://developer.withings.com/openapi.yaml` and the canonical Executor callback:

```text
https://executor.server.kitze.io/api/oauth/callback
```

The saved OpenAPI integration slug is `withings`; it currently exposes 62 tools,
uses OAuth template `withingsOAuth2`, and probes `measure-getmeas` with
`action=getmeas` as its read-only health check.

The personal-data OAuth template should use authorization endpoint
`https://account.withings.com/oauth2_user/authorize2`, token endpoint
`https://wbsapi.withings.net/v2/oauth2`, and scopes `user.info`, `user.metrics`,
and `user.activity`. Do not request `user.sleepevents` unless notification-only
bed-presence events are explicitly needed. A standard personal connection does
not need the contract-only account-creation, logistics, signature, or raw-data
flows that also appear in the official spec. Register the confidential Withings
client through Executor's browser handoff so its client secret never passes
through chat or logs.

## Configuration

`runtime.env` currently configures:

- production mode (`NODE_ENV=production`)
- bind address `0.0.0.0` and port `4788`
- public base URL `https://executor.server.kitze.io`
- data directory `/data`
- analytics/telemetry disabled (`DO_NOT_TRACK=1`, `EXECUTOR_DISABLE_ANALYTICS=1`)
- local-network access enabled

Do not print, commit, or paste the contents of `runtime.env` into logs or documentation. If secrets are added later, keep them in Docker secrets or another protected secret store.

## Companion Namecheap adapter

The neighboring `../namecheap-executor-adapter` directory is a separate service, not part of this folder. It runs as `namecheap-executor-api` from image `namecheap-executor-adapter:1.1.1` on port `4791`.

Its job is to keep Namecheap credentials server-side and translate authenticated HTTP requests into calls to the official Namecheap XML API. It supports documented operations for:

- domains and domain contacts
- DNS hosts, nameservers, and email forwarding
- transfers
- SSL certificates
- users and addresses
- domain privacy

Read operations use `GET /commands/<command>`; write operations use `POST`, and delete operations use `DELETE`. `/health` is public, `/openapi.json` describes the API, and command calls require a bearer token. Credentials are loaded from `/run/secrets/namecheap.env` inside that container; values are base64-encoded there and must never be documented here.

Executor can use this adapter as an OpenAPI integration. The normal flow is:

```text
MCP client -> Executor -> authenticated Namecheap adapter -> Namecheap API
```

Namecheap whitelists this host's actual outbound IP, `91.102.183.206`, and the
adapter's base64-encoded `NAMECHEAP_CLIENT_IP` matches it. Executor's saved
Namecheap OpenAPI integration uses the host-local adapter directly:
`http://127.0.0.1:4791`, with its spec at `/openapi.json`. This deliberately
bypasses the former Cloudflare Worker route, which failed with HTTP 525 before
reaching the adapter. Do not restore that Worker URL. Never print the adapter's
secret environment file while maintaining this configuration.

Namecheap write operations can spend money or replace/delete records, so confirm parameters and scope before executing them.

## Routine operations

Run these from `/root/services/executor` or any host shell:

```sh
docker ps --filter name=executor
docker logs --tail 100 executor
curl -fsS https://executor.server.kitze.io/api/health
docker restart executor
docker inspect executor
```

For the companion adapter:

```sh
docker ps --filter name=namecheap-executor-api
docker logs --tail 100 namecheap-executor-api
curl -fsS http://127.0.0.1:4791/health
```

When changing the Executor version or container configuration, preserve the `executor-data` volume. Replacing or recreating the container is safe only if that volume remains attached. After a change, verify `/api/health`, load the UI, and test the relevant integration with a read-only operation first.

The host-side `contract-tests/` directory contains the read-only service contract
runner and the local `scan-openapi-metadata.ts` guard. The runner exercises the
actual MCP surface with a dedicated read-only token and fails on stale or failed
connection verdicts, unexpected `ExecutorOpaqueValue` nodes, envelope/shape
changes, oversized results, and latency regressions. Run it sequentially from a
separate monitor or timer; do not put its token in `runtime.env`. The metadata
scan is read-only and reports active OpenAPI operations missing
`sensitivityVersion: 2`; it does not refresh or mutate stored catalogs.

To rebuild the current local image after intentionally updating an override:

```sh
docker build -t executor-selfhost:1.5.42-kitze-842b480-ui419aead-scheduledtasks2 /root/services/executor
```

Do not replace `serve.js` or `ui-dist/` from a newer upstream image without reapplying and browser-testing the local fixes until upstream exposes equivalent supported behavior.

## Repository notes

- `runtime.env`: deployment environment configuration; sensitive operational material must stay private.
- `Dockerfile` and `.dockerignore`: build the local derived image without sending `runtime.env` into the build context.
- `serve.js`: Executor 1.5.42 server bundle with upstream OAuth/scope, Gmail-modify, browser-session, and MCP transport updates plus the local authentication, live approval routing, OAuth/MCP health, Withings OAuth compatibility, OpenAPI recursive-output sensitivity, security, recovery, Coolify safe service/scheduled-task projections, and defensive execute-result formatting fixes.
- `ui-dist/`: generated Executor 1.5.42 frontend with the health, sidebar-dot, Refresh, sticky sidebar traffic-light summary/filter, and integrations-grid overrides.
- `index.html`, `index-kitze2.js`, `routes-kitze2.js`, and `use-connection-health-kitze2.js`: retained legacy health-only build artifacts; they are not copied into the active image.
- `AGENTS.md`: this operational handoff.
- `contract-tests/`: sanitized read-only MCP service contracts plus the local stale OpenAPI metadata scan; these are host-side monitor files and are not copied into the image.
- The maintainable Executor application source remains in the upstream repository; these bundles are deployment overrides, not a source checkout.
- The Namecheap adapter source is in `../namecheap-executor-adapter`.
