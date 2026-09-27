# Protocol Support And Maintenance Scope

Status: current

## Runtime boundary

The supported runtime is the local Sidecar plus SDK Bridge:

- `sidecar/server.ts` owns the public HTTP endpoints.
- `core/` owns shared OpenAI protocol preparation and response shaping.
- `bridge/server.mjs` owns the in-memory Cursor SDK Agent and pending-run state, plus the minimal on-disk index used to resume clean completed Agents.
- The Trace Viewer current-state tab reads the Bridge's authenticated runtime
  snapshot. It does not infer live pending ownership from historical journals;
  its availability and parsing do not affect the Responses path.

Deployment is local. Docker Compose uses the pinned Node.js 24 LTS image; direct source execution supports Node.js 24 or later. Shared `core/` code is part of the local runtime, not an independently deployed service.

## Protocol priority

Responses is the primary OpenAI compatibility target. Codex and OpenClaw are the main real-harness acceptance paths.

Chat Completions and Anthropic Messages remain compatibility endpoints on a best-effort basis. They may reuse shared Bridge primitives and naturally receive shared behavior changes, but Responses work does not require endpoint-specific Chat or Messages alignment or acceptance testing unless that scope is explicitly requested.

Compatibility means the documented primary workflows are supported. It does not imply complete conformance with every upstream parameter or behavior. User-visible coverage and known limitations remain in [`README.md`](../../README.md).

## Assistant message phases

The SDK Bridge classifies text at the boundary that owns its outcome: narration
handed off with a client tool batch is `commentary`; the completed run's answer
is `final`. Classification does not depend on trace IDs or successful logging.
The Responses adapter maps these values to assistant message `phase` values
`commentary` and `final_answer`, respectively.

Streaming text starts without a phase because the tool or terminal boundary may
not have arrived yet. `response.output_item.done` finalizes that same message ID
with the confirmed phase, and `response.completed.output` carries the identical
message. Non-streaming output uses the same phase mapping. An unknown phase
stays absent; tool count alone does not classify arbitrary Responses text.

Clients preserve the phase when replaying assistant output. Cursor's canonical
transcript checkpoint remains role, rendered text, and image count: phase is
presentation metadata and does not alter SDK tool-result matching or Agent
affinity. See [Responses Agent context affinity](responses-agent-context-affinity.md).

Conformance covers both response modes, tool-result continuation with phased
history, stable message identity, and classification when trace recording fails.

## Grok 4.7 model selection

Grok 4.7 declares `reasoning_effort` in the Cursor model catalog. Responses
`reasoning.effort` uses that parameter name through both Sidecar and Bridge;
legacy models with `effort` retain their existing mapping. An explicit
`service_tier: "default"` disables Fast when the catalog supports it.

Client token budgets do not select a Cursor context mode. An explicit
`cursor_context` or model `context` parameter selects that mode, subject to
upstream admission. The catalog advertises 256k and 500k for Grok 4.7, but local
SDK 1.0.31 and 1.0.32 rejected explicit 500k selections during validation on
2026-09-27 while the same 256k selections completed. Do not claim 500k local
support from catalog metadata alone or silently replace it with 256k. See
[Cursor's model documentation](https://cursor.com/docs/models/grok-4-7) and the
[local SDK limitation report](https://forum.cursor.com/t/grok-4-7-run-rejects-advertised-context-500k/172554).

## Change requirements

- Responses changes must preserve the contracts in the other current specs unless the spec changes in the same patch.
- Changes to rendering, recovery or steering must preserve the [model-visible input accounting invariants](responses-agent-context-affinity.md#model-visible-input-accounting) and verify the delivered content, including the absence of adapter-created duplicate representations.
- Shared primitive changes must not introduce a second Chat- or Messages-only state path solely to preserve historical behavior.
- Protocol errors remain explicit. Unsupported semantics must not silently degrade to prompt guidance where the public endpoint promises hard enforcement.
- Automated regression tests are required for deterministic contracts. Codex and OpenClaw harness validation is required for changes whose correctness depends on real transcript or cancellation behavior.

## HTTP transport

The Sidecar uses Node.js 24 HTTP and Web Streams. Request bodies are limited to
64 MiB and must arrive within 60 seconds. Oversized bodies return HTTP 413
`request_too_large`; body timeouts return HTTP 408 `request_timeout`. These
limits apply before SDK admission. After admission the existing Bridge deadline
and cancellation contracts own execution timeouts; HTTP socket idleness does
not impose a second short model deadline.

Response writes respect transport backpressure. A disconnected client aborts
the incoming request signal and cancels the response body, including a body
created after the disconnect. The Bridge still owns whether detached execution
continues or explicit cancellation terminates its Run.
