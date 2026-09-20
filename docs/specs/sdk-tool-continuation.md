# SDK Tool Batches And Continuation

Status: current

## Scope

This spec defines how cursor2response exposes Cursor SDK tool calls, matches returned results, and continues the same SDK run. Responses is the conformance target; Chat Completions and Anthropic Messages may reuse the same Bridge primitives under the maintenance scope in [protocol-support.md](protocol-support.md).

Superseding user turns are defined separately in [responses-superseding-turns.md](responses-superseding-turns.md).

## Ownership

- The external harness executes tools and owns their side effects.
- cursor2response forwards calls, validates their public shape, matches results, and preserves SDK run ownership.
- Once a tool call is exposed, cursor2response must not execute it, silently discard it, or replay it through a replacement Agent.

## Identities and state

One in-memory session actor per Agent cache key is the single owner of the SDK
Agent, active run, steering inbox, subscriber, and delivery state. An active
run contains:

- `expected: Set<sdkCallId>` for observed SDK calls;
- `parked: Map<internalCallKey, callback>` for callbacks waiting on harness results;
- `emitted: Set<internalCallKey>` for the batch currently visible to the harness;
- `settledSdkToolResults: Map<sdkCallId, result>` for idempotent SDK callback replay after a result settles;
- terminal output or terminal error, but never both as active states.

At most one HTTP subscriber is attached to the actor. A newer well-formed
request replaces the previous subscriber without cancelling the SDK run. Text,
reasoning, and progress events are routed only to the current subscriber.

The actor latches the latest emitted tool batch until matching results settle
it, and latches terminal output until the Bridge successfully writes it to the
subscriber. A reconnecting subscriber receives the same latched delivery,
including the same public tool call IDs. Subscriber replacement is therefore
not a waiter conflict and does not recreate or replay the SDK run.

Missing SDK call IDs use collision-free internal keys. Internal keys and raw SDK IDs do not cross the public protocol boundary.

## Tool inventory lifetime

`send.local.customTools` replaces the Agent-level default for one SDK run. The
Bridge therefore rebuilds the callback map and supplies the complete current
tool inventory on every send. Tool definitions do not merge or accumulate
across runs, and the SDK conversation checkpoint stores calls and results, not
the schemas that enabled them.

Dynamic names, descriptions, schemas, and callbacks do not participate in the
Responses Agent bootstrap or transcript fingerprint. The installed SDK does
not publicly guarantee backend schema deduplication or prompt-cache behavior,
so cursor2response relies only on the per-send replacement contract for
correctness.

The Bridge derives each public call ID from the session key, execution identity,
and SDK call ID. IDs are stable within the pending Run, differ across generations,
and are no longer than 64 characters. The same public ID is used by OpenAI
`call_id` and Anthropic `tool_use_id`; a Responses `ctc_...` output item ID is
not a result-pairing key.

## Tool metadata

Function and custom tool definitions may include the cursor2response extension
`output_schema` (alias `outputSchema`) and `annotations`. Shared OpenAI
preparation accepts these alongside the tool name or inside a nested
`function` definition. The Messages translator preserves explicitly supplied
metadata through the same shared path.

`output_schema` must be a JSON object. `annotations` must be an object; the
accepted fields are `title` (string), `readOnlyHint`, `destructiveHint`,
`idempotentHint`, and `openWorldHint` (booleans). Invalid types, including
`null`, return HTTP 400. Unknown annotation fields are ignored. Missing fields
remain absent, and explicit `false` hints remain false; cursor2response never infers
these attributes from a tool name, description, or schema.

The Bridge forwards these values as SDK `customTools` metadata on each send.
They describe the tool to the model: they do not enforce permissions, change
execution ownership, or validate returned output against `outputSchema`.
The existing input argument validation and result pairing rules still apply.
Metadata follows the same per-run replacement and Agent affinity rules as the
rest of the tool inventory. Responses response metadata echoes the normalized
tool definition using `output_schema`.

## Batch discovery

The SDK does not expose a batch count or batch-end event. `modelCallId` groups observed generation events but cannot prove that every callback has arrived. The Bridge therefore freezes the currently parked calls after the configured quiet window, currently 10 ms from the latest `stream_running` event or callback.

Calls arriving after the window remain parked and form the next barrier after the current batch settles. This may reduce parallelism, but it must not change call IDs, result ownership, or side-effect semantics.

## Wire contract

The internal Bridge request accepts only the array form:

```json
{
  "resumeToolResults": [
    { "callId": "call_...", "output": "...", "isError": false }
  ]
}
```

The legacy singular result shape is not supported.

An ordinary continuation must return the complete currently emitted batch. Results are matched by public call ID, independent of result order. Missing batch members fail with HTTP 409. Unknown and replayed public IDs are logged and ignored; they must not resolve a different callback. An anonymous SDK callback receives a stable response-scoped public ID when parked. It remains a singleton positional fallback and requires exactly one result if a legacy caller omits that generated ID.

The SDK may replay a callback with the same raw call ID after a partial batch is settled. When the tool name and arguments are identical, the Bridge reuses the parked callback promise or the previously settled SDK result and logs the duplicate with its reuse action; the outer tool is never executed twice. JSON object arguments use a stable structural fingerprint, so property order alone does not create a mismatch. A mismatched duplicate remains an HTTP 409 protocol conflict.

Schema validation happens before any call in a batch is exposed. If one call is rejected, the entire rejected batch is returned through an internal correction continuation on the same Cursor run as `isError` results, so no sibling callback waits forever and no partial batch reaches the harness. Rejected calls and correction results do not enter the public Responses checkpoint.

## Recovery boundaries

- Transparent transport retry is allowed only before any event is exposed and when the request carries no tool results.
- Empty-turn recovery is allowed only when the run emitted neither text nor tool calls. It closes the cached Agent, skips persisted resume, and full-replays the accepted input on a fresh Agent.
- A disconnected subscriber does not own the SDK run. Reconnection replaces
  the subscriber and re-delivers the latest unacknowledged barrier or terminal
  output from the session actor.
- After a tool batch is exposed, cursor2response must not switch session or replay the prompt to rescue that run.
- A superseding user turn may settle an exposed but unreturned current batch. The Bridge appends its user interjection to the actual batch and continues the run. A `<turn_aborted>` marker remains model-visible in that interjection and establishes the corrected logical branch after delivery. Synthetic aborted errors settle callbacks without claiming completed tool side effects; results supplied for a different stale batch are discarded rather than reassigned.
- Explicit caller cancellation settles parked callbacks, cancels the active run,
  and closes the Agent. Cancellation also covers the gap after a tool Response
  completed and before continuation admission. A Bridge transport disconnect
  only detaches its subscriber. Ownership checks, public Sidecar abort semantics,
  and the 65-minute pending lease are defined in
  [SDK lifecycle](sdk-executor-lifecycle.md). A cancelled or expired checkpoint
  remains dirty; the next independent request uses the authoritative full prompt.
- A Bridge process restart loses in-memory Agents and pending runs. The Bridge may resume an SDK Agent only from a persisted clean terminal checkpoint for the same cache key and model. Dirty, active, cancelled, timed-out, or pending-tool runs are not resumed. Recovery of their tool history still requires caller-supplied `function_call` plus matching `function_call_output` items; cursor2response does not invent completed side effects.
- An ordinary follow-up with an independent incremental prompt can recover a dead client turn by settling and annotating the actual pending batch. A request with neither results nor an independent follow-up remains a protocol conflict; the SDK client must not turn that conflict into a full-prompt retry.

## Conformance cases

- Automated and live conformance covers batches of one to five calls, including parallel read-only calls; the protocol does not define five as a hard maximum.
- Results returned out of order still settle the matching callbacks.
- Mixed success, error, and timeout results can continue the same run.
- Missing, duplicate, replayed, and unknown call IDs have deterministic errors or observability.
- A quiet-window split creates another sequential barrier without duplicating tool execution.
- Disconnect, cancellation, Bridge restart, and empty-turn handling never replay an already exposed tool call inside cursor2response.
- A stop followed by a user turn creates a fresh Agent and resends the authoritative full transcript.
- A dead client turn with a usable incremental follow-up settles the pending batch and continues without replay.
- A marker-bearing correction settles and annotates the active batch on the same Run, including when provisional output diverges from the corrected client transcript.

## Rationale

Observed SDK traces reconstructed 505 model tool batches: 48.7% singleton, 26.1% double, 18.6% triple, and 6.5% four to five calls, averaging 1.84 calls per batch. Callback timing and harness traces placed the lowest robust quiet window at 5-10 ms. The 10 ms default favors singleton latency while safely turning late siblings into another barrier.
