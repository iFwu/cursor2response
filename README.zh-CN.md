# cursor2response

**复用 Cursor 会话，在同一个 Run 中续接工具调用，让执行过程清晰可见。**

[English](README.md) · 简体中文

面向 OpenAI Responses API 客户端的本地 Cursor SDK 网关，内置 Trace Viewer。经过 **Codex 和 OpenClaw** 日常使用中的持续验证，重点解决会话复用、工具续接和执行过程可观测性。

![cursor2response 功能概览](docs/images/overview-zh-CN.png)

网关运行在本机，模型推理仍使用 Cursor 服务，需要你自己的 Cursor API Key。本项目独立维护，非 Cursor 官方产品。

## 快速开始

安装 Docker Engine 和 Docker Compose，然后执行：

```bash
git clone https://github.com/ifwu/cursor2response.git
cd cursor2response
cp .env.example .env
openssl rand -hex 32
```

将生成的随机值填入 `.env` 的 `CURSOR_SDK_BRIDGE_TOKEN`，用于内部 Bridge 调用鉴权；它与 Cursor API Key 是两个独立凭据。客户端可以自行提供 Cursor Key，也可以在 `.env` 中设置 `CURSOR_API_KEY`，作为单用户部署的默认 Key。

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:6718/health
curl --fail http://127.0.0.1:8100/health
```

| 组件 | 地址 |
| --- | --- |
| API base URL | `http://127.0.0.1:6718/v1` |
| Trace Viewer | `http://127.0.0.1:8100` |
| SDK Bridge | 仅 Compose 内部网络可访问 |

在客户端中填写上述 API base URL、你的 Cursor API Key，选择 **Responses** 模式，并使用 `/v1/models` 返回的 model ID：

```bash
curl --fail http://127.0.0.1:6718/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
```

两个对外端口默认只绑定 localhost。请保管好 `.env`。Viewer 没有用户鉴权，可能展示对话内容；如果配置了默认 Cursor Key，能够访问 API 的调用者就能使用该凭据。

配置、源码运行、升级和备份见[本地部署指南](docs/runbooks/local-deployment.md)。镜像由源码在本地构建，项目不提供托管网关或预构建发布镜像。

## 接入客户端

将 `MODEL_ID` 替换为 `/v1/models` 返回的模型 ID。客户端进程的环境中需要有 `CURSOR_API_KEY`；网关的 `.env` 不会自动配置另一个客户端进程。

```bash
export CURSOR_API_KEY="your-cursor-api-key"
```

### Codex

将以下设置合并到 `~/.codex/config.toml`，根级设置应放在 TOML table 之前：

```toml
model_provider = "cursor2response"
model = "MODEL_ID"

[model_providers.cursor2response]
name = "cursor2response"
base_url = "http://127.0.0.1:6718/v1"
wire_api = "responses"
env_key = "CURSOR_API_KEY"
```

在已设置 `CURSOR_API_KEY` 的终端运行 `codex`，无需预先创建 named profile。

### OpenClaw

将以下内容合并到 `~/.openclaw/openclaw.json`，替换两处 `MODEL_ID`：

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

如果已有 `agents.defaults.models` 模型 allowlist，需要将 `cursor2response/MODEL_ID` 加入其中。Key 必须在实际运行 Gateway 的进程环境中可用；在另一个终端执行 `export` 不会改变已运行服务的环境。按现有 OpenClaw 服务管理方式使配置生效。

示例未指定上下文限制。默认值不等于实测 SDK 上限；请根据所选模型和配置的路由设置 `contextWindow` 与 `agents.defaults.contextTokens`，说明见[上下文预算](docs/specs/grok-hybrid.md#client-context-budgets)。

### Claude Code（best effort）

安装 Claude Code 后，选用 `/v1/models` 返回的可用 Claude 模型 ID。这里的 base URL 不带 `/v1`：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:6718 \
ANTHROPIC_API_KEY="$CURSOR_API_KEY" \
claude --model MODEL_ID
```

此方式使用 best-effort Anthropic Messages 适配。可在 Claude Code 的 `/status` 中确认 base URL 和生效的凭据；持久化设置见 [Claude Code 网关配置](https://code.claude.com/docs/en/llm-gateway-connect)。

## 看清一次会话的执行过程

Trace Viewer 将同一 session 的请求、Agent lanes、SDK Runs、工具调用和路由变化串起来，直接查看上下文复用、replay 和工具续接，无需逐条拼接原始日志。

![Trace Viewer 会话时间线](docs/images/trace-timeline.png)

识别出的 Codex/OpenClaw harness 上下文会折叠为次级条目，让用户请求和工具活动更容易找到。

Runtime 页面从 Bridge 查询当前 Agent 和待处理任务。历史 trace 用来解释已经发生的过程，runtime snapshot 用来确认此刻仍在运行的状态。

![Trace Viewer 实时运行状态](docs/images/trace-runtime.png)

截图使用合成演示数据。实时会话和 trace 检查方法见 [Trace Viewer 指南](docs/runbooks/trace-viewer.md)。

## 主要特性

| 能力 | 实际作用 |
| --- | --- |
| **会话复用** | 兼容的后续轮次复用 SDK Agent，只发送缺失的输入后缀，为 prompt cache 复用保留条件。 |
| **同一 Run 内工具续接** | 后续 HTTP 请求送回的工具结果直接完成原 SDK Run 的回调，保持 SDK agent loop 连续。 |
| **Native steer** | 符合条件的新指令通过 `Run.steer()` 进入正在执行的 Run，并按顺序处理、确认送达。 |
| **Trace Viewer** | 在本地页面查看会话历史、工具活动、上下文 replay、provider 切换和当前 runtime 归属。 |
| **上下文溢出 fallback** | 显式启用 `grok-hybrid` 后，确认 SDK context compaction 时可转到配置的 OpenAI-compatible Responses endpoint 继续。 |
| **明确的执行边界** | 保留 assistant commentary 与 final 阶段；取消操作指向所属执行；干净结束的 Agent 可在重启后恢复。 |

![会话与 runtime 流程](docs/images/runtime-flow-zh-CN.png)

一次 HTTP 请求不等于一次 SDK Run：同一个 Run 可以跨越多轮工具请求。后续用户轮次可以在原 Agent 上开启新 Run，也可以 steer 符合条件的活跃执行。复用需要稳定且兼容的 session identity 和对话历史；明确的恢复边界仍可能触发完整 replay。缓存行为由 provider 决定，项目不承诺固定命中率。

Fallback 有明确范围：选择 `grok-hybrid` 或 `grok-hybrid-fast` 并配置 provider 后才会启用。只有确认 SDK context compaction 才触发，普通错误不会触发。当前请求立即 fallback 还需要确认清理完成且尚未输出公开内容，后续请求则沿已记录的路由继续。详见[路由契约](docs/specs/grok-hybrid.md)。

Grok 也可通过模型 ID 选择速度：`grok-hybrid-fast` 使用 Fast SDK 路由并保留已配置的溢出 fallback；`cursor-grok-fast` 直接走 Cursor。底层请求还可使用 `service_tier` 等 Fast 参数，显式参数的优先级见[路由契约](docs/specs/grok-hybrid.md#identity-and-state)。

Responses 还支持原生 `system_prompt` 扩展：非空字符串替换主 Agent 的 Cursor system prompt；省略或设为 `false` 使用 SDK 默认值。覆盖需要账号支持，不适用于 Grok hybrid 路由；复用同一 Agent 的各次请求应保持该值一致。详见[系统提示词契约](docs/specs/responses-agent-context-affinity.md#native-system-prompt)。

## 项目缘起

本项目源于 [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api) 的 fork，起因是[上游 issue #1](https://github.com/NGLSG/Cursor2API/issues/1) 中的缓存命中与会话复用问题。最初的目标是避免每次客户端请求都重建 SDK 上下文，并让工具往返留在 SDK 原有执行中。

随后在 Codex 和 OpenClaw 中持续自用和实证验证，逐步完善了工具续接、steering、取消、transcript 对齐和 trace 跟踪。项目在维护者的日常工作流中稳定下来后，作为以 Responses 为主、有独立 runtime 和协议契约的项目开源分享。

## 兼容范围与边界

- **主要 API：** `/v1/responses`，包括流式响应、客户端工具、工具结果续接和 session affinity。Codex 与 OpenClaw 是主要真实客户端验收路径。
- **Best effort：** `/v1/chat/completions`、`/v1/messages` 和 `/v1/messages/count_tokens`，不声明完整协议兼容。
- **Runtime：** 所有服务统一使用 Node.js 24 LTS，支持本地 Docker Compose 或源码运行。Docker 整套运行路径已在 Linux amd64 验证，其他平台尚未验收。
- **对话历史：** 客户端需保留要求的公开历史，包括工具调用、结果和 assistant phases；`previous_response_id` 不能代替这些历史。
- **重启行为：** Compose 持久化 SDK checkpoints 和 Bridge 状态；干净结束的 Agent 可以恢复，活跃 Run 和待返回的工具回调不会跨进程重启保留。`docker compose down` 保留 volumes，`docker compose down -v` 会删除它们。
- **上下文计量：** token 估算不是权威 SDK context 测量，单次长 prompt 成功不能证明多轮对话的安全上下文上限。
- **Trace 隐私：** 日志与状态可能包含 prompt、工具参数及结果，分享前需检查并脱敏。

具体兼容范围见[协议支持说明](docs/specs/protocol-support.md)。

## 从源码运行

安装 Node.js 24 LTS 和 npm 后执行：

```bash
npm ci
npm run build
node server.mjs start
node server.mjs status
```

Launcher 是轻量的 API + Bridge 启动方式，会生成自己的内部 token，并将进程状态和 launcher 日志放在 `~/.cursor2response`。使用 `node server.mjs stop` 停止。单独启动 Viewer 不会自动发现该 token；需要完整 API + Bridge + Viewer 时，请使用 Docker Compose 或[三终端源码部署](docs/runbooks/local-deployment.md#direct-source-execution)，不要混用 launcher。

API 启动后，在已导出 `CURSOR_API_KEY` 的终端中，可从源码目录以表格查看模型：

```bash
node server.mjs models
node server.mjs models --json
```

API 使用其他端口时附加 `--port PORT`。

## 开发与文档

```bash
npm run typecheck
npm test
npm run test:operations
npm run trace:viewer:typecheck
npm run trace:viewer:test
npm run trace:viewer:build
```

从[文档索引](docs/README.md)和[仓库约定](AGENTS.md)开始。协议变更应同步更新对应 spec 和回归覆盖。

## 致谢 · Credits

- [standardagents/composer-api](https://github.com/standardagents/composer-api)：采用 MIT 许可的原始项目，为后续 fork 提供基础。
- [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api)：本项目的直接上游，在原始项目上扩展了 sidecar 部署、Responses / Messages / Chat 三协议和客户端适配。
- `@cursor/sdk` 与 Cursor Composer 模型：提供网关所依托的 SDK 与模型能力。
- [LINUX DO](https://linux.do)：提供交流与讨论的社区。

cursor2response 在上述项目与贡献的基础上继续扩展，现独立维护。

## 许可 · License

项目源码采用 [MIT license](LICENSE)，保留原 Standard Agents 版权声明。

依赖保留各自许可；`@cursor/sdk` 不适用本仓库的 MIT license。详见[第三方声明](THIRD_PARTY_NOTICES.md)。
