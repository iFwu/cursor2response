# Runtime Trace Viewer

Status: operational runbook

## Scope

The runtime trace viewer is a local investigation surface for the structured
Sidecar and SDK Bridge structured logs and exported trace files defined by
[Responses runtime trajectory](../specs/responses-runtime-trace-signatures.md).
It groups records by Session and assembles a chronological event graph across
Agent lanes, Executions, SDK Runs, inputs, outputs, replays, context decisions,
and errors.

The `当前状态` tab reads an authenticated, metadata-only Bridge `/runtime`
snapshot through the viewer's `GET /api/runtime` proxy. It shows the Bridge's
current in-memory state independently of the selected log or trace file.
Historical log records do not determine whether a Run is currently pending.

The viewer is an aggregator, not a runtime truth owner. SDK-accepted facts come
from Bridge trajectory events and public response-writer facts come from
Sidecar trajectory events. The viewer joins exact IDs and never creates a User
turn, deduplicates by text, or infers Agent and Run relationships from
timestamps.

The default data source is the live log for the last six hours. The viewer
does not change request processing or maintain a trace database. Semantic
content is recorded once per accepted occurrence; repeated transcript and
request material is represented by request lineage, counts, hashes, checkpoint
references, and decisions. Complete rendered prompts and request bodies remain
excluded. Failure trace artifacts are reduced to metadata and are not used to
fill trajectory gaps.

## Start

Install the repository dependencies and start the production build:

```bash
npm ci
npm run trace:viewer
```

The standalone default address is `http://127.0.0.1:4319`; Compose publishes `http://127.0.0.1:8100`. To expose it on a trusted
private network:

```bash
CURSOR2RESPONSE_TRACE_VIEWER_HOST=0.0.0.0 npm run trace:viewer
```

The server has no authentication layer. Tool fields that look like secrets are
masked in the interface until explicitly revealed, but this does not prevent a
client with viewer access from reading the API response. Do not bind it to an
untrusted network.

The default trace directory is
`${XDG_STATE_HOME:-~/.local/state}/cursor2response/traces`. Override it with
`CURSOR2RESPONSE_TRACE_VIEWER_DIR`. The viewer creates the directory with mode
`0700`; browser imports are stored as unique files with mode `0600`.

Supported inputs are `.jsonl`, `.ndjson`, `.log`, `.json`, `.json.gz`, and
`.rejected.json`. Each line may be a structured runtime record or a journald
JSON envelope whose `MESSAGE` contains the structured record. The default file
limit is 32 MiB and can be changed with
`CURSOR2RESPONSE_TRACE_VIEWER_MAX_BYTES`.

Live log windows are fixed to `1h`, `6h`, `24h`, `3d`, or `7d`. The Viewer reads the shared directory configured by `CURSOR2RESPONSE_TRACE_LOG_DIR`, defaulting to `${XDG_STATE_HOME:-~/.local/state}/cursor2response/logs`.

Run API and Bridge through `scripts/structured-log-runner.mjs` as shown in the [deployment runbook](local-deployment.md). Each service writes its own `bridge.jsonl` or `sidecar.jsonl` and rotated files. `CURSOR2RESPONSE_TRACE_LOG_MAX_BYTES` defaults to 16 MiB per file, and `CURSOR2RESPONSE_TRACE_LOG_FILES` defaults to four files per service including the active file (maximum 16). `CURSOR2RESPONSE_TRACE_VIEWER_LOG_MAX_BYTES` defaults to a 128 MiB read ceiling. The source API is `/api/logs?since=6h`.

Logging failures do not block service requests. Rotation bounds retained history; truncated reads, dropped records, and read failures can make a session partial. Do not assume a selected seven-day window contains seven days of retained events. Imported journald envelopes remain readable without a host `journalctl` dependency.

The runtime proxy resolves its Bridge URL from
`CURSOR2RESPONSE_TRACE_VIEWER_BRIDGE_URL`, then `CURSOR_SDK_BRIDGE_URL`, then
`http://${CURSOR_SDK_BRIDGE_HOST:-127.0.0.1}:${CURSOR_SDK_BRIDGE_PORT:-8792}`.
A trailing `/sdk` is removed before appending `/runtime`. The server loads
these settings and `CURSOR_SDK_BRIDGE_TOKEN` from its environment, with missing
values filled from the repository `.env` and then the working directory `.env`.
Only the server sends the token as Bearer authentication; it never includes
the token or upstream response errors in browser responses. The browser cannot
select an upstream URL. Runtime requests reject redirects, time out after three
seconds, and accept only the versioned snapshot's allowlisted identity, timing,
count, and status fields. Tool arguments, results, prompts, and credentials are
excluded. Invalid or unavailable snapshots return HTTP 503 with an explicit
error, independently of the historical trace APIs.

The viewer consumes the current trajectory event family only. It does not
translate legacy semantic trace events or accept an older API schema during a
non-atomic update. Restart the viewer after deploying a schema change. A
log window crossing the deployment boundary may produce a partial Session;
that boundary is shown rather than reconstructed.

## Use

`时间线` retains the log and imported-file investigation view. `当前状态`
shows Agents, active Runs, Runs waiting for tools, and Runs without a Subscriber.
The current state table supports phase and identity filters. Each Run shows
its waiting or running duration, pending tool count, lease time remaining, and
Subscriber attachment. Expanded rows include full causal IDs, pending tool
call IDs, the original waiting start, and lease expiry. Waiting duration uses
the Bridge's `waitingSince`; lease renewal does not reset that duration.

The default pending lease is 65 minutes. The panel shows the effective Bridge
setting and cleanup timeout, not a frontend constant. A lease is the bound for
a parked Run retained between HTTP requests; it is not a per-tool execution
timeout. The latest 64 cancelled, expired, or failed Runs show their exact
error codes, along with process-lifetime cancellation, lease expiry,
authentication failure, and cleanup failure counters. A Bridge restart resets
this in-memory history; the invocation ID and startup time identify that
boundary.

Runtime snapshots refresh every five seconds only while that tab and browser
page are visible. Manual refresh is also available. When a refresh fails, the
panel retains and marks the last successful snapshot as disconnected and
stale; it never presents an unavailable Bridge as zero active Runs. Snapshots
older than 15 seconds are also marked stale. Session links switch to the
historical timeline with the full Session ID, and report a missing Session
when the selected log window does not contain it. The `tab=runtime` URL
parameter opens the current-state tab without changing the selected Session.

`Live logs` is the default source. The source menu changes its fixed time
window, opens files already present in the trace directory, or imports another
trace. Dropping a file anywhere over the page also imports and opens it.

The Session list is ordered with active Sessions first, then by latest
activity. It can be filtered by active, anomalous, failed, or partial status.
Selecting a Session opens one chronological timeline with Agent lanes. Agent
creation, persisted resume, replacement, model change, and failed Execution
boundaries remain visible without splitting the conversation into separate
Sessions.

The default `重点事件` projection uses this order:

1. User input and the complete final Model output published to the client.
2. Errors, Agent transitions, SDK replay, transport retry, and exceptional
   context decisions.
3. Agent commentary.
4. Tool calls and accepted Tool results.
5. Ordinary request metadata, routine context decisions, per-request client
   history confirmations, checkpoint details, hashes, timing, and usage.

User input is a visual anchor, not an owning Turn. A matching Tool result stays
on the active Execution and SDK Run. Steering user input may appear inside an
active Run, and several user inputs may causally lead to one final output.

Client harnesses (Codex, OpenClaw) wrap or accompany real user text with
injected instructions and metadata. The viewer shows those parts as secondary
`Harness 上下文` rows inside the turn instead of user anchors; the turn anchor
and the Session title come from the real user text only. The underlying
accepted Input is unchanged and stays one fact in the raw event view.

Published final Model output is visually distinct from intermediate
commentary. SDK output that did not reach the client remains in its Agent lane
as provisional. Consecutive commentary may be collapsed only within one Agent,
Execution, and uninterrupted phase. Tool calls split commentary phases; Tool
arguments and results are collapsed by default.

SDK replay and transport retry are always available in the main investigation
timeline. A replay row shows its layer, cause, affected Agent or Execution,
context size, and checkpoint hash. It references known semantic content and
never prints another User row for a repeated transcript.

Client transcript replay is a separate fact and is intentionally quiet: a
stateless client (OpenClaw, Codex over Responses) resends its full history on
every request — including every tool round-trip inside one turn — and the
Bridge matches it without re-feeding anything to the SDK. These per-request
confirmations appear only in `全部事件` and the raw view. Each turn instead
shows one `SDK 上下文` digest line summarizing full sends (with causes),
incremental reuse, and client history confirmations, so whether prior
prompt/context/tools actually had to be replayed is visible at a glance.

The timeline modes are `重点事件`, `异常`, and `全部事件`. `异常` keeps explicit
errors, failed Executions, Agent transitions, SDK replay/retry recovery, and
exceptional context decisions. `全部事件` adds normalized request, routine
decision, client history, and checkpoint records without promoting them to
semantic content.

Long content is collapsed. Selecting an event opens the fixed detail panel;
causal IDs link to parent request, Agent, Execution, Run, Input, Output, Tool
call, and checkpoint records. Source event links jump to the normalized raw
record. `j`/`k` moves the selection, `/` focuses search, and `Escape` closes the
detail panel.

Each event carries a waterfall mark within the Session range. Time ordering is
preserved across lanes, while exact causal edges come from IDs rather than
timestamp proximity. Search matches semantic content, Tool names, error and
decision codes, and request, Agent, Execution, Run, call, checkpoint, or
Session IDs.

Live logs data refreshes with the toolbar's refresh control. If the
selected window omits the Session start, a
referenced event, or semantic content required by a visible edge, the viewer
marks the Session `partial`. It does not treat missing terminal records as
failure because an Execution may be active, waiting for a Tool result, or
outside the selected window.

## Development And Verification

Run the API server in one terminal and the Vite development server in another:

```bash
node tools/trace-viewer/server.mjs
npm run trace:viewer:dev
```

The Vite server proxies `/api` and `/health` to the API server on port `4319`.
Before handing off viewer changes, run:

```bash
npm run trace:viewer:typecheck
npm run trace:viewer:build -- --outDir /tmp/cursor2response-trace-viewer-check
npm run trace:viewer:test
curl --fail http://127.0.0.1:4319/health
```

The isolated build avoids overwriting `tools/trace-viewer/dist` while a local
service may be serving it. Build to the configured production output only as
part of an authorized deployment. Before runtime-panel acceptance, check a
waiting Run, an empty successful snapshot, an unavailable Bridge, and a
previously successful snapshot followed by a connection failure on desktop and
mobile. Browser checks should also confirm that switching back to the timeline
stops runtime polling and that full Session links preserve identity.
