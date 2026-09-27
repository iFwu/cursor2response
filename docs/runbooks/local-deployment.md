# Local deployment

## Supported layouts

Docker Compose starts the API, SDK Bridge, and Trace Viewer together on the pinned Node.js 24 LTS image. Direct source execution supports Node.js 24 or later and is verified on Node 24 and 26. Use one layout per configured port and state directory. Do not point a test candidate at an existing deployment's state.

The package accepts later Node majors, but each newly released major still needs the full test and operations suites before it becomes a verified runtime. Docker remains the reproducible fallback when a newer host runtime exposes an incompatibility.

The API defaults to `127.0.0.1:6718`; Compose publishes the Viewer at `127.0.0.1:8100`. The Bridge is internal in Compose. The standalone Viewer defaults to `127.0.0.1:4319`.

## Docker Compose

Start in the source directory:

```bash
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `.env` as `CURSOR_SDK_BRIDGE_TOKEN`. Set `CURSOR_API_KEY` only if you want a single-user default; otherwise clients supply their own Cursor key. Keep this file private and do not reuse the Bridge token as a provider credential.

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:6718/health
curl --fail http://127.0.0.1:8100/health
curl --fail http://127.0.0.1:8100/api/runtime
```

The runtime proxy must return a current Bridge snapshot, including process identity. Viewer health alone does not establish correct Bridge authentication or trace ingestion. Inspect bounded startup output with `docker compose logs --tail 100` and exercise a representative Responses request.

The Compose file is the source of truth for volume names and container mount paths. Preserve the volumes that hold SDK HOME/checkpoints, Bridge indexes, optional fallback route markers, failure traces, and shared structured logs. Never mount the whole host HOME as a shortcut for client path compatibility.

For an update, review the source changes and configuration, back up durable state when needed, then run:

```bash
docker compose up -d --build
docker compose ps
```

Recheck health, runtime identity, served Viewer assets, and the behavior affected by the update. Building an image does not replace a running container. Active SDK runs and pending tool callbacks are lost when Bridge is replaced.

`docker compose down` stops this stack and retains named volumes. `docker compose down -v` deletes those volumes and is a destructive reset, not an update procedure. Backups must include the SDK checkpoint storage and Bridge indexes together; an index alone is not a complete resumable conversation.

## Direct source execution

This is the complete three-process layout with shared Bridge authentication. If you previously used `node server.mjs start`, stop that managed stack with `node server.mjs stop` before using these commands on the same ports. The launcher generates a separate internal token; starting `npm run trace:viewer` beside it does not automatically connect runtime inspection.

Install Node.js 24 or later, then:

```bash
npm ci
npm run build
cp .env.example .env
openssl rand -hex 32
```

Set `CURSOR_SDK_BRIDGE_TOKEN` in `.env`. For manual execution use these local addresses; Compose supplies its own internal addresses:

```dotenv
CURSOR_SDK_BRIDGE_HOST=127.0.0.1
CURSOR_SDK_BRIDGE_PORT=6719
CURSOR_SDK_BRIDGE_URL=http://127.0.0.1:6719/sdk
CURSOR2RESPONSE_TRACE_VIEWER_BRIDGE_URL=http://127.0.0.1:6719
CURSOR2RESPONSE_TRACE_VIEWER_PORT=8100
HOST=127.0.0.1
PORT=6718
```

Start Bridge, then Sidecar, then Viewer in separate terminals. Node's native
`--env-file` loads dotenv values without shell execution. Existing process
environment variables take precedence over values in the file:

```bash
node --env-file=.env scripts/structured-log-runner.mjs bridge -- node bridge/server.mjs
```

```bash
node --env-file=.env scripts/structured-log-runner.mjs sidecar -- node dist/runtime/sidecar/server.js
```

```bash
node --env-file=.env tools/trace-viewer/server.mjs
```

The runner keeps bounded structured logs under `${XDG_STATE_HOME:-~/.local/state}/cursor2response/logs`; set `CURSOR2RESPONSE_TRACE_LOG_DIR` consistently for all three processes to override it. Ctrl-C stops a foreground process. The `node server.mjs start` launcher starts only API and Bridge through the same structured-log runner and manages its own internal token. Use Compose or the explicit commands above to configure the Viewer and Bridge authentication together.

## Network proxy

The Bridge accepts the standard HTTP proxy environment used by Cursor and Node.js:

```dotenv
HTTP_PROXY=http://host.docker.internal:7890
HTTPS_PROXY=http://host.docker.internal:7890
NO_PROXY=localhost,127.0.0.1,0.0.0.0,::1,bridge,api,viewer
NODE_USE_ENV_PROXY=1
```

Only the Bridge receives these Compose settings, so Cursor SDK upstream traffic uses the proxy while Sidecar-to-Bridge and Viewer traffic stays local. `node server.mjs start` loads the repository `.env` before starting its child processes. For direct execution, use `--env-file` as shown above; `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS` are startup settings.

Some proxies cannot carry the SDK's HTTP/2 bidirectional stream. Set `CURSOR_SDK_USE_HTTP1_FOR_AGENT=1` to make the local SDK transport use HTTP/1.1 with SSE. Leave it unset unless the normal path fails.

Compose maps `host.docker.internal` to the Docker host. The proxy must still listen on an address reachable from the container; a host service bound only to `127.0.0.1` is not reachable through the host gateway. This integration covers HTTP(S) proxies, not SOCKS proxy URLs. Keep the local names in `NO_PROXY` when customizing it.

For a proxy that performs TLS inspection, set `NODE_EXTRA_CA_CERTS` to a trusted PEM bundle. Direct source execution can use a host path. In Docker, mount the bundle read-only with a Compose override and use its container path, for example:

```yaml
services:
  bridge:
    volumes:
      - /path/on/host/proxy-ca.pem:/etc/cursor2response/proxy-ca.pem:ro
```

```dotenv
NODE_EXTRA_CA_CERTS=/etc/cursor2response/proxy-ca.pem
```

Health endpoints only prove the local processes are running. Validate proxy connectivity with `/v1/models`, then exercise a representative Responses request; a successful health check is not proof that Cursor traffic reached the upstream service.

## SDK workspace in containers

Compose sets `CURSOR_SDK_WORKING_DIRECTORY=/workspace` as the SDK execution directory. The client working directory remains part of session identity and forwarded tool context; host paths do not need to exist inside the container. The Bridge exposes client tools through MCP and does not use a host HOME mount. Keep the SDK execution directory stable across container replacement so checkpoints remain discoverable.

## Persistent state and restart behavior

Completed clean Agents are indexed under `${CURSOR_SDK_BRIDGE_AGENT_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/cursor2response/bridge-agents}`. The Bridge marks state dirty before sending and clean only after a terminal finished run without a pending tool callback. Only clean entries may be resumed, and the SDK's corresponding checkpoint storage must also remain available.

A restart during a run, exposed tool batch, or cancellation does not preserve pending ownership. An Agent ID file is not proof that a tool callback survived. Verify clean resume with an independent follow-up using the same model and session, and inspect `agentResumed`, `promptSource`, and recovery events. Verify dirty-state recovery separately.

## Optional api-fallback route

Select `model: "cursor-relay"` in the client. All four settings are required:

```dotenv
C2R_PRIMARY_MODEL=cursor-model
C2R_FALLBACK_BASE_URL=https://gateway.example/v1
C2R_FALLBACK_API_KEY=replace-with-dedicated-key
C2R_FALLBACK_MODEL=upstream-model
```

The catalog displays **Cursor Relay**. Existing `cursor-auto` requests remain
accepted during migration and share the same sticky route markers. Migrate
client and gateway model selections to `cursor-relay`; the old request alias
can be removed once every client and gateway has migrated.

`C2R_PRIMARY_MODEL` must name an available Cursor model; `C2R_FALLBACK_MODEL`
must name a model accepted by the external API. They may differ. For a Grok
fast primary, set `C2R_PRIMARY_MODEL=grok-4.6-fast`; there is no separate
`cursor-relay-fast` alias. Other client model choices continue to use the SDK
directly. This configures one route, not per-model mappings or a fallback chain.

The base URL excludes `/responses`. `C2R_FALLBACK_TIMEOUT_MS` defaults to 180000
and covers response headers and body. `C2R_FALLBACK_STATE_DIR` defaults to
`${XDG_STATE_HOME:-~/.local/state}/cursor2response/fallback-routes`. Preserve this
directory across restarts. In Compose it lives in the existing `api-state`
volume; change mount paths through a Compose override rather than using host
paths inside containers.

Compose reads these values from `.env`, or from
`docker compose --env-file /path/to/runtime.env up -d --build`. It explicitly
passes the four route settings and timeout only to the API service. Direct Node
uses `--env-file=/path/to/runtime.env`; the local launcher also loads repository
`.env`, with process environment taking precedence. A systemd deployment can
use `EnvironmentFile=` for the same keys. Keep files containing credentials
private (0600); do not put them in Git or command-line arguments.

Notifications are off by default. Direct Node deployments may set
`C2R_FALLBACK_NOTIFY_COMMAND` to an executable implementing the notification
arguments in the spec. Container deployments require an explicitly installed
executable and Compose override. Verify the provider's Responses semantics,
tool continuation, and billing before enabling the route. See the
[routing contract](../specs/api-fallback.md).

## Trace data

Logs and failure artifacts may contain sensitive model-visible content. Keep state local, protect backups, and review artifacts before sharing. The [Viewer runbook](trace-viewer.md) describes log limits and partial windows; the [failure-trace spec](../specs/responses-failure-traces.md) defines capture and retention.
