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

The Compose file is the source of truth for volume names and container mount paths. Preserve the volumes that hold SDK HOME/checkpoints, Bridge indexes, optional hybrid route markers, failure traces, and shared structured logs. Never mount the whole host HOME as a shortcut for client path compatibility.

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

In each of three terminals, load the trusted, locally edited `.env` before the corresponding process. Shell sourcing executes the file as shell code, so do not source unreviewed downloaded configuration:

```bash
set -a
. ./.env
set +a
```

Start Bridge, then Sidecar, then Viewer in those terminals:

```bash
node scripts/structured-log-runner.mjs bridge -- node bridge/server.mjs
```

```bash
node scripts/structured-log-runner.mjs sidecar -- node dist/runtime/sidecar/server.js
```

```bash
node tools/trace-viewer/server.mjs
```

The runner keeps bounded structured logs under `${XDG_STATE_HOME:-~/.local/state}/cursor2response/logs`; set `CURSOR2RESPONSE_TRACE_LOG_DIR` consistently for all three processes to override it. Ctrl-C stops a foreground process. The `node server.mjs start` launcher starts only API and Bridge through the same structured-log runner and manages its own internal token. Use Compose or the explicit commands above to configure the Viewer and Bridge authentication together.

## SDK workspace in containers

Compose sets `CURSOR_SDK_WORKING_DIRECTORY=/workspace` as the SDK execution directory. The client working directory remains part of session identity and forwarded tool context; host paths do not need to exist inside the container. The Bridge exposes client tools through MCP and does not use a host HOME mount. Keep the SDK execution directory stable across container replacement so checkpoints remain discoverable.

## Persistent state and restart behavior

Completed clean Agents are indexed under `${CURSOR_SDK_BRIDGE_AGENT_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/cursor2response/bridge-agents}`. The Bridge marks state dirty before sending and clean only after a terminal finished run without a pending tool callback. Only clean entries may be resumed, and the SDK's corresponding checkpoint storage must also remain available.

A restart during a run, exposed tool batch, or cancellation does not preserve pending ownership. An Agent ID file is not proof that a tool callback survived. Verify clean resume with an independent follow-up using the same model and session, and inspect `agentResumed`, `promptSource`, and recovery events. Verify dirty-state recovery separately.

## Optional Grok hybrid route

The fallback requires all three settings:

```dotenv
CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_BASE_URL=https://gateway.example/v1
CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_API_KEY=replace-with-dedicated-key
CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_MODEL=upstream-model
```

The base URL excludes `/responses`. The optional `CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_TIMEOUT_MS` defaults to 180000. Keep route state under `CURSOR2RESPONSE_GROK_HYBRID_STATE_DIR` or the default local state directory across restarts. Verify the configured provider's Responses semantics, tool continuation, and billing before enabling the route. See the [routing contract](../specs/grok-hybrid.md).

## Trace data

Logs and failure artifacts may contain sensitive model-visible content. Keep state local, protect backups, and review artifacts before sharing. The [Viewer runbook](trace-viewer.md) describes log limits and partial windows; the [failure-trace spec](../specs/responses-failure-traces.md) defines capture and retention.
