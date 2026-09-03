FROM ghcr.io/usefulsoftwareco/executor-selfhost:1.5.42@sha256:3fb4e7fdcd639dd5c8d3de51d168e6d3b78654a156a4f5f323a2f986565cb4dc

# Exact-version server bundle with the local security/recovery stack, the
# host-specific Better Auth cookie prefix, real MCP liveness checks,
# refresh-token-aware OAuth scope discovery, Withings compatibility, public
# recursive OpenAPI response preservation, upstream first-party OAuth support,
# and MCP 2026-07-28 transport reliability fixes.
COPY serve.js /app/apps/host-selfhost/dist-server/serve.js

# Exact-version local UI build. It keeps independent integrations-list health
# probes, adds semantic status dots, a forced refresh action, and a sticky
# traffic-light summary/filter to the sidebar, and renders the integrations
# catalog as a responsive card grid.
COPY ui-dist/ /app/apps/host-selfhost/dist/

# The upstream distroless image has no /bin/sh, so use an exec-form healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
