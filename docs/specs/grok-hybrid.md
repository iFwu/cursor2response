# Grok Hybrid Responses Routing

Status: current

## Identity And State

Models `grok-hybrid` and `grok-hybrid-fast` enable this policy on local
Responses. The SDK primary is `grok-4.6`; the base variant defaults to
`fast=false`, while the `-fast` variant requests `fast=true`. An incoming
`fast=true`, `service_tier=priority/fast`, or `cursor_fast=true` request also opts
into fast mode, and `cursor_params.fast` remains the final explicit override.
Other models and OpenClaw are unchanged by this routing implementation.
Fallback is a configured
Responses endpoint. Prefer native upstream Responses over protocol translation;
the public endpoint name alone does not establish the upstream protocol.

The same `-fast` convention applies to direct Cursor Grok requests: the base
model defaults to `fast=false` and `cursor-grok-fast` selects `fast=true`. Bracket parameters such as `[fast=true]` remain supported
for low-level callers and diagnostics. OpenClaw model entries should expose
both variants with an effective `contextTokens` that matches the end-to-end
route, rather than the primary SDK ceiling alone.

Requests require full public history and the existing session-affinity resolver:
header precedence and `prompt_cache_key` fallback are unchanged. Generated
identities, `previous_response_id` and native SDK `system_prompt` overrides are
rejected. SDK input checks still apply before routing; opaque provider state
is not migrated.

Route markers isolate resolved Cursor credential, logical model, working
directory and resolved session key, independently of SDK Agent/trace IDs.
Only confirmed `cursor_sdk_context_compacted` arms fallback. Generic 413,
authentication, timeout, rate-limit and model failures do not.

Persist the marker before fallback, even when current recovery is unsafe. Later
same-identity requests use fallback, including after an upstream failure or
restart. There is no automatic switch back. New session identities start on
SDK; a harness changing affinity on compaction also creates a new routing
identity. Do not strip suffixes or guess session families.

Files contain version, route and time; names hash the routing identity.
Directory/file creation modes are 0700/0600 with atomic rename. Unreadable or
invalid state fails explicitly. Markers do not expire; operators can retire
files for confirmed closed sessions. There is no public reset endpoint.

## Client Context Budgets

Client window settings control harness compaction; they do not expand the SDK
conversation budget. Cursor injects system instructions, rules and dynamic tool
context outside the public prompt. The adapter currently reports input usage
using a character estimate, so public input tokens and SDK checkpoint tokens
must not be treated as the same measurement.

A successful single long-text request does not establish a safe multi-turn tool
window. Hybrid clients may choose a larger budget to continue on the configured
fallback after SDK overflow. Such budgets depend on upstream capacity and tool
schema compatibility, and do not change the recovery admission rules below.
The [model-visible input accounting contract](responses-agent-context-affinity.md#model-visible-input-accounting)
applies to the SDK primary regardless of model variant. Exact SDK context measurement is not currently available.

## Recovery

HTTP 409 `cursor_sdk_tool_result_pending`, `cursor_sdk_tool_result_batch_mismatch`
and `cursor_sdk_tool_result_unmatched` never trigger fallback or persist a route
marker, including when wrapped in an error cause chain. Rejected admission does
not terminate the previous Run or prove that its exposed tools had no side
effects. No output in the current request proves neither cleanup nor complete
tool history. The cancellation helper and its HTTP success response do not
provide that proof; batch matching must remain enforced.

Internal `contextRetrySafe` is true only after cancellation of the captured,
already-attached Run and awaited Agent disposal succeed within the cleanup
deadline. Missing ownership/attachment, cleanup failure or deadline leaves it
false. Internal HTTP/NDJSON error delivery waits for this barrier. Public errors
remain `413 context_length_exceeded`.

Only an un-aborted request with that proof and no started public output may
perform one fallback attempt. Hybrid SSE defers the SDK `response.created`
preamble until output starts, preserving one coherent Response identity.
After publication starts, or with unconfirmed cleanup, preserve current error
behavior. OpenClaw may still compact on that error; manual-continuation
signaling is not implemented. Client tools are not undone or replayed; the
authoritative history preserves their public call IDs and results.

Fallback receives the original parsed body with only `model` replaced. JSON and
complete valid SSE frames, actual response model, IDs and usage pass unchanged. Use only the
dedicated configured credential, never the Cursor bearer or arbitrary inbound
headers. Reject redirects. Caller abort and a bounded deadline cover headers
and body. Fallback failures never retry against SDK.

SDK-generated Responses retain the adapter's own assistant phase mapping.
Fallback phases are preserved without inference or rewriting. Missing native
upstream phases belong in the upstream gateway's explicit compatibility policy,
not in this transparent relay.

### Fallback Stream Termination

Both initial recovery and sticky fallback use the same protocol relay before
best-effort observation. It publishes complete SSE frames immediately without
buffering the whole response. It retains only an unfinished frame (limited to
16 MiB), preserving UTF-8 and LF/CRLF/CR framing across transport chunks.

An upstream read failure or EOF without a Responses terminal event discards the
unfinished frame and emits one `response.failed`, using the last published
upstream Response identity/model and a sequence number above the observed
sequence. If no upstream identity was received, the failure receives a local
Response ID. It never fabricates completion, repeats a tool, retries a request,
or emits a second `response.created`. An already published terminal event is
not contradicted by another failure on a later transport error.

Failures remain observable as `hybrid_fallback_stream_failed`,
`hybrid_fallback_missing_terminal`, `hybrid_fallback_invalid_stream`, or
`hybrid_fallback_frame_too_large`. Malformed JSON frames and frames over the
protocol bound fail explicitly; unknown valid events pass through. This
protocol parsing does not reuse or depend on trajectory parsing. JSON/non-2xx
responses are unchanged. Consumer cancellation cancels the upstream reader.
This handles upstream body failures while the Sidecar/downstream connection is
still usable; it cannot repair a Sidecar crash or downstream network break.

## Observation And Verification

`trajectory_route_decision` records logical/actual model, route, cause, sticky
hit, attempt index, publication state, cleanup proof and blocked-retry reason.
SDK/fallback attempts share ingress identity. Fallback has a distinct request
and execution; its `fallback_` lane is an external provider, not a Cursor Run.
Inputs, text/tools, publication, terminal outcomes and usage use the existing
viewer. Exclude URLs/credentials. Bounded observation parsing/writes fail open
without altering forwarded bytes or route decisions. The first overflow that
persists a fallback marker also sends a short `notify-send` warning with session
identity, a short user-visible prompt prefix, and the Responses request id as `traceId`; sticky reuse stays quiet. The notify source remains `cursor2response`.
The prefix comes from the latest visible user message in the complete request
history, including on tool-result continuations with no newly added user input.
Internal context, tool outputs and image payloads are excluded.
`CURSOR2RESPONSE_GROK_HYBRID_NOTIFY=0` disables it. Notification failure is ignored.

Automated checks cover both response modes, recovery/rejection, old Bridge
errors lacking proof, persistence, session/credential/directory isolation,
generic errors, cancellation, tool history and observation failures.

```sh
node dist/runtime/scripts/validate-grok-hybrid.js --env-file /path/to/private/hybrid.env
```

The check injects safe pre-output SDK overflow, then performs five serial real
fallback tool calls with growing history and reports warm cache hits. It does
not prove a genuine SDK ceiling reproduction, OpenClaw acceptance or maximum
upstream context capacity.

Validate the selected native Responses route independently with:

```sh
node dist/runtime/scripts/validate-responses-phases.js --key-file /path/to/private.env \
  --base-url https://gateway.example/v1 --model upstream-grok-model --require-commentary
```

This check performs five serial fictional tool calls and a final receipt summary.
It records raw SSE privately, reports warm cache hits, and requires any emitted
pre-tool text to carry matching commentary phases in item-done and completed
output. A run with no pre-tool text is inconclusive, not proof of phase support.
