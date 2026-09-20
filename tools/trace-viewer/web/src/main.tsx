import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronDown, ChevronRight,
  Ban, Circle, Clock3, Copy, Database, FileText, FileUp, Filter, GitBranch, MessageSquareText,
  PanelRightClose, Play, RefreshCw, RotateCcw, Search, Send, UserRound, Wrench, XCircle
} from "lucide-react";
import {
  App as AntApp, Button, ConfigProvider, Empty, Input, Popover, Segmented, Select,
  Spin, Switch, Tag, Tooltip, Upload
} from "antd";

import "./styles.css";
import { groupInteractions, type InteractionGroup } from "./interaction-model";
import { RuntimePanel } from "./runtime";

type Severity = "normal" | "notice" | "warning" | "error";
type SessionStatus = "observed" | "running" | "completed" | "failed" | "cancelled";
type ViewMode = "trajectory" | "events";
type StepMode = "key" | "issues" | "all";
type SessionFilter = "all" | "running" | "issues" | "partial";
type Model = { id: string; params?: Array<{ id: string; value: string }> };
type TraceEvent = {
  id: string;
  event: string;
  timestamp: string | null;
  timestampMs: number | null;
  offsetMs: number | null;
  invocationId: string;
  unit: string;
  model: Model | null;
  modelKey: string;
  laneId: string;
  severity: Severity;
  recoveryKind?: string;
  fields: Record<string, unknown>;
};
type ProjectionKind =
  | "user_input" | "turn_aborted" | "harness_context" | "final_output" | "error" | "agent_transition" | "replay"
  | "retry" | "recovery" | "context_decision" | "commentary" | "tool_call" | "tool_result"
  | "metadata" | "checkpoint";
type Projection = {
  id: string;
  kind: ProjectionKind;
  priority: number;
  title: string;
  content: string | null;
  timestamp: string | null;
  timestampMs: number | null;
  laneId: string;
  agentId: string | null;
  requestId: string | null;
  requestKind: string | null;
  requestPurpose: string | null;
  sessionSource: string | null;
  ingressRequestId: string | null;
  executionId: string | null;
  runId: string | null;
  inputId: string | null;
  outputId: string | null;
  callId: string | null;
  toolName: string | null;
  status: string | null;
  decision: string | null;
  reason: string | null;
  replayKind: string | null;
  divergenceKind: string | null;
  divergedItemIndex: number | null;
  knownTranscriptItemCount: number | null;
  clientTranscriptItemCount: number | null;
  divergedItemPreview: string | null;
  knownItemPreview: string | null;
  divergedCharOffset: number | null;
  transcriptItemCount: number | null;
  replayedTranscriptItemCount: number | null;
  transcriptSha256: string | null;
  contextItemCount: number | null;
  sentPromptChars: number | null;
  checkpointHash: string | null;
  transitionKind: string | null;
  fromAgentId: string | null;
  toAgentId: string | null;
  recoveryKind: string | null;
  provisional: boolean;
  severity: Severity;
  secondary: boolean;
  sourceEventIds: string[];
  executionIds?: string[];
};
type Lane = {
  id: string;
  agentId: string | null;
  model: Model | null;
  modelKey: string;
  status: string;
  provisional: boolean;
  failureCount: number;
  executionIds: string[];
  eventIds: string[];
  firstSeen: string | null;
  lastSeen: string | null;
};
type Session = {
  id: string;
  title: string | null;
  status: SessionStatus;
  severity: Severity;
  partial: boolean;
  partialReasons: string[];
  issueCount: number;
  errorCount: number;
  warningCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  durationMs: number | null;
  clientSources: string[];
  clientPlatforms: string[];
  requestPurposes: string[];
  models: Model[];
  events: TraceEvent[];
  graph: { nodeIds: string[]; edges: Array<{ id: string; from: string; to: string; type: string }> };
  lanes: Lane[];
  authenticationRecoveries: AuthenticationRecovery[];
  compactionRecoveries: CompactionRecovery[];
  projections: Projection[];
};
type Diagnostics = {
  totalRecords: number;
  acceptedRecords: number;
  malformedLines: number;
  ignoredRecords: number;
  strippedFields: number;
};
type TraceModel = {
  schemaVersion: 3;
  source: { kind?: "file" | "logs"; name?: string; since?: string; bytes?: number; imported?: boolean; partial?: boolean; retentionBounded?: boolean };
  diagnostics: Diagnostics;
  sessions: Session[];
};
type TraceFile = { name: string; bytes: number; modifiedAt: string; oversized: boolean };
type Selection = { kind: "projection" | "event"; id: string } | null;
type AuthenticationRecovery = {
  state: "recovered" | "recovering" | "failed";
  requestId: string;
  fromAgentId: string;
  toAgentId: string;
  rotated: boolean;
  replayed: boolean;
  sourceEventIds: string[];
};
type CompactionRecovery = {
  kind: "context_compaction";
  state: "recovered";
  requestId: string | null;
  fromAgentId: string;
  toAgentId: string;
  sourceEventIds: string[];
};
type TurnGroup = InteractionGroup<Projection>;

const sourceLogs = "__logs__";
const logWindows = ["1h", "6h", "24h", "3d", "7d"];
const statusNames: Record<SessionStatus, string> = {
  observed: "已观测", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消"
};
const kindNames: Record<ProjectionKind, string> = {
  user_input: "用户输入",
  turn_aborted: "打断标记",
  harness_context: "Harness 上下文",
  final_output: "最终输出",
  error: "执行错误",
  agent_transition: "Agent 切换",
  replay: "Replay",
  retry: "Retry",
  recovery: "上下文压缩后已恢复",
  context_decision: "上下文决策",
  commentary: "过程说明",
  tool_call: "工具调用",
  tool_result: "工具结果",
  metadata: "运行记录",
  checkpoint: "Checkpoint"
};
const severityNames: Record<Severity, string> = {
  normal: "正常", notice: "提示", warning: "警告", error: "错误"
};
// Narrative states keep Chinese; machine tokens (causes, replay kinds, error
// codes) intentionally stay English and render verbatim via the valueName
// fallback instead of awkward translations.
const valueNames: Record<string, string> = {
  observed: "已观测", running: "运行中", completed: "已完成", failed: "失败",
  cancelled: "已取消", finished: "已完成", succeeded: "成功", error: "错误",
  terminal: "已结束", accepted: "已接收", received: "已收到", published: "已发布",
  partial: "部分发布", streaming: "输出中", provisional: "暂存", send_failed: "发送失败",
  superseded: "已被替代", initial: "首次请求", continuation: "继续请求", steering: "追加输入",
  retry: "重试请求", forwarded: "已转发", rejected: "已拒绝", aborted: "已中止",
  retry_scheduled: "已安排重试", created: "已创建", resumed: "已恢复", replaced: "已替换",
  start_full: "发送完整上下文", send_incremental: "发送增量上下文", continue_run: "继续当前运行",
  steer_run: "追加到当前运行", reattach: "重新关联", reject: "拒绝",
  session_start_outside_window: "会话开始时间不在当前窗口", missing_parent_request: "缺少上级请求",
  missing_input_content: "缺少输入内容", missing_output_content: "缺少输出内容",
  missing_execution_start: "缺少执行开始事件"
};
const eventNames: Record<string, string> = {
  trajectory_agent_transition: "Agent 切换",
  trajectory_context_checkpoint: "Checkpoint",
  trajectory_context_decision: "上下文决策",
  trajectory_error: "执行错误",
  trajectory_execution_attached: "执行已关联",
  trajectory_execution_started: "执行开始",
  trajectory_execution_terminal: "执行结束",
  trajectory_input_accepted: "输入已接收",
  trajectory_input_content_chunk: "输入内容",
  trajectory_output_content_chunk: "输出内容",
  trajectory_output_published: "输出已发布",
  trajectory_replay: "Replay",
  trajectory_request: "请求进入"
};
const metadataTitleNames: Record<string, string> = {
  "Initial request": "首次请求",
  "Continuation request": "继续请求",
  "Retry request": "重试请求",
  "Steering request": "追加输入请求",
  "Agent created": "Agent 已创建",
  "Execution started": "执行开始",
  "Execution attached": "执行已关联",
  "Client history": "客户端携带历史",
  "context decision": "上下文决策"
};
const clientSourceNames: Record<string, string> = {
  codex: "Codex", openclaw: "OpenClaw", healthcheck: "健康检查", superconductor: "Superconductor Chat", unknown: "未识别来源"
};
const clientPlatformNames: Record<string, string> = {
  linux: "Linux", mac: "macOS", unknown: "平台未识别"
};
const logWindowNames: Record<string, string> = {
  "1h": "1 小时", "6h": "6 小时", "24h": "24 小时", "3d": "3 天", "7d": "7 天"
};
const sensitiveKey = /(?:api[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)/i;

function valueName(value: string | null | undefined, fallback = "未记录") {
  if (!value) return fallback;
  return valueNames[value] ?? value;
}

function eventName(value: string) {
  return eventNames[value] ?? value;
}

function clientSourceName(value: string) {
  if (clientSourceNames[value]) return clientSourceNames[value];
  if (value.startsWith("ua:")) return `UA: ${value.slice(3)}`;
  return value;
}

function clientPlatformName(value: string) {
  return clientPlatformNames[value] ?? value;
}

function ClientMetaTags({ sources, platforms, compactionRecovered = false }: {
  sources: string[];
  platforms: string[];
  compactionRecovered?: boolean;
}) {
  const visiblePlatforms = platforms.filter((value) => value !== "unknown");
  if (!sources.length && !visiblePlatforms.length && !compactionRecovered) return null;
  return (
    <span className="client-meta-tags">
      {sources.map((value) => (
        <Tag key={`source:${value}`} className="meta-tag meta-tag-source">{clientSourceName(value)}</Tag>
      ))}
      {visiblePlatforms.map((value) => (
        <Tag key={`platform:${value}`} className="meta-tag meta-tag-platform">{clientPlatformName(value)}</Tag>
      ))}
      {compactionRecovered && <Tag className="meta-tag meta-tag-recovery">压缩恢复</Tag>}
    </span>
  );
}

function isHealthCheck(session: Session) {
  return session.clientSources.includes("healthcheck");
}

function partialReasonsName(values: string[]) {
  return values.map((value) => value === "log_source_incomplete" ? "日志读取不完整或存在丢弃记录" : valueNames[value] ?? value).join("、");
}

function laneName(laneId: string) {
  return laneId === "transport" ? "传输层" : laneId.slice(6);
}

function itemLabel(item: Projection) {
  if (item.kind === "tool_call") return item.toolName ? `工具调用 · ${item.toolName}` : "工具调用";
  if (item.kind === "tool_result") return item.toolName ? `工具结果 · ${item.toolName}` : "工具结果";
  if (item.kind === "error") return item.status ? `执行${valueName(item.status, "异常")}` : "执行错误";
  if (item.kind === "recovery") return "上下文压缩后已恢复";
  if (item.kind === "turn_aborted") return "打断标记";
  if (item.kind === "metadata") {
    if (item.title.startsWith("Execution ")) return `执行${valueName(item.status, "已结束")}`;
    return metadataTitleNames[item.title] ?? kindNames.metadata;
  }
  return kindNames[item.kind];
}

// Steps that must stay visible even while a turn's routine steps are
// collapsed: agent switches, replays, retries, and anything abnormal.
function isKeyIssue(item: Projection) {
  if (item.recoveryKind) return false;
  return item.kind === "error"
    || item.kind === "agent_transition"
    || item.kind === "replay"
    || item.kind === "retry"
    || (item.kind === "context_decision" && Boolean(item.reason))
    || item.severity === "error"
    || item.severity === "warning";
}

function authenticationRecoveryLabel(recovery: AuthenticationRecovery) {
  if (recovery.state === "recovered") return "认证轮转后已恢复";
  if (recovery.state === "recovering") return "正在进行认证轮转恢复";
  return "认证轮转后仍未恢复";
}

function initialLocation() {
  const params = new URLSearchParams(window.location.search);
  const range = params.get("range") ?? "6h";
  return {
    source: params.get("source") ?? sourceLogs,
    range: logWindows.includes(range) ? range : "6h",
    sessionId: params.get("session"),
    tab: params.get("tab") === "runtime" ? "runtime" : "timeline"
  };
}

const locationState = initialLocation();

function truncate(value: string, max = 120) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatDuration(value: number | null) {
  if (value === null) return "-";
  if (value < 1_000) return `${Math.round(value)} 毫秒`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

function formatBytes(value?: number) {
  if (value === undefined) return "-";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function formatClock(value: string | null) {
  if (!value) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
}

function maskSecrets(value: string) {
  try {
    const parsed = JSON.parse(value);
    const visit = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(visit);
      if (!input || typeof input !== "object") return input;
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, child]) => [
        key, sensitiveKey.test(key) ? "••••••••" : visit(child)
      ]));
    };
    return JSON.stringify(visit(parsed), null, 2);
  } catch {
    return value;
  }
}

function itemIcon(kind: ProjectionKind, size = 14) {
  if (kind === "user_input") return <UserRound size={size} />;
  if (kind === "turn_aborted") return <Ban size={size} />;
  if (kind === "harness_context") return <FileText size={size} />;
  if (kind === "final_output") return <Send size={size} />;
  if (kind === "commentary") return <MessageSquareText size={size} />;
  if (kind === "tool_call" || kind === "tool_result") return <Wrench size={size} />;
  if (kind === "agent_transition") return <GitBranch size={size} />;
  if (kind === "replay" || kind === "retry") return <RotateCcw size={size} />;
  if (kind === "error") return <AlertTriangle size={size} />;
  if (kind === "recovery") return <RotateCcw size={size} />;
  if (kind === "context_decision") return <Bot size={size} />;
  if (kind === "checkpoint") return <Database size={size} />;
  return <Circle size={size} />;
}

function statusIcon(status: SessionStatus, size = 15) {
  if (status === "completed") return <CheckCircle2 size={size} />;
  if (status === "failed" || status === "cancelled") return <XCircle size={size} />;
  if (status === "running") return <Play size={size} />;
  return <Circle size={size} />;
}

function StatusTag({ status }: { status: SessionStatus }) {
  const color = status === "failed" || status === "cancelled" ? "error" : status === "running" ? "processing" : status === "completed" ? "success" : "default";
  return <Tag className="status-tag" color={color} icon={statusIcon(status, 13)}>{statusNames[status]}</Tag>;
}

function SeverityDot({ severity }: { severity: Severity }) {
  return <span className={`severity-dot severity-${severity}`} aria-label={severityNames[severity]} />;
}

function ContentBlock({ content, code = false, clamp = 8 }: { content: string; code?: boolean; clamp?: number }) {
  const [expanded, setExpanded] = useState(false);
  const long = content.length > clamp * 80 || content.split("\n").length > clamp;
  return (
    <div className={`content-block${code ? " content-code" : ""}`}>
      <pre
        className={!expanded && long ? "content-collapsed" : ""}
        style={!expanded && long ? { WebkitLineClamp: clamp } : undefined}
      >{content}</pre>
      {long && <Button type="link" size="small" onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}>
        {expanded ? "收起" : "展开全部"}
      </Button>}
    </div>
  );
}

async function readTrace(response: Response): Promise<TraceModel> {
  const body = await response.json() as TraceModel & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "轨迹无法载入");
  if (body.schemaVersion !== 3) throw new Error(`需要轨迹数据结构 v3，实际收到 v${String(body.schemaVersion)}`);
  return body;
}

function RunItem({ session, selected, onSelect }: { session: Session; selected: boolean; onSelect: () => void }) {
  const recovery = session.authenticationRecoveries.at(-1);
  return (
    <button type="button" className={`run-item${selected ? " selected" : ""}`} onClick={onSelect}>
      <div className="run-item-top">
        <ClientMetaTags sources={session.clientSources} platforms={session.clientPlatforms} compactionRecovered={session.compactionRecoveries.length > 0} />
        <span className="run-time">{formatClock(session.lastSeen)}</span>
      </div>
      <span className="run-title">{session.title ? truncate(session.title, 100) : "尚无用户输入"}</span>
      <div className="run-metadata">
        <SeverityDot severity={session.severity} />
        <span>{statusNames[session.status]}</span>
        {session.errorCount > 0 && <span className="run-issues run-errors">{session.errorCount} 个错误</span>}
        {session.warningCount > 0 && <span className="run-issues run-warnings">{session.warningCount} 个警告</span>}
        {session.partial && <span>数据不完整</span>}
        {recovery && <span className={`recovery-text recovery-${recovery.state}`}>{authenticationRecoveryLabel(recovery)}</span>}
      </div>
    </button>
  );
}

function AgentRef({ laneId, onFilter }: { laneId: string; onFilter: (laneId: string) => void }) {
  return (
    <Tooltip title="只看此 Agent">
      <button type="button" className="agent-ref" onClick={(event) => { event.stopPropagation(); onFilter(laneId); }}>
        {laneId === "transport" ? <Database size={12} /> : <Bot size={12} />}
        <code>{truncate(laneName(laneId), 24)}</code>
      </button>
    </Tooltip>
  );
}

function AgentBar({ session, agentFilter, onJump, onFilter }: {
  session: Session;
  agentFilter: string;
  onJump: (laneId: string) => void;
  onFilter: (laneId: string) => void;
}) {
  const lanes = [...session.lanes.filter((lane) => lane.agentId), ...session.lanes.filter((lane) => !lane.agentId)];
  if (lanes.length < 2 && !lanes.some((lane) => lane.agentId)) return null;
  return (
    <div className="agent-bar" aria-label="Agent 轨道">
      {lanes.map((lane) => (
        <div key={lane.id} className={`agent-pill${agentFilter === lane.id ? " active" : ""}${lane.failureCount ? " failed" : ""}`}>
          <Tooltip title="跳转到首次出现">
            <button type="button" className="agent-pill-jump" onClick={() => onJump(lane.id)}>
              {lane.agentId ? <Bot size={13} /> : <Database size={13} />}
              <code>{lane.agentId ? truncate(lane.agentId, 22) : "传输层"}</code>
              <small>
                {lane.executionIds.length > 0 && `${lane.executionIds.length} 次执行`}
                {lane.failureCount > 0 && ` · ${lane.failureCount} 个错误`}
              </small>
            </button>
          </Tooltip>
          <Tooltip title={agentFilter === lane.id ? "取消过滤" : "只看这条轨道"}>
            <button
              type="button"
              className="agent-pill-filter"
              aria-pressed={agentFilter === lane.id}
              onClick={() => onFilter(agentFilter === lane.id ? "all" : lane.id)}
            ><Filter size={12} /></button>
          </Tooltip>
        </div>
      ))}
      {agentFilter !== "all" && <Button type="link" size="small" onClick={() => onFilter("all")}>显示全部</Button>}
    </div>
  );
}

function AuthenticationRecoveryStrip({ recovery }: { recovery: AuthenticationRecovery }) {
  const finalStep = recovery.state === "recovered"
    ? { icon: <CheckCircle2 size={15} />, label: "恢复成功" }
    : recovery.state === "failed"
      ? { icon: <XCircle size={15} />, label: "恢复失败" }
      : { icon: <Clock3 size={15} />, label: "恢复中" };
  const summary = recovery.state === "recovered"
    ? "旧 Agent 认证失败后已切换到新 Agent，完整重放 SDK 上下文，本次请求最终成功。"
    : recovery.state === "failed"
      ? "旧 Agent 认证失败后已切换到新 Agent，但替代执行仍然失败。"
      : "旧 Agent 认证失败后已切换到新 Agent，替代执行尚未结束。";
  return (
    <section className={`recovery-strip recovery-${recovery.state}`} aria-label={authenticationRecoveryLabel(recovery)}>
      <div className="recovery-copy">
        <strong>{authenticationRecoveryLabel(recovery)}</strong>
        <span>{summary}</span>
      </div>
      <div className="recovery-steps" aria-label="认证恢复步骤">
        <span><AlertTriangle size={15} />认证失败</span>
        <ArrowRight size={14} />
        <span><RotateCcw size={15} />轮转 Agent</span>
        <ArrowRight size={14} />
        <span className={!recovery.replayed ? "step-pending" : ""}><Database size={15} />{recovery.replayed ? "完整重放" : "等待重放"}</span>
        <ArrowRight size={14} />
        <span>{finalStep.icon}{finalStep.label}</span>
      </div>
    </section>
  );
}

function LaneDivider({ laneId, onFilter }: { laneId: string; onFilter: (laneId: string) => void }) {
  return (
    <div className="lane-divider" data-lane={laneId}>
      {laneId === "transport" ? <Database size={13} /> : <Bot size={13} />}
      <code>{truncate(laneName(laneId), 42)}</code>
      <button type="button" onClick={() => onFilter(laneId)}>只看</button>
    </div>
  );
}

function AnchorCard({ item, role, dimmed, selected, showAgent, steering, onSelect, onFilterAgent }: {
  item: Projection;
  role: "input" | "final";
  dimmed: boolean;
  selected: boolean;
  showAgent: boolean;
  onSelect: () => void;
  onFilterAgent: (laneId: string) => void;
  steering?: boolean;
}) {
  const published = item.status === "published";
  const unaccepted = role === "input" && item.status !== "accepted";
  const label = role === "input"
    ? item.kind === "turn_aborted" ? "打断标记" : "用户输入"
    : published ? "最终输出" : "暂存输出";
  return (
    <article
      className={`anchor-card anchor-${role}${item.kind === "turn_aborted" ? " anchor-aborted" : ""}${role === "final" && !published ? " anchor-provisional" : ""}${dimmed ? " out-of-scope" : ""}${selected ? " selected" : ""}`}
      data-lane={item.laneId}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }}
    >
      <header>
        <span className="anchor-label">{role === "input" ? item.kind === "turn_aborted" ? <Ban size={14} /> : <UserRound size={14} /> : <Send size={14} />}{label}</span>
        {role === "input" && steering && item.kind !== "turn_aborted" && <Tag color="processing">追加输入</Tag>}
        {role === "final" && !published && <Tag color="warning">{valueName(item.status ?? "streaming", "未发布")}</Tag>}
        {unaccepted && <Tag color="warning">{valueName(item.status, "未确认接收")}</Tag>}
        {showAgent && item.laneId !== "transport" && <AgentRef laneId={item.laneId} onFilter={onFilterAgent} />}
        <time>{formatClock(item.timestamp)}</time>
      </header>
      {item.content
        ? <ContentBlock content={item.content} clamp={14} />
        : <p className="anchor-missing">内容未记录（当前日志窗口缺少内容分片）</p>}
    </article>
  );
}

// Investigation card for a transcript fork: where the client history stopped
// matching, how much of the known context survived, and the client's version
// of the first mismatching item (the known version exists only as a hash).
function DivergencePanel({ item }: { item: Projection }) {
  const index = item.divergedItemIndex ?? 0;
  const known = item.knownTranscriptItemCount ?? 0;
  const client = item.clientTranscriptItemCount ?? 0;
  const truncated = item.divergenceKind === "client_history_truncated";
  const total = Math.max(known, client, 1);
  return (
    <div className="diverge-panel">
      <div className="diverge-heading">
        <GitBranch size={13} />
        <strong>轨迹分叉</strong>
        <span>{truncated ? "客户端历史被截短" : `第 ${index + 1} 项内容不一致`}</span>
      </div>
      <div className="diverge-bar" aria-hidden="true">
        <span className="diverge-match" style={{ width: `${(index / total) * 100}%` }} />
        <span className={truncated ? "diverge-missing" : "diverge-mismatch"} style={{ width: `${((total - index) / total) * 100}%` }} />
      </div>
      <div className="diverge-facts">
        <span>{index === 0 ? "从第 1 项起即不一致" : `前 ${index} 项与已知上下文一致`}</span>
        <span>已知 {known} 项</span>
        <span>本次客户端携带 {client} 项</span>
        {truncated && known > client && <span>缺少尾部 {known - client} 项</span>}
        {item.reason && <code>{item.reason}</code>}
      </div>
      {item.divergedItemPreview && <div className="diverge-preview">
        {item.knownItemPreview ? (
          <>
            <span className="diverge-preview-label">
              第 {index + 1} 项两个版本对照
              {item.divergedCharOffset !== null && <>（前 {item.divergedCharOffset} 字符一致，差异从此处开始）</>}
            </span>
            {item.knownItemPreview === item.divergedItemPreview ? (
              <>
                <ContentBlock content={item.divergedItemPreview} code clamp={4} />
                <p className="diverge-hint">两个版本的可见文本一致——差异在不可见的结构字段（如图片、角色或元数据）。</p>
              </>
            ) : (
              <>
                <span className="diverge-version known">已知版本（上一轮请求）</span>
                <ContentBlock content={item.knownItemPreview} code clamp={4} />
                <span className="diverge-version client">本次客户端版本</span>
                <ContentBlock content={item.divergedItemPreview} code clamp={4} />
              </>
            )}
          </>
        ) : (
          <>
            <span className="diverge-preview-label">客户端本次的第 {index + 1} 项（已知版本无文本快照可对照）</span>
            <ContentBlock content={item.divergedItemPreview} code clamp={4} />
          </>
        )}
      </div>}
      <p className="diverge-hint">
        {truncated
          ? "客户端丢弃了已知历史的尾部，常见于客户端 compaction 或回滚到更早的上下文；SDK 上下文已按本次请求完整重建。"
          : "客户端在该位置发来了与已知记录不同的内容，常见于客户端 compaction 或历史改写；可与本会话更早轮次相同位置的输入/输出对照。"}
      </p>
    </div>
  );
}

function StepRow({ item, selected, onSelect }: {
  item: Projection;
  selected: boolean;
  onSelect: () => void;
}) {
  const code = item.kind === "tool_call" || item.kind === "tool_result";
  const content = code && item.content ? maskSecrets(item.content) : item.content;
  const showStatus = item.status
    && !["published", "accepted", "received"].includes(item.status)
    && !(item.kind === "commentary" && item.status === "streaming");
  return (
    <article
      className={`step-row kind-${item.kind} severity-${item.severity}${item.secondary ? " secondary" : ""}${selected ? " selected" : ""}`}
      data-lane={item.laneId}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }}
    >
      <div className="step-marker">{itemIcon(item.kind)}</div>
      <div className="step-body">
        <div className="step-heading">
          <strong>{itemLabel(item)}</strong>
          {item.provisional && <Tag>暂存</Tag>}
          {showStatus && <Tag>{valueName(item.status)}</Tag>}
          <time>{formatClock(item.timestamp)}</time>
        </div>
        {content && <ContentBlock content={content} code={code} clamp={item.kind === "harness_context" ? 2 : code ? 3 : 8} />}
        {!content && <div className="step-summary">
          {item.replayKind === "sdk_context" && <span>向 SDK 完整重放 {item.contextItemCount ?? "?"} 个上下文项</span>}
          {item.replayKind === "client_transcript" && item.transcriptItemCount !== null && <span>
            请求携带 {item.transcriptItemCount} 项历史{item.replayedTranscriptItemCount !== null
              ? `（新增 ${item.transcriptItemCount - item.replayedTranscriptItemCount} 项，其余与已知上下文一致）`
              : ""}
          </span>}
          {item.replayKind && !["sdk_context", "client_transcript"].includes(item.replayKind) && <code>{item.replayKind}</code>}
          {item.transcriptSha256 && <code>摘要 {truncate(item.transcriptSha256, 16)}</code>}
          {item.replayKind === "sdk_context" && item.checkpointHash && <code>检查点 {truncate(item.checkpointHash, 16)}</code>}
          {item.fromAgentId && <code>{truncate(item.fromAgentId, 18)}</code>}
          {item.fromAgentId && item.toAgentId && <ArrowRight size={13} />}
          {item.toAgentId && <code>{truncate(item.toAgentId, 18)}</code>}
          {item.decision && <span>{valueName(item.decision)}</span>}
          {item.reason && <code>{item.reason}</code>}
          {item.executionId && <code>{truncate(item.executionId, 28)}</code>}
          {!item.executionId && item.requestId && <code>{truncate(item.requestId, 28)}</code>}
        </div>}
        {item.callId && <div className="step-facts"><Wrench size={12} />调用 <code>{item.callId}</code></div>}
        {item.divergedItemIndex !== null && <DivergencePanel item={item} />}
      </div>
    </article>
  );
}

function RawEvent({ event, selected, onSelect }: { event: TraceEvent; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`raw-event${selected ? " selected" : ""}`} onClick={onSelect}>
      <SeverityDot severity={event.severity} />
      <time>{formatClock(event.timestamp)}</time>
      <span className="raw-event-name">{event.recoveryKind === "context_compaction" ? `${eventName(event.event)} · 压缩后已恢复` : eventName(event.event)}</span>
      <span>{truncate(laneName(event.laneId), 20)}</span>
      <span>{String(event.fields.executionId ?? event.fields.requestId ?? "")}</span>
    </button>
  );
}

function DetailPanel({ session, selection, onClose, onOpenEvent }: {
  session: Session;
  selection: Selection;
  onClose: () => void;
  onOpenEvent: (id: string) => void;
}) {
  const projection = selection?.kind === "projection" ? session.projections.find((item) => item.id === selection.id) ?? null : null;
  const event = selection?.kind === "event" ? session.events.find((item) => item.id === selection.id) ?? null : null;
  if (!projection && !event) return null;
  const title = projection
    ? itemLabel(projection)
    : event?.recoveryKind === "context_compaction" ? `${eventName(event.event)} · 压缩后已恢复` : event ? eventName(event.event) : "事件";
  const timestamp = projection?.timestamp ?? event?.timestamp ?? null;
  const lane = projection?.laneId ?? event?.laneId ?? "transport";
  const content = projection?.content ?? null;
  const fields = event?.fields ?? (projection ? Object.fromEntries(Object.entries({
    inputId: projection.inputId,
    outputId: projection.outputId,
    requestId: projection.requestId,
    requestKind: projection.requestKind,
    requestPurpose: projection.requestPurpose,
    sessionSource: projection.sessionSource,
    ingressRequestId: projection.ingressRequestId,
    executionId: projection.executionId,
    runId: projection.runId,
    callId: projection.callId,
    status: projection.status,
    decision: projection.decision,
    reason: projection.reason,
    replayKind: projection.replayKind,
    divergenceKind: projection.divergenceKind,
    divergedItemIndex: projection.divergedItemIndex,
    knownTranscriptItemCount: projection.knownTranscriptItemCount,
    clientTranscriptItemCount: projection.clientTranscriptItemCount,
    divergedItemPreview: projection.divergedItemPreview,
    knownItemPreview: projection.knownItemPreview,
    divergedCharOffset: projection.divergedCharOffset,
    transcriptItemCount: projection.transcriptItemCount,
    replayedTranscriptItemCount: projection.replayedTranscriptItemCount,
    transcriptSha256: projection.transcriptSha256,
    contextItemCount: projection.contextItemCount,
    sentPromptChars: projection.sentPromptChars,
    checkpointHash: projection.checkpointHash,
    transitionKind: projection.transitionKind,
    fromAgentId: projection.fromAgentId,
    toAgentId: projection.toAgentId,
    recoveryKind: projection.recoveryKind
  }).filter(([, value]) => value !== null && value !== undefined)) : {});
  const copyValue = content ?? JSON.stringify(fields, null, 2);
  return (
    <aside className="detail-panel">
      <div className="detail-header">
        <h2>{title}</h2>
        <div>
          <Tooltip title="复制"><Button type="text" icon={<Copy size={16} />} onClick={() => void navigator.clipboard.writeText(copyValue)} /></Tooltip>
          <Tooltip title="关闭"><Button type="text" icon={<PanelRightClose size={16} />} onClick={onClose} /></Tooltip>
        </div>
      </div>
      <div className="detail-scroll">
        <dl className="detail-facts">
          <div><dt>时间</dt><dd>{formatDateTime(timestamp)}</dd></div>
          <div><dt>轨道</dt><dd><code>{laneName(lane)}</code></dd></div>
          <div><dt>会话</dt><dd><code>{session.id}</code></dd></div>
        </dl>
        {content && <ContentBlock content={projection?.kind === "tool_call" || projection?.kind === "tool_result" ? maskSecrets(content) : content} code={projection?.kind === "tool_call" || projection?.kind === "tool_result"} clamp={20} />}
        <h3>规范字段</h3>
        <ContentBlock content={maskSecrets(JSON.stringify(fields, null, 2))} code clamp={20} />
        {projection && <div className="source-events">
          <h3>来源事件</h3>
          {projection.sourceEventIds.map((id) => <button type="button" key={id} onClick={() => onOpenEvent(id)}><code>{id}</code></button>)}
        </div>}
      </div>
    </aside>
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function App() {
  const { message } = AntApp.useApp();
  const [tab, setTab] = useState(locationState.tab);
  const [trace, setTrace] = useState<TraceModel | null>(null);
  const [files, setFiles] = useState<TraceFile[]>([]);
  const [source, setSource] = useState(locationState.source);
  const [range, setRange] = useState(locationState.range);
  const [sessionId, setSessionId] = useState<string | null>(locationState.sessionId);
  const [agentFilter, setAgentFilter] = useState("all");
  const [view, setView] = useState<ViewMode>("trajectory");
  const [stepMode, setStepMode] = useState<StepMode>("key");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [sessionQuery, setSessionQuery] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [showHealthChecks, setShowHealthChecks] = useState(false);
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const traceRequested = useRef(false);

  const applyTrace = useCallback((next: TraceModel, selectedSessionId?: string) => {
    setTrace(next);
    setSessionId((current) => {
      if (selectedSessionId) return selectedSessionId;
      const keep = next.sessions.find((session) => session.id === current);
      if (keep && (showHealthChecks || !isHealthCheck(keep))) return current;
      return next.sessions.find((session) => !isHealthCheck(session))?.id
        ?? (showHealthChecks ? next.sessions[0]?.id ?? null : null);
    });
  }, [showHealthChecks]);

  const refreshFiles = useCallback(async () => {
    const response = await fetch("/api/files");
    const body = await response.json() as { files?: TraceFile[]; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "文件列表无法载入");
    setFiles(body.files ?? []);
  }, []);

  const loadLogs = useCallback(async (windowValue: string, silent = false, selectedSessionId?: string) => {
    traceRequested.current = true;
    if (!silent) setLoading(true);
    try {
      applyTrace(await readTrace(await fetch(`/api/logs?since=${encodeURIComponent(windowValue)}`)), selectedSessionId);
    } catch (error) {
      if (!silent) message.error(errorMessage(error, "实时日志无法载入"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applyTrace, message]);

  const loadFile = useCallback(async (name: string) => {
    traceRequested.current = true;
    setLoading(true);
    try {
      applyTrace(await readTrace(await fetch(`/api/files/${encodeURIComponent(name)}`)));
    } catch (error) {
      message.error(errorMessage(error, "轨迹无法载入"));
    } finally {
      setLoading(false);
    }
  }, [applyTrace, message]);

  const importFile = useCallback(async (file: File) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const next = await readTrace(response);
      applyTrace(next);
      setSource(next.source.name ?? file.name);
      await refreshFiles();
      message.success(`${next.source.name ?? file.name} 已导入`);
    } catch (error) {
      message.error(errorMessage(error, "轨迹导入失败"));
    } finally {
      setLoading(false);
    }
  }, [applyTrace, message, refreshFiles]);

  useEffect(() => {
    void refreshFiles().catch((error) => message.error(errorMessage(error, "文件列表无法载入")));
  }, []);

  useEffect(() => {
    if (tab !== "timeline" || traceRequested.current) return;
    if (source === sourceLogs) void loadLogs(range, false, sessionId ?? undefined);
    else void loadFile(source);
  }, [tab, source, range, sessionId, loadLogs, loadFile]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (source !== sourceLogs) params.set("source", source);
    if (source === sourceLogs && range !== "6h") params.set("range", range);
    if (sessionId) params.set("session", sessionId);
    if (tab === "runtime") params.set("tab", "runtime");
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [source, range, sessionId, tab]);

  useEffect(() => {
    if (!pendingJump) return;
    const frame = requestAnimationFrame(() => {
      const nodes = scrollRef.current?.querySelectorAll<HTMLElement>("[data-lane]") ?? [];
      const node = [...nodes].find((candidate) => candidate.dataset.lane === pendingJump);
      if (node) {
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
        node.classList.add("jump-flash");
        window.setTimeout(() => node.classList.remove("jump-flash"), 1500);
      }
      setPendingJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingJump]);

  const normalizedSessionQuery = sessionQuery.trim().toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  const sessions = useMemo(() => (trace?.sessions ?? []).filter((session) => {
    if (!showHealthChecks && isHealthCheck(session)) return false;
    if (filter === "running" && session.status !== "running") return false;
    if (filter === "issues" && session.issueCount === 0) return false;
    if (filter === "partial" && !session.partial) return false;
    if (!normalizedSessionQuery) return true;
    return JSON.stringify({ id: session.id, title: session.title, sources: session.clientSources, models: session.models }).toLowerCase().includes(normalizedSessionQuery);
  }), [trace, filter, normalizedSessionQuery, showHealthChecks]);
  const session = trace?.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const turnGroups = useMemo(() => groupInteractions(session?.projections ?? []), [session]);
  const agentLaneCount = session?.lanes.filter((lane) => lane.agentId).length ?? 0;
  const rawEvents = useMemo(() => (session?.events ?? []).filter((event) => {
    if (agentFilter !== "all" && event.laneId !== agentFilter) return false;
    if (!normalizedQuery) return true;
    return JSON.stringify(event).toLowerCase().includes(normalizedQuery);
  }), [session, agentFilter, normalizedQuery]);

  const matchesAgent = (item: Projection) => agentFilter === "all" || item.laneId === agentFilter;
  const matchesQuery = (item: Projection) => !normalizedQuery || JSON.stringify(item).toLowerCase().includes(normalizedQuery);
  const modeAllows = (item: Projection) => {
    if (stepMode === "all") return true;
    if (stepMode === "key") return item.kind === "recovery" || (!item.recoveryKind && item.kind !== "metadata" && item.kind !== "checkpoint");
    return isKeyIssue(item);
  };

  const selectSession = (id: string) => {
    setSessionId(id);
    setAgentFilter("all");
    setSelection(null);
    setExpandedTurns(new Set());
    setView("trajectory");
  };
  const openRuntimeSession = (id: string) => {
    selectSession(id);
    setTab("timeline");
    if (source !== sourceLogs || !trace?.sessions.some((item) => item.id === id)) {
      setSource(sourceLogs);
      void loadLogs(range, false, id);
    }
  };
  const chooseSource = (next: string) => {
    setSource(next);
    setSelection(null);
    setAgentFilter("all");
    if (next === sourceLogs) void loadLogs(range);
    else void loadFile(next);
  };
  const refresh = () => source === sourceLogs ? void loadLogs(range) : void loadFile(source);
  const toggleHealthChecks = (checked: boolean) => {
    setShowHealthChecks(checked);
    if (!checked && session && isHealthCheck(session)) {
      const fallback = trace?.sessions.find((candidate) => !isHealthCheck(candidate))?.id ?? null;
      if (fallback) selectSession(fallback);
      else setSessionId(null);
    }
  };
  const filterLane = (laneId: string) => {
    setAgentFilter(laneId);
  };
  const jumpToLane = (laneId: string) => {
    setView("trajectory");
    if (agentFilter !== "all" && agentFilter !== laneId) setAgentFilter("all");
    // The jump target may sit inside collapsed routine steps.
    setExpandedTurns(new Set(turnGroups.map((group) => group.id)));
    setPendingJump(laneId);
  };
  const toggleTurn = (id: string) => {
    setExpandedTurns((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sourcePanel = (
    <div className="source-panel">
      <label>数据源</label>
      <Select value={source} onChange={chooseSource} options={[
        { value: sourceLogs, label: "实时日志" },
        ...files.map((file) => ({ value: file.name, label: file.oversized ? `${file.name}（过大）` : file.name, disabled: file.oversized }))
      ]} />
      {source === sourceLogs && <><label>日志范围</label><Select value={range} onChange={(next) => { setRange(next); void loadLogs(next); }} options={logWindows.map((value) => ({ value, label: logWindowNames[value] }))} /></>}
      <Upload beforeUpload={(file) => { void importFile(file); return false; }} showUploadList={false}><Button icon={<FileUp size={15} />}>导入轨迹文件</Button></Upload>
      {trace && <div className="source-diagnostics">
        <span>已接收 {trace.diagnostics.acceptedRecords}</span><span>已忽略 {trace.diagnostics.ignoredRecords}</span><span>{formatBytes(trace.source.bytes)}</span>
      </div>}
    </div>
  );

  const renderTurnGroup = (group: TurnGroup) => {
    const visibleSteps = group.steps.filter((item) => matchesAgent(item) && matchesQuery(item) && modeAllows(item));
    const anchors = [...group.inputs, ...group.finals];
    const anchorsMatch = anchors.some((item) => matchesAgent(item) && matchesQuery(item));
    if (!visibleSteps.length && !anchorsMatch) return null;
    const hasInput = group.inputs.length > 0;
    const completed = group.status === "completed";
    const failed = group.status === "failed" || group.status === "cancelled";
    const expanded = expandedTurns.has(group.id);
    // Collapsed turns still show key steps (agent switches, replays, errors);
    // only routine steps hide behind the toggle.
    const highlights = visibleSteps.filter(isKeyIssue);
    const shownSteps = expanded ? visibleSteps : highlights;
    const hiddenCount = visibleSteps.length - shownSteps.length;
    // Per-turn digests: computed over every step of the turn, not only the
    // currently visible ones, so filters cannot hide a full replay or switch.
    const transitions = group.steps.filter((item) => item.kind === "agent_transition" && !item.recoveryKind);
    const recoveries = group.steps.filter((item) => item.kind === "recovery");
    const fullSends = group.steps.filter((item) => item.decision === "start_full");
    const incremental = group.steps.filter((item) => ["send_incremental", "continue_run", "steer_run"].includes(item.decision ?? ""));
    const historyChecks = group.steps.filter((item) => item.replayKind === "client_transcript");
    const fullSendCauses = [...new Set(fullSends.map((item) => item.reason).filter((reason): reason is string => Boolean(reason) && reason !== "first_turn"))];
    const divergedStep = group.steps.find((item) => item.divergedItemIndex !== null);
    const contextParts: ReactNode[] = [];
    if (fullSends.length) contextParts.push(<span key="full" className={fullSendCauses.length ? "context-warn" : ""}>
      完整发送 {fullSends.length} 次{fullSendCauses.length > 0 && <>（<code>{fullSendCauses.join(", ")}</code>{divergedStep && <> · 分叉于第 {divergedStep.divergedItemIndex! + 1} 项</>}）</>}
    </span>);
    if (incremental.length) contextParts.push(<span key="incremental">增量复用 {incremental.length} 次</span>);
    if (historyChecks.length) contextParts.push(<span key="history">客户端携带历史 {historyChecks.length} 次</span>);
    if (recoveries.length) contextParts.push(<span key="recovery">压缩后恢复 {recoveries.length} 次</span>);
    const stepRows: ReactNode[] = [];
    let previousLane = group.inputs[0]?.laneId ?? null;
    for (const item of shownSteps) {
      if (agentLaneCount > 1 && agentFilter === "all" && item.laneId !== previousLane) {
        stepRows.push(<LaneDivider key={`divider-${item.id}`} laneId={item.laneId} onFilter={filterLane} />);
      }
      previousLane = item.laneId;
      stepRows.push(<StepRow
        key={item.id}
        item={item}
        selected={selection?.kind === "projection" && selection.id === item.id}
        onSelect={() => setSelection({ kind: "projection", id: item.id })}
      />);
    }
    const anchorProps = (item: Projection) => ({
      item,
      dimmed: !(matchesAgent(item) && matchesQuery(item)),
      selected: selection?.kind === "projection" && selection.id === item.id,
      showAgent: agentLaneCount > 1,
      onSelect: () => setSelection({ kind: "projection", id: item.id }),
      onFilterAgent: filterLane
    });
    return (
      <section className="turn" key={group.id}>
        <header className="turn-header">
          <span className="turn-index">{hasInput ? `第 ${group.index} 轮` : "会话准备"}</span>
          {hasInput && <span className={`turn-status ${completed ? "done" : failed ? "failed" : "open"}`}>
            {completed ? <CheckCircle2 size={13} /> : failed ? <XCircle size={13} /> : <Clock3 size={13} />}
            {statusNames[group.status]}
          </span>}
          {transitions.length > 0 && <span className="turn-flag">
            <GitBranch size={12} />
            Agent 切换{transitions.length > 1 ? ` × ${transitions.length}` : ""}
          </span>}
        </header>
        {group.inputs.map((item, index) => <AnchorCard
          key={item.id}
          role="input"
          steering={item.requestKind === "steering" || index > 0}
          {...anchorProps(item)}
        />)}
        {contextParts.length > 0 && <div className="turn-context-summary" aria-label="SDK 上下文摘要">
          <Database size={12} />
          <span className="context-label">SDK 上下文</span>
          {contextParts}
        </div>}
        {visibleSteps.length > 0 && <div className="turn-steps">
          {expanded && <button type="button" className="steps-toggle" onClick={() => toggleTurn(group.id)}>
            <ChevronDown size={14} />
            收起中间过程 · {visibleSteps.length} 项
          </button>}
          {shownSteps.length > 0 && <div className="step-list">{stepRows}</div>}
          {!expanded && hiddenCount > 0 && <button type="button" className="steps-toggle" onClick={() => toggleTurn(group.id)}>
            <ChevronRight size={14} />
            展开中间过程 · 还有 {hiddenCount} 项
          </button>}
        </div>}
        {group.finals.map((item) => <AnchorCard key={item.id} role="final" {...anchorProps(item)} />)}
        {hasInput && !group.finals.length && <p className="turn-pending">尚未发布最终输出</p>}
      </section>
    );
  };

  const turnSections = view === "trajectory" ? turnGroups.map(renderTurnGroup).filter(Boolean) : [];

  return (
    <div className={`app-shell ${tab}-active`}>
      <header className="topbar">
        <div className="topbar-navigation">
          <div className="brand"><Activity size={16} /><strong>运行轨迹</strong></div>
          <nav className="main-tabs" role="tablist" aria-label="查看范围">
            <button type="button" role="tab" id="timeline-tab" aria-selected={tab === "timeline"} aria-controls="timeline-panel" onClick={() => setTab("timeline")}><FileText size={14} />时间线</button>
            <button type="button" role="tab" id="runtime-tab" aria-selected={tab === "runtime"} aria-controls="runtime-panel" onClick={() => setTab("runtime")}><Activity size={14} />当前状态</button>
          </nav>
        </div>
        {tab === "timeline" && <div className="topbar-actions">
          <Popover content={sourcePanel} trigger="click" open={sourceOpen} onOpenChange={setSourceOpen} placement="bottomRight">
            <Button icon={<Database size={15} />}>{source === sourceLogs ? `实时日志 · ${logWindowNames[range]}` : trace?.source.name ?? source}<ChevronDown size={13} /></Button>
          </Popover>
          <Tooltip title="刷新"><Button icon={<RefreshCw size={16} className={loading ? "spin" : ""} />} onClick={refresh} /></Tooltip>
        </div>}
      </header>
      <RuntimePanel visible={tab === "runtime"} onOpenSession={openRuntimeSession} />
      <div className={`workspace${selection ? " detail-open" : ""}`} hidden={tab !== "timeline"} id="timeline-panel" role="tabpanel" aria-labelledby="timeline-tab">
        <aside className="run-sidebar">
          <div className="sidebar-heading">
            {trace?.source.retentionBounded && <div className="sidebar-meta" role="status">{trace.source.partial ? "日志读取不完整，可能缺少事件。" : "实时日志受容量与时间窗口限制。"}</div>}
            <Input allowClear prefix={<Search size={13} />} placeholder="搜索会话" value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} />
            <Segmented<SessionFilter> block size="small" value={filter} onChange={setFilter} options={[{ label: "全部", value: "all" }, { label: "运行中", value: "running" }, { label: "问题", value: "issues" }, { label: "不完整", value: "partial" }]} />
            <div className="sidebar-meta">
              <span>{sessions.length} 个会话</span>
              <label className="health-filter-toggle"><span>健康检查</span><Switch size="small" checked={showHealthChecks} onChange={toggleHealthChecks} /></label>
            </div>
          </div>
          <div className="run-list">
            {sessions.map((item) => <RunItem key={item.id} session={item} selected={item.id === sessionId} onSelect={() => selectSession(item.id)} />)}
            {!sessions.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的会话" />}
          </div>
        </aside>
        <main className="trace-main">
          {session ? <>
            <div className="trace-header">
              <h1>{session.title ? truncate(session.title, 160) : "尚无用户输入"}</h1>
              <div className="trace-meta">
                <StatusTag status={session.status} />
                {session.partial && <Tooltip title={partialReasonsName(session.partialReasons)}><Tag className="status-tag" color="warning" icon={<AlertTriangle size={13} />}>数据不完整</Tag></Tooltip>}
                <ClientMetaTags sources={session.clientSources} platforms={session.clientPlatforms} compactionRecovered={session.compactionRecoveries.length > 0} />
                <span>{session.models.map((model) => model.id).join(" + ") || "模型未记录"}</span>
                <span><Clock3 size={12} />{formatDuration(session.durationMs)}</span>
                <span>{formatDateTime(session.firstSeen)}</span>
                <code>{session.id}</code>
              </div>
            </div>
            {session.authenticationRecoveries.at(-1) && <AuthenticationRecoveryStrip recovery={session.authenticationRecoveries.at(-1)!} />}
            <div className="trace-toolbar">
              <AgentBar session={session} agentFilter={agentFilter} onJump={jumpToLane} onFilter={filterLane} />
              <div className="toolbar-controls">
                <Input className="trace-search" allowClear size="small" prefix={<Search size={13} />} placeholder="过滤轨迹内容" value={query} onChange={(event) => setQuery(event.target.value)} />
                {view === "trajectory" && <Segmented<StepMode> size="small" value={stepMode} onChange={setStepMode} options={[{ label: "重点", value: "key" }, { label: "问题", value: "issues" }, { label: "全部", value: "all" }]} />}
                <Segmented<ViewMode> size="small" value={view} onChange={(next) => { setView(next); setSelection(null); }} options={[{ label: "轨迹", value: "trajectory" }, { label: `原始事件 ${session.events.length}`, value: "events" }]} />
              </div>
            </div>
            <div className="main-scroll" ref={scrollRef}>
              {view === "trajectory" && <div className="turn-list">
                {turnSections}
                {!turnSections.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的轨迹内容" />}
              </div>}
              {view === "events" && <div className="raw-events">
                {rawEvents.map((event) => <RawEvent key={event.id} event={event} selected={selection?.kind === "event" && selection.id === event.id} onSelect={() => setSelection({ kind: "event", id: event.id })} />)}
                {!rawEvents.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的规范事件" />}
              </div>}
            </div>
          </> : <div className="empty-main"><Empty description={loading ? "正在载入轨迹" : sessionId ? "当前日志范围内没有此会话" : "请选择一个会话"} /></div>}
        </main>
        {session && selection && <DetailPanel session={session} selection={selection} onClose={() => setSelection(null)} onOpenEvent={(id) => { setView("events"); setSelection({ kind: "event", id }); }} />}
      </div>
      {tab === "timeline" && loading && !trace && <div className="initial-loading"><Spin size="large" /></div>}
    </div>
  );
}

createRoot(document.getElementById("app")!).render(
  <ConfigProvider theme={{ token: { colorPrimary: "#222222", borderRadius: 4, fontSize: 14 } }}>
    <AntApp><App /></AntApp>
  </ConfigProvider>
);
