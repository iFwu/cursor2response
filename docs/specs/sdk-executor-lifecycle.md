# Cursor SDK Executor And Pending Run Lifecycle

Status: current

## Scope

The Bridge owns session actors, Agent handles, active Runs, subscribers, and
pending tool deliveries. Responses is the conformance path; see
[protocol-support.md](protocol-support.md),
[sdk-tool-continuation.md](sdk-tool-continuation.md), and
[responses-agent-context-affinity.md](responses-agent-context-affinity.md).

## Credentials And Executor Ownership

The dependency is pinned to `@cursor/sdk@1.0.31`. Its authenticated transport
refreshes credentials before JWT expiry, at the later of expiry minus five
minutes and the credential lifetime midpoint. Credentials without a usable
JWT expiry use a conservative 30-minute local lifetime. Concurrent refreshes
on one transport share a promise.

A retryable refresh failure may retain a still-valid credential and schedule
another attempt within 30 seconds. An expired credential cannot use this
fallback. Non-retryable refresh failures remain terminal in that transport.
Unary transport authentication retry is bounded by the SDK. A semantic
authentication failure inside a Run is not a transport authentication error.

The SDK still shares executors by its own cache and reference-counted Agent
handles. A model or session identity does not isolate that executor.
The Bridge does not maintain an executor-group admission gate, timer-based
credential rotation, hard-invalidation queue, or authentication replay.

Recognized authentication failures return public HTTP 401 `unauthorized`.
The failed Run is terminal, its state stays dirty, and its Agent handle is
disposed. Repeated failure paths join the same cleanup promise. No replacement
Agent or full replay is attempted automatically for authentication failures.
Other actors remain independently admissible, including actors using the same
API key and working directory.

Releasing one Agent does not guarantee that a shared poisoned transport is
reset. A persistent credential rejection can therefore affect later requests
using that credential; those requests fail visibly instead of waiting for
another session's pending tools. Correcting credentials and any necessary
operational reset are outside transparent retry.

## Actor And Cancellation Ownership

One actor serializes admission, callback settlement, replacement, cancellation,
and lease expiry. Each pending Run carries an execution identity and the
actor generation that admitted it. Public call IDs incorporate that execution
identity, so a reused raw SDK call ID in another generation cannot match an
earlier delivery.

The internal `POST /sdk/cancel` accepts `requestId`. For a continuation that
has not reached admission, the protocol adapter additionally sends `apiKey`, `model`,
`workingDirectory`, `sessionKey`, and `pendingToolCallIds`. Tool bodies and
results are excluded from cancellation requests.

Cancellation follows these rules:

- The latest admitted request may cancel its pending Run after its HTTP
  response has completed.
- A replaced request has no cancellation authority after a newer subscriber
  attaches, including after that newer subscriber detaches.
- A rejected context or tool-result batch does not replace the subscriber or
  change the last accepted request's cancellation authority.
- An unadmitted continuation may cancel only the exact nonempty emitted
  public-ID set in its own Agent cache key, with unique IDs and no currently
  attached subscriber. Superseding and internal-correction requests do not
  use this fallback.
- The actor transition rechecks the captured Run, generation, latest request,
  subscriber, and emitted IDs before cancellation.
- A cancellation arriving before its matching HTTP request also leaves the
  existing bounded request tombstone. The later request observes cancellation
  before admission.
- The protocol adapter sends cancellation even when its signal is already aborted before
  the first Bridge fetch.
- A result accepted before a late batch-based cancellation stays accepted.
  Cancellation accepted first makes the corresponding late result terminal.

A lost Bridge HTTP connection detaches its subscriber and preserves the Run
for reconnect. The explicit cancellation endpoint and request deadlines end
the Run. The public Sidecar treats its request AbortSignal as caller
cancellation and sends that endpoint request; the HTTP protocol cannot prove
whether that public abort originated from a user stop or a network loss.
Subscriber replacement alone never cancels the Run.

Cancellation settles internal callbacks with an aborted-result error, without
claiming that an external tool did not execute. The external harness owns the
actual side effect and result. The Bridge records dirty state, invokes SDK
cancellation and Agent disposal, and releases local actor ownership. It does
not wait indefinitely for the SDK stream to report its terminal event.

`CURSOR_SDK_BRIDGE_RUN_CLEANUP_TIMEOUT_MS` defaults to 5000. Cancellation has
one cleanup deadline across late attachment, cancellation, and disposal.
A cleanup error or deadline is logged as `sdk_run_cleanup_failed`, including
the affected execution and cleanup phase. Local release after a deadline is
not proof that the remote SDK acknowledged cancellation. A late attachment
is still cancelled; late cleanup must not remove a newer generation's state.

SDK context-overflow errors wait for bounded cancellation and disposal before
internal HTTP/NDJSON delivery. `contextRetrySafe` is true only for a captured
attached Run whose cancellation and disposal succeeded. Local terminal flags
are not that proof. See [Grok hybrid routing](grok-hybrid.md).

## Pending Lease

`CURSOR_SDK_BRIDGE_PENDING_LEASE_MS` defaults to 3900000 ms (65 minutes).
This covers Codex's permitted one-hour `wait_agent` call plus five minutes
for delivery and reconnect. OpenClaw exec normally yields after 10 seconds
(maximum 120 seconds); process polling is at most 30 seconds. Codex terminal
polling defaults to a maximum of five minutes. These are callback waiting
windows, separate from a background process's lifetime.

Custom tools, changed client timeout configuration, synchronous shell modes,
and human approval waits can exceed the default. Operators must increase the
lease when intentionally permitting those longer callback waits. There is no
universal maximum across all externally supplied tools.

The lease starts when a tool batch is exposed. It also bounds a detached Run
that is still generating or holding undelivered terminal output. Absence of a
subscriber does not itself mean that the tool has been abandoned.

A validated reconnect receiving the same latched delivery renews the lease.
A successfully accepted complete tool-result batch clears that lease; a later
batch receives its own lease. SDK progress, unknown results, malformed
requests, cancelled subscribers, and failed schema/context validation do not
renew it. No client heartbeat protocol is introduced.

Expiry is rechecked under the actor transition both on the timer and on
request admission. Expiry and result settlement cannot both win. Expiry
returns `cursor_sdk_pending_lease_expired` (HTTP 409), settles internal
callbacks, disposes the Agent, and leaves dirty persisted state. This error
is not eligible for transparent retry or missing-pending full replay.

The Bridge retains the most recent 4096 terminated public call IDs for the
process lifetime. Known late results preserve the terminal error, including
after a new generation starts. This registry contains no tool payloads.
After restart or registry eviction, the ordinary missing-pending contract
applies; only the caller's authoritative history can establish executed tools.
No expired callback is silently resolved into a newer Run.

## Live Observation

Authenticated `GET /runtime` returns a read-only snapshot with schema version 1,
process invocation identity, snapshot time, lease and cleanup settings,
current Run phases, subscriber identity, pending public call IDs, waiting
start, lease deadline, and recent terminal outcomes. It omits credentials,
prompts, tool arguments, tool results, and checkpoint text.

Phases are `starting`, `running`, `waiting_tools`, `terminal_delivery`, and
`cancelling`. The most recent 64 terminations and process-local counters
cover cancellation, lease expiry, authentication failure, and cleanup failure.
The viewer proxies this snapshot and never reconstructs current ownership
from missing journal terminal records. Stale or unavailable snapshots are
visibly distinct from an empty runtime. Observation failures never alter
admission, callback ownership, business payloads, or terminal state.

## Verification And Observation

Automated coverage exercises concurrent independent admission, credentials
crossing the previous rotation boundary, terminal authentication errors,
cross-request cancellation, both cancellation/result orderings, replaced
subscribers, raw call-ID reuse across generations, lease expiry, reconnect
renewal, and bounded cleanup. Viewer checks cover the authenticated upstream
boundary, redaction, invalid snapshots, and unavailability.

Candidate Codex/OpenClaw validation must use isolated ports, state directories,
and viewer build output. A candidate pass is not production deployment or
evidence of long-term credential stability.

After an authorized deployment, track authentication failure counts and 401
outcomes, pending age and lease expiry, cleanup failures, unrelated-session
admission latency, reconnect success, and full replay/token changes. A single
pending Run must never block another actor's admission. Reassess credential
failures using the actual SDK transport and Run terminal evidence rather than
assuming every semantic authentication error was caused by token expiry.
