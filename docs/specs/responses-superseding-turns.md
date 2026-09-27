# Responses Steering Turns

Status: current

## Scope

This spec defines how the Responses path accepts user input while a Cursor SDK
run is active. Codex is the primary conformance harness. Tool-batch ownership
and callback matching remain defined by
[sdk-tool-continuation.md](sdk-tool-continuation.md).

## Classification and wire shape

OpenAI `response.completed` ends one Response generation. A completed Response
may still contain tool calls whose outputs must be supplied in another request;
it does not prove that the application tool loop or Cursor SDK run is terminal.
The Bridge actor's pending and terminal state remains authoritative for the SDK
run. protocol adapter transcript classification only identifies a superseding candidate.

The protocol adapter marks a request as a superseding candidate when a new user item
follows the latest unresolved batch of `function_call` or `custom_tool_call`
items. The batch contains every tool call since the preceding user or tool-output
boundary. Ordered output items such as assistant commentary or reasoning do not
split the batch. Earlier settled batches are excluded. For a flattened replay,
an assistant message after the matching tool outputs ends the search and makes
later user input a normal follow-up; this is a replay heuristic, not a Response
completion signal. Assistant commentary placed before the matching outputs
remains part of the active turn.

The protocol adapter forwards:

- `supersedePendingRun: true`;
- the declared public call IDs in `supersededToolCallIds`;
- supplied results belonging to that batch;
- an incremental prompt rendered from only the new turn suffix;
- `supersedingTurnAborted: true` only when the suffix before the new user
  contains a developer `<turn_aborted>` marker. The marker remains in the
  rendered incremental prompt delivered to the model.

The marker identifies a model-visible correction of the preceding segment.
Observing an HTTP abort does not synthesize the marker or reclassify the next
request.

## Actor inbox

One session actor owns the Agent, active run, ordered steering inbox, recent
turn identities, and current subscriber. Requests deposit turns; they do not
take ownership of the SDK run.

A turn identity is the SHA-256 digest of stable JSON containing the actor cache
key, declared public call IDs in wire order, and the rendered incremental
prompt. Request IDs are excluded because Sidecar and protocol adapter retries generate
new request IDs. A content-identical retry reattaches to the active outcome and
does not enter the inbox twice. The actor retains the most recent 256 delivered
identities while retaining every queued identity.

The protocol adapter omits the stable instructions from the incremental prompt. After
matching the retry identity and confirming the current bootstrap, the Bridge
projects delivery onto the new transcript suffix, excluding any prefix already
accepted or queued for delivery. The suffix starts no earlier than the adapter's
new-turn boundary, so supplied callback results are not inserted again as
conversation text. A `<turn_aborted>` marker, current output constraints, and
image markers for the new suffix remain part of that delivery. Bootstrap changes
still replace the Agent and replay the complete authoritative input.

## Admission

Admission validates before depositing a new turn or resolving a callback:

1. Declared public IDs are non-empty and unique.
2. Every supplied result belongs to the declared batch and no supplied ID is
   duplicated.
3. If the declared IDs match the currently emitted batch, supplied results are
   preserved and missing siblings receive an internal `isError: true` aborted
   result.
4. If the request names a stale batch while another batch is emitted, stale
   supplied output is discarded and every callback in the actual emitted batch
   receives the internal aborted result.

When the active run has no parked, expected, or emitted tool batch, a
marker-free text-only turn first attempts native SDK steering. Image turns
retain their attachments until callback annotation or a follow-up SDK send. Other valid turns remain
queued for a tool-result boundary or terminal fallback. This case is not a
writer conflict.

Duplicate declared IDs, undeclared results, and duplicate supplied results fail
with HTTP 409 without depositing the turn or settling callbacks. A recovered
stale-batch mismatch is logged with declared, supplied, and actual pending call
IDs.

An ordinary follow-up can arrive while the previous client turn is still
parked without carrying its tool results. If it has an independent incremental
prompt, the actor treats it as dead-turn recovery: queue the new turn, settle
the actual emitted batch with synthetic aborted results, annotate that batch,
and continue the cached run. If no batch is emitted yet, the turn waits for the
next boundary or terminal fallback. This path does not return
`cursor_sdk_tool_result_pending` and does not replay the transcript.

## Native steering

For a live Run with `steer`, the actor submits the oldest eligible inbox turn
once and marks it `native_pending`. Only one injection is in flight at a time.
The SDK promise is awaited outside actor admission, so newer subscribers,
tool-result callbacks, and cancellation can progress. Later turns cannot be
annotated ahead of an unacknowledged injection.

`complete_delivered` accepts that turn on the same Run, records trajectory
input acceptance with `acceptedBy: run_steer`, and removes it from the inbox.
Only this ACK advances the authoritative user checkpoint. Tool continuations
received during the ACK wait settle their callbacks immediately, while their
checkpoint advancement waits for all preceding user injections. Provisional
output produced during the wait retains its public order after queued inputs.
Incremental suffix selection accounts for earlier queued turns, so a second
turn does not resend the first one. Content retries before or after ACK
reattach to the current outcome.

Delivery acknowledgement does not promise immediate interruption of generated
text. The SDK may complete its current text segment before applying the injected
instruction. The Bridge preserves that output and does not infer cancellation
or failed delivery from this delay.

`revert_to_followup` returns the turn to the existing annotation or terminal
fallback path without another native attempt. Terminal delivery waits for an
outstanding SDK ACK before deciding whether a fallback is needed. The Bridge
does not impose an additional ACK timeout or dispatch a second copy while the
SDK promise remains pending. SDK 1.0.31 owns the initial 15-second ACK deadline;
its queued acknowledgement removes that deadline. The public outcome does not
distinguish rejection, next-turn queuing, and an initial ACK timeout, so fallback
relies on the SDK's `revert_to_followup` delivery contract.

Thrown errors and unknown ACK values fail the run with
`cursor_sdk_steer_failed`, mark its checkpoint dirty, and do not replay it.
Every ACK checks the original actor, Run, and generation; a late ACK after
cancellation, failure, or Agent replacement cannot accept input or start a send.
Evicting an Agent clears its inbox and delivered turn identities. Recovery
requires the complete client-authoritative transcript.

An already exposed tool batch and a `<turn_aborted>` correction retain the
callback settlement path below. Native steering does not stand in for tool
results or claim that external tool side effects were cancelled.

## Annotate and continue

A superseding request is deposited as a mailbox steer on the active run.

At the next tool-result resolution, all queued turns are appended in
arrival order to the result for the last callback in the actual
`pending.emitted` order:

```text
<user_interjection>
<rendered incremental turn>
</user_interjection>
```

Each turn creates one block. The batch is annotated once, including when stale
batch recovery generated the actual synthetic results. Result `isError` state
is preserved. Turns leave the inbox at annotation time and are never sent
again as follow-up prompts.

For a `<turn_aborted>` correction, callback settlement and annotation establish
the new model-visible logical branch. The Bridge then adopts the supplied
adapter-authoritative checkpoint for subsequent context decisions. Earlier
provisional output may remain in the Agent conversation; the marker instructs
the model to treat that preceding segment as aborted.

If native steering is unavailable or declines delivery and no barrier exists,
the current subscriber waits for the next barrier or terminal state. An
ordinary result-only continuation also flushes eligible queued turns into the
batch it resolves.

## Terminal fallback

If an active run reaches terminal state while turns remain queued, the
Bridge sends the queue as one incremental prompt on the same Agent. Rendered
turn suffixes are joined with a blank line and are not sent one run at a time.
The terminal output is acknowledged before the replacement run becomes active.

The Bridge never starts this fallback without a subscriber. It retains the
terminal delivery and inbox until another request attaches. A content retry can
therefore recover the same outcome without replay or duplicate delivery.

If the merged Agent send fails before delivery is confirmed, the Bridge returns
the fatal error and evicts the failed actor. Recovery requires the retrying
client to provide the complete authoritative transcript containing every
undelivered user turn, as Codex and OpenClaw do. A client that retries only its
latest turn cannot reconstruct earlier turns from the evicted inbox.

## Stop and resume

When the caller explicitly cancels the active request, the actor settles parked callbacks with
the internal aborted result, cancels the SDK run, records a dirty persisted
checkpoint, and evicts the Agent. A `Run` returned after the abort is
immediately cancelled. Cancellation cleanup is bounded, with failures reported
before local ownership is released. Transport disconnect, cross-request
cancellation, generation checks, and the 65-minute pending lease follow
[SDK lifecycle](sdk-executor-lifecycle.md).

The next request creates a fresh Agent and sends the complete authoritative
prompt. The Bridge does not assume that `run.cancel()` rolled back conversation
history inside the Cursor Agent.

## Subscriber and Agent boundaries

A newer request replaces the previous subscriber without cancelling a Shape-A
run. The replaced waiter receives the internal
`cursor_sdk_subscriber_replaced` signal; the active transport exposes only the
new subscriber's events. Latched tool or terminal output remains re-deliverable
until the Bridge successfully writes it.

If a superseding candidate arrives after the active run has already been
acknowledged, stale supersede metadata is cleared and normal prompt selection
applies: cached or resumed Agents receive the independent incremental prompt;
otherwise recovery creates an Agent from the full prompt with the documented
recovery suffix.

Transparent Sidecar or SDK retries get one attempt for any superseding request.
They must not replay an admitted result and user-turn pair.

## Full replay fallback

`created-full` is limited to a first turn, a request for which no live or
resumable Agent can accept an independent incremental prompt, or a context
mismatch defined by
[responses-agent-context-affinity.md](responses-agent-context-affinity.md). The
Bridge logs a non-null `replayCause` on every `sdk_prompt_selected` record:

- `first_turn`;
- `missing_incremental_prompt`;
- `agent_state_missing`, `agent_state_dirty`, or `agent_model_mismatch`;
- `agent_resume_failed` or `agent_unavailable`;
- `agent_context_missing`, `agent_bootstrap_mismatch`,
  `agent_transcript_diverged`, or `agent_provisional_transcript_diverged`;
- `cancelled_run`;
- `retryable_sdk_error`;
- `unmatched_tool_results`, `empty_turn_recovery`,
  `transient_sdk_error`, or `sidecar_transient_retry`.

When an active pending run must fall back because no independent incremental
prompt exists, the Bridge first settles callbacks and cancels the run, then
evicts that Agent and creates the replay Agent. The SDK client never converts a
`cursor_sdk_tool_result_pending` response into a full-prompt retry. A matched
tool-result request may still replay after a Bridge restart reports
`cursor_sdk_tool_result_unmatched`; that recovery carries the explicit
`unmatched_tool_results` cause.

## Conformance cases

- Native delivery uses one active Run and advances context only after ACK.
- Consecutive native turns and content retries do not duplicate input.
- A terminal Run waits for its outstanding ACK before a single fallback send.
- Tool callbacks and cancellation progress while native ACK is pending.
- Native ACK failures do not replay, and late ACKs cannot revive a cancelled Run.
- Marker-free and marker-bearing suffixes produce distinct structured wire
  values.
- Interleaved assistant commentary does not split a parallel tool batch.
- Two successive mailbox steers are accepted and each reaches the actual batch
  once.
- Real parallel results remain unchanged except for the final annotation;
  missing siblings remain errors.
- A stale declared batch annotates the actual synthetic batch, never the stale
  supplied output.
- A marker-bearing correction annotates the actual callback and continues the
  active Run after provisional divergence.
- Subscriber abort followed by a user turn creates a fresh Agent and sends the
  authoritative full prompt.
- A run ending before a barrier sends all queued turns once in arrival order.
- With no subscriber, terminal output and inbox remain held until reattach.
- Identical content with another request ID does not duplicate an annotation or
  merged prompt.
- A dead client turn with an independent incremental prompt settles and
  continues on the cached run.
- A pending-tool conflict never triggers a transparent full-prompt retry.
- Every `created-full` prompt-selection record names its replay cause.
- Malformed IDs fail before inbox or callback state changes.
- Subscriber replacement and reconnect never recreate the active SDK run.
