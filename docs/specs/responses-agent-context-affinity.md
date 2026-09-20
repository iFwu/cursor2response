# Responses Agent Context Affinity

Status: current

## Scope

This spec defines when the Responses path may reuse a Cursor SDK Agent and how
it derives the missing prompt suffix from a complete Codex or OpenClaw
transcript. Tool-result ownership remains defined by
[sdk-tool-continuation.md](sdk-tool-continuation.md), and active steering remains
defined by [responses-superseding-turns.md](responses-superseding-turns.md).
SDK credential handling, cancellation ownership, and pending leases are defined by
[sdk-executor-lifecycle.md](sdk-executor-lifecycle.md).

## Agent identity

The Agent cache key remains the SHA-256-derived identity of API key, model,
working directory, and external session key. Context hashes never create a
parallel actor or become part of the public session identity.

Each context-aware Agent epoch also stores:

- `bootstrapFingerprint`: SHA-256 of the effective rendered prefix through the
  `INPUT:` header, including the internal Responses directive and normalized
  top-level `instructions`. When `system_prompt` is a string, the fingerprint
  hashes canonical JSON containing that prefix and the exact native system
  prompt instead;
- `transcriptItemHashes`: ordered SHA-256 hashes of the latest
  adapter-authoritative public transcript accepted by that Agent;
- `provisionalTranscriptItemHashes`: the same checkpoint extended by public
  assistant and tool-call output observed from the SDK after that accepted
  transcript.

The Bridge also retains `systemPromptFingerprint`, SHA-256 of the exact native
system prompt or `null` for the SDK default. It is checked for cached, active,
and persisted Agents, including callers without Responses context metadata.
Changing, disabling, or omitting a previously supplied prompt replaces the Agent under the
same actor with replay cause `agent_bootstrap_mismatch`. Clean persisted state
stores only this fingerprint, and pre-extension state implies the SDK default.
Neither prompt identity creates a new cache key.

## Native system prompt

Responses accepts optional `system_prompt`: `false` disables the native override,
while a non-empty string is forwarded verbatim to SDK `AgentOptions.systemPrompt`
on both create and resume. Disabling normalizes to omission of the SDK option,
so it requires no native system-prompt permission. This is
an explicit local SDK Bridge extension: it replaces the main Agent's entire
Cursor system prompt. It does not append to the SDK default, affect subagent
prompts, or replace the independent tool schema channel. Server-side account
permission can reject the option. SDK 1.0.31 reports its account gate as
`[invalid_argument] unknown option '--system-prompt'`; the Bridge exposes this
as `400 cursor_sdk_system_prompt_unavailable`, with no automatic replay. The
caller can explicitly disable the override using `system_prompt: false`.
An environment without the local SDK Bridge rejects a native prompt string with
`400 unsupported_parameter`.

Existing Responses `instructions` remain in the rendered conversation prefix.
The native system prompt is not appended to conversation text, echoed in
response metadata, or recorded in Bridge runtime metadata. Clients must send
the same `system_prompt` on every request and tool continuation that reuses the
Agent. Omission and `false` both select the SDK default. Blank strings and other
non-string values, including `true` and `null`, return
`400 invalid_request_error` at the public endpoint.

Model remains part of the cache key. A model A -> model B -> model A sequence
therefore retains independent A and B checkpoints. Returning to A sends only
the transcript items produced while B was active and the latest user turn.

## Canonical transcript

The shared Responses renderer derives one canonical value per rendered item:

- message: role, rendered text, and attached-image count;
- function or custom tool call: public call ID, name, and normalized arguments;
- function or custom tool output: public call ID, rendered output, image count,
  and error state;
- other visible item: normalized JSON without root transport ID or status.

Reasoning items and `additional_tools` are not transcript checkpoints because
they are excluded from the Cursor conversation prompt or supplied through the
SDK tool channel. Object key order, generated item IDs, and completion status
do not affect the hash.

The renderer records the character offset and image count of each item in the
full prompt. Output constraints remain after the transcript boundary and do
not participate in Agent identity.

Responses clients preserve the order of the model's `response.output` items
when replaying history and append each `function_call_output` after that
ordered output. The adapter's rendering of the replayed `input` is therefore
the authoritative public transcript order. SDK event arrival or callback
delivery order cannot override it.

## Model-visible input accounting

These invariants apply to every model using the Responses SDK path, including
full-history reconstruction, incremental sends and active-run steering.

Each historical tool output has one model-visible `TOOL RESULT` record containing
its complete rendered output, public `tool_call_id`, known tool name and explicit
`is_error=true` when applicable. Arguments appear only in the tool-call record.
The adapter must not append an SDK-shaped feedback copy of those arguments or
results, transform arbitrary client output into inferred built-in results, or
truncate it. Images remain attachments rather than repeated data URLs in text.

An active tool continuation delivers the raw result once to its owned SDK
callback. It must not also append that same output as conversation text to the
same run. A full replay on a replacement Agent reconstructs the accepted history
once for that Agent; it does not authorize sending a second representation of an
item within that prompt. Hashes, trace records and other observation metadata
are not additional model-visible input channels.

Incremental sends omit the stable bootstrap and accepted history. Active
steering also excludes already queued user items, as specified in
[Responses Steering Turns](responses-superseding-turns.md#actor-inbox).
New instructions, output constraints, error states, abort markers and images
remain subject to their existing delivery and Agent replacement contracts.
Deduplication must not erase intentionally repeated content in distinct public
items or weaken the exact ordered-prefix check.

A renderer change that alters the model-visible representation of accepted
history must also update its effective bootstrap so incompatible completed
Agents use the existing bootstrap-mismatch full replay. Pending callbacks retain
their existing batch-ownership and settlement rules.

Acceptance checks compare the authoritative input, rendered prompt and actual
SDK send or callback content for the same request and Agent. Counting Agent
creation or full replays alone cannot rule out duplication within one prompt.
Length comparisons must use the same unit and clearly separate adapter input,
SDK-owned context and cumulative usage. Character counts and Run-total usage
must not be reported as exact current-context token counts.

Regression checks must verify that a large result and its call arguments each
have one representation, preserve raw JSON/error/image content, and ensure a
cumulative steer or delivery retry does not resend an accepted or queued suffix.
The maintained checks are in [Responses preparation tests](../../core/openai.test.ts)
and [native steering tests](../../bridge/native-steering.test.mjs); they inspect
prepared or delivered content rather than only the presence of a feedback marker.

## Prompt selection

A cached or clean persisted Agent accepts another send only when:

1. its bootstrap fingerprint equals the current fingerprint; and
2. its stored transcript hashes are an exact prefix of the current hashes.

The authoritative checkpoint determines whether the client remains on the
accepted public branch. For a new turn, the provisional checkpoint must also
be an exact prefix of the current transcript because it represents history
that may already exist inside the Cursor Agent. The Bridge slices only after
that provisional checkpoint. The sliced prompt prepends `INPUT:`, retains
current output constraints, and adds an image marker for missing items only.
The Sidecar's legacy latest-assistant heuristic is not authoritative for
context-aware requests.

The active-run exception is a validated superseding turn containing a
model-visible `<turn_aborted>` marker. Once the marker and new user suffix are
annotated onto the actual callback, that delivered correction establishes the
new logical branch and its adapter-authoritative checkpoint. This exception is
limited to the same actor and active pending Run; it does not apply during
cached or persisted Agent selection.

An equal authoritative transcript does not create a new turn, including when
the provisional checkpoint is longer or divergent. A pending run keeps
an immutable copy of its accepted input checkpoint. A retry matching that
checkpoint, or the current latched delivery checkpoint, reattaches without
starting another send. Otherwise the Bridge returns HTTP 409
`cursor_sdk_transcript_not_extended` without closing the Agent.

A bootstrap mismatch produces replay cause `agent_bootstrap_mismatch`. Any
edit, revert, shortening, branch change, or compacted replacement that breaks
the exact prefix produces `agent_transcript_diverged`. A cached or persisted
Agent without context fields produces `agent_context_missing`. When the
authoritative checkpoint is a strict prefix but the provisional checkpoint is
not, the cause is `agent_provisional_transcript_diverged`. Each cause replaces
the Agent epoch under the same actor and sends the authoritative full prompt.
The Bridge does not attempt LCS, arbitrary diff repair, or similarity matching.

## Active runs

Starting a send records both the accepted input checkpoint and the latest
adapter-authoritative checkpoint on the pending run. The Bridge may extend a
separate provisional checkpoint from assistant text and exposed tool calls for
delivery retry and internal correction bookkeeping. On admission of an ordinary
new turn, provisional hashes prevent reuse when the Agent may contain output
that the adapter-authoritative transcript did not accept. A validated active-run
`<turn_aborted>` correction instead makes that provisional segment model-visible
as aborted before advancing the authoritative checkpoint.

Successful terminal delivery acknowledges the pending output but does not
promote its provisional checkpoint to authoritative state. A terminal state is
persisted as clean only after that acknowledgement. The next protocol adapter context is
the only authority that can confirm whether delivered output entered the
public transcript.

Matched outer tool-result continuations validate batch ownership against
public call IDs, compare the request only with the last authoritative
checkpoint, and then adopt the adapter's current checkpoint. The Bridge does
not rebuild tool-output hashes or reorder model output. Context metadata on a
continuation may then advance the checkpoint through an accepted superseding
user turn. Synthetic aborted results are internal cancellation state and never
become public transcript hashes.

An ordinary result-only continuation treats its authoritative transcript end
as accepted by that callback delivery. Any later item that requires separate
delivery must be classified as a superseding turn.

If an ordinary divergent request arrives while a run is active, the actor
serializes the transition. An exposed batch must first receive matching
supplied results or a valid superseding correction; an ordinary request without
results remains a 409 pending-result conflict. After settlement, the Bridge
replaces the Agent epoch and sends the authoritative full prompt.

A validated `<turn_aborted>` steer settles the actual exposed batch, annotates
its last callback with the marker and new user suffix, and continues the active
Run. Missing current-batch results are represented by internal aborted results;
stale supplied results are never reassigned. The supplied authoritative context
is adopted only after annotation delivery.

Tool calls rejected by cursor2response's outer schema validation use an internal
correction continuation on the same pending run. The Bridge rolls back the
rejected call hashes while retaining any public narration, and the rejection
result itself does not enter the public checkpoint. A corrected call can then
be exposed normally without changing Agent epoch.

## Persistence and tools

Persisted Agent state version 3 stores the bootstrap fingerprint plus both the
authoritative and provisional transcript hash sequences beside the SDK Agent
ID. Only a clean state with compatible model and context may resume. Versions
1 and 2, and context-less version 3 states, remain readable for legacy callers
but cannot resume a context-aware Responses request. This one-time replay
boundary is required because earlier state does not distinguish SDK delivery
order from the adapter-authoritative transcript.

SDK `send.local.customTools` is a per-run replacement. Current names,
descriptions, schemas, and callbacks are supplied on every send and do not
participate in bootstrap or transcript identity. A change between the no-tool
and tool-enabled internal directive still changes the effective bootstrap.

For Codex and OpenClaw, stable normalized instructions plus a canonical
transcript that retains the accepted transcript as an exact ordered prefix keep
the same Agent epoch and send only the missing suffix. Repeating the same tool
map on each request does not disturb that match. Changing a tool schema replaces
the inventory for the current SDK run but does not by itself change Agent
identity.

An SDK callback without a raw call ID receives a stable response-scoped public
ID when it is parked. The same ID is used by the checkpoint, Responses output,
and result continuation. Empty-turn recovery deliberately closes any cached
Agent and skips persisted resume before replaying the same authoritative input
on a fresh Agent.

## Conformance

- Stable append-only history reuses one Agent and sends the exact missing item
  suffix without stable instructions.
- Model A -> model B -> model A reuses A and sends the intervening B turns.
- Instruction changes and transcript divergence close the old Agent and log a
  named full-replay cause.
- Equal completed history starts no SDK run.
- Retries of an active accepted input or latched delivery reattach without
  replaying an external side effect.
- Tool call, tool result, and assistant completion advance the provisional
  checkpoint; an exact public replay allows the next turn to send only the new
  user item.
- An acknowledged terminal assistant omitted by the next authoritative
  transcript replaces the Agent epoch with cause
  `agent_provisional_transcript_diverged`.
- Internally rejected tool calls correct on the same run without entering the
  public checkpoint; anonymous callbacks keep one public ID through result
  continuation.
- A divergent pending run settles its exposed tool batch before Agent
  replacement and never reassigns a result to another callback.
- Clean compatible version 3 state resumes incrementally; legacy state creates
  a full-replay epoch.
- Per-send tool schema changes do not change the Agent epoch.
- Empty-turn recovery creates a fresh Agent even when the transcript is equal.
- Cancellation closes the old Agent; a subsequent turn full-replays the
  authoritative transcript on a fresh Agent.

## SDK execution directory

`CURSOR_SDK_WORKING_DIRECTORY`, when explicitly set, selects the SDK local execution directory independently of a client working directory. Compose fixes this directory at `/workspace`. The logical client working directory remains part of Agent affinity and tool forwarding; it is not rewritten into a container path. This permits clients on a different filesystem to use the gateway without mounting their HOME. Keep the configured SDK directory and SDK state volume stable across restarts.
