import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, ChevronRight, Clock3, Copy, RefreshCw, Search, Unplug, Wrench } from "lucide-react";
import { App, Button, Empty, Input, Select, Spin, Tag, Tooltip } from "antd";

type Phase = "starting" | "running" | "waiting_tools" | "terminal_delivery" | "cancelling";
type RuntimeIdentity = {
  sessionKey: string; sdkSessionKey: string; requestId: string; executionId: string;
  agentId: string; runId: string | null; generation: number;
};
type RuntimeRun = RuntimeIdentity & {
  initialRequestId: string; model: string | null; phase: Phase; createdAt: string; ageMs: number;
  subscriber: { attached: boolean; requestId: string | null }; pendingToolCount: number; pendingToolCallIds: string[]; waitingSince: string | null;
  leaseExpiresAt: string | null; leaseRemainingMs: number | null;
  terminalError: { code: string; status: number } | null;
};
type Termination = RuntimeIdentity & {
  reason: "cancelled" | "lease_expired" | "failed"; errorCode: string; terminatedAt: string; pendingToolCount: number;
};
type RuntimeSnapshot = {
  schemaVersion: 1; observedAt: string; serviceInvocationId: string; pid: number; startedAt: string;
  pendingLeaseMs: number; cleanupTimeoutMs: number;
  counts: { agents: number; activeRuns: number; waitingTools: number; detachedRuns: number };
  runs: RuntimeRun[]; recentTerminations: Termination[];
  counters: { cancelled: number; leaseExpired: number; authenticationFailures: number; cleanupFailures: number };
};

const phaseNames: Record<Phase, string> = {
  starting: "启动中", running: "运行中", waiting_tools: "等待工具", terminal_delivery: "终态待交付", cancelling: "取消中"
};
const phaseColors: Record<Phase, string> = {
  starting: "default", running: "processing", waiting_tools: "warning", terminal_delivery: "default", cancelling: "error"
};
const terminationNames = { cancelled: "已取消", lease_expired: "Lease 到期", failed: "失败" };

function duration(value: number | null) {
  if (value === null) return "-";
  const seconds = Math.max(0, Math.floor(value / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function dateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function Identity({ label, value }: { label: string; value: string | number | null }) {
  return <div><dt>{label}</dt><dd><code>{value ?? "-"}</code></dd></div>;
}

function RunIdentity({ item }: { item: RuntimeIdentity }) {
  return <>
    <Identity label="Session" value={item.sessionKey} />
    <Identity label="SDK Session" value={item.sdkSessionKey} />
    <Identity label="Request" value={item.requestId} />
    <Identity label="Execution" value={item.executionId} />
    <Identity label="Agent" value={item.agentId} />
    <Identity label="Run" value={item.runId} />
    <Identity label="Generation" value={item.generation} />
  </>;
}

function SessionLink({ sessionKey, onOpenSession }: { sessionKey: string; onOpenSession: (id: string) => void }) {
  const { message } = App.useApp();
  return <div className="runtime-session-link">
    <button type="button" onClick={() => onOpenSession(sessionKey)} title={sessionKey}><code>{sessionKey || "会话未记录"}</code><ArrowRight size={13} /></button>
    <Tooltip title="复制 Session ID"><Button size="small" type="text" aria-label="复制 Session ID" icon={<Copy size={12} />} onClick={() => {
      void navigator.clipboard.writeText(sessionKey).then(() => message.success("Session ID 已复制"), () => message.error("Session ID 复制失败"));
    }} /></Tooltip>
  </div>;
}

export function RuntimePanel({ visible, onOpenSession }: { visible: boolean; onOpenSession: (id: string) => void }) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [phase, setPhase] = useState("all");
  const [query, setQuery] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/runtime", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.code === "runtime_invalid_snapshot" ? "运行状态数据无效" : "Bridge 当前不可用");
      if (data.schemaVersion !== 1 || !Number.isFinite(Date.parse(data.observedAt))) throw new Error("运行状态数据无效");
      setSnapshot(data as RuntimeSnapshot);
      setUpdatedAt(Date.now());
      setNow(Date.now());
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error && cause.name === "Error" ? cause.message : "运行状态连接中断");
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const update = () => {
      if (document.visibilityState !== "visible") {
        requestRef.current?.abort();
        return;
      }
      setNow(Date.now());
      void refresh();
    };
    update();
    const timer = window.setInterval(update, 5000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      requestRef.current?.abort();
    };
  }, [visible, refresh]);

  const queryValue = query.trim().toLowerCase();
  const matchesIdentity = (item: RuntimeIdentity) => [item.sessionKey, item.sdkSessionKey, item.requestId, item.executionId, item.agentId, item.runId]
    .some((value) => value?.toLowerCase().includes(queryValue));
  const runs = snapshot?.runs.filter((item) => (phase === "all" || (phase === "detached" ? !item.subscriber.attached : item.phase === phase)) && matchesIdentity(item)) ?? [];
  const terminations = snapshot?.recentTerminations.filter(matchesIdentity).slice().reverse() ?? [];
  const stale = Boolean(snapshot && (error || !updatedAt || now - updatedAt > 15000 || now - Date.parse(snapshot.observedAt) > 15000));
  const elapsed = updatedAt && !stale ? Math.max(0, now - updatedAt) : 0;

  return <main className="runtime-panel" hidden={!visible} id="runtime-panel" role="tabpanel" aria-labelledby="runtime-tab">
    <header className="runtime-heading">
      <div><h1>当前运行状态</h1><span className={`runtime-connection ${error ? "unavailable" : stale ? "stale" : snapshot ? "connected" : ""}`}>
        {error ? <Unplug size={13} /> : stale ? <AlertTriangle size={13} /> : <Activity size={13} />}
        {error ? snapshot ? "连接中断 · 保留上次快照" : "Bridge 不可用" : stale ? "快照已陈旧" : snapshot ? "Bridge 已连接" : "正在连接"}
      </span></div>
      <div className="runtime-refresh">
        {snapshot && <time title={dateTime(snapshot.observedAt)}>快照 {new Date(snapshot.observedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time>}
        <Tooltip title="刷新运行状态"><Button aria-label="刷新运行状态" disabled={loading} icon={<RefreshCw size={15} className={loading ? "spin" : ""} />} onClick={() => void refresh()} /></Tooltip>
      </div>
    </header>

    {error && <div className="runtime-notice" role="alert"><AlertTriangle size={15} /><span>{error}{snapshot ? ` · 最后成功获取 ${updatedAt ? dateTime(new Date(updatedAt).toISOString()) : "-"}` : ""}</span></div>}
    {stale && !error && <div className="runtime-notice" role="status"><Clock3 size={15} /><span>快照已超过 15 秒，当前运行状态尚未确认</span></div>}

    {snapshot && <>
      <dl className={`runtime-counts${stale ? " is-stale" : ""}`}>
        <div><dt>Agents</dt><dd>{snapshot.counts.agents}</dd></div>
        <div><dt>活动 Runs</dt><dd>{snapshot.counts.activeRuns}</dd></div>
        <div className="waiting"><dt><Wrench size={13} />等待工具</dt><dd>{snapshot.counts.waitingTools}</dd></div>
        <div><dt><Unplug size={13} />无 Subscriber</dt><dd>{snapshot.counts.detachedRuns}</dd></div>
      </dl>
      <div className="runtime-service">
        <span>Pending lease <strong>{duration(snapshot.pendingLeaseMs)}</strong></span>
        <span>Cleanup <strong>{duration(snapshot.cleanupTimeoutMs)}</strong></span>
        <span>PID <code>{snapshot.pid}</code></span>
        <span>启动 <time>{dateTime(snapshot.startedAt)}</time></span>
        <span className="runtime-invocation">Invocation <code title={snapshot.serviceInvocationId}>{snapshot.serviceInvocationId}</code></span>
      </div>
    </>}

    <div className="runtime-filters">
      <Input aria-label="搜索运行状态" allowClear prefix={<Search size={14} />} placeholder="搜索 Session 或运行 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Select aria-label="运行状态筛选" value={phase} onChange={setPhase} options={[
        { value: "all", label: "全部状态" }, ...Object.entries(phaseNames).map(([value, label]) => ({ value, label })), { value: "detached", label: "无 Subscriber" }
      ]} />
      {snapshot && <span>{runs.length} / {snapshot.runs.length} 个 Run</span>}
    </div>

    {!snapshot ? <div className="runtime-empty">{loading ? <Spin /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未获取运行状态" />}</div> : <div className="runtime-scroll">
      <section className={`runtime-runs${stale ? " is-stale" : ""}`} aria-label="当前 Runs">
        <div className="runtime-run-columns"><span>状态 / Session</span><span>等待 / 运行时长</span><span>Pending tools</span><span>Lease 剩余</span><span>Subscriber</span></div>
        {runs.map((run) => <details className="runtime-run" key={`${run.executionId}:${run.generation}:${run.agentId}`}>
          <summary>
            <div className="runtime-run-primary"><ChevronRight size={14} /><Tag color={phaseColors[run.phase]}>{phaseNames[run.phase]}</Tag><code title={run.sessionKey}>{run.sessionKey || "会话未记录"}</code><span>{run.model}</span></div>
            <div className="runtime-run-value"><span>{run.waitingSince ? "等待时长" : "运行时长"}</span><strong>{duration(run.waitingSince ? Date.parse(snapshot.observedAt) - Date.parse(run.waitingSince) + elapsed : run.ageMs + elapsed)}</strong></div>
            <div className="runtime-run-value"><span>Pending tools</span><strong>{run.pendingToolCount}</strong></div>
            <div className={`runtime-run-value${run.leaseRemainingMs !== null && run.leaseRemainingMs < 300000 ? " lease-warning" : ""}`}><span>Lease 剩余</span><strong>{duration(run.leaseRemainingMs === null ? null : run.leaseRemainingMs - elapsed)}</strong></div>
            <div className="runtime-run-value"><span>Subscriber</span><strong>{run.subscriber.attached ? "已连接" : "无"}</strong></div>
          </summary>
          <div className="runtime-run-detail">
            <SessionLink sessionKey={run.sessionKey} onOpenSession={onOpenSession} />
            <dl className="runtime-identities">
              <RunIdentity item={run} />
              <Identity label="Initial request" value={run.initialRequestId} />
              <Identity label="Subscriber" value={run.subscriber.requestId} />
              <Identity label="创建时间" value={dateTime(run.createdAt)} />
              <Identity label="运行时长" value={duration(run.ageMs + elapsed)} />
              <Identity label="开始等待" value={run.waitingSince ? dateTime(run.waitingSince) : null} />
              <Identity label="Lease 到期" value={run.leaseExpiresAt ? dateTime(run.leaseExpiresAt) : null} />
              {run.terminalError && <Identity label="终态错误" value={`${run.terminalError.code} (${run.terminalError.status})`} />}
            </dl>
            {run.pendingToolCallIds.length > 0 && <div className="runtime-tool-ids"><strong>Pending tool call IDs</strong>{run.pendingToolCallIds.map((id) => <code key={id}>{id}</code>)}</div>}
          </div>
        </details>)}
        {!runs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={snapshot.runs.length ? "没有匹配的 Run" : stale ? "上次快照没有活动 Run" : "当前没有活动 Run"} />}
      </section>

      <section className="runtime-terminations">
        <header><h2>最近终止</h2><div className="runtime-counters">
          <span>取消 {snapshot.counters.cancelled}</span><span>Lease 到期 {snapshot.counters.leaseExpired}</span><span>认证失败 {snapshot.counters.authenticationFailures}</span><span>Cleanup 失败 {snapshot.counters.cleanupFailures}</span>
        </div></header>
        {terminations.map((item) => <details key={`${item.executionId}:${item.generation}:${item.terminatedAt}`} className="runtime-termination">
          <summary><ChevronRight size={14} /><Tag color={item.reason === "cancelled" ? "default" : "error"}>{terminationNames[item.reason]}</Tag><code title={item.sessionKey}>{item.sessionKey}</code><span>{item.errorCode}</span><time>{dateTime(item.terminatedAt)}</time></summary>
          <div className="runtime-run-detail"><SessionLink sessionKey={item.sessionKey} onOpenSession={onOpenSession} /><dl className="runtime-identities"><RunIdentity item={item} /><Identity label="Pending tools" value={item.pendingToolCount} /></dl></div>
        </details>)}
        {!terminations.length && <p className="runtime-no-terminations">{queryValue ? "没有匹配的终止记录" : "暂无终止记录"}</p>}
      </section>
    </div>}
  </main>;
}
