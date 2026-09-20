# cursor2response

**Keep Cursor conversations warm. Continue tool calls in the same Run. See what happened.**

English · [简体中文](README.zh-CN.md)

A local Cursor SDK gateway for clients using the OpenAI Responses API, with a built-in Trace Viewer. Developed through daily use with **Codex and OpenClaw**, it focuses on conversation reuse, reliable tool continuation, and observable execution.

![cursor2response overview](docs/images/overview-en.png)

The gateway runs on your machine; model inference uses Cursor services and requires your own Cursor API key. This is an independently maintained project, not an official Cursor product.

## Quick start

Install Docker Engine with Docker Compose, then:

```bash
git clone https://github.com/ifwu/cursor2response.git
cd cursor2response
cp .env.example .env
openssl rand -hex 32
```

Set `CURSOR_SDK_BRIDGE_TOKEN` in `.env` to the generated random value. This authenticates internal Bridge calls and is separate from your Cursor API key. Clients can supply their own Cursor key; optionally set `CURSOR_API_KEY` in `.env` as a single-user default.

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:6718/health
curl --fail http://127.0.0.1:8100/health
```

| Component | Address |
| --- | --- |
| API base URL | `http://127.0.0.1:6718/v1` |
| Trace Viewer | `http://127.0.0.1:8100` |
| SDK Bridge | Internal Compose network only |

Configure your client to use the API base URL, **Responses** mode, your Cursor API key, and a model ID returned by `/v1/models`:

```bash
curl --fail http://127.0.0.1:6718/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
```

Both published ports bind to localhost by default. Keep `.env` private. The Viewer has no user authentication and may display conversation content; a configured default Cursor key is available to anyone who can reach the API.

See [local deployment](docs/runbooks/local-deployment.md) for configuration, source execution, updates, and backups. Images are built locally from source; no hosted gateway or prebuilt release image is provided.

## Trace your conversation

The Viewer connects a session's requests, Agent lanes, SDK Runs, tool calls, and route changes. It makes context reuse, replay, and tool continuation visible without piecing together raw logs.

![Trace Viewer session timeline](docs/images/trace-timeline.png)

The runtime view queries the Bridge for its current Agents and pending work. Historical traces explain what happened; the runtime snapshot shows what is still active.

![Trace Viewer runtime state](docs/images/trace-runtime.png)

Screenshots use synthetic demonstration data. See the [Trace Viewer guide](docs/runbooks/trace-viewer.md) for live sessions and trace inspection.

## What it does well

| Capability | What you get |
| --- | --- |
| **Conversation reuse** | Compatible follow-up turns reuse an SDK Agent and send the missing input suffix, preserving the opportunity for prompt-cache reuse. |
| **Same-Run tool continuation** | Tool results arriving in later HTTP requests settle callbacks on the existing SDK Run, keeping the SDK's agent loop intact. |
| **Native steering** | Eligible new instructions reach an active Run through `Run.steer()`, with delivery acknowledgments and ordered handling. |
| **Trace Viewer** | Inspect session history, tool activity, context replay, provider changes, and current runtime ownership from one local UI. |
| **Context-overflow fallback** | Opt-in `grok-hybrid` routing can continue through a configured OpenAI-compatible Responses endpoint after confirmed SDK context compaction. |
| **Clear execution boundaries** | Assistant commentary and final phases stay distinct; cancellation targets the owning execution, and clean completed Agents can resume after restart. |

![Conversation and runtime flow](docs/images/runtime-flow-en.png)

An HTTP request is not an SDK Run: one Run can span multiple tool round trips. A later user turn can start a new Run on the same Agent, or steer eligible active work. Reuse depends on a compatible session identity and conversation history; explicit recovery boundaries can still require full replay. Cache behavior remains provider-controlled, so no fixed hit rate is promised.

Fallback is deliberately scoped: selecting `grok-hybrid` or `grok-hybrid-fast` and configuring its provider enables it. Confirmed SDK context compaction triggers the policy; ordinary errors do not. Immediate fallback requires confirmed cleanup and no public output yet, and subsequent requests follow the recorded route. See the [routing contract](docs/specs/grok-hybrid.md).

## Why this project exists

This began as a fork of [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api), following the cache-hit and conversation-reuse problem in [upstream issue #1](https://github.com/NGLSG/Cursor2API/issues/1). The original goal was to stop rebuilding SDK context for each client request and keep tool round trips inside the SDK's existing execution.

Extensive practical use with Codex and OpenClaw led to deeper work on tool continuation, steering, cancellation, transcript reconciliation, and tracing. After becoming dependable in the maintainer's daily workflows, it is being shared as a Responses-focused project with its own runtime and protocol contracts.

## Compatibility and limits

- **Primary API:** `/v1/responses`, including streaming, client tools, tool-result continuation, and session affinity. Codex and OpenClaw are the main real-client validation paths.
- **Best effort:** `/v1/chat/completions`, `/v1/messages`, and `/v1/messages/count_tokens`. These endpoints do not claim full protocol conformance.
- **Runtime:** Node.js 24 LTS for every service, through local Docker Compose or source execution. The Docker stack has been exercised on Linux amd64; other platforms are not yet validated.
- **Conversation history:** clients must preserve the required public history, including tool calls, results, and assistant phases. `previous_response_id` does not replace that history.
- **Restart behavior:** Compose persists SDK checkpoints and Bridge state. Clean completed Agents may resume; active Runs and pending tool callbacks do not survive process replacement. `docker compose down` retains volumes; `docker compose down -v` deletes them.
- **Context accounting:** token estimates are not authoritative SDK context measurements. A successful long prompt does not establish a safe multi-turn context ceiling.
- **Trace privacy:** logs and state can contain prompts, tool arguments, and results. Review and sanitize artifacts before sharing them.

See [protocol support](docs/specs/protocol-support.md) for the detailed compatibility contract.

## Run from source

With Node.js 24 LTS and npm installed:

```bash
npm ci
npm run build
node server.mjs start
node server.mjs status
```

The launcher starts the API and Bridge on loopback, generates their internal token, and keeps process state and logs under `~/.cursor2response`. Stop them with `node server.mjs stop`. To run the Viewer alongside them with shared trace logs, follow the [source deployment instructions](docs/runbooks/local-deployment.md#direct-source-execution).

## Development and documentation

```bash
npm run typecheck
npm test
npm run test:operations
npm run trace:viewer:typecheck
npm run trace:viewer:test
npm run trace:viewer:build
```

Start with the [documentation index](docs/README.md) and [repository instructions](AGENTS.md). Protocol changes should update the relevant specification and regression coverage together.

## License and origin

Source is available under the [MIT license](LICENSE), retaining the original Standard Agents copyright notice. This project derives from [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api) and is maintained independently.

Dependencies retain their own licenses; `@cursor/sdk` is not covered by this repository's MIT license. See [third-party notices](THIRD_PARTY_NOTICES.md).
