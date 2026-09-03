# Executor service contract checks

This is a small, read-only monitor for the integrations configured in the
self-hosted Executor instance. It tests the result an agent receives through
MCP, including authentication, tool dispatch, upstream response shape, and
`ExecutorOpaqueValue` protection. It is intentionally not an Executor unit
test suite.

## Run it

Keep the token outside this directory and outside `runtime.env`:

```sh
EXECUTOR_MCP_TOKEN='read-only-token-from-your-secret-store' \
  bun /root/services/executor/contract-tests/run.ts
```

Useful options and variables:

- `EXECUTOR_MCP_URL` changes the MCP endpoint; the canonical URL is the default.
- `EXECUTOR_MCP_TOKEN` is required and is never printed by the runner.
- `EXECUTOR_ADAPTER_HEALTH_URL=http://127.0.0.1:4791/health` adds the local Namecheap adapter check when the monitor runs on the host.
- `--json` leaves the JSON report on stdout without the human summary on stderr.
- `--no-health` skips `/api/health` and the optional adapter health check.
- `--discover` additionally pages through `tools/list`; it is intentionally off by default because Cloudflare has a large catalog.

The default manifest is a bounded set of read-only probes. Run it sequentially
from cron or a systemd timer. Do not parallelize the calls: parallel health
requests were one of the reasons the integrations sidebar produced misleading
green/expired results. The connection-inventory check is intentionally strict:
expired, degraded, unknown, and unchecked connections all fail the suite.

Exit codes are suitable for alerting:

- `0`: runtime checks and every enabled contract passed;
- `1`: a service failed, returned an unexpected shape, exceeded a limit, or
  contained an unexpected opaque value;
- `2`: the monitor was misconfigured or could not load its manifest.

The report contains only status, counts, paths, latency, HTTP status, and
sanitized error codes. It does not print response bodies, OAuth tokens, API
keys, message contents, or adapter credentials.

## Add a service

Add one explicit case to `manifest.json` for each important connection. Mark it
`"readOnly": true`; the runner rejects missing or unsafe cases and also blocks
common mutation verbs in tool names. Keep arguments bounded (`limit: 1`,
`maxResults: 1`, a narrow time range) and assert the smallest useful shape.

For ordinary public data, leave `allowedOpaquePaths` as an empty array. If a
response intentionally contains a secret-bearing leaf, allow only that exact
JSON Pointer (wildcards are supported), never the whole response. A whole
`ExecutorOpaqueValue` on a normal list/get probe should fail the check.

## Catch stale OpenAPI metadata locally

Before and after an Executor bundle/spec refresh, run this read-only scan on the
Executor host:

```sh
bun /root/services/executor/contract-tests/scan-openapi-metadata.ts
```

It joins active OpenAPI connections with the stored operation catalog. An
operation without `sensitivityVersion: 2` is reported as stale because the
current runtime deliberately treats it as whole-output sensitive. This scan
does not repair or refresh anything; refreshing catalogs is a separate,
state-changing operation that should be backed up and tested first.
