# cursor2response

**复用 Cursor 会话，在同一 Run 内续接工具调用，让执行链路清晰可见。**

[English](README.md) · 简体中文

面向 **Codex 与 OpenClaw** 等客户端的本地 Cursor SDK 网关，专注 OpenAI Responses 协议，内置 Trace Viewer。核心支持长会话复用、同一 Run 内工具续接与执行全链路可视化。

![cursor2response 功能概览](docs/images/overview-zh-CN.png)

网关运行在本机，模型推理依托 Cursor 服务，需提供个人 Cursor API Key。本项目独立维护，非 Cursor 官方产品。

## 快速开始

环境要求：Docker Engine 与 Docker Compose。

```bash
git clone https://github.com/ifwu/cursor2response.git
cd cursor2response
cp .env.example .env
openssl rand -hex 32
```

将生成的随机字符串填入 `.env` 的 `CURSOR_SDK_BRIDGE_TOKEN`（用于网关内部 Sidecar 与 Bridge 间鉴权）。客户端可各自在请求头携带 Cursor Key；亦可在 `.env` 中指定 `CURSOR_API_KEY` 作为单用户部署的默认 Key。

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:6718/health
curl --fail http://127.0.0.1:8100/health
```

| 服务 | 地址 | 访问范围 |
| --- | --- | --- |
| API Base URL | `http://127.0.0.1:6718/v1` | 本地回环（127.0.0.1） |
| Trace Viewer | `http://127.0.0.1:8100` | 本地回环（127.0.0.1） |
| SDK Bridge | 内部端口 | 仅 Compose 内部网络 |

列出当前账号可用的模型 ID：

```bash
curl --fail http://127.0.0.1:6718/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
```

> **安全提示**：对外端口默认仅绑定 `127.0.0.1`。Trace Viewer 无内置鉴权，请勿直接暴露至公网；配置了默认 `CURSOR_API_KEY` 时，任何可访问 API 的客户端均可消耗该配额。完整配置与持久化备份见[本地部署指南](docs/runbooks/local-deployment.md)。

若当前网络需要代理才能访问 Cursor 服务，可在 `.env` 中配置标准 HTTP(S) 代理变量。Docker 宿主地址、HTTP/1.1 fallback、自定义 CA 与验收边界见[网络代理说明](docs/runbooks/local-deployment.md#network-proxy)。

## 接入客户端

将下方配置中的 `MODEL_ID` 替换为 `/v1/models` 返回的实际模型 ID。

在运行客户端的环境中设置 `CURSOR_API_KEY`：

```bash
export CURSOR_API_KEY="your-cursor-api-key"
```

### Codex

将以下配置合并至 `~/.codex/config.toml`（顶层配置需置于任何 `[table]` 之前）：

```toml
model_provider = "cursor2response"
model = "MODEL_ID"

[model_providers.cursor2response]
name = "cursor2response"
base_url = "http://127.0.0.1:6718/v1"
wire_api = "responses"
env_key = "CURSOR_API_KEY"
```

直接在终端运行 `codex` 即可，无需指定 profile。

### OpenClaw

将以下配置合并至 `~/.openclaw/openclaw.json`：

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

> **提示**：若配置了 `agents.defaults.models` 白名单，需同步加入 `cursor2response/MODEL_ID`。实际使用建议根据模型特性合理配置 `contextWindow` 与 `agents.defaults.contextTokens`，详见[上下文预算说明](docs/specs/grok-hybrid.md#client-context-budgets)。

### Claude Code（兼容模式）

启动时指定本地端点（Base URL 不带 `/v1`）：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:6718 \
ANTHROPIC_API_KEY="$CURSOR_API_KEY" \
claude --model MODEL_ID
```

此路径通过 Anthropic Messages 协议做最佳努力适配。可在 Claude Code 内输入 `/status` 核对端点状态；持久化配置见 [Claude Code 网关文档](https://code.claude.com/docs/en/llm-gateway-connect)。

## Trace 链路可视化

Trace Viewer 将同一 Session 内的请求流转、Agent 迁移、SDK Run 生命周期、工具调用及路由决策整合为统一时间线，直观呈现上下文复用与工具续接，告别低效的日志翻找。

![Trace Viewer 会话时间线](docs/images/trace-timeline.png)

对 Codex / OpenClaw 注入的环境预设与元数据，时间线会自动折叠为次级条目，突出真实用户意图与工具交互。

切换至 Runtime 视图可实时掌握 Bridge 内存中的活跃 Agent、挂起 Run 及租约状态：

![Trace Viewer 实时运行状态](docs/images/trace-runtime.png)

截图基于合成演示数据。排查流程与日志规格参见 [Trace Viewer 指南](docs/runbooks/trace-viewer.md)。

## 核心特性

| 特性 | 说明 |
| --- | --- |
| **会话复用** | 轮次间自动复用 SDK Agent，仅增量发送历史后缀，最大化保留服务端 prompt cache 机会。 |
| **同一 Run 内工具续接** | 客户端返回的工具结果直接结算原 SDK Run 挂起的回调，维持 SDK 内部 agent loop 完整。 |
| **Native Steer** | 运行中的 Run 支持通过 `Run.steer()` 顺序接入新指令，无需中断当前执行。 |
| **Trace Viewer** | 本地可视化面板，直观审计会话历史、上下文重放、工具耗时与运行时归属。 |
| **上下文溢出 Fallback** | 启用 `grok-hybrid` 后，遭遇 SDK context compaction 时无缝切换至配置的外部 Responses 端点。 |
| **原生系统提示词扩展** | 请求支持 `system_prompt` 参数，可自定义或完全剥离 Cursor 默认系统提示词。 |
| **清晰的执行边界** | 区分过程思考与最终回复；支持精准关联取消；重启后支持恢复已干净完结的 Agent。 |

![会话与 runtime 流程](docs/images/runtime-flow-zh-CN.png)

### 核心机制

- **请求与 Run 解耦**：一次 HTTP 请求不等于一次 SDK Run。多次工具往返均在同一 Run 内闭环，避免每次工具返回都重新组装模型上下文。
- **多轮复用与 Steering**：新轮次可在同一 Agent 上开启新 Run；若上一次执行尚未结束，新指令可通过 native steer 机制排队注入。
- **前缀匹配与重放保护**：复用严格基于对话历史的前缀哈希比对。若检测到客户端对历史进行了总结压缩或手动修改，网关自动回退为全量重放，保障上下文一致性。
- **Grok Hybrid 路由策略**：使用 `grok-hybrid` 或 `grok-hybrid-fast` 时，仅在确认触发 SDK context compaction 且当前请求尚未对外输出内容时执行安全降级，此后该会话固定沿外部端点继续。详见[路由契约](docs/specs/grok-hybrid.md)。
- **原生 `system_prompt` 覆盖**：Responses 请求可传入非空字符串直接替换 Cursor SDK 默认系统提示词，或传 `false` 使用默认配置（需账号权限支持）。详见[系统提示词契约](docs/specs/responses-agent-context-affinity.md#native-system-prompt)。

## 项目缘起

本项目最初源自对 [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api) 的 fork，旨在解决[上游 issue #1](https://github.com/NGLSG/Cursor2API/issues/1) 提出的核心痛点：避免每次客户端请求都全量重建 SDK 上下文，并使多轮工具交互能够维持在同一执行生命周期中。

在深度适配 Codex 与 OpenClaw 的工程实践中，项目进一步补齐了单 Run 工具续接、原生指令注入（steering）、精准取消控制、对话历史严格对齐以及全链路 Trace Viewer 观测系统，最终演进为一个拥有独立运行时与严密协议契约的 Responses 本地网关。

## 兼容范围与运行约束

- **核心协议：** `/v1/responses`，全面支持流式传输、客户端工具定义、工具结果连续回传及会话亲和性。Codex 与 OpenClaw 为核心验收标准。
- **兼容端点（Best Effort）：** `/v1/chat/completions`、`/v1/messages` 及 `/v1/messages/count_tokens` 仅作基础功能适配，不承诺所有上游参数行为完全对齐。
- **运行时：** 源码运行支持 Node.js 24 及以上版本（已验证 Node 24 与 26）；Linux amd64 Docker 镜像继续固定 Node.js 24 LTS，作为稳定部署基线。
- **客户端历史要求：** 客户端必须自行维护并传回完整的上下文历史（包括工具调用、返回结果与阶段标注）；`previous_response_id` 不能替代历史内容。
- **状态持久化：** Docker Compose 持久化 SDK checkpoint 与 Bridge 状态索引。正常退出的 Agent 重启后可无缝恢复，但运行中的任务与待返回的工具回调无法跨进程恢复。
- **上下文计量：** 网关返回的 token 用量为基于字符的估算值，不代表 Cursor SDK 内部真实窗口占用；单次长 prompt 成功不代表多轮交互的安全上限。
- **Trace 数据脱敏：** 追踪日志会包含实际 prompt 及工具出入参，对外分享日志文件前请务必审查脱敏。

详细协议支持清单参见[协议支持说明](docs/specs/protocol-support.md)。

## 源码运行

若需直接通过 Node.js 24 及以上版本与 npm 运行：

```bash
npm ci
npm run build
node server.mjs start
node server.mjs status
```

`server.mjs` 会先加载仓库中的 `.env`，再启动轻量级 API + Bridge 本地后台守护。内部 Token 与进程状态存于 `~/.cursor2response`，使用 `node server.mjs stop` 停止。

启动后可在终端直接列出可用模型表格：

```bash
node server.mjs models
node server.mjs models --json
```

> **注意**：独立启动的 Trace Viewer 无法自动感知 `server.mjs` 的动态 Token。如需同时使用 API、Bridge 与 Trace Viewer，建议使用 Docker Compose 或参考[三终端源码部署说明](docs/runbooks/local-deployment.md#direct-source-execution)。

## 开发与测试

```bash
npm run typecheck
npm test
npm run test:operations
npm run trace:viewer:typecheck
npm run trace:viewer:test
npm run trace:viewer:build
```

从[文档索引](docs/README.md)和[仓库约定](AGENTS.md)开始。协议变更应同步更新对应 spec 和回归测试覆盖。

## 致谢 · Credits

- [standardagents/composer-api](https://github.com/standardagents/composer-api)：采用 MIT 许可的原始项目，为后续 fork 提供基础。
- [NGLSG/cursor2api](https://github.com/NGLSG/cursor2api)：本项目的直接上游，在原始项目上扩展了 sidecar 部署、Responses / Messages / Chat 三协议和客户端适配。
- `@cursor/sdk` 与 Cursor Composer 模型：提供网关所依托的 SDK 与模型能力。
- [LINUX DO](https://linux.do)：提供交流与讨论的社区。

cursor2response 在上述项目与贡献的基础上继续扩展，现独立维护。

## 许可 · License

项目源码采用 [MIT license](LICENSE)，保留原 Standard Agents 版权声明。

依赖保留各自许可；`@cursor/sdk` 不适用本仓库的 MIT license。详见[第三方声明](THIRD_PARTY_NOTICES.md)。
