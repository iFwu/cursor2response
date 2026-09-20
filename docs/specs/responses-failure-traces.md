# Responses Failure Trace Artifacts

Status: current

## Scope

The local Sidecar records a full diagnostic artifact only when a Responses request on the SDK Bridge path reaches one of these terminal failures:

- an HTTP or streamed protocol conflict with status `409`;
- `cursor_sdk_bridge_timeout`;
- `cursor_sdk_idle_timeout`;
- `cursor_sdk_stream_timeout`;
- `cursor_sdk_timeout`;
- `cursor_sdk_tool_correction_timeout`.

Successful requests continue to use normal journal summaries. Authentication failures, ordinary model/provider failures, `cursor_sdk_cancelled`, client disconnects, and other manual cancellation do not create artifacts. An internally recovered `409` is not terminal and is not captured.

This facility does not add a Responses state store, a replay service, synthetic tool results, or a replay CLI. Cursor SDK state and tool selection outside the public request are not reconstructable, so the artifact is evidence for investigation rather than a deterministic replay contract.

## Artifact schema

Accepted captures are gzip-compressed JSON named `*.json.gz` with `schemaVersion: 1` and `kind: "cursor2response_failure_trace"`. Each artifact contains:

- `capturedAt`: the terminal capture time;
- `request`: route, complete public Responses body, generated response ID,
  resolved model, stream mode, normalized `clientSource` label, and normalized
  `clientPlatform` label;
- `request.session`: affinity source, received session header names, and SHA-256 of the resolved session key;
- `derived`: full and incremental prompt character counts and SHA-256 values, tool names/count, continuation counts, supersede metadata, lineage classification, and stateless replay eligibility;
- `events`: every SSE frame successfully emitted by the Sidecar before and including the terminal failure frame, with a millisecond offset from request capture start;
- `failure`: terminal status, code, and a message capped at 4096 characters.

Headers, raw user-agent values, Cursor API keys, and Bridge tokens are not
stored. Root request-body slots named `apiKey`, `api_key`, or `authorization`,
matched case-insensitively, are removed. Other model-visible body content,
including prompts and tool outputs, is preserved exactly; the writer does not
scan or redact nested content. Artifacts therefore remain sensitive local data.

If `previous_response_id` is present, `derived.lineage` is `body-only-unresolved`: the referenced response is not resolved or copied into the artifact. `statelessReplayEligible` is metadata only and is true solely for a first-turn shape with no `previous_response_id`, incremental prompt, tool output, resumed tool result, or superseding turn. It does not assert that a future model run will choose the same tools or output.

## Storage contract

The default directory is `${XDG_STATE_HOME:-~/.local/state}/cursor2response/failure-traces`; `CURSOR2RESPONSE_FAILURE_TRACE_DIR` can replace it. The directory is mode `0700`, artifact files are mode `0600`, and writes use a temporary file plus atomic rename.

Retention is bounded to seven days, 20 files, and 200 MiB total. `CURSOR2RESPONSE_FAILURE_TRACE_MAX_BYTES` changes the byte ceiling; values below 16 KiB are normalized to 16 KiB so a metadata-only rejection marker can always fit. Pruning runs at Sidecar startup and around every artifact write, removing oldest entries first.

An artifact that exceeds the byte ceiling is not partially saved. A small `*.rejected.json` file with `kind: "cursor2response_failure_trace_rejection"`, failure metadata, byte counts when available, and `reason: "capture_rejected_size_limit"` records the rejection without request or event content. Rejection markers share the same retention limits.

## Conformance cases

- A terminal streaming SDK deadline saves the public body, emitted SSE sequence, and `response.failed` frame.
- A terminal non-stream Bridge conflict preserves status `409` and saves one artifact.
- A `409` recovered by the existing missing-pending fallback saves no artifact.
- A client that disconnects after an SDK event cancels the active Bridge run and saves no artifact.
- First-turn, follow-up, tool-output, superseding, and unresolved-lineage shapes receive the correct `statelessReplayEligible` metadata without initiating replay.
