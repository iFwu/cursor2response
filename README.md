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

## Connect a client

Use a model ID from `/v1/models` in place of `MODEL_ID`. The client process must have `CURSOR_API_KEY` in its environment; the gateway's `.env` does not configure a separate client process.

```bash
export CURSOR_API_KEY="your-cursor-api-key"
```

### Codex

Merge these settings into `~/.codex/config.toml`, keeping root settings above any TOML tables:

```toml
model_provider = "cursor2response"
model = "MODEL_ID"

[model_providers.cursor2response]
name = "cursor2response"
base_url = "http://127.0.0.1:6718/v1"
wire_api = "responses"
env_key = "CURSOR_API_KEY"
```

Run `codex` from a terminal with `CURSOR_API_KEY` set. No named profile is required.

### OpenClaw

Merge this into `~/.openclaw/openclaw.json`; replace both occurrences of `MODEL_ID`:

```json5
{
  models: {
    mode: "merge",
    providers: {
      cursor2response: {
        baseUrl: "http://127.0.0.1:6718/v1",
        apiKey: "${CURSOR_API_KEY}",
        api: "openai-responses",
        models: [{ id: "MODEL_ID", name: "Cursor" }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "cursor2response/MODEL_ID" },
    },
  },
}
```

If you already use an `agents.defaults.models` allowlist, add `cursor2response/MODEL_ID` there. Make the key available to the actual Gateway process; exporting it in a different terminal does not update a running service. Apply the configuration through your normal OpenClaw service workflow.

The example leaves context limits unset. Defaults are not measured SDK limits: choose `contextWindow` and `agents.defaults.contextTokens` for your model and configured route, as described in [context budgets](docs/specs/grok-hybrid.md#client-context-budgets).

### Claude Code (best effort)

With Claude Code installed, use a Claude model ID available through `/v1/models`. Its base URL excludes `/v1`:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:6718 \
ANTHROPIC_API_KEY="$CURSOR_API_KEY" \
claude --model MODEL_ID
```

This uses the Anthropic Messages adapter, which remains best effort. Check `/status` in Claude Code to confirm the base URL and active credential; see [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect) for persistent settings.

## Trace your conversation

The Viewer connects a session's requests, Agent lanes, SDK Runs, tool calls, and route changes. It makes context reuse, replay, and tool continuation visible without piecing together raw logs.

![Trace Viewer session timeline](docs/images/trace-timeline.png)

Recognized Codex/OpenClaw harness context is collapsed into secondary entries, keeping the user request and tool activity easy to find.

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

Grok model IDs also select speed: `grok-hybrid-fast` uses the Fast SDK route with configured overflow fallback; `cursor-grok-fast` goes directly through Cursor. Low-level requests can use Fast parameters, including `service_tier`; explicit parameter precedence is described in the [routing contract](docs/specs/grok-hybrid.md#identity-and-state).

Responses also supports a native `system_prompt` extension: a non-empty string replaces the main Agent's Cursor system prompt, while omission or `false` uses the SDK default. This requires account support, is unavailable on Grok hybrid routes, and must stay consistent across requests reusing an Agent. See the [system prompt contract](docs/specs/responses-agent-context-affinity.md#native-system-prompt).

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

The launcher is a lightweight API + Bridge mode. It generates its own internal token and keeps process state and launcher logs under `~/.cursor2response`. Stop it with `node server.mjs stop`. A separately started Viewer does not discover that token. For the complete API + Bridge + Viewer setup, use Docker Compose or the [three-terminal source setup](docs/runbooks/local-deployment.md#direct-source-execution) instead of the launcher.

With the API running and `CURSOR_API_KEY` exported, list models from the checkout without a raw JSON response:

```bash
node server.mjs models
node server.mjs models --json
```

Use `--port PORT` if the API uses a different port.

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

## Credits

- [standardagents/composer-api](https://github.com/standardagents/composer-api) — the original MIT-licensed project on which this lineage is based.
- [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api) — our direct upstream, which extended the original project with sidecar deployment, Responses / Messages / Chat support, and client integrations.
- `@cursor/sdk` and Cursor Composer models — the SDK and model capabilities behind the gateway.
- [LINUX DO](https://linux.do) — a community for discussion and exchange.

cursor2response is independently maintained and builds on these projects and contributions.

## License

Source is available under the [MIT license](LICENSE), retaining the original Standard Agents copyright notice.

Dependencies retain their own licenses; `@cursor/sdk` is not covered by this repository's MIT license. See [third-party notices](THIRD_PARTY_NOTICES.md).
