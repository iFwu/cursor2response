# Responses Runtime Trajectory

Status: current

## Scope

This specification defines the structured runtime trajectory emitted by the
Responses Agent path and the rules used to assemble it from the Sidecar and SDK
Bridge structured logs. The trajectory answers:

- which semantic inputs the SDK actually accepted;
- which Agent, Execution, and SDK Run handled them;
- which output reached the client;
- when an Agent changed, an execution failed, or context was replayed; and
- why a request was retried, reattached, rejected, or sent as full context.

The trajectory is a recent operational view over structured logs. It does
not add a recorder service, trajectory database, replay service, or long-term
conversation archive. Failure trace artifacts remain defined by
[responses-failure-traces.md](responses-failure-traces.md). Their complete
request and event bodies are outside this contract.

This contract replaces the previous request- and Run-centered trace schema.
Consumers do not translate earlier trace events, infer missing identities from
timestamps, or fall back to legacy content fields.

## Trajectory model

A **Session** is the stable caller conversation identity represented by the
full SHA-256 `sessionKey`. It spans model changes, Bridge restarts, persisted
Agent resume, Agent replacement, retries, and multiple SDK Runs. A raw caller
affinity key is never recorded. Shortened Session values are invalid because
they cannot be joined without collision risk.

A Session is a chronological event graph, not a tree of user turns:

```text
Session
|- Agent lane A
|  |- Execution 1 -> SDK Run 1
|  `- Execution 2 -> send_failed
|- Agent transition: A -> B
`- Agent lane B
   `- Execution 3 -> SDK Run 2

Inputs, outputs, replays, checkpoints, and errors are attached by stable IDs
and causal edges rather than by adjacency.
```

There is no authoritative `UserTurn` or `turnId`. User input, Tool results,
replayed context, and internal corrections are all Inputs. User input remains
more important in the display, but it does not own subsequent Runs or Tool
activity. In particular:

- Tool-result continuation remains in the existing Execution and SDK Run;
- steering may add user Input to an active SDK Run;
- multiple queued user Inputs may be merged into one `Agent.send()`;
- a retry or complete transcript carried by another HTTP request does not
  create another semantic Input; and
- replacing an Agent creates another Execution, not another user turn.

A viewer may derive a display-only interaction interval from causal links
between user Inputs and the final published Model output. That interval is not
stored as identity and cannot override the underlying event graph. One final
output may be related to multiple steering Inputs.

## Entities and identity

### Agent lane

An Agent lane contains every observed event for one exact SDK `agentId` within
the Session. The same `agentId` remains in one lane across SDK Runs and a
persisted resume after Bridge restart. A changed `agentId` creates another
lane. Model and Bridge service invocation are lane attributes, not Session
boundaries.

Every observed lane creation, resume, or replacement has an explicit
`trajectory_agent_transition`. A consumer does not infer a transition from
time proximity. If the runtime cannot provide the cause, it records `unknown`.

### Execution and SDK Run

An Execution is one attempted `Agent.send()`. The Bridge creates
`executionId` immediately before calling the SDK, then binds `runId` when the
SDK returns a Run. This preserves a failed send even when no `runId` exists.
Starting another `Agent.send()` creates another Execution. A matching Tool
result resumes the existing Execution and Run and therefore creates neither.

An Execution has exactly one terminal state: `finished`, `failed`,
`send_failed`, `cancelled`, or `superseded`.

### Input

Every SDK-accepted semantic input occurrence has one `inputId` and one source:

- `user`: user-role input, whether it starts a send or steers an active Run;
- `tool_result`: a result accepted for the matching pending Tool call;
- `replay`: context actually sent to an Agent again; or
- `internal`: an SDK-visible correction or cancellation input that is not a
  public user or Tool result.

`inputId` identifies an occurrence, not content. Two real user Inputs with the
same text have different IDs. A transparent retry, request transcript replay,
or delivery reattachment reuses or references the original ID and cannot
create a second semantic Input.

The Sidecar and protocol adapter pass candidate occurrence metadata through the request
path. The Bridge binds that metadata to the current request and ingress identity
at admission, before an Input can wait in the actor inbox. Those identities
remain attached when a steering Input is accepted later on an older active
Execution. The Bridge derives the authoritative `inputId` only when it emits
`trajectory_input_accepted`.

### Output

Every SDK-produced output occurrence has one `outputId` and one type:

- `commentary`: Agent progress or intermediate narration;
- `final`: the terminal Model answer; or
- `tool_call`: an exposed Tool invocation, including its public call ID, name,
  and normalized arguments.

An output may exist in the SDK trajectory without reaching the client. SDK
production and client publication are separate facts and are never inferred
from an Execution-level status.

### Context checkpoint

A Context checkpoint identifies the ordered semantic history used for an SDK
context decision. It contains a cryptographic `checkpointHash`, the preceding
checkpoint when known, ordered added semantic IDs, and item counts. A hash is
evidence of identity and progression; it is not a replacement for a semantic
event and does not create Session or Agent identity.

## Fact ownership

The component where a fact occurs owns its event:

- **Sidecar** records ingress attempts, transport retry lineage, and output
  handed to the public Responses response writer. These are client publication
  facts; they do not claim that the remote process received the bytes.
- **SDK Bridge** records context decisions, Agent transitions, Executions, SDK
  Runs, semantic Inputs accepted by the SDK, SDK-produced Outputs, and terminal
  errors. These are SDK acceptance facts.
- **Viewer** joins immutable events by stable IDs. It does not create runtime
  facts, deduplicate by text, repair identities, or infer causal edges from
  nearby timestamps.

Adapter-derived request classification may be carried into Sidecar or Bridge
events, but the protocol adapter is not a third semantic truth owner. The structured-log runner supplies
the observed timestamp; the business event producer owns its service invocation identity. Each producer also
supplies a unique `eventId`; related events use exact identity fields and
`causedByEventId` where an event-to-event edge is required.

## Event envelope

Every trajectory event has:

| Field | Contract |
| :-- | :-- |
| `trajectorySchemaVersion` | `1`. This is a new event family and does not imply compatibility with an earlier viewer schema. |
| `event` | One event name defined below. |
| `eventId` | Unique immutable event occurrence ID. |
| `sessionKey` | Full Session SHA-256 identity. |
| `serviceInvocationId` | Exact producer process invocation identity. |
| `clientSource` | Normalized `codex`, `openclaw`, `healthcheck`, `superconductor`, `ua:<family>`, or `unknown` display label. `ua:<family>` is a bounded, lowercase, versionless User-Agent family fallback; it is not identity. |
| `clientPlatform` | Normalized `linux`, `mac`, or `unknown` platform inferred from the User-Agent OS segment. It is display metadata, not a concrete machine identity. |
| `requestId` | Current transport attempt when one exists. |
| `causedByEventId` | Immediate causal event when applicable. |

Agent, Execution, Run, Input, Output, call, checkpoint, and parent request IDs
are added only when applicable. Missing optional identity means that an edge is
unknown; it never authorizes a time-based join.

## Request and decision events

### `trajectory_route_decision`

The opt-in [Grok hybrid route](grok-hybrid.md) records `route`, `routeCause`,
`logicalModel`, `upstreamModel`, `routeStickyHit`, `attemptIndex`,
`outputPublished`, `contextRetrySafe`, `fallbackAttempted`, and
`fallbackBlockedReason`. Observations never control routing. Fallback requests
have separate request/execution IDs under the same ingress. A `fallback_` lane
represents an external Responses upstream, not a Cursor SDK Agent. Terminal
records include observed `inputTokens`, `outputTokens`, and `cachedInputTokens`.
Diagnostic parsing failures never change forwarded bytes.

### `trajectory_request`

The Sidecar emits one event for each inbound request attempt. It records only
the structure and decision needed for investigation:

- `requestId`, optional `logicalRequestId`, and optional `parentRequestId`;
- `attemptIndex` and `requestKind` (`initial`, `continuation`, `steering`, or
  `retry`);
- `sessionSource`, naming the header family, `prompt_cache_key`, or generated
  fallback that supplied affinity without recording its raw value;
- optional `requestPurpose=compaction` when the Sidecar recognizes the exact
  OpenClaw summarization request contract; recognition is observation-only and
  fails open when the contract is absent or changes;
- `decision` (`forwarded`, `rejected`, `aborted`, or `retry_scheduled`) and a
  named `decisionCause` when the decision is not an ordinary forward;
- `transcriptItemCount`, `replayedTranscriptItemCount`, `userInputCount`, and
  `toolResultCount`;
- full public input and candidate incremental input character counts and
  cryptographic hashes;
- the authoritative checkpoint hash when provided; and
- whether the request carried transcript items already observed for the
  Session, plus `transcriptSha256` over the ordered normalized transcript.

It does not contain a request body, rendered prompt, transcript item bodies,
or semantic content. Repeating a complete public transcript therefore adds a
small request decision event rather than another User row.

For bounded journals emitted before `requestPurpose` existed, the viewer may
derive the same display label from the exact OpenClaw summarization sentinels in
accepted Input content. That projection does not modify the raw event or any
runtime identity or decision.

### `trajectory_context_decision`

The Bridge records the decision that relates a request to SDK state. Its
`decision` is one of `start_full`, `send_incremental`, `continue_run`,
`steer_run`, `reattach`, or `reject`. It carries the exact Agent, Execution,
Run, and checkpoint identities that apply, plus the selected prompt character
count and a named `decisionCause` when relevant.

Candidate incremental size from the request is supporting evidence. The
selected SDK decision and size are authoritative. A consumer does not treat a
large suffix as an error by itself.

### `trajectory_replay`

Replay and retry are first-class diagnostic events with one `replayKind`:

- `client_transcript`: an inbound request carried semantic history already
  observed for the Session;
- `transport_retry`: Sidecar or protocol adapter repeated a logical request attempt; or
- `sdk_context`: the Bridge actually supplied full context to an Agent.

The event references the original request, semantic IDs, or checkpoint and
records counts, character size, aggregate hash, source and destination Agent
or Execution when applicable, and a named `replayCause`. It never repeats the
referenced content, with the single divergence-preview exception below.

When the cause is a transcript divergence (`agent_transcript_diverged` or
`agent_provisional_transcript_diverged`), the event also localizes the fork:
`divergedItemIndex` is the first transcript item (0-based) whose hash stopped
matching, `knownTranscriptItemCount` and `clientTranscriptItemCount` are the
two compared lengths, and `divergenceKind` distinguishes `item_mismatch` (the
client sent different content at that index) from `client_history_truncated`
(the client history is a strict shorter prefix of the known transcript). For
`item_mismatch` the event carries bounded excerpts (≤200 chars each) of both
versions of the diverged item: `divergedItemPreview` is the client's current
version, and `knownItemPreview` is the previously known version when the
Bridge still holds the prompt text of the request whose hashes became the
agent's known context (an in-memory snapshot, self-validated by hash before
use — a stale snapshot degrades to no preview, never a wrong one). When both
sides are available, `divergedCharOffset` is the first differing character
within the item and both previews are windowed around it, so a one-line change
deep inside a large item is directly visible. These fields are captured at
detection time because the known per-item hashes and the prompt snapshot live
only in Bridge memory and agent state; once the Agent rotates the fork
position is unrecoverable.

The Bridge refreshes that in-memory snapshot when an ordinary tool-result
continuation adopts its authoritative checkpoint. A snapshot whose prompt
length does not match the renderer metadata is unavailable; diagnostic offsets
must not be applied to a differently prepared prompt. Snapshot failures and
divergence-description failures are observation-only and never change admission,
tool settlement, cancellation, or replay selection. Deferred steering may lack
a matching snapshot and therefore has the same no-preview fallback.

`knownItemHash` and `clientItemHash` identify the compared items when present.
`knownRequestId` identifies the snapshot's request when its old item text is
available. Previews remain sensitive local trace content, not a redacted export;
the existing 200-character ceiling applies independently to each side.

### `trajectory_context_replacement`

For an active Agent context mismatch, the Bridge captures the divergence before
settling any exposed tool batch. After successful settlement, it records this
event before cancelling or evicting the old Agent. It carries the incoming
`requestId` and `ingressRequestId`, the old `agentId`, `executionId`, `runId`, and
`previousRequestId`, the `replayCause`, `resumeToolResultsCount`,
`supersedePendingRun`, and the same available divergence fields as
`trajectory_replay`. A rejected pending-result request emits no replacement
event. The event records the replacement decision, not successful creation of
the next Agent; a later `sdk_context` replay confirms the full send and repeats
the captured detail.

Only an actual active context replacement emits this extra record. Ordinary
continuations do not log their prompt snapshots or add per-item history dumps.
Failure to write this diagnostic, including its error report, fails open.

### Replay causes

Every `sdk_context` replay has a non-null cause. The current causes are defined
by [Responses Steering Turns](responses-superseding-turns.md#full-replay-fallback),
including first use, missing or dirty persisted state, model or context
mismatch, cancellation, authentication recovery, retryable SDK failure,
unmatched Tool results, and empty-turn recovery.

`client_transcript` records that content was present on the wire; it does not
claim that the Bridge resent that content to the SDK. `sdk_context` is the
corresponding authoritative fact when a full SDK send occurred.

### `trajectory_observation_error`

The Sidecar or Bridge emits this diagnostic when a best-effort trace operation
such as hashing, identity derivation, serialization, or journal preparation
fails. It carries only an observation `scope` and stable `errorCode`. This event
does not describe a business request failure and must not be used to infer that
SDK admission, Tool delivery, streaming, or terminal state failed.

## Agent and execution events

### `trajectory_agent_transition`

The Bridge records `transitionKind` (`created`, `resumed`, or `replaced`),
source and destination Agent, service invocation, and model identities, and a
named `transitionCause`. Persisted resume uses the same Agent lane and records
`resumed`; replacement uses different Agent IDs. Failure, context divergence,
model switch, explicit cancellation, and retry recovery remain distinct
causes.

### `trajectory_execution_started`

The Bridge emits this event immediately before one `Agent.send()`. It records
`executionId`, `agentId`, accepted or replayed `inputIds`, selected checkpoint,
prompt mode (`full` or `incremental`), and request identity.

### `trajectory_execution_attached`

When `Agent.send()` returns a Run, the Bridge binds `executionId` to the exact
`runId`. A request attaching to an active or latched Execution also uses this
event with `attachmentKind=continuation` or `reattach`; it does not start
another Execution.

### `trajectory_execution_terminal`

The Bridge records `executionId`, optional `runId`, terminal status, duration,
and structured failure code and phase when applicable. Raw provider messages
are excluded by default. `send_failed` is valid without a Run ID.

### `trajectory_error`

An explicit semantic, transport, state, or publication failure is a separate
event linked to the affected request, Agent, Execution, Run, Input, or Output.
It records a stable error code, phase, retryability, and whether the error was
terminal. A viewer does not declare a failure merely because a terminal event
is outside the observed log window. A Run may be waiting on a Tool result.

Expected request cancellation may use `errorCode=cursor_sdk_cancelled` in the
Sidecar publication phase. It remains terminal for that request and is never
retryable, but viewers classify it as a notice rather than a failure. Client
disconnects and manual cancellation do not create failure trace artifacts.

## Semantic content events

Semantic content is recorded once per occurrence and subsequently referenced
by ID. Content hashes do not serve as occurrence identity.

### `trajectory_input_content_chunk` and `trajectory_input_accepted`

The Bridge emits bounded chunks for one Input only when that Input first
becomes SDK-accepted in the observed trajectory. Chunks carry `inputId`,
source, content part and chunk indices, content type, and the full content hash.
`trajectory_input_accepted` closes the acceptance fact and links the Input to
the accepting Agent, Execution, Run, originating request, and checkpoint. A
queued steering Input retains its own request identity rather than inheriting
the request that started the pending Execution.

A matching Tool result is recorded only after batch ownership validation and
actual callback delivery. Unmatched, rejected, ignored, or duplicated results
remain request or error diagnostics and never become accepted semantic Input.

Trace metadata is observational. The Bridge recomputes content hashes and
lengths from the received business content and never rejects SDK admission
because an upstream trace hash, length, or checkpoint is missing or stale.
Invalid trace-only entries may be omitted from the journal, while the original
user Input or Tool result continues through the normal execution path.

Replayed content normally references existing semantic IDs. If a journal
window first observes content during a real SDK full replay, it may record that
content once with `source=replay`; later replays reference it. It must not be
presented as a new user Input.

### `trajectory_output_content_chunk`

The Bridge emits bounded chunks for one SDK-produced Output. Chunks carry
`outputId`, output type, Agent, Execution, Run, content part and chunk indices,
and the full content hash. Tool calls additionally carry the public `callId`,
Tool name, and argument content kind. Commentary and final Model output remain
separate Outputs and are never concatenated across a Tool call or Agent lane.

### `trajectory_output_published`

The Sidecar emits this event only after the corresponding public Responses
payload is handed to its HTTP response writer. It references `outputId` and the
published chunk or completion boundary. `publicationKind=completed` marks a
complete final Model output. This is the strongest publication fact available
at the service boundary, not proof that the remote process consumed the bytes.
A disconnect may therefore leave an SDK Output with no publication event or
with only a published prefix.

The Bridge event timestamp represents SDK acceptance; the Sidecar publication
event timestamp represents client publication. An Execution-level success
cannot substitute for either fact.

### `trajectory_context_checkpoint`

The Bridge emits a checkpoint only when accepted semantic history advances or
when a context decision needs to identify selected state. It records
`checkpointHash`, optional `previousCheckpointHash`, ordered
`addedSemanticIds`, total item count, Agent and Execution identity, and whether
the checkpoint is authoritative or provisional.

Repeated requests that do not advance context reference the checkpoint hash
and do not emit another equivalent checkpoint body.

## Content and retention boundary

Each semantic content occurrence is capped at 128 KiB across its chunks. When
the source is larger, the event records `truncated=true`, observed byte count,
and a hash of the complete source. The normal trajectory never records:

- a complete Responses request body;
- a complete rendered prompt or arbitrary SDK event object;
- raw authorization headers or `User-Agent` values; or
- failure trace artifact bodies.

User input, Model output, Tool arguments, and Tool results may contain secrets
or project data. Viewer masking is a presentation safeguard only: the browser
has already received allowed content. The viewer has no authentication layer
and must remain on loopback or a trusted private network.

The live source is the local Sidecar and Bridge structured log directory. The runner wraps each line with `MESSAGE`, `__REALTIME_TIMESTAMP`, `service`, `stream`, and optional `tracePartial` metadata. Observation timestamps do not replace producer-owned invocation or causal identities. Each service has an independent active file and bounded rotation; the Viewer reads only the known service filenames and rejects symlinks.

The runner must keep observation off the business backpressure path. Bounded queue or line overflows may drop records; the next recorded envelope marks the gap. File-write failures disable file logging for that runner process while business execution continues. A stalled console consumer must not stall the child service.

A Session whose first causal event or referenced semantic content is outside the selected window is marked `partial`. Missing, truncated, or unreadable source files and explicit drop markers also make the returned source and Sessions partial. Missing history is not reconstructed from hashes, request bodies, or failure artifacts. Imported journald exports remain read-only snapshots and do not require journald for live operation. See the [Viewer runbook](../runbooks/trace-viewer.md) for retention and read ceilings.

## Viewer projection

The viewer groups by Session, preserves chronological order, and places events
in Agent lanes. Causal edges and transition markers connect lanes without
reordering events by Agent. The default projection uses these priorities:

1. User input and complete final Model output published to the client.
2. Errors, Agent transitions, SDK-layer replay, transport retry, and
   exceptional context decisions.
3. Agent commentary.
4. Tool calls and accepted Tool results.
5. Ordinary request metadata, routine context decisions, per-request client
   transcript confirmations, checkpoint details, hashes, timing, and usage.

User input remains a prominent timeline anchor. Commentary remains visible but
is visually subordinate to final output and diagnostic transitions. Adjacent
commentary may be collapsed only within one Agent, Execution, and uninterrupted
phase; a Tool call is a hard boundary. Tool arguments and results are compact
and collapsed by default.

The primary display groups anchors by Execution. Initial user input, later
steering input, and a top-level `<turn_aborted>` control marker accepted by the
same active Execution appear in one interaction interval in acceptance order.
The marker is rendered as its own control anchor, while the following user input
is labeled as steering. The latest terminal state for the grouped Execution
determines whether the interaction is running, completed, failed, or cancelled;
the number of input anchors does not create additional running states.

A viewer may decompose one accepted user Input into a Harness context part and
a real user text part for display. The decomposition is display-only: it never
creates or removes an Input occurrence, changes recorded hashes, or re-anchors
the accepted fact, and both display parts reference the same Input. It is gated
by the observed `clientSource` and matches only exact wrappers that client is
known to emit (Codex AGENTS instructions and environment-context items;
OpenClaw runtime-context delimiter blocks and the leading inbound-metadata
envelope). Codex wrappers are also matched for `superconductor` and when the
source is unidentified, because gateway forwarding can rewrite the client
identity while the wrapper shape stays distinctive. Unrecognized content stays
user input. Harness
context never anchors a user turn and never provides the Session title.

Only `final` Output with a complete `trajectory_output_published` fact is
presented as the final client result. SDK-produced but unpublished commentary
or Model output stays in its Agent lane and is marked provisional. Failed,
cancelled, and superseded Executions remain visible.

SDK-layer replay, transport retry, and exceptional context decisions appear in
the main timeline, not only in raw details. A replay row names the layer,
cause, parent request or checkpoint, old and new Agent or Execution when
applicable, size, and hash. It references semantic content rather than
reproducing it.

A `client_transcript` replay fact is different: on a stateless client protocol
every request carries the full history, the Bridge matches it against known
context, and nothing is re-fed to the SDK. This per-request confirmation is
recorded for every request and is therefore ordinary metadata in the
projection, never a prominent replay row and never an anomaly signal by
itself. Routine context decisions that describe the default path
(`send_incremental`, `continue_run`, `steer_run`, `reattach`, and `start_full`
itself) are also ordinary metadata; an actual full replay is already
prominent through its paired `trajectory_replay` row.

The raw event view may show other normalized journal records, but only current
`trajectorySchemaVersion: 1` events construct the trajectory. The viewer keeps
only the trajectory field allowlist in browser-visible details so unrelated
journal fields cannot leak through an imported record. Unknown event names do
not create semantic rows.

## Conformance cases

- One user Input followed by any number of Tool-result continuation requests
  produces one User row and one accepted Input occurrence.
- Two real, identical user messages produce two Input IDs and two User rows.
- Steering input and a `<turn_aborted>` marker retain their originating request,
  share the active Execution interval, and do not create duplicate running
  interaction states.
- An HTTP retry and a complete transcript replay add request and replay
  diagnostics without copying semantic content.
- A full SDK context replay records its cause, checkpoint, source and
  destination Agent, and selected size without duplicating known Inputs.
- A matched Tool result attaches to the pending Execution and Run; an
  unmatched or rejected result never enters semantic Input.
- `Agent.send()` failure before Run creation leaves a terminal Execution with
  `send_failed` and no `runId`.
- Agent replacement preserves both lanes, the explicit transition, every
  failed or provisional Output, and the replacement result.
- Commentary and final output remain distinct across Tool and Agent
  boundaries.
- SDK-produced output without Sidecar publication remains visible as
  provisional and is never presented as the final client answer.
- A Bridge restart and persisted resume continue the same Agent lane and add a
  `resumed` transition.
- Journal truncation or a time-window boundary marks the Session `partial`
  without guessing missing content or terminal state.
- Legacy trace events do not create trajectory entities or content.
