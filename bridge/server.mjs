import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import http from "node:http";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  CURSOR_SDK_SUMMARY_HOOK_MARKER,
  createCursorSdkSummaryHooks,
  resolveCursorSdkLoadContract
} from "./cursor-sdk-summary-loader.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cursorSdkLoadContract = resolveCursorSdkLoadContract();
registerHooks(createCursorSdkSummaryHooks(cursorSdkLoadContract));
const { Agent, Cursor } = await import(cursorSdkLoadContract.entryUrl);
const cursorSdkSummaryHookMarker = globalThis[Symbol.for(CURSOR_SDK_SUMMARY_HOOK_MARKER)];
if (
  cursorSdkSummaryHookMarker?.version !== cursorSdkLoadContract.packageVersion
  || cursorSdkSummaryHookMarker?.url !== cursorSdkLoadContract.entryUrl
) {
  throw new Error("Cursor SDK summary hook did not transform the loaded SDK entry.");
}
delete globalThis[Symbol.for(CURSOR_SDK_SUMMARY_HOOK_MARKER)];

loadEnvFile(path.join(repoRoot, ".env"));
loadEnvFile(path.join(process.cwd(), ".env"));
configureCursorSdkNetwork(Cursor, process.env);

const host = process.env.CURSOR_SDK_BRIDGE_HOST || "127.0.0.1";
const port = parseInteger(process.env.CURSOR_SDK_BRIDGE_PORT, 8792);
const bridgeToken = process.env.CURSOR_SDK_BRIDGE_TOKEN || "";
const maxJsonBytes = parseInteger(process.env.CURSOR_SDK_BRIDGE_MAX_JSON_BYTES, 1024 * 1024);
const maxAgents = parseInteger(process.env.CURSOR_SDK_BRIDGE_MAX_AGENTS, 128);
const runIdleTimeoutMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS, 180 * 1000);
const runMaxTimeoutMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_RUN_MAX_TIMEOUT_MS, 300 * 1000);
const toolBatchDiscoveryMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_TOOL_BATCH_DISCOVERY_MS, 10);
const toolBatchGraceMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_TOOL_BATCH_GRACE_MS, 10);
const toolCallUsageSettleTimeoutMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_TOOL_USAGE_SETTLE_TIMEOUT_MS, 2 * 1000);
const maxRunRetries = parseInteger(process.env.CURSOR_SDK_BRIDGE_MAX_RUN_RETRIES, 3);
const retryBaseDelayMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_RETRY_BASE_DELAY_MS, 500);
const pendingLeaseMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_PENDING_LEASE_MS, 65 * 60 * 1000);
const runCleanupTimeoutMs = parseInteger(process.env.CURSOR_SDK_BRIDGE_RUN_CLEANUP_TIMEOUT_MS, 5 * 1000);
const traceMaxTextChars = parseInteger(process.env.CURSOR_SDK_TRACE_MAX_TEXT_CHARS, 6 * 1024);
const traceChunkMaxChars = parseInteger(process.env.CURSOR_SDK_TRACE_CHUNK_MAX_CHARS, 6 * 1024);
const trajectoryMaxContentChars = 128 * 1024;
const defaultCwd = process.env.CURSOR_SDK_WORKING_DIRECTORY || process.cwd();
const agentStateDirectory = path.resolve(process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR || path.join(
  process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"),
  "cursor2response",
  "bridge-agents"
));
const agentStateMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const agentStateMaxEntries = 4096;
const agentStatePruneInterval = 256;
const clientMcpServerName = "client";
const clientMcpServerMode = "--client-mcp-server";
const clientToolCallbackPath = "/client-tool-call";
const ABORTED_TOOL_RESULT_MESSAGE = "Turn was aborted before a tool result was submitted.";
const diagnosticsStartedAt = process.hrtime.bigint();
const serviceInvocationId = process.env.INVOCATION_ID || `bridge_${crypto.randomUUID()}`;
const RECOVERY_PROMPT_SUFFIX = [
  "[cursor2response recovery]",
  "This message is a full replay of an existing conversation because the previous Agent was unavailable.",
  "The transcript above is history, not a new task to re-plan. Client tools are already registered as native custom tools; do not search the transcript for tool schemas or ask for schemas.",
  "Continue from the latest user message and call tools immediately if work remains."
].join("\n");

function normalizedClientSource(value) {
  const source = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (source === "codex" || source === "openclaw" || source === "healthcheck" || source === "superconductor") {
    return source;
  }
  return /^ua:[a-z][a-z0-9._-]{0,63}$/.test(source) ? source : "unknown";
}

function normalizedClientPlatform(value) {
  const platform = typeof value === "string" ? value.trim().toLowerCase() : "";
  return platform === "linux" || platform === "mac" ? platform : "unknown";
}

function diagnosticClock() {
  return {
    wallTime: new Date().toISOString(),
    monotonicMs: Number(process.hrtime.bigint() - diagnosticsStartedAt) / 1e6
  };
}

function pendingDiagnosticClock(pending) {
  return {
    ...diagnosticClock(),
    pendingAgeMs: Date.now() - pending.createdAt,
    firstCallbackAgeMs: pending.firstCallbackAt
      ? Date.now() - pending.firstCallbackAt
      : null,
    firstParkedAgeMs: pending.firstParkedAt
      ? Date.now() - pending.firstParkedAt
      : null,
    batchFrozenAgeMs: pending.batchFrozenAt
      ? Date.now() - pending.batchFrozenAt
      : null,
    batchEmittedAgeMs: pending.batchEmittedAt
      ? Date.now() - pending.batchEmittedAt
      : null
  };
}

function externalToolCallId(sessionKey, callIdentity, toolName) {
  const hash = crypto.createHash("sha256").update(`${sessionKey}\0${callIdentity}`).digest("hex").slice(0, 32);
  const suffix = String(toolName || "tool").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 16) || "tool";
  return `call_sdk_${hash}_${suffix}`;
}

function truncateTraceText(value, maxChars = traceMaxTextChars) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxChars) return text;
  const marker = `\n\n[... trace truncated: ${text.length - maxChars} chars omitted ...]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

function traceChunkRecords(input, maxChars = traceChunkMaxChars) {
  const text = typeof input.text === "string" ? input.text : String(input.text ?? "");
  const hash = typeof input.sha256 === "string"
    ? input.sha256
    : crypto.createHash("sha256").update(text).digest("hex");
  const chunks = [];
  for (let start = 0; start < text.length || (start === 0 && text.length === 0);) {
    let end = Math.min(text.length, start + Math.max(1, maxChars));
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end;
  }
  return chunks.map((chunk, index) => ({
    event: input.event ?? "sdk_trace_input_chunk",
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    reason: input.reason,
    field: input.field,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.callId ? { callId: input.callId } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    sha256: hash,
    chunkIndex: index,
    chunkCount: chunks.length,
    totalChars: text.length,
    content: chunk
  }));
}

function writeTrajectoryRecord(record) {
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch {
    serialized = JSON.stringify({
      event: "trajectory_observation_error",
      trajectorySchemaVersion: 1,
      eventId: crypto.randomUUID(),
      serviceInvocationId,
      scope: "record_serialization",
      errorCode: "trace_record_write_failed"
    });
  }
  console.info(serialized);
}

function logTrajectory(event, input) {
  writeTrajectoryRecord({
    event,
    trajectorySchemaVersion: 1,
    eventId: crypto.randomUUID(),
    serviceInvocationId,
    ...diagnosticClock(),
    ...input
  });
}

function trajectoryCheckpointHash(pending) {
  try {
    return crypto.createHash("sha256").update(stableJson({
      bootstrapFingerprint: pending.bootstrapFingerprint ?? null,
      transcriptItemHashes: pending.transcriptItemHashes ?? []
    })).digest("hex");
  } catch {
    logTrajectoryObservationError("checkpoint_hash", "trace_checkpoint_hash_failed");
    return undefined;
  }
}

function trajectoryInputIdFor(pending, input, index) {
  try {
    const occurrenceKey = input.source === "tool_result"
      ? `${input.callId || `anonymous:${index}`}\0${input.contentSha256}`
      : `${input.contextCheckpointHash ?? trajectoryCheckpointHash(pending)}\0${input.itemIndex ?? index}\0${input.contentSha256}`;
    return `input_${crypto.createHash("sha256")
      .update(`${pending.trajectorySessionId}\0${input.source}\0${occurrenceKey}`)
      .digest("hex")
      .slice(0, 32)}`;
  } catch {
    logTrajectoryObservationError("input_id", "trace_input_id_failed");
    return undefined;
  }
}

function logTrajectoryInputsAccepted(pending, inputs, acceptedBy) {
  try {
    const acceptedInCall = new Set();
    for (const [index, input] of (inputs ?? []).entries()) {
      if (!input?.contentSha256) continue;
      const content = typeof input.content === "string" ? input.content : stringifyToolResult(input.content);
      const inputId = trajectoryInputIdFor(pending, input, index);
      if (!inputId || acceptedInCall.has(inputId)) continue;
      acceptedInCall.add(inputId);
      const requestId = input.trajectoryRequestId ?? pending.requestId;
      const ingressRequestId = input.trajectoryIngressRequestId ?? pending.ingressRequestId;
      if (!tracedTrajectoryInputContentIds.has(inputId)) {
        const recordedContent = content.slice(0, trajectoryMaxContentChars);
        for (const record of traceChunkRecords({
          event: "trajectory_input_content_chunk",
          requestId,
          sessionKey: pending.trajectorySessionId,
          text: recordedContent,
          sha256: input.contentSha256
        })) {
          writeTrajectoryRecord({
            ...record,
            trajectorySchemaVersion: 1,
            eventId: crypto.randomUUID(),
            serviceInvocationId,
            sdkSessionKey: input.trajectorySdkSessionKey ?? pending.sessionKey,
            ingressRequestId,
            inputId,
            source: input.source,
            ...(input.itemIndex !== undefined ? { itemIndex: input.itemIndex } : {}),
            ...(input.callId ? { callId: input.callId } : {}),
            ...(input.isError !== undefined ? { isError: input.isError } : {}),
            contentSha256: record.sha256,
            contentChars: record.totalChars,
            observedChars: content.length,
            truncated: content.length > recordedContent.length
          });
        }
        tracedTrajectoryInputContentIds.add(inputId);
        while (tracedTrajectoryInputContentIds.size > 16384) {
          tracedTrajectoryInputContentIds.delete(tracedTrajectoryInputContentIds.values().next().value);
        }
      }
      logTrajectory("trajectory_input_accepted", {
        sessionKey: pending.trajectorySessionId,
        sdkSessionKey: input.trajectorySdkSessionKey ?? pending.sessionKey,
        ingressRequestId,
        requestId,
        inputId,
        source: input.source,
        ...(input.itemIndex !== undefined ? { itemIndex: input.itemIndex } : {}),
        contentSha256: input.contentSha256,
        contentChars: input.contentChars,
        checkpointHash: input.contextCheckpointHash ?? trajectoryCheckpointHash(pending),
        executionId: pending.executionId,
        agentId: pending.agentId,
        ...(pending.run?.id ? { runId: pending.run.id } : {}),
        acceptedBy
      });
    }
  } catch {
    logTrajectoryObservationError("input_recording", "trace_input_record_failed");
  }
}

function currentTrajectoryOutputId(pending) {
  pending.outputId ??= `output_${crypto.randomUUID().replaceAll("-", "")}`;
  return pending.outputId;
}

function finalizeTrajectoryOutput(pending, runId, outputType, text, provisional = false) {
  let outputId;
  try {
    outputId = currentTrajectoryOutputId(pending);
    const content = String(text ?? "");
    const contentSha256 = crypto.createHash("sha256").update(content).digest("hex");
    const recordedContent = content.slice(0, trajectoryMaxContentChars);
    if (content || outputType === "final") {
      for (const record of traceChunkRecords({
        event: "trajectory_output_content_chunk",
        requestId: pending.requestId,
        sessionKey: pending.trajectorySessionId,
        agentId: pending.agentId,
        runId,
        text: recordedContent,
        sha256: contentSha256
      })) {
        writeTrajectoryRecord({
          ...record,
          trajectorySchemaVersion: 1,
          eventId: crypto.randomUUID(),
          serviceInvocationId,
          sdkSessionKey: pending.sessionKey,
          ingressRequestId: pending.ingressRequestId,
          executionId: pending.executionId,
          outputId,
          outputType,
          provisional,
          acceptedAt: pending.outputAcceptedAt ?? new Date().toISOString(),
          contentSha256: record.sha256,
          contentChars: record.totalChars,
          observedChars: content.length,
          truncated: content.length > recordedContent.length
        });
      }
    }
  } catch {
    logTrajectoryObservationError("output_recording", "trace_output_record_failed");
    outputId = undefined;
  } finally {
    pending.outputId = null;
    pending.outputAcceptedAt = null;
  }
  return outputId;
}

function logTrajectoryToolOutput(pending, runId, parked) {
  try {
    const outputId = `output_${crypto.randomUUID().replaceAll("-", "")}`;
    const summary = summarizeToolTraceValue(parked.toolCall.args);
    const recordedContent = summary.text.slice(0, trajectoryMaxContentChars);
    for (const record of traceChunkRecords({
      event: "trajectory_output_content_chunk",
      requestId: pending.requestId,
      sessionKey: pending.trajectorySessionId,
      agentId: pending.agentId,
      runId,
      callId: parked.externalCallId,
      toolName: parked.toolCall.type,
      text: recordedContent,
      sha256: summary.sha256
    })) {
      writeTrajectoryRecord({
        ...record,
        trajectorySchemaVersion: 1,
        eventId: crypto.randomUUID(),
        serviceInvocationId,
        sdkSessionKey: pending.sessionKey,
        ingressRequestId: pending.ingressRequestId,
        executionId: pending.executionId,
        outputId,
        outputType: "tool_call",
        contentKind: "arguments",
        contentSha256: record.sha256,
        contentChars: record.totalChars,
        observedChars: summary.text.length,
        truncated: summary.text.length > recordedContent.length
      });
    }
    return outputId;
  } catch {
    logTrajectoryObservationError("tool_output_recording", "trace_tool_output_record_failed");
    return undefined;
  }
}

function logTrajectoryObservationError(scope, errorCode) {
  try {
    writeTrajectoryRecord({
      event: "trajectory_observation_error",
      trajectorySchemaVersion: 1,
      eventId: crypto.randomUUID(),
      serviceInvocationId,
      scope,
      errorCode
    });
  } catch {
    // A failed diagnostic sink cannot turn an observation failure into a request failure.
  }
}

function logTrajectoryExecutionTerminal(pending, status, error, phase) {
  if (!pending.executionStartedLogged || pending.executionTerminalLogged) return;
  pending.executionTerminalLogged = true;
  logTrajectory("trajectory_execution_terminal", {
    sessionKey: pending.trajectorySessionId,
    sdkSessionKey: pending.sessionKey,
    ingressRequestId: pending.ingressRequestId,
    requestId: pending.requestId,
    executionId: pending.executionId,
    agentId: pending.agentId,
    ...(pending.run?.id ? { runId: pending.run.id } : {}),
    status,
    durationMs: Date.now() - pending.createdAt,
    ...(error?.code ? { errorCode: error.code } : {}),
    ...(phase ? { phase } : {})
  });
}

function summarizeToolTraceValue(value) {
  let text;
  let fingerprintText;
  try {
    text = JSON.stringify(value ?? null);
    fingerprintText = stableJson(value ?? null);
  } catch {
    text = String(value);
    fingerprintText = text;
  }
  let stringCount = 0;
  let stringChars = 0;
  let realNewlines = 0;
  let literalBackslashN = 0;
  const visit = (entry) => {
    if (typeof entry === "string") {
      stringCount += 1;
      stringChars += entry.length;
      realNewlines += (entry.match(/\n/g) ?? []).length;
      literalBackslashN += (entry.match(/\\n/g) ?? []).length;
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === "object") {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return {
    sha256: crypto.createHash("sha256").update(fingerprintText).digest("hex"),
    jsonChars: text.length,
    stringCount,
    stringChars,
    realNewlines,
    literalBackslashN,
    text
  };
}

function toolArgsTraceChunkRecords(input, maxChars = traceChunkMaxChars) {
  return traceChunkRecords({
    event: "sdk_trace_tool_args_chunk",
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    reason: input.phase,
    field: "toolArgs",
    runId: input.runId,
    callId: input.callId,
    toolName: input.toolName,
    phase: input.phase,
    text: input.summary.text,
    sha256: input.summary.sha256
  }, maxChars);
}

function pendingToolState(pending) {
  return {
    expected: [...pending.expected],
    settledSdkCallIds: [...pending.settledSdkCallIds],
    parked: [...pending.parked.values()].map((entry) => entry.callId).filter(Boolean),
    emitted: [...pending.emitted].map((key) => pending.parked.get(key)?.callId).filter(Boolean),
    readyBatch: pending.readyBatch
      ? [...pending.readyBatch].map((key) => pending.parked.get(key)?.callId).filter(Boolean)
      : [],
    subscriberAttached: Boolean(activePendingAgentSubscriber(pending)),
    terminalError: pending.terminalError
      ? {
          name: pending.terminalError.name,
          code: pending.terminalError.code,
          message: pending.terminalError.message
        }
      : null,
    ageMs: Date.now() - pending.createdAt
  };
}

function pendingRunIdentity(pending) {
  if (!pending) return {};
  return {
    pendingRequestId: pending.requestId,
    agentId: pending.agentId,
    ...(pending.run?.id ? { runId: pending.run.id } : {})
  };
}

function logToolArgsTrace({ pending, runId, phase, callId, toolName, args, comparedTo }) {
  const summary = summarizeToolTraceValue(args);
  const matchesComparedTo = comparedTo ? comparedTo.summary.sha256 === summary.sha256 : undefined;
  console.info(JSON.stringify({
    event: "sdk_trace_tool_args",
    phase,
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    agentId: pending.agentId,
    runId,
    callId,
    toolName,
    sha256: summary.sha256,
    jsonChars: summary.jsonChars,
    stringCount: summary.stringCount,
    stringChars: summary.stringChars,
    realNewlines: summary.realNewlines,
    literalBackslashN: summary.literalBackslashN,
    comparedToPhase: comparedTo?.phase,
    comparedToSha256: comparedTo?.summary?.sha256,
    matchesComparedTo
  }));
  // Escaping regressions are the reason these phase traces exist, but a mismatch is
  // just one field inside a high-volume info record. Emit a separate warn so a
  // monitor can alert on real corruption without tailing every tool call.
  if (matchesComparedTo === false) {
    console.warn(JSON.stringify({
      event: "sdk_tool_args_mismatch",
      phase,
      comparedToPhase: comparedTo?.phase,
      requestId: pending.requestId,
      sessionKey: pending.sessionKey,
      runId,
      callId,
      toolName,
      sha256: summary.sha256,
      comparedToSha256: comparedTo?.summary?.sha256,
      jsonChars: summary.jsonChars,
      comparedToJsonChars: comparedTo?.summary?.jsonChars,
      realNewlines: summary.realNewlines,
      comparedToRealNewlines: comparedTo?.summary?.realNewlines,
      literalBackslashN: summary.literalBackslashN,
      comparedToLiteralBackslashN: comparedTo?.summary?.literalBackslashN
    }));
  }
  return { phase, summary };
}

function takePendingNarration(pending) {
  const text = pending.segmentText;
  pending.segmentText = "";
  return text;
}

const sessionActors = new Map();
const retiredToolCalls = new Map();
const recentRunTerminations = [];
const runtimeStartedAt = new Date().toISOString();
const runtimeCounters = { leaseExpired: 0, cancelled: 0, authenticationFailures: 0, cleanupFailures: 0 };
const trajectorySessionStates = new Map();
const maxTrajectorySessionStates = 4096;
const activeClientToolCaptures = new Map();
const agentRequestLifecycles = new Map();
const maxAgentRequestLifecycles = 4096;
const pendingAgentOutputOwner = Symbol("pendingAgentOutputOwner");
const forceNextRunAgentKeys = new Set();
const tracedTrajectoryInputContentIds = new Set();
let agentStateDirectoryReady = null;
let agentStatePrunePromise = null;
let agentStateWritesSincePrune = 0;
const agentStateOperations = new Map();
let server = null;


if (isMainModule()) {
  installBridgeProcessHandlers();
  if (process.argv.includes(clientMcpServerMode)) {
    await runClientForwardingMcpServerFromEnvironment();
  } else {
    startServer();
    process.on("SIGINT", () => closeAndExit(0));
    process.on("SIGTERM", () => closeAndExit(0));
  }
}

export {
  ABORTED_TOOL_RESULT_MESSAGE,
  Agent,
  agentCacheKey,
  bridgePrompt,
  attachPendingAgentSubscriber,
  attachPendingAgentRun,
  bindPendingAgentRunAbort,
  clientMcpToolDefinitions,
  clientForwardingMcpServerSource,
  configureCursorSdkNetwork,
  localAgentCreateOptions,
  localAgentSendOptions,
  isForwardableSDKToolCall,
  isAuthenticationSDKError,
  isRetryableSDKRunError,
  composerToolCallFromText,
  consumePendingAgentRun,
  cancelAgentRequest,
  runtimeSnapshot,
  createPendingAgentRun,
  detachPendingAgentSubscriber,
  failPendingAgentRun,
  handleCursorSdkDelta,
  normalizeSDKToolCall,
  normalizeModel,
  normalizeSdkEvent,
  normalizeSdkUsage,
  normalizeResumeToolResults,
  openAgentRequestLifecycle,
  openAiError,
  parseBridgePromptFields,
  parseTrajectoryInputs,
  parkPendingToolCall,
  recordPendingToolCallStatus,
  requirePendingAgentRunForToolResults,
  resolvePendingToolResults,
  runLocalAgentBody,
  runLocalAgentUnlocked,
  acknowledgePendingAgentOutput,
  sdkRunFailureSummary,
  statusFromError,
  startServer,
  takePendingNarration,
  traceChunkRecords,
  summarizeToolTraceValue,
  toolArgsTraceChunkRecords,
  truncateTraceText,
  validateClientMcpToolCall,
  waitForPendingAgentEvent,
  traceSdkPayload,
  toolCallFromDelta
};

function startServer() {
  if (server) return server;
  server = http.createServer((request, response) => {
    handleRequest(request, response).catch(async (error) => {
      await error?.contextRecoveryBarrier;
      if (response.destroyed || response.writableEnded) return;
      writeJson(response, openAiError(error), statusFromError(error));
    });
  });
  server.listen(port, host, () => {
    console.log(`Cursor SDK local-agent bridge listening on http://${host}:${port}/sdk`);
  });
  return server;
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, {
      ok: true, agents: activeAgentCount(),
      ...(process.env.CURSOR2RESPONSE_LAUNCH_ID ? {
        launchId: process.env.CURSOR2RESPONSE_LAUNCH_ID,
        launcherPid: Number(process.env.CURSOR2RESPONSE_LAUNCHER_PID),
        pid: process.pid
      } : {})
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime") {
    if (bridgeToken && bearerToken(request) !== bridgeToken) {
      writeJson(response, openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")), 401);
      return;
    }
    writeJson(response, runtimeSnapshot());
    return;
  }

  if (request.method === "POST" && url.pathname === "/models") {
    if (bridgeToken && bearerToken(request) !== bridgeToken) {
      writeJson(response, openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")), 401);
      return;
    }
    const body = await readJsonBody(request);
    const apiKey = requiredString(body.apiKey, "apiKey");
    const models = await Cursor.models.list({ apiKey });
    writeJson(response, { models });
    return;
  }

  if (request.method === "POST" && url.pathname === clientToolCallbackPath) {
    await handleClientToolCallback(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/sdk/cancel") {
    if (bridgeToken && bearerToken(request) !== bridgeToken) {
      writeJson(response, openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")), 401);
      return;
    }
    const body = await readJsonBody(request);
    const requestId = requiredString(body.requestId, "requestId");
    const cancelled = await cancelAgentRequest(
      requestId,
      cancelledAgentRequestError(),
      typeof body.apiKey === "string" && typeof body.sessionKey === "string" ? {
        apiKey: body.apiKey,
        model: normalizeModel(typeof body.model === "string" ? body.model : ""),
        workingDirectory: sdkWorkingDirectory(body.workingDirectory),
        sessionKey: body.sessionKey,
        pendingToolCallIds: body.pendingToolCallIds
      } : undefined
    );
    writeJson(response, { ok: true, cancelled });
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/sdk") {
    writeJson(response, openAiError(new HttpError("Not found", 404, "not_found")), 404);
    return;
  }

  if (bridgeToken && bearerToken(request) !== bridgeToken) {
    writeJson(response, openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")), 401);
    return;
  }

  const body = await readJsonBody(request);
  const apiKey = requiredString(body.apiKey, "apiKey");
  const systemPrompt = optionalSystemPrompt(body.systemPrompt);
  const model = normalizeModel(typeof body.model === "string" ? body.model : "");
  const sessionKey = typeof body.sessionKey === "string" && body.sessionKey ? body.sessionKey : crypto.randomUUID();
  const workingDirectory = sdkWorkingDirectory(body.workingDirectory);
  const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : crypto.randomUUID();
  const ingressRequestId = typeof body.ingressRequestId === "string" && body.ingressRequestId
    ? body.ingressRequestId
    : requestId;
  const trajectorySessionId = typeof body.trajectorySessionId === "string" && body.trajectorySessionId
    ? body.trajectorySessionId
    : sessionKey;
  const resumeToolResults = normalizeResumeToolResults(body.resumeToolResults, {
    requestId,
    ingressRequestId,
    sessionKey,
    trajectorySessionId
  });
  const supersedePendingRun = body.supersedePendingRun === true;
  const supersedingTurnAborted = body.supersedingTurnAborted === true;
  const internalToolCorrection = body.internalToolCorrection === true;
  const fullReplayCause = typeof body.fullReplayCause === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(body.fullReplayCause)
    ? body.fullReplayCause
    : undefined;
  const supersededToolCallIds = Array.isArray(body.supersededToolCallIds)
    ? body.supersededToolCallIds.filter((callId) => typeof callId === "string" && Boolean(callId.trim())).map((callId) => callId.trim())
    : [];
  const {
    prompt,
    incrementalPrompt,
    promptAlreadyPrepared,
    hasIncrementalPrompt,
    fullReplay
  } = parseBridgePromptFields(body, resumeToolResults);
  const agentContext = parseAgentContext(body.agentContext, prompt);
  const clientTools = resumeToolResults.length > 0 && !supersedePendingRun && !agentContext
    ? []
    : parseClientTools(body.tools);
  const streamEvents = body.streamEvents === true;
  const emitReasoning = body.emitReasoning === true;
  const clientSource = normalizedClientSource(body.clientSource);
  const clientPlatform = normalizedClientPlatform(body.clientPlatform);
  const trajectoryInputs = parseTrajectoryInputs(body.trajectoryInputs, {
    requestId,
    ingressRequestId,
    sessionKey,
    trajectorySessionId
  });
  console.info(JSON.stringify({
    event: "sdk_bridge_request",
    ...diagnosticClock(),
    requestId,
    mode: "agent",
    model: sdkModelSelection(model),
    clientSource,
    clientPlatform,
    sessionKey,
    promptChars: prompt.length,
    incrementalPromptChars: incrementalPrompt.length,
    resumeToolResultsCount: resumeToolResults.length,
    supersedePendingRun,
    supersedingTurnAborted,
    internalToolCorrection,
    fullReplayCause: fullReplayCause ?? null,
    emitReasoning,
    toolCount: clientTools.length,
    toolNames: clientTools.map((tool) => tool.name),
    agentContextItems: agentContext?.transcriptItemHashes.length ?? 0
  }));

  const input = {
    apiKey,
    systemPrompt,
    model,
    prompt: promptAlreadyPrepared ? prompt : bridgePrompt(prompt, clientTools),
    incrementalPrompt: promptAlreadyPrepared ? incrementalPrompt : bridgePrompt(incrementalPrompt, clientTools),
    sessionKey,
    workingDirectory,
    requestId,
    ingressRequestId,
    trajectorySessionId,
    clientTools,
    resumeToolResults,
    supersedePendingRun,
    supersedingTurnAborted,
    internalToolCorrection,
    supersededToolCallIds,
    fullReplayCause,
    hasIncrementalPrompt,
    fullReplay,
    agentContext,
    trajectoryInputs,
    emitReasoning
  };
  console.info(JSON.stringify({
    event: "sdk_trace_input",
    requestId,
    sessionKey,
    model: sdkModelSelection(model),
    promptChars: input.prompt.length,
    incrementalPromptChars: input.incrementalPrompt.length,
    promptSha256: crypto.createHash("sha256").update(input.prompt).digest("hex"),
    incrementalPromptSha256: crypto.createHash("sha256").update(input.incrementalPrompt).digest("hex"),
    promptAlreadyPrepared,
    toolCount: clientTools.length,
    toolNames: clientTools.map((tool) => tool.name)
  }));
  const lifecycle = openAgentRequestLifecycle(requestId, request, response);
  try {
    if (streamEvents) {
      await streamLocalAgent(input, response, lifecycle.signal, lifecycle.touch);
      return;
    }

    const output = await runLocalAgent(input, undefined, lifecycle.signal, lifecycle.touch);
    if (writeJson(response, output)) {
      acknowledgePendingAgentOutput(output);
      await pendingAgentOutputAcknowledgement(output);
    }
  } finally {
    lifecycle.close();
  }
}

function parseBridgePromptFields(body, resumeToolResults) {
  if (resumeToolResults.length > 0 && body.supersedePendingRun !== true) {
    return {
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      incrementalPrompt: "",
      promptAlreadyPrepared: true,
      hasIncrementalPrompt: false,
      fullReplay: false
    };
  }
  const prompt = requiredString(body.prompt, "prompt");
  const hasIncrementalPrompt = typeof body.incrementalPrompt === "string" && Boolean(body.incrementalPrompt.trim());
  const incrementalPrompt = hasIncrementalPrompt ? body.incrementalPrompt : prompt;
  const promptAlreadyPrepared = body.promptAlreadyPrepared === true;
  return {
    prompt,
    incrementalPrompt,
    promptAlreadyPrepared,
    hasIncrementalPrompt,
    fullReplay: !hasIncrementalPrompt
  };
}

function parseAgentContext(value, prompt) {
  if (value === undefined) return undefined;
  const hashPattern = /^[a-f0-9]{64}$/;
  const valid = isRecord(value)
    && typeof value.bootstrapFingerprint === "string"
    && hashPattern.test(value.bootstrapFingerprint)
    && Array.isArray(value.transcriptItemHashes)
    && value.transcriptItemHashes.every((hash) => typeof hash === "string" && hashPattern.test(hash))
    && Array.isArray(value.transcriptItemOffsets)
    && Array.isArray(value.transcriptItemImageCounts)
    && value.transcriptItemOffsets.length === value.transcriptItemHashes.length
    && value.transcriptItemImageCounts.length === value.transcriptItemHashes.length
    && Number.isSafeInteger(value.transcriptEndOffset)
    && value.transcriptEndOffset >= 0
    && Number.isSafeInteger(value.promptTextChars)
    && value.promptTextChars >= value.transcriptEndOffset
    && value.promptTextChars <= prompt.length
    && value.transcriptItemOffsets.every((offset, index) => (
      Number.isSafeInteger(offset)
      && offset >= 0
      && offset <= value.transcriptEndOffset
      && (index === 0 || offset > value.transcriptItemOffsets[index - 1])
    ))
    && value.transcriptItemImageCounts.every((count) => Number.isSafeInteger(count) && count >= 0);
  if (!valid) {
    throw new HttpError("Invalid Responses Agent context metadata.", 400, "cursor_sdk_agent_context_invalid");
  }
  return {
    bootstrapFingerprint: value.bootstrapFingerprint,
    transcriptItemHashes: [...value.transcriptItemHashes],
    transcriptItemOffsets: [...value.transcriptItemOffsets],
    transcriptItemImageCounts: [...value.transcriptItemImageCounts],
    transcriptEndOffset: value.transcriptEndOffset,
    promptTextChars: value.promptTextChars
  };
}

function parseTrajectoryInputs(value, context = {}) {
  if (!Array.isArray(value)) return [];
  const hashPattern = /^[a-f0-9]{64}$/;
  return value.flatMap((entry) => {
    if (!isRecord(entry) || entry.source !== "user" || typeof entry.content !== "string") return [];
    const contentSha256 = crypto.createHash("sha256").update(entry.content).digest("hex");
    return [{
      source: entry.source,
      content: entry.content,
      contentSha256,
      contentChars: entry.content.length,
      itemIndex: Number.isSafeInteger(entry.itemIndex) ? entry.itemIndex : undefined,
      contextCheckpointHash: typeof entry.contextCheckpointHash === "string" && hashPattern.test(entry.contextCheckpointHash)
        ? entry.contextCheckpointHash
        : undefined,
      trajectoryRequestId: context.requestId,
      trajectoryIngressRequestId: context.ingressRequestId,
      trajectorySdkSessionKey: context.sessionKey,
      trajectorySessionId: context.trajectorySessionId
    }];
  });
}

function normalizeResumeToolResults(value, context) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((result) => {
    const content = stringifyToolResult(result.output);
    const contentSha256 = crypto.createHash("sha256").update(content).digest("hex");
    return {
      callId: typeof result.callId === "string" ? result.callId : undefined,
      output: result.output,
      isError: result.isError === true,
      content,
      contentSha256,
      contentChars: content.length,
      source: "tool_result",
      trajectoryRequestId: context.requestId,
      trajectoryIngressRequestId: context.ingressRequestId,
      trajectorySdkSessionKey: context.sessionKey,
      trajectorySessionId: context.trajectorySessionId
    };
  });
}

function hasIndependentIncrementalPrompt(input) {
  if (typeof input.hasIncrementalPrompt === "boolean") return input.hasIncrementalPrompt;
  return typeof input.incrementalPrompt === "string" && Boolean(input.incrementalPrompt.trim());
}

async function handleClientToolCallback(request, response) {
  if (bridgeToken && bearerToken(request) !== bridgeToken) {
    writeJson(response, openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")), 401);
    return;
  }

  const body = await readJsonBody(request);
  const cacheKey = requiredString(body.cacheKey, "cacheKey");
  const toolName = requiredString(body.toolName, "toolName");
  const args = isRecord(body.arguments) ? body.arguments : {};
  const accepted = await captureActiveClientToolCall(cacheKey, { type: toolName, args });
  writeJson(response, { ok: true, accepted });
}

async function streamLocalAgent(input, response, signal, onProgress) {
  let closed = false;
  const markClosed = () => {
    closed = true;
  };
  const socket = response.socket;
  response.on("close", markClosed);
  response.on("error", markClosed);
  socket?.on?.("error", markClosed);
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Access-Control-Allow-Origin": "*"
  });
  const emit = (event) => {
    if (closed) return false;
    const wrote = writeNdjson(response, event);
    if (!wrote) closed = true;
    return wrote;
  };
  try {
    const output = await runLocalAgent(input, emit, signal, onProgress);
    if (emit({ type: "done", output })) {
      acknowledgePendingAgentOutput(output);
      await pendingAgentOutputAcknowledgement(output);
    }
  } catch (error) {
    await error?.contextRecoveryBarrier;
    emit({ type: "error", error: openAiError(error).error });
  } finally {
    response.off("close", markClosed);
    response.off("error", markClosed);
    socket?.off?.("error", markClosed);
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }
}

async function runLocalAgent(input, onEvent, signal, onProgress) {
  return runLocalAgentUnlocked(input, onEvent, signal, onProgress, { deferTerminalAck: true });
}

function sessionActor(cacheKey) {
  let actor = sessionActors.get(cacheKey);
  if (actor) {
    actor.touchedAt = Date.now();
    return actor;
  }
  actor = {
    cacheKey,
    agentEntry: null,
    activeRun: null,
    subscriber: null,
    inbox: [],
    steeringTurns: new Map(),
    transition: Promise.resolve(),
    generation: 0,
    touchedAt: Date.now()
  };
  sessionActors.set(cacheKey, actor);
  return actor;
}

function trajectorySessionState(sessionKey) {
  let state = trajectorySessionStates.get(sessionKey);
  if (!state) {
    state = { lastAgentId: null, lastCheckpointHash: null, touchedAt: Date.now() };
    trajectorySessionStates.set(sessionKey, state);
    if (trajectorySessionStates.size > maxTrajectorySessionStates) {
      const oldest = [...trajectorySessionStates.entries()]
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (oldest) trajectorySessionStates.delete(oldest[0]);
    }
  }
  state.touchedAt = Date.now();
  return state;
}

function withSessionActorTransition(actor, work) {
  const operation = actor.transition.catch(() => undefined).then(work);
  actor.transition = operation.then(() => undefined, () => undefined);
  return operation;
}


async function disposeAgentHandle(agent) {
  const dispose = agent?.[Symbol.asyncDispose];
  if (typeof dispose === "function") {
    await dispose.call(agent);
    return;
  }
  agent?.close();
}


function actorOwnsPendingRun(pending) {
  return sessionActors.get(pending.cacheKey) === pending.actor
    && pending.actor.activeRun === pending
    && pending.actor.generation === pending.generation;
}

function actorOwnsAgentGeneration(pending) {
  return sessionActors.get(pending.cacheKey) === pending.actor
    && pending.actor.agentEntry?.agent === pending.agent
    && pending.actor.generation === pending.generation;
}

async function runLocalAgentUnlocked(input, onEvent, signal, onProgress, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let emittedEvent = false;
    const emit = onEvent
      ? (event) => {
          emittedEvent = true;
          return onEvent(event);
        }
      : undefined;

    try {
      signal?.throwIfAborted();
      return await runLocalAgentBody(input, emit, signal, onProgress, options);
    } catch (error) {
      signal?.throwIfAborted();
      const shouldRetry =
        attempt < maxRunRetries &&
        !emittedEvent &&
        input.resumeToolResults.length === 0 &&
        !input.supersedePendingRun &&
        !isAuthenticationSDKError(error) &&
        isRetryableSDKRunError(error);
      if (!shouldRetry) throw error;
      input.fullReplayCause = "retryable_sdk_error";
      await evictCachedAgent(input);
      console.warn(`Retrying Cursor SDK run after retryable upstream error (${attempt + 1}/${maxRunRetries}).`);
      await sleep(retryDelayMs(attempt), undefined, { signal });
    }
  }
}

async function runLocalAgentBody(input, onEvent, signal, onProgress, options = {}) {
  signal?.throwIfAborted();
  const cacheKey = agentCacheKey(input);
  const actor = sessionActor(cacheKey);
  const admission = await withSessionActorTransition(actor, async () => {
    signal?.throwIfAborted();
    let existing = actor.activeRun;
    if (!input.supersedePendingRun) assertNoRetiredToolResults(cacheKey, input.resumeToolResults);
    if (existing?.leaseExpiresAt && existing.leaseExpiresAt <= Date.now()) {
      await expirePendingAgentRun(existing);
      if (!input.supersedePendingRun) assertNoRetiredToolResults(cacheKey, input.resumeToolResults);
      existing = null;
    }
    if (!input.supersedePendingRun) {
      try {
        requirePendingAgentRunForToolResults(existing, input.resumeToolResults);
      } catch (error) {
        console.warn(JSON.stringify({
          event: "sdk_tool_results_unmatched",
          requestId: input.requestId,
          cacheKey,
          sessionKey: input.sessionKey,
          model: sdkModelSelection(input.model),
          ...pendingRunIdentity(existing),
          resumeToolResultsCount: input.resumeToolResults.length
        }));
        throw error;
      }
    }
    if (
      existing
      && input.resumeToolResults.length === 0
      && !input.supersedePendingRun
      && !systemPromptReplayCause(existing, input)
      && pendingContextRetry(existing, input.agentContext)
    ) {
      return {
        response: continuePendingAgentRun(existing, input, null, onEvent, signal, onProgress, {
          suppressUntilDelivery: actor.inbox.length > 0
        })
      };
    }
    if (input.internalToolCorrection) {
      if (existing && systemPromptReplayCause(existing, input)) {
        throw new HttpError("An internal tool correction cannot change systemPrompt.", 409, "cursor_sdk_agent_context_conflict");
      }
      if (!existing || input.resumeToolResults.length === 0) {
        throw new HttpError(
          "An internal tool correction requires the exposed pending tool batch.",
          409,
          "cursor_sdk_tool_correction_unmatched"
        );
      }
      return {
        response: continuePendingAgentRun(
          existing,
          input,
          input.resumeToolResults,
          onEvent,
          signal,
          onProgress,
          { internalToolCorrection: true }
        )
      };
    }
    const pendingReplayCause = existing
      ? systemPromptReplayCause(existing, input)
        ?? agentContextReplayCause(pendingAuthoritativeContextState(existing), input.agentContext)
        ?? (input.resumeToolResults.length === 0
          && !(input.supersedePendingRun && input.supersedingTurnAborted === true)
          ? agentProvisionalReplayCause(
              pendingAuthoritativeContextState(existing),
              pendingProvisionalContextState(existing),
              input.agentContext
            )
          : null)
      : null;
    if (existing && pendingReplayCause) {
      input.fullReplayDetail = transcriptDivergenceDetail(pendingReplayCause, {
        transcriptItemHashes: existing.authoritativeTranscriptItemHashes,
        provisionalTranscriptItemHashes: pendingProvisionalContextState(existing).transcriptItemHashes,
        contextSnapshot: actor.agentEntry?.contextSnapshot
      }, input);
      if (existing.emitted.size > 0) {
        if (input.supersedePendingRun) {
          const supersede = supersedingToolResults(existing, input);
          if (!supersede.results) {
            throw new HttpError(
              "Cursor SDK agent is waiting for the previous tool result.",
              409,
              "cursor_sdk_tool_result_pending"
            );
          }
          const hasSyntheticResult = supersede.results.some((result) => (
            result.isError === true && result.output === ABORTED_TOOL_RESULT_MESSAGE
          ));
          if (hasSyntheticResult && input.supersedingTurnAborted !== true) {
            throw new HttpError(
              "A divergent Responses replay must settle every exposed tool call or explicitly abort the turn.",
              409,
              "cursor_sdk_tool_result_batch_mismatch"
            );
          }
          resolvePendingToolResults(existing, supersede.results);
        } else if (input.resumeToolResults.length > 0) {
          resolvePendingToolResults(existing, input.resumeToolResults);
        } else {
          throw new HttpError(
            "Cursor SDK agent is waiting for the previous tool result.",
            409,
            "cursor_sdk_tool_result_pending"
          );
        }
      }
      try {
        logTrajectory("trajectory_context_replacement", {
          sessionKey: input.trajectorySessionId ?? existing.trajectorySessionId,
          sdkSessionKey: input.sessionKey,
          ingressRequestId: input.ingressRequestId ?? input.requestId,
          requestId: input.requestId,
          previousRequestId: existing.lastRequestId,
          executionId: existing.executionId,
          agentId: existing.agentId,
          runId: existing.run?.id,
          replayCause: pendingReplayCause,
          resumeToolResultsCount: input.resumeToolResults.length,
          supersedePendingRun: input.supersedePendingRun === true,
          ...input.fullReplayDetail
        });
      } catch {
        logTrajectoryObservationError("context_replacement", "trace_context_replacement_failed");
      }
      await cancelActiveRunAndEvictAgent(existing, {
        source: "agent_context_replaced",
        error: cancelledAgentRequestError()
      });
      input.fullReplayCause = pendingReplayCause;
      input.resumeToolResults = [];
      input.supersedePendingRun = false;
      input.supersedingTurnAborted = false;
      input.supersededToolCallIds = [];
      input.fullReplay = true;
      existing = null;
    }
    if (existing) {
      if (input.supersedePendingRun) {
        const turn = steeringTurnFromInput(actor, input);
        const knownTurn = actor.steeringTurns.get(turn.identity);
        if (knownTurn) {
          return {
            response: continuePendingAgentRun(existing, input, null, onEvent, signal, onProgress, {
              suppressUntilDelivery: ["queued", "native_pending"].includes(knownTurn.state)
            })
          };
        }
        const supersede = supersedingToolResults(existing, input);
        // Keep retry identity stable after the submitted prefix has been acknowledged.
        turn.prompt = supersedingPrompt(input, existing);
        depositSteeringTurn(actor, turn);
        startNativeSteering(existing);
        if (supersede.mismatched && supersede.pendingCallIds.length > 0) {
          console.warn(JSON.stringify({
            event: "sdk_superseding_turn_recovered_mismatched_pending",
            cacheKey,
            sessionKey: input.sessionKey,
            declaredCallIds: input.supersededToolCallIds,
            pendingCallIds: supersede.pendingCallIds,
            suppliedResultCallIds: input.resumeToolResults.map((result) => result.callId),
            pendingAgeMs: Date.now() - existing.createdAt
          }));
        }
        console.info(JSON.stringify({
          event: "sdk_steering_turn_deposited",
          cacheKey,
          sessionKey: input.sessionKey,
          delivery: "annotate",
          inboxSize: actor.inbox.length,
          suppliedToolResultCount: input.resumeToolResults.length,
          syntheticToolResultCount: (supersede.results ?? [])
            .filter((result) => result.isError && result.output === ABORTED_TOOL_RESULT_MESSAGE).length,
          pendingAgeMs: Date.now() - existing.createdAt
        }));
        return {
          response: continuePendingAgentRun(existing, input, supersede.results, onEvent, signal, onProgress, {
            suppressUntilDelivery: supersede.results === null
          })
        };
      }
      if (input.resumeToolResults.length === 0) {
        const extendsPendingContext = input.agentContext
          ? agentContextStrictlyExtends(pendingAuthoritativeContextState(existing), input.agentContext)
          : hasIndependentIncrementalPrompt(input);
        if (extendsPendingContext) {
          const actualCallIds = pendingExternalCallIds(existing);
          const queuedCheckpoint = actor.inbox.at(-1)?.agentContext;
          const recoveryInput = {
            ...input,
            incrementalPrompt: agentContextSuffixPrompt(
              input,
              queuedCheckpoint && input.agentContext
                  && queuedCheckpoint.bootstrapFingerprint === input.agentContext.bootstrapFingerprint
                  && isTranscriptPrefix(queuedCheckpoint.transcriptItemHashes, input.agentContext.transcriptItemHashes)
                ? queuedCheckpoint.transcriptItemHashes
                : transcriptSuffixCheckpoint(
                    pendingAuthoritativeContextState(existing),
                    pendingProvisionalContextState(existing),
                    input.agentContext
                  )
            )
              ?? input.incrementalPrompt,
            supersededToolCallIds: actualCallIds,
            supersedingTurnAborted: false
          };
          const turn = steeringTurnFromInput(actor, recoveryInput);
          const knownTurn = actor.steeringTurns.get(turn.identity);
          if (knownTurn) {
            return {
              response: continuePendingAgentRun(existing, input, null, onEvent, signal, onProgress, {
                suppressUntilDelivery: ["queued", "native_pending"].includes(knownTurn.state)
              })
            };
          }
          depositSteeringTurn(actor, turn);
          startNativeSteering(existing);
          const results = syntheticPendingToolResults(existing);
          console.warn(JSON.stringify({
            event: "sdk_dead_turn_recovered",
            cacheKey,
            sessionKey: input.sessionKey,
            pendingCallIds: actualCallIds,
            syntheticToolResultCount: results?.length ?? 0,
            pendingAgeMs: Date.now() - existing.createdAt
          }));
          return {
            response: continuePendingAgentRun(existing, input, results, onEvent, signal, onProgress, {
              suppressUntilDelivery: results === null
            })
          };
        }
        if (input.agentContext) {
          throw new HttpError(
            "Responses transcript does not contain a new item for the active Cursor Agent.",
            409,
            "cursor_sdk_transcript_not_extended"
          );
        }
        if (!input.fullReplay) {
          console.warn(JSON.stringify({
            event: "sdk_pending_run_without_tool_result",
            requestId: input.requestId,
            cacheKey,
            sessionKey: input.sessionKey,
            model: sdkModelSelection(input.model),
            ...pendingRunIdentity(existing),
            promptChars: input.prompt.length,
            incrementalPromptChars: input.incrementalPrompt.length,
            pendingAgeMs: Date.now() - existing.createdAt,
            pendingToolCallIds: [...existing.emitted]
              .map((key) => existing.parked.get(key)?.callId)
              .filter(Boolean)
          }));
          throw new HttpError("Cursor SDK agent is waiting for the previous tool result.", 409, "cursor_sdk_tool_result_pending");
        }
        console.warn(JSON.stringify({
          event: "sdk_pending_run_settled_for_full_replay",
          requestId: input.requestId,
          cacheKey,
          sessionKey: input.sessionKey,
          model: sdkModelSelection(input.model),
          ...pendingRunIdentity(existing),
          replayCause: "missing_incremental_prompt",
          pendingAgeMs: Date.now() - existing.createdAt
        }));
        await cancelActiveRunAndEvictAgent(existing, {
          source: "full_replay_fallback",
          error: cancelledAgentRequestError()
        });
        input.fullReplayCause = "missing_incremental_prompt";
      } else {
        console.info(JSON.stringify({
          event: "sdk_tool_results_matched",
          requestId: input.requestId,
          cacheKey,
          sessionKey: input.sessionKey,
          model: sdkModelSelection(input.model),
          ...pendingRunIdentity(existing),
          resumeToolResultsCount: input.resumeToolResults.length,
          pendingAgeMs: Date.now() - existing.createdAt
        }));
        return {
          response: continuePendingAgentRun(existing, input, input.resumeToolResults, onEvent, signal, onProgress)
        };
      }
    }

    if (input.supersedePendingRun) {
      console.info(JSON.stringify({
        event: "sdk_superseding_turn_without_pending_run",
        cacheKey,
        sessionKey: input.sessionKey,
        resumeToolResultsCount: input.resumeToolResults.length
      }));
      input.supersedePendingRun = false;
      input.supersedingTurnAborted = false;
      input.supersededToolCallIds = [];
      input.resumeToolResults = [];
    }
    let agentEntry = await getAgent(input, signal, actor);
    if (agentEntry.cached && !input.agentContext && !hasIndependentIncrementalPrompt(input)) {
      input.fullReplayCause ??= "missing_incremental_prompt";
      await evictAgent(agentEntry.cacheKey, agentEntry.agent, { keepActor: true });
      agentEntry = await getAgent(input, signal, actor);
    }
    return { response: startPendingAgentRun(input, agentEntry, onEvent, signal, onProgress) };
  });
  const output = await admission.response;
  if (options.deferTerminalAck !== true) {
    acknowledgePendingAgentOutput(output);
    await pendingAgentOutputAcknowledgement(output);
  }
  return output;
}

async function continuePendingAgentRun(existing, input, results, onEvent, signal, onProgress, options = {}) {
  signal?.throwIfAborted();
  if (results) {
    const correctionCheckpoint = options.internalToolCorrection
      ? existing.delivery?.preToolCallCheckpointLength
      : undefined;
    if (
      options.internalToolCorrection
      && (
        existing.delivery?.type !== "tool_call"
        || (
          Array.isArray(existing.transcriptItemHashes)
          && !Number.isSafeInteger(correctionCheckpoint)
        )
      )
    ) {
      throw new HttpError(
        "The pending Cursor SDK delivery is not an internal tool correction batch.",
        409,
        "cursor_sdk_tool_correction_unmatched"
      );
    }
    if (!options.internalToolCorrection) assertPendingInputContext(existing, input.agentContext);
    resolvePendingToolResults(existing, results, {
      annotationTurns: queuedAnnotationTurns(existing.actor)
    });
    if (options.internalToolCorrection) {
      if (Number.isSafeInteger(correctionCheckpoint)) {
        truncatePendingContext(existing, correctionCheckpoint);
      }
    } else {
      if (existing.actor.inbox.some((turn) => turn.state === "native_pending")) {
        existing.steeringInputContext = input.agentContext;
        existing.steeringInputCheckpoint = existing.transcriptItemHashes ? [...existing.transcriptItemHashes] : undefined;
      } else {
        adoptPendingInputContext(existing, input.agentContext, input);
        existing.steeringInputContext = undefined;
        existing.steeringInputCheckpoint = undefined;
      }
    }
  }
  const subscriber = attachPendingAgentSubscriber(existing, {
    requestId: input.requestId,
    eventSink: !results && options.suppressUntilDelivery ? null : onEvent,
    deferredEventSink: !results && options.suppressUntilDelivery ? onEvent : undefined,
    progressSink: onProgress,
    signal
  });
  logTrajectory("trajectory_context_decision", {
    sessionKey: input.trajectorySessionId ?? existing.trajectorySessionId,
    sdkSessionKey: input.sessionKey,
    ingressRequestId: input.ingressRequestId ?? input.requestId,
    requestId: input.requestId,
    executionId: existing.executionId,
    agentId: existing.agentId,
    ...(existing.run?.id ? { runId: existing.run.id } : {}),
    decision: input.supersedePendingRun ? "steer_run" : "continue_run",
    checkpointHash: trajectoryCheckpointHash(existing),
    contextItemCount: existing.transcriptItemHashes?.length ?? 0,
    model: sdkModelSelection(input.model)
  });
  logTrajectory("trajectory_execution_attached", {
    sessionKey: input.trajectorySessionId ?? existing.trajectorySessionId,
    sdkSessionKey: input.sessionKey,
    ingressRequestId: input.ingressRequestId ?? input.requestId,
    requestId: input.requestId,
    executionId: existing.executionId,
    agentId: existing.agentId,
    ...(existing.run?.id ? { runId: existing.run.id } : {}),
    attachmentKind: results ? "continuation" : "reattach"
  });
  let output;
  try {
    output = await waitForPendingAgentEvent(existing, subscriber);
  } finally {
    detachPendingAgentSubscriber(subscriber);
  }
  if (output.status === "tool_call" || existing.actor.inbox.length === 0) return output;
  signal?.throwIfAborted();
  // Keep acknowledgement and replacement pending creation synchronous so no
  // concurrent request can observe an idle actor and send on the same Agent.
  acknowledgePendingAgentOutput(output);
  return startSteeringInboxRun(existing, input, onEvent, signal, onProgress, output.usage ?? null);
}

async function startPendingAgentRun(
  input,
  agentEntry,
  onEvent,
  signal,
  onProgress,
  carriedUsage = null,
  deliveringTurns = []
) {
  const cacheKey = agentEntry.cacheKey;
  const actor = sessionActor(cacheKey);
  const trajectoryState = trajectorySessionState(input.trajectorySessionId ?? input.sessionKey);
  const executionId = `execution_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!trajectoryState.lastAgentId) {
    logTrajectory("trajectory_agent_transition", {
      sessionKey: input.trajectorySessionId ?? input.sessionKey,
      sdkSessionKey: input.sessionKey,
      ingressRequestId: input.ingressRequestId ?? input.requestId,
      requestId: input.requestId,
      toAgentId: agentEntry.agent.agentId,
      transitionKind: agentEntry.resumed ? "resumed" : "created",
      transitionCause: agentEntry.resumed ? "persisted_agent" : input.fullReplayCause ?? "session_start",
      model: sdkModelSelection(input.model)
    });
  } else if (trajectoryState.lastAgentId !== agentEntry.agent.agentId) {
    logTrajectory("trajectory_agent_transition", {
      sessionKey: input.trajectorySessionId ?? input.sessionKey,
      sdkSessionKey: input.sessionKey,
      ingressRequestId: input.ingressRequestId ?? input.requestId,
      requestId: input.requestId,
      fromAgentId: trajectoryState.lastAgentId,
      toAgentId: agentEntry.agent.agentId,
      transitionKind: "replaced",
      transitionCause: input.fullReplayCause ?? "agent_replaced",
      model: sdkModelSelection(input.model)
    });
  }
  trajectoryState.lastAgentId = agentEntry.agent.agentId;
  const contextPrompt = deliveringTurns.length > 0 && input.agentContext
    ? input.incrementalPrompt
    : agentContextIncrementalPrompt(input, agentEntry);
  const pending = createPendingAgentRun(
    cacheKey,
    agentEntry,
    input.requestId,
    input.sessionKey,
    input.agentContext,
    {
      executionId,
      ingressRequestId: input.ingressRequestId ?? input.requestId,
      trajectorySessionId: input.trajectorySessionId ?? input.sessionKey,
      trajectoryInputs: input.trajectoryInputs ?? []
    }
  );
  pending.model = input.model;
  pending.emitReasoning = input.emitReasoning === true;
  pending.carriedUsage = carriedUsage;
  const subscriber = attachPendingAgentSubscriber(pending, {
    requestId: input.requestId,
    eventSink: onEvent,
    progressSink: onProgress,
    signal
  });
  const useIncrementalPrompt = agentEntry.cached
    && (contextPrompt !== undefined || (!input.agentContext && hasIndependentIncrementalPrompt(input)));
  const promptSource = useIncrementalPrompt
    ? agentEntry.resumed
      ? "resumed-incremental"
      : "cached-incremental"
    : "created-full";
  const recoverySuffixApplied = promptSource === "created-full" && input.hasIncrementalPrompt === true;
  const prompt = recoverySuffixApplied
    ? `${input.prompt}\n\n${RECOVERY_PROMPT_SUFFIX}`
    : useIncrementalPrompt
      ? input.incrementalPrompt
      : input.prompt;
  const selectedPrompt = useIncrementalPrompt && contextPrompt !== undefined
    ? contextPrompt
    : prompt;
  const force = forceNextRunAgentKeys.delete(cacheKey);

  try {
    signal?.throwIfAborted();
    await writePersistedAgentState(cacheKey, {
      sdkAgentId: agentEntry.agent.agentId,
      model: input.model,
      dirty: true,
      ...pendingAgentContextState(pending)
    });
    console.info(JSON.stringify({
      event: "sdk_prompt_selected",
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      agentId: agentEntry.agent.agentId,
      agentCacheHit: agentEntry.cacheHit === true,
      agentResumed: agentEntry.resumed === true,
      sentPromptChars: selectedPrompt.length,
      promptSource,
      replayCause: promptSource === "created-full"
        ? agentEntry.replayCause
          ?? input.fullReplayCause
          ?? (hasIndependentIncrementalPrompt(input) ? "agent_unavailable" : "first_turn")
        : null,
      recoverySuffixApplied
    }));
    const replayCause = promptSource === "created-full"
      ? agentEntry.replayCause
        ?? input.fullReplayCause
        ?? (hasIndependentIncrementalPrompt(input) ? "agent_unavailable" : "first_turn")
      : null;
    const replayDetail = [agentEntry.replayDetail, input.fullReplayDetail]
      .find((detail) => detail && detail.cause === replayCause) ?? null;
    const checkpointHash = trajectoryCheckpointHash(pending);
    logTrajectory("trajectory_context_decision", {
      sessionKey: pending.trajectorySessionId,
      sdkSessionKey: pending.sessionKey,
      ingressRequestId: pending.ingressRequestId,
      requestId: pending.requestId,
      executionId: pending.executionId,
      agentId: pending.agentId,
      decision: promptSource === "created-full" ? "start_full" : "send_incremental",
      decisionCause: replayCause,
      checkpointHash,
      contextItemCount: pending.transcriptItemHashes?.length ?? 0,
      sentPromptChars: selectedPrompt.length,
      model: sdkModelSelection(input.model)
    });
    if (promptSource === "created-full" && replayCause !== "first_turn") {
      logTrajectory("trajectory_replay", {
        sessionKey: pending.trajectorySessionId,
        sdkSessionKey: pending.sessionKey,
        ingressRequestId: pending.ingressRequestId,
        requestId: pending.requestId,
        executionId: pending.executionId,
        agentId: pending.agentId,
        replayKind: "sdk_context",
        replayCause,
        divergenceKind: replayDetail?.divergenceKind,
        divergedItemIndex: replayDetail?.divergedItemIndex,
        knownTranscriptItemCount: replayDetail?.knownTranscriptItemCount,
        clientTranscriptItemCount: replayDetail?.clientTranscriptItemCount,
        divergedItemPreview: replayDetail?.divergedItemPreview,
        knownItemPreview: replayDetail?.knownItemPreview,
        divergedCharOffset: replayDetail?.divergedCharOffset,
        knownItemHash: replayDetail?.knownItemHash,
        clientItemHash: replayDetail?.clientItemHash,
        knownRequestId: replayDetail?.knownRequestId,
        checkpointHash,
        contextItemCount: pending.transcriptItemHashes?.length ?? 0
      });
    }
    logTrajectory("trajectory_execution_started", {
      sessionKey: pending.trajectorySessionId,
      sdkSessionKey: pending.sessionKey,
      ingressRequestId: pending.ingressRequestId,
      requestId: pending.requestId,
      executionId: pending.executionId,
      agentId: pending.agentId,
      inputIds: pending.trajectoryInputs.map((entry, index) => trajectoryInputIdFor(pending, entry, index)).filter(Boolean),
      checkpointHash,
      promptMode: promptSource === "created-full" ? "full" : "incremental",
      model: sdkModelSelection(input.model)
    });
    pending.executionStartedLogged = true;
    const run = await agentEntry.agent.send(selectedPrompt, {
      ...localAgentSendOptions(input, {
        force,
        pending,
        onDelta: (args) => handleCursorSdkDelta(pending, args)
      }),
      idempotencyKey: input.requestId
    });
    await attachPendingAgentRun(pending, run);
    logTrajectory("trajectory_execution_attached", {
      sessionKey: pending.trajectorySessionId,
      sdkSessionKey: pending.sessionKey,
      ingressRequestId: pending.ingressRequestId,
      requestId: pending.requestId,
      executionId: pending.executionId,
      agentId: pending.agentId,
      runId: run.id
    });
    logTrajectoryInputsAccepted(pending, [
      ...pending.trajectoryInputs,
      ...deliveringTurns.flatMap((turn) => turn.trajectoryInputs ?? [])
    ], "agent_send");
    const addedSemanticIds = [
      ...pending.trajectoryInputs,
      ...deliveringTurns.flatMap((turn) => turn.trajectoryInputs ?? [])
    ].map((entry, index) => trajectoryInputIdFor(pending, entry, index)).filter(Boolean);
    if (trajectoryState.lastCheckpointHash !== checkpointHash) {
      logTrajectory("trajectory_context_checkpoint", {
        sessionKey: pending.trajectorySessionId,
        sdkSessionKey: pending.sessionKey,
        ingressRequestId: pending.ingressRequestId,
        requestId: pending.requestId,
        executionId: pending.executionId,
        agentId: pending.agentId,
        runId: run.id,
        checkpointHash,
        ...(trajectoryState.lastCheckpointHash ? {
          previousCheckpointHash: trajectoryState.lastCheckpointHash
        } : {}),
        addedSemanticIds,
        totalItemCount: pending.transcriptItemHashes?.length ?? 0,
        checkpointState: "authoritative"
      });
      trajectoryState.lastCheckpointHash = checkpointHash;
    }
    markSteeringTurnsDelivered(pending.actor, deliveringTurns, "sent");
    pending.completionPromise = consumePendingAgentRun(pending, run);
    pending.completionPromise.catch(() => undefined);
    return await waitForPendingAgentEvent(pending, subscriber);
  } catch (error) {
    settlePendingRunAttachment(pending);
    if (signal?.reason?.code === "cursor_sdk_subscriber_disconnected") throw signal.reason;
    if (signal?.aborted || pending.cancelledByRequest) {
      await withSessionActorTransition(pending.actor, () => cancelActiveRunAndEvictAgent(pending, {
        source: "subscriber_abort",
        error: signal?.reason ?? pending.cancelledByRequest ?? error
      })).catch(() => undefined);
      throw signal?.reason ?? pending.cancelledByRequest ?? error;
    }
    if (error?.code === "cursor_sdk_subscriber_replaced") throw error;
    await failPendingAgentRun(pending, error, { cancelRun: true });
    throw error;
  } finally {
    settlePendingRunAttachment(pending);
    detachPendingAgentSubscriber(subscriber);
  }
}

function agentContextIncrementalPrompt(input, agentEntry) {
  if (!input.agentContext || !agentEntry.cached) return undefined;
  const checkpoint = transcriptSuffixCheckpoint(
    agentEntry,
    {
      bootstrapFingerprint: agentEntry.bootstrapFingerprint,
      transcriptItemHashes: agentEntry.provisionalTranscriptItemHashes
    },
    input.agentContext
  );
  if (!Array.isArray(checkpoint)) return undefined;
  return agentContextSuffixPrompt(input, checkpoint);
}

function transcriptSuffixCheckpoint(authoritative, provisional, current) {
  if (
    current
    && provisional?.bootstrapFingerprint === current.bootstrapFingerprint
    && Array.isArray(provisional.transcriptItemHashes)
    && isTranscriptPrefix(provisional.transcriptItemHashes, current.transcriptItemHashes)
  ) {
    return provisional.transcriptItemHashes;
  }
  return authoritative?.transcriptItemHashes;
}

function agentContextSuffixPrompt(input, checkpoint) {
  if (!input.agentContext || !Array.isArray(checkpoint)) return undefined;
  if (checkpoint.length >= input.agentContext.transcriptItemHashes.length) {
    throw new HttpError(
      "Responses transcript does not contain a new item for the cached Cursor Agent.",
      409,
      "cursor_sdk_transcript_not_extended"
    );
  }
  const start = input.agentContext.transcriptItemOffsets[checkpoint.length];
  const textPrompt = input.prompt.slice(0, input.agentContext.promptTextChars);
  const transcript = textPrompt.slice(start, input.agentContext.transcriptEndOffset);
  const trailing = textPrompt.slice(input.agentContext.transcriptEndOffset);
  let prompt = `INPUT:\n${transcript}${trailing}`;
  const imageCount = input.agentContext.transcriptItemImageCounts
    .slice(checkpoint.length)
    .reduce((total, count) => total + count, 0);
  if (imageCount > 0) {
    prompt += `\n\n[${imageCount} image input${imageCount === 1 ? "" : "s"} attached by the OpenAI-compatible client.]`;
  }
  return prompt;
}

async function handleCursorSdkDelta(pending, args) {
  const update = args?.update;
  if (!isRecord(update) || !["summary-started", "summary", "summary-completed"].includes(update.type)) {
    return;
  }
  const summary = update.type === "summary" && typeof update.summary === "string" ? update.summary : "";
  console.warn(JSON.stringify({
    event: "cursor_sdk_summary_update",
    ...pendingDiagnosticClock(pending),
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    runId: pending.run?.id || pending.cacheKey,
    type: update.type,
    ...(summary ? {
      summaryChars: summary.length,
      summarySha256: crypto.createHash("sha256").update(summary).digest("hex")
    } : {})
  }));
  if (update.type !== "summary-started") return;
  await failPendingAgentRun(
    pending,
    new HttpError(
      "Cursor SDK compacted the conversation, so cursor2response can no longer preserve the full transcript.",
      413,
      "cursor_sdk_context_compacted"
    ),
    { cancelRun: true }
  );
}

function supersedingPrompt(input, pending) {
  const context = input.agentContext;
  if (!context || context.transcriptItemOffsets.length === 0) return input.incrementalPrompt;
  const fullPrompt = input.prompt.slice(0, context.promptTextChars);
  const bootstrap = fullPrompt.slice(0, context.transcriptItemOffsets[0]);
  let suffix = input.incrementalPrompt;
  if (bootstrap && suffix.startsWith(bootstrap)) suffix = suffix.slice(bootstrap.length);
  else if (suffix.startsWith("INPUT:\n")) suffix = suffix.slice("INPUT:\n".length);
  const imageMarker = /\n\n\[(\d+) image inputs? attached by the OpenAI-compatible client\.\]$/.exec(suffix);
  if (imageMarker && context.transcriptItemImageCounts.some((count) => count > 0)) {
    suffix = suffix.slice(0, imageMarker.index);
  }
  const offset = fullPrompt.length - suffix.length;
  const firstItem = context.transcriptItemOffsets.indexOf(offset);
  if (firstItem < 0 || !fullPrompt.endsWith(suffix)) return input.incrementalPrompt;
  if (imageMarker && context.transcriptItemImageCounts.slice(firstItem)
    .reduce((total, count) => total + count, 0) !== Number(imageMarker[1])) return input.incrementalPrompt;
  const queued = pending.actor.inbox.at(-1)?.agentContext;
  const accepted = queued?.bootstrapFingerprint === context.bootstrapFingerprint
    && isTranscriptPrefix(queued.transcriptItemHashes, context.transcriptItemHashes)
    ? queued.transcriptItemHashes
    : pending.authoritativeTranscriptItemHashes;
  const firstMissing = Array.isArray(accepted) && isTranscriptPrefix(accepted, context.transcriptItemHashes)
    ? Math.max(firstItem, accepted.length)
    : firstItem;
  return agentContextSuffixPrompt(input, context.transcriptItemHashes.slice(0, firstMissing));
}

function steeringTurnFromInput(actor, input) {
  if (!input.incrementalPrompt) {
    throw new HttpError(
      "A superseding Responses turn requires a new user prompt.",
      400,
      "cursor_sdk_superseding_turn_missing_prompt"
    );
  }
  const identity = crypto
    .createHash("sha256")
    .update(stableJson({
      cacheKey: actor.cacheKey,
      supersededToolCallIds: input.supersededToolCallIds,
      prompt: input.incrementalPrompt
    }))
    .digest("hex");
  return {
    identity,
    prompt: input.incrementalPrompt,
    systemPrompt: input.systemPrompt,
    agentContext: input.agentContext,
    model: input.model,
    workingDirectory: input.workingDirectory,
    clientTools: input.clientTools,
    trajectoryInputs: steeringTrajectoryInputs(actor.activeRun, input.trajectoryInputs ?? []),
    supersedingTurnAborted: input.supersedingTurnAborted === true,
    state: "queued",
    createdAt: Date.now()
  };
}

function depositSteeringTurn(actor, turn) {
  turn.provisionalCheckpoint = actor.activeRun?.transcriptItemHashes
    ? [...actor.activeRun.transcriptItemHashes] : undefined;
  actor.inbox.push(turn);
  actor.steeringTurns.set(turn.identity, turn);
  actor.touchedAt = Date.now();
}

function steeringTrajectoryInputs(pending, inputs) {
  try {
    const delivered = pending.steeringTrajectoryUserHashes
      ?? (pending.trajectoryInputs ?? []).filter((entry) => entry.source === "user").map((entry) => entry.contentSha256);
    const accepted = delivered.concat(pending.actor.inbox.flatMap((turn) => turn.trajectoryInputs
      .filter((entry) => entry.source === "user").map((entry) => entry.contentSha256)));
    const users = inputs.filter((entry) => entry.source === "user");
    if (!accepted.every((hash, index) => hash && users[index]?.contentSha256 === hash)) return inputs;
    let userIndex = 0;
    return inputs.filter((entry) => entry.source !== "user" || userIndex++ >= accepted.length);
  } catch {
    logTrajectoryObservationError("steering_inputs", "trace_input_projection_failed");
    return inputs;
  }
}

function queuedAnnotationTurns(actor) {
  const firstPending = actor.inbox.findIndex((turn) => turn.state === "native_pending");
  return (firstPending < 0 ? actor.inbox : actor.inbox.slice(0, firstPending))
    .filter((turn) => turn.state === "queued");
}

function queuedSteeringTurns(actor) {
  return actor.inbox.filter((turn) => turn.state === "queued");
}

function markSteeringTurnsDelivered(actor, turns, state) {
  if (turns.length === 0) return;
  const identities = new Set(turns.map((turn) => turn.identity));
  for (const turn of turns) {
    if (!["queued", "native_pending"].includes(turn.state)) continue;
    turn.state = state;
    turn.deliveredAt = Date.now();
    if (["steered", "annotated"].includes(state)) {
      try {
        const pending = actor.activeRun;
        pending.steeringTrajectoryUserHashes ??= (pending.trajectoryInputs ?? [])
          .filter((entry) => entry.source === "user").map((entry) => entry.contentSha256);
        pending.steeringTrajectoryUserHashes.push(...turn.trajectoryInputs
          .filter((entry) => entry.source === "user").map((entry) => entry.contentSha256));
      } catch {
        logTrajectoryObservationError("steering_inputs", "trace_input_projection_failed");
      }
    }
    delete turn.agentContext;
    delete turn.provisionalCheckpoint;
    delete turn.systemPrompt;
  }
  actor.inbox = actor.inbox.filter((turn) => !identities.has(turn.identity));
  const delivered = [...actor.steeringTurns.values()].filter((turn) => !["queued", "native_pending"].includes(turn.state));
  for (const turn of delivered.slice(0, Math.max(0, delivered.length - 256))) {
    actor.steeringTurns.delete(turn.identity);
  }
  actor.touchedAt = Date.now();
  if (actor.inbox.length === 0 && actor.subscriber?.deferredEventSink) {
    actor.subscriber.eventSink = actor.subscriber.deferredEventSink;
    actor.subscriber.deferredEventSink = undefined;
  }
}

function startNativeSteering(pending) {
  const turn = pending.actor.inbox[0];
  const run = pending.run;
  if (!actorOwnsPendingRun(pending) || pending.terminalError || pending.terminalOutput
    || pending.cancelledByRequest || typeof run?.steer !== "function"
    || pending.parked.size > 0 || pending.emitted.size > 0 || pending.expected.size > 0
    || !turn || turn.state !== "queued" || turn.nativeAttempted || turn.supersedingTurnAborted) return;
  turn.state = "native_pending";
  turn.nativeAttempted = true;
  const checkpoint = pending.transcriptItemHashes ? [...pending.transcriptItemHashes] : undefined;
  // ACK waits outside actor admission so tool callbacks and cancellation can progress.
  Promise.resolve().then(() => run.steer(turn.prompt)).then(
    (outcome) => withSessionActorTransition(pending.actor, async () => {
      if (!actorOwnsPendingRun(pending) || pending.run !== run || pending.terminalError
        || pending.cancelledByRequest || turn.state !== "native_pending") return;
      if (outcome === "complete_delivered") {
        const lastTurn = pending.actor.inbox.length === 1;
        const current = (lastTurn ? pending.steeringInputContext : undefined) ?? turn.agentContext;
        const base = (lastTurn ? pending.steeringInputCheckpoint : undefined) ?? checkpoint;
        const tail = base && isTranscriptPrefix(base, pending.transcriptItemHashes)
          ? pending.transcriptItemHashes.slice(base.length) : [];
        if (current && (!pending.authoritativeTranscriptItemHashes
          || isTranscriptPrefix(pending.authoritativeTranscriptItemHashes, current.transcriptItemHashes))) {
          adoptPendingInputContext(pending, current);
          for (const hash of tail) pending.transcriptItemHashes?.push(hash);
          if (pending.transcriptItemHashes) {
            pending.actor.agentEntry.provisionalTranscriptItemHashes = [...pending.transcriptItemHashes];
          }
          for (const queued of pending.actor.inbox) {
            if (base && queued.provisionalCheckpoint && isTranscriptPrefix(base, queued.provisionalCheckpoint)) {
              queued.provisionalCheckpoint = [...current.transcriptItemHashes, ...queued.provisionalCheckpoint.slice(base.length)];
            }
          }
        }
        if (lastTurn) {
          pending.steeringInputContext = undefined;
          pending.steeringInputCheckpoint = undefined;
        } else if (base && pending.steeringInputCheckpoint
          && isTranscriptPrefix(base, pending.steeringInputCheckpoint) && current) {
          pending.steeringInputCheckpoint = [...current.transcriptItemHashes, ...pending.steeringInputCheckpoint.slice(base.length)];
        }
        pending.nativeSteeringDelivered = true;
        logTrajectoryInputsAccepted(pending, turn.trajectoryInputs, "run_steer");
        markSteeringTurnsDelivered(pending.actor, [turn], "steered");
      } else if (outcome === "revert_to_followup") {
        turn.state = "queued";
      } else {
        throw new HttpError("Cursor SDK returned an unknown steering outcome.", 502, "cursor_sdk_steer_failed");
      }
      console.info(JSON.stringify({
        event: "sdk_steering_ack", sessionKey: pending.sessionKey,
        runId: run.id, outcome, turnId: turn.identity
      }));
      startNativeSteering(pending);
      signalPendingAgentRun(pending);
    }),
    (error) => { throw new HttpError(`Cursor SDK steering failed: ${error?.message || "unknown error"}`, 502, "cursor_sdk_steer_failed"); }
  ).catch((error) => withSessionActorTransition(pending.actor, async () => {
    if (actorOwnsPendingRun(pending) && pending.run === run && !pending.terminalError) {
      await failPendingAgentRun(pending, error, { cancelRun: true });
    }
  })).catch(() => undefined);
}

function mergedSteeringPrompt(turns) {
  return turns.map((turn) => turn.prompt).join("\n\n");
}

function startSteeringInboxRun(existing, input, onEvent, signal, onProgress, carriedUsage) {
  const turns = queuedSteeringTurns(existing.actor);
  if (turns.length === 0) {
    throw new HttpError("No steering turn is available for delivery.", 409, "cursor_sdk_steering_inbox_empty");
  }
  const latest = turns.at(-1);
  const followUpInput = {
    ...input,
    systemPrompt: latest.systemPrompt,
    agentContext: existing.steeringInputContext ?? latest.agentContext ?? input.agentContext,
    model: latest.model,
    workingDirectory: latest.workingDirectory,
    clientTools: latest.clientTools,
    trajectoryInputs: turns.flatMap((turn) => turn.trajectoryInputs ?? []),
    incrementalPrompt: mergedSteeringPrompt(turns),
    hasIncrementalPrompt: true,
    resumeToolResults: [],
    supersedePendingRun: false,
    supersedingTurnAborted: false,
    supersededToolCallIds: [],
    fullReplay: false
  };
  return startPendingAgentRun(
    followUpInput,
    {
      agent: existing.agent,
      cacheKey: existing.cacheKey,
      cached: true,
      cacheHit: true,
      resumed: false,
      model: followUpInput.model,
      systemPromptFingerprint: existing.systemPromptFingerprint,
      bootstrapFingerprint: existing.bootstrapFingerprint,
      transcriptItemHashes: existing.authoritativeTranscriptItemHashes,
      provisionalTranscriptItemHashes: existing.transcriptItemHashes
    },
    onEvent,
    signal,
    onProgress,
    carriedUsage,
    turns
  );
}

function supersedingToolResults(pending, input) {
  const emitted = [...pending.emitted].map((key) => pending.parked.get(key)).filter(Boolean);
  const pendingCallIds = emitted.map((parked) => parked.externalCallId);
  const declaredCallIds = new Set(input.supersededToolCallIds);
  if (
    declaredCallIds.size === 0
    || declaredCallIds.size !== input.supersededToolCallIds.length
  ) {
    throw new HttpError(
      "The superseding user turn does not match the pending Cursor SDK tool batch.",
      409,
      "cursor_sdk_superseding_turn_mismatch"
    );
  }

  const supplied = new Map();
  for (const result of input.resumeToolResults) {
    const callId = typeof result.callId === "string" ? result.callId : "";
    if (!declaredCallIds.has(callId)) {
      throw new HttpError(
        `Unknown Cursor SDK tool result for ${callId || "missing call ID"}.`,
        409,
        "cursor_sdk_tool_result_batch_mismatch"
      );
    }
    if (supplied.has(callId)) {
      throw new HttpError(
        `Duplicate Cursor SDK tool result for ${callId}.`,
        409,
        "cursor_sdk_tool_result_batch_mismatch"
      );
    }
    supplied.set(callId, result);
  }

  if (emitted.length === 0) {
    return {
      mismatched: true,
      pendingCallIds: [],
      results: null
    };
  }

  const mismatched = declaredCallIds.size !== pendingCallIds.length
    || pendingCallIds.some((callId) => !callId || !declaredCallIds.has(callId));
  return {
    mismatched,
    pendingCallIds,
    results: pendingCallIds.map((callId) => {
      const suppliedResult = mismatched ? null : supplied.get(callId);
      return suppliedResult ?? {
        callId,
        output: ABORTED_TOOL_RESULT_MESSAGE,
        isError: true
      };
    })
  };
}

function pendingExternalCallIds(pending) {
  return [...pending.emitted]
    .map((key) => pending.parked.get(key)?.externalCallId)
    .filter(Boolean);
}

function syntheticPendingToolResults(pending) {
  if (pending.emitted.size === 0) return null;
  return [...pending.emitted].flatMap((key) => {
    const parked = pending.parked.get(key);
    if (!parked) return [];
    return [{
      ...(parked.externalCallId ? { callId: parked.externalCallId } : {}),
      output: ABORTED_TOOL_RESULT_MESSAGE,
      isError: true
    }];
  });
}

async function cancelActiveRunAndEvictAgent(pending, options = {}) {
  if (pending.cleanupPromise) return pending.cleanupPromise;
  if (!actorOwnsPendingRun(pending)) return pending.terminalOutput?.usage ?? null;
  const actor = pending.actor;
  pending.cancelledByRequest = options.error ?? cancelledAgentRequestError();
  pending.terminalError = pending.cancelledByRequest;
  pending.terminalOutput = null;
  recordRunTermination(pending, pending.terminalError, options.source ?? "cancelled");
  clearPendingLease(pending);
  const subscriber = actor.subscriber;
  if (subscriber?.pending === pending) {
    subscriber.unbindAbort?.();
    actor.subscriber = null;
  }
  abortPendingToolCallbacks(pending);
  actor.touchedAt = Date.now();
  signalPendingAgentRun(pending);
  pending.cleanupPromise = (async () => {
    const deadline = Date.now() + runCleanupTimeoutMs;
    const dirtyStatePersisted = await writePersistedAgentState(pending.cacheKey, {
      sdkAgentId: pending.agentId,
      model: pending.model,
      dirty: true,
      ...pendingAgentContextState(pending)
    }).then(() => true).catch((error) => {
      console.warn(JSON.stringify({
        event: "sdk_agent_state_dirty_failed",
        requestId: pending.requestId,
        cacheKey: pending.cacheKey,
        sessionKey: pending.sessionKey,
        agentId: pending.agentId,
        runId: pending.run?.id,
        model: sdkModelSelection(pending.model),
        message: error instanceof Error ? error.message : String(error)
      }));
      return false;
    });
    if (!pending.run) await awaitRunCleanup(pending, "attachment", () => pending.runAttachment.promise, deadline);
    await awaitRunCleanup(pending, "cancel", () => cancelPendingSdkRun(pending), deadline);
    await awaitRunCleanup(pending, "dispose", () => evictAgent(pending.cacheKey, pending.agent, {
      invalidatePersisted: !dirtyStatePersisted,
      keepActor: true,
      awaitDispose: true
    }), deadline);
    if (actorOwnsPendingRun(pending)) actor.activeRun = null;
    console.info(JSON.stringify({
      event: "sdk_pending_run_cancelled_agent_evicted",
      requestId: pending.requestId,
      cacheKey: pending.cacheKey,
      sessionKey: pending.sessionKey,
      agentId: pending.agentId,
      runId: pending.run?.id || pending.cacheKey,
      model: sdkModelSelection(pending.model),
      source: options.source ?? "unknown"
    }));
    return null;
  })();
  return pending.cleanupPromise;
}

async function awaitRunCleanup(pending, phase, work, deadline = Date.now() + runCleanupTimeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HttpError("SDK cleanup deadline exceeded.", 504, "cursor_sdk_cleanup_timeout")), Math.max(0, deadline - Date.now()));
      })
    ]);
  } catch (error) {
    runtimeCounters.cleanupFailures += 1;
    console.warn(JSON.stringify({
      event: "sdk_run_cleanup_failed", requestId: pending.lastRequestId,
      sessionKey: pending.sessionKey, executionId: pending.executionId,
      agentId: pending.agentId, runId: pending.run?.id, generation: pending.generation,
      phase, errorCode: error?.code ?? "cursor_sdk_cleanup_failed"
    }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pendingLeaseExpiredError() {
  return new HttpError("Cursor SDK pending lease expired. Tool execution outcome remains owned by the caller.", 409, "cursor_sdk_pending_lease_expired");
}

function clearPendingLease(pending) {
  clearTimeout(pending.leaseTimer);
  pending.leaseTimer = null;
  pending.leaseExpiresAt = null;
  pending.waitingSince = null;
}

function renewPendingLease(pending) {
  if (!actorOwnsPendingRun(pending) || pending.terminalError) return;
  clearTimeout(pending.leaseTimer);
  pending.waitingSince ??= Date.now();
  pending.leaseExpiresAt = Date.now() + pendingLeaseMs;
  const expiresAt = pending.leaseExpiresAt;
  const reclaim = () => {
    void withSessionActorTransition(pending.actor, async () => {
      if (pending.leaseExpiresAt !== expiresAt || !actorOwnsPendingRun(pending)) return;
      if (Date.now() < expiresAt) {
        schedule();
        return;
      }
      await expirePendingAgentRun(pending);
    }).catch((error) => {
      console.warn(JSON.stringify({ event: "sdk_pending_lease_reclaim_failed", executionId: pending.executionId, errorCode: error?.code ?? "cursor_sdk_cleanup_failed" }));
    });
  };
  const schedule = () => {
    pending.leaseTimer = setTimeout(reclaim, Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647));
    pending.leaseTimer.unref?.();
  };
  schedule();
}

async function expirePendingAgentRun(pending) {
  if (!actorOwnsPendingRun(pending) || pending.terminalError) return;
  runtimeCounters.leaseExpired += 1;
  return cancelActiveRunAndEvictAgent(pending, { source: "lease_expired", error: pendingLeaseExpiredError() });
}

function recordRunTermination(pending, error, source) {
  if (pending.terminationRecorded) return;
  pending.terminationRecorded = true;
  const reason = source === "failed" ? "failed" : source === "lease_expired" ? "lease_expired" : "cancelled";
  if (isAuthenticationSDKError(error)) runtimeCounters.authenticationFailures += 1;
  if (error?.code === "cursor_sdk_cancelled") runtimeCounters.cancelled += 1;
  const toolCallIds = pendingExternalCallIds(pending);
  for (const callId of toolCallIds) {
    retiredToolCalls.set(callId, { cacheKey: pending.cacheKey, error });
  }
  while (retiredToolCalls.size > 4096) retiredToolCalls.delete(retiredToolCalls.keys().next().value);
  const entry = {
    sessionKey: pending.trajectorySessionId, sdkSessionKey: pending.sessionKey,
    executionId: pending.executionId, agentId: pending.agentId, runId: pending.run?.id ?? null,
    requestId: pending.lastRequestId, generation: pending.generation,
    terminatedAt: new Date().toISOString(), reason, source,
    errorCode: codeFromError(error, statusFromError(error)), pendingToolCount: toolCallIds.length
  };
  recentRunTerminations.push(entry);
  if (recentRunTerminations.length > 64) recentRunTerminations.shift();
  logTrajectoryExecutionTerminal(pending, reason === "failed" ? "failed" : "cancelled", error, reason);
  console.info(JSON.stringify({ event: "sdk_run_terminated", ...entry }));
}

function assertNoRetiredToolResults(cacheKey, results) {
  for (const result of results) {
    const retired = retiredToolCalls.get(result.callId);
    if (retired?.cacheKey === cacheKey) throw retired.error;
  }
}

function runtimeSnapshot() {
  const now = Date.now();
  const runs = [...sessionActors.values()].flatMap((actor) => {
    const pending = actor.activeRun;
    if (!pending) return [];
    const subscriber = activePendingAgentSubscriber(pending);
    return [{
      sessionKey: pending.trajectorySessionId, sdkSessionKey: pending.sessionKey,
      requestId: pending.lastRequestId, initialRequestId: pending.requestId,
      executionId: pending.executionId, agentId: pending.agentId, runId: pending.run?.id ?? null,
      generation: pending.generation, model: pending.model ?? null,
      phase: pending.cancelledByRequest ? "cancelling" : pending.emitted.size > 0 ? "waiting_tools"
        : pending.terminalOutput ? "terminal_delivery" : pending.run ? "running" : "starting",
      createdAt: new Date(pending.createdAt).toISOString(), ageMs: now - pending.createdAt,
      subscriber: { attached: Boolean(subscriber), requestId: subscriber?.requestId ?? null },
      pendingToolCount: pending.parked.size, pendingToolCallIds: pendingExternalCallIds(pending),
      waitingSince: pending.waitingSince ? new Date(pending.waitingSince).toISOString() : null,
      leaseExpiresAt: pending.leaseExpiresAt ? new Date(pending.leaseExpiresAt).toISOString() : null,
      leaseRemainingMs: pending.leaseExpiresAt ? Math.max(0, pending.leaseExpiresAt - now) : null,
      terminalError: pending.terminalError ? { code: codeFromError(pending.terminalError, statusFromError(pending.terminalError)), status: statusFromError(pending.terminalError) } : null
    }];
  });
  return {
    schemaVersion: 1, observedAt: new Date(now).toISOString(), serviceInvocationId,
    pid: process.pid, startedAt: runtimeStartedAt, pendingLeaseMs, cleanupTimeoutMs: runCleanupTimeoutMs,
    counts: { agents: activeAgentCount(), activeRuns: runs.length, waitingTools: runs.filter((run) => run.phase === "waiting_tools").length, detachedRuns: runs.filter((run) => !run.subscriber.attached).length },
    counters: { ...runtimeCounters }, runs, recentTerminations: [...recentRunTerminations]
  };
}

function abortPendingToolCallbacks(pending) {
  const abortedResult = {
    output: ABORTED_TOOL_RESULT_MESSAGE,
    isError: true
  };
  const sdkResult = toSdkToolResult(abortedResult);
  clearPendingToolBatchTimer(pending);
  pending.readyBatch = null;
  pending.delivery = null;
  for (const [key, parked] of pending.parked) {
    pending.parked.delete(key);
    pending.emitted.delete(key);
    if (parked.callId) {
      pending.expected.delete(parked.callId);
      pending.settledSdkCallIds.add(parked.callId);
      pending.settledSdkToolResults.set(parked.callId, {
        toolName: parked.toolCall.type,
        argsSha256: summarizeToolTraceValue(parked.toolCall.args).sha256,
        result: sdkResult
      });
    }
    parked.resolve(sdkResult);
  }
}

function requirePendingAgentRunForToolResults(existing, results) {
  if (!existing && results.length > 0) {
    throw new HttpError(
      "No pending Cursor SDK tool call matches the returned results.",
      409,
      "cursor_sdk_tool_result_unmatched"
    );
  }
}

function createPendingAgentRun(cacheKey, agentEntry, requestId, sessionKey, agentContext, trajectory = {}) {
  const actor = sessionActor(cacheKey);
  actor.generation += 1;
  const authoritativeTranscriptItemHashes = agentContext
    ? [...agentContext.transcriptItemHashes]
    : agentEntry.transcriptItemHashes;
  const provisionalTranscriptItemHashes = agentContext
    ? [...agentContext.transcriptItemHashes]
    : agentEntry.provisionalTranscriptItemHashes ?? agentEntry.transcriptItemHashes;
  actor.agentEntry = {
    agent: agentEntry.agent,
    touchedAt: Date.now(),
    systemPromptFingerprint: agentEntry.systemPromptFingerprint,
    bootstrapFingerprint: agentContext?.bootstrapFingerprint ?? agentEntry.bootstrapFingerprint,
    transcriptItemHashes: authoritativeTranscriptItemHashes,
    provisionalTranscriptItemHashes,
    contextSnapshot: actor.agentEntry?.agent === agentEntry.agent
      ? actor.agentEntry.contextSnapshot
      : undefined
  };
  const pending = {
    cacheKey,
    actor,
    generation: actor.generation,
    agent: agentEntry.agent,
    agentId: agentEntry.agent.agentId,
    run: null,
    runAttachment: deferred(),
    runAttachmentSettled: false,
    runCancelled: false,
    cancelledByRequest: null,
    requestIds: new Set(),
    lastRequestId: requestId,
    cleanupPromise: null,
    leaseTimer: null,
    leaseExpiresAt: null,
    waitingSince: null,
    expected: new Set(),
    settledSdkCallIds: new Set(),
    settledSdkToolResults: new Map(),
    parked: new Map(),
    emitted: new Set(),
    readyBatch: null,
    nextEvent: deferred(),
    delivery: null,
    terminalOutput: null,
    terminalError: null,
    toolBatchDiscoveryMs,
    toolBatchGraceMs,
    batchTimer: null,
    nextInternalToolId: 0,
    completionPromise: null,
    requestId,
    sessionKey,
    executionId: trajectory.executionId ?? `execution_${crypto.randomUUID().replaceAll("-", "")}`,
    ingressRequestId: trajectory.ingressRequestId ?? requestId,
    trajectorySessionId: trajectory.trajectorySessionId ?? sessionKey,
    trajectoryInputs: trajectory.trajectoryInputs ?? [],
    executionStartedLogged: false,
    executionTerminalLogged: false,
    outputId: null,
    outputAcceptedAt: null,
    traceSequence: 0,
    streamToolArgsByCallId: new Map(),
    streamToolCallCounts: new Map(),
    callbackToolArgsByCallId: new Map(),
    callbackToolCallCounts: new Map(),
    carriedUsage: null,
    segmentText: "",
    fullText: "",
    bootstrapFingerprint: actor.agentEntry.bootstrapFingerprint,
    systemPromptFingerprint: actor.agentEntry.systemPromptFingerprint,
    transcriptItemHashes: Array.isArray(actor.agentEntry.provisionalTranscriptItemHashes)
      ? [...actor.agentEntry.provisionalTranscriptItemHashes]
      : undefined,
    acceptedBootstrapFingerprint: agentContext?.bootstrapFingerprint,
    acceptedTranscriptItemHashes: agentContext
      ? [...agentContext.transcriptItemHashes]
      : undefined,
    authoritativeBootstrapFingerprint: agentContext?.bootstrapFingerprint,
    authoritativeTranscriptItemHashes: agentContext
      ? [...agentContext.transcriptItemHashes]
      : undefined,
    createdAt: Date.now(),
    firstCallbackAt: null,
    firstParkedAt: null,
    batchFrozenAt: null,
    batchEmittedAt: null,
    batchFreezeCount: 0,
    batchEmissionCount: 0,
    reasoningSegmentOpen: false,
    emitReasoning: false
  };
  actor.activeRun = pending;
  actor.touchedAt = Date.now();
  return pending;
}

function pendingAgentContextState(pending) {
  return typeof pending.authoritativeBootstrapFingerprint === "string"
    && Array.isArray(pending.authoritativeTranscriptItemHashes)
    && Array.isArray(pending.transcriptItemHashes)
    ? {
        systemPromptFingerprint: pending.systemPromptFingerprint,
        bootstrapFingerprint: pending.authoritativeBootstrapFingerprint,
        transcriptItemHashes: [...pending.authoritativeTranscriptItemHashes],
        provisionalTranscriptItemHashes: [...pending.transcriptItemHashes]
      }
    : { systemPromptFingerprint: pending.systemPromptFingerprint };
}

function pendingAuthoritativeContextState(pending) {
  return {
    bootstrapFingerprint: pending.authoritativeBootstrapFingerprint,
    transcriptItemHashes: pending.authoritativeTranscriptItemHashes
  };
}

function pendingProvisionalContextState(pending) {
  const queued = pending.actor.inbox.at(-1);
  const checkpoint = queued?.provisionalCheckpoint;
  if (queued?.agentContext && checkpoint && pending.transcriptItemHashes
    && isTranscriptPrefix(checkpoint, pending.transcriptItemHashes)) {
    return {
      bootstrapFingerprint: queued.agentContext.bootstrapFingerprint,
      transcriptItemHashes: [...queued.agentContext.transcriptItemHashes, ...pending.transcriptItemHashes.slice(checkpoint.length)]
    };
  }
  return {
    bootstrapFingerprint: pending.bootstrapFingerprint,
    transcriptItemHashes: pending.transcriptItemHashes
  };
}

function appendPendingContextItem(pending, value) {
  if (!Array.isArray(pending.transcriptItemHashes)) return;
  pending.transcriptItemHashes.push(contextItemHash(value));
  const entry = pending.actor.agentEntry;
  if (!actorOwnsPendingRun(pending) || entry?.agent !== pending.agent) return;
  entry.provisionalTranscriptItemHashes = [...pending.transcriptItemHashes];
  entry.touchedAt = Date.now();
  pending.actor.touchedAt = entry.touchedAt;
}

function truncatePendingContext(pending, length) {
  if (!Array.isArray(pending.transcriptItemHashes) || !Number.isSafeInteger(length)) return;
  pending.transcriptItemHashes = pending.transcriptItemHashes.slice(0, length);
  const entry = pending.actor.agentEntry;
  if (!actorOwnsPendingRun(pending) || entry?.agent !== pending.agent) return;
  entry.provisionalTranscriptItemHashes = [...pending.transcriptItemHashes];
  entry.touchedAt = Date.now();
  pending.actor.touchedAt = entry.touchedAt;
}

function assertPendingInputContext(pending, current) {
  if (!current || !Array.isArray(pending.authoritativeTranscriptItemHashes)) return;
  if (
    pending.authoritativeBootstrapFingerprint !== current.bootstrapFingerprint
    || !isTranscriptPrefix(pending.authoritativeTranscriptItemHashes, current.transcriptItemHashes)
  ) {
    throw new HttpError(
      "Responses context does not extend the pending Cursor Agent transcript.",
      409,
      "cursor_sdk_agent_context_conflict"
    );
  }
}

function adoptPendingInputContext(pending, current, input) {
  if (!current || !Array.isArray(pending.authoritativeTranscriptItemHashes)) return;
  if (
    pending.authoritativeBootstrapFingerprint !== current.bootstrapFingerprint
    || !isTranscriptPrefix(pending.authoritativeTranscriptItemHashes, current.transcriptItemHashes)
  ) return;
  pending.authoritativeBootstrapFingerprint = current.bootstrapFingerprint;
  pending.authoritativeTranscriptItemHashes = [...current.transcriptItemHashes];
  pending.bootstrapFingerprint = current.bootstrapFingerprint;
  pending.transcriptItemHashes = [...current.transcriptItemHashes];
  const entry = pending.actor.agentEntry;
  if (!actorOwnsPendingRun(pending) || entry?.agent !== pending.agent) return;
  entry.bootstrapFingerprint = pending.authoritativeBootstrapFingerprint;
  entry.transcriptItemHashes = [...pending.authoritativeTranscriptItemHashes];
  entry.provisionalTranscriptItemHashes = [...pending.transcriptItemHashes];
  if (input) entry.contextSnapshot = agentContextSnapshot(input) ?? entry.contextSnapshot;
  entry.touchedAt = Date.now();
  pending.actor.touchedAt = entry.touchedAt;
}

function contextItemHash(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function assistantContextItem(text) {
  return { type: "message", role: "assistant", text, imageCount: 0 };
}

function toolCallContextItem(parked) {
  return {
    type: "tool_call",
    callId: parked.externalCallId ?? parked.callId ?? "",
    name: parked.toolCall.type,
    arguments: normalizeJsonValue(parked.toolCall.args)
  };
}

function attachPendingAgentSubscriber(pending, input = {}) {
  if (!actorOwnsPendingRun(pending)) {
    throw new HttpError("Cursor SDK run is no longer active.", 409, "cursor_sdk_run_inactive");
  }
  const actor = pending.actor;
  const previous = actor.subscriber;
  if (previous) {
    previous.unbindAbort?.();
    actor.subscriber = null;
  }
  const subscriber = {
    actor,
    pending,
    requestId: input.requestId,
    eventSink: input.eventSink,
    deferredEventSink: input.deferredEventSink,
    progressSink: input.progressSink,
    unbindAbort: null
  };
  actor.subscriber = subscriber;
  if (input.requestId) {
    pending.requestIds.add(input.requestId);
    pending.lastRequestId = input.requestId;
  }
  subscriber.unbindAbort = bindPendingAgentRunAbort(pending, input.signal, subscriber);
  signalPendingAgentRun(pending);
  return subscriber;
}

function detachPendingAgentSubscriber(subscriber) {
  if (!subscriber) return;
  subscriber.unbindAbort?.();
  subscriber.unbindAbort = null;
  if (subscriber.actor.subscriber === subscriber) {
    subscriber.actor.subscriber = null;
    if (actorOwnsPendingRun(subscriber.pending) && !subscriber.pending.leaseExpiresAt) {
      renewPendingLease(subscriber.pending);
    }
  }
}

function activePendingAgentSubscriber(pending) {
  if (!actorOwnsPendingRun(pending)) return null;
  const subscriber = pending.actor.subscriber;
  return subscriber?.pending === pending ? subscriber : null;
}

function traceSdkPayload(event) {
  if (!event || typeof event !== "object") return { type: "unknown", value: event };
  switch (event.type) {
    case "assistant":
      return {
        type: "assistant",
        content: (Array.isArray(event.message?.content) ? event.message.content : []).map((block) => {
          if (block?.type === "text") return { type: "text", text: block.text };
          if (block?.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
          return { type: block?.type || "unknown" };
        })
      };
    case "thinking":
      return { type: "thinking", text: event.text, thinkingDurationMs: event.thinking_duration_ms };
    case "tool_call":
      return { type: "tool_call", callId: event.call_id, name: event.name, status: event.status, args: event.args };
    case "status":
      return { type: "status", status: event.status, message: event.message };
    case "task":
      return { type: "task", status: event.status, text: event.text };
    case "request":
      return { type: "request", requestId: event.request_id };
    case "system":
      return { type: "system", subtype: event.subtype, model: event.model, tools: event.tools };
    case "user":
      return { type: "user", content: event.message?.content };
    case "usage":
      return { type: "usage", usage: event.usage };
    default:
      return { type: event.type || "unknown" };
  }
}

function semanticUnknownSdkEvent(sdkType, reason, metadata = {}) {
  return [{ kind: "semantic-unknown", sdkType, reason, ...metadata }];
}

function normalizeSdkEvent(event) {
  if (!isRecord(event)) return semanticUnknownSdkEvent("unknown", "invalid_event");
  const sdkType = typeof event.type === "string" && event.type ? event.type : "unknown";
  switch (sdkType) {
    case "assistant": { // Validate every block before allowing any text to escape.
      if (!isRecord(event.message) || !Array.isArray(event.message.content)) {
        return semanticUnknownSdkEvent(sdkType, "invalid_assistant_content");
      }
      const normalized = [];
      for (const block of event.message.content) {
        if (!isRecord(block)) return semanticUnknownSdkEvent(sdkType, "invalid_assistant_block");
        if (block.type === "text") {
          if (typeof block.text !== "string") {
            return semanticUnknownSdkEvent(sdkType, "invalid_assistant_text");
          }
          normalized.push({ kind: "text", sdkType, text: block.text });
          continue;
        }
        if (block.type === "tool_use") {
          if (
            typeof block.id !== "string"
            || !block.id.trim()
            || typeof block.name !== "string"
            || !block.name.trim()
          ) {
            return semanticUnknownSdkEvent(sdkType, "invalid_assistant_tool_use");
          }
          normalized.push({
            kind: "diagnostic",
            sdkType,
            name: "assistant_tool_use",
            block: { id: block.id, name: block.name, input: block.input }
          });
          continue;
        }
        return semanticUnknownSdkEvent(sdkType, "unknown_assistant_block", {
          blockType: typeof block.type === "string" ? block.type : "unknown"
        });
      }
      return normalized.length > 0
        ? normalized
        : [{ kind: "diagnostic", sdkType, name: "assistant_empty" }];
    }
    case "tool_call": {
      const callId = typeof event.call_id === "string" ? event.call_id.trim() : "";
      const sdkName = typeof event.name === "string" ? event.name.trim() : "";
      if (!callId) return semanticUnknownSdkEvent(sdkType, "invalid_tool_call_id");
      if (!sdkName) return semanticUnknownSdkEvent(sdkType, "invalid_tool_name");
      if (!new Set(["running", "completed", "error"]).has(event.status)) {
        return semanticUnknownSdkEvent(sdkType, "unknown_tool_status", {
          status: typeof event.status === "string" ? event.status : "unknown"
        });
      }
      const toolName = sdkName === "mcp" && typeof event.args?.toolName === "string" && event.args.toolName.trim()
        ? event.args.toolName.trim()
        : sdkName;
      const args = sdkName === "mcp" && isRecord(event.args?.args) ? event.args.args : event.args;
      return [{ kind: "tool_call", sdkType, callId, sdkName, toolName, status: event.status, args }];
    }
    case "thinking": {
      if (typeof event.text !== "string") return semanticUnknownSdkEvent(sdkType, "invalid_reasoning_text");
      if (
        event.thinking_duration_ms !== undefined
        && (
          typeof event.thinking_duration_ms !== "number"
          || !Number.isFinite(event.thinking_duration_ms)
          || event.thinking_duration_ms < 0
        )
      ) {
        return semanticUnknownSdkEvent(sdkType, "invalid_reasoning_duration");
      }
      return [{
        kind: "reasoning",
        sdkType,
        text: event.text,
        ...(event.thinking_duration_ms !== undefined ? { thinkingDurationMs: event.thinking_duration_ms } : {})
      }];
    }
    case "usage": {
      const usage = normalizeSdkUsage(event.usage);
      return usage
        ? [{ kind: "usage", sdkType, usage }]
        : semanticUnknownSdkEvent(sdkType, "invalid_usage");
    }
    case "status": {
      if (event.status === "CREATING" || event.status === "RUNNING") {
        return [{
          kind: "progress",
          sdkType,
          status: event.status,
          ...(typeof event.message === "string" ? { message: event.message } : {})
        }];
      }
      if (["FINISHED", "ERROR", "CANCELLED", "EXPIRED"].includes(event.status)) {
        return [{
          kind: "terminal-impacting",
          sdkType,
          status: event.status,
          ...(typeof event.message === "string" ? { message: event.message } : {})
        }];
      }
      return semanticUnknownSdkEvent(sdkType, "unknown_run_status", {
        status: typeof event.status === "string" ? event.status : "unknown"
      });
    }
    case "system":
      return [{ kind: "diagnostic", sdkType, name: "system" }];
    case "user":
      return [{ kind: "diagnostic", sdkType, name: "user" }];
    case "request":
      return [{
        kind: "diagnostic",
        sdkType,
        name: "request",
        ...(typeof event.request_id === "string" ? { requestId: event.request_id } : {})
      }];
    case "task":
      return [{
        kind: "diagnostic",
        sdkType,
        name: "task",
        ...(typeof event.status === "string" ? { status: event.status } : {}),
        ...(typeof event.text === "string" ? { text: event.text } : {})
      }];
    default:
      return semanticUnknownSdkEvent(sdkType, "unknown_event_type");
  }
}

function sdkSemanticUnknownError(event) {
  const error = new HttpError(
    `Cursor SDK emitted an unsupported semantic event (${event.reason}).`,
    502,
    "sdk_semantic_unknown"
  );
  error.sdkType = event.sdkType;
  error.reason = event.reason;
  return error;
}

function logSdkSemanticUnknown(pending, run, error) {
  console.warn(JSON.stringify({
    event: "sdk_semantic_unknown",
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    agentId: pending.agentId,
    runId: run.id,
    sdkType: error.sdkType,
    reason: error.reason
  }));
  error.semanticUnknownLogged = true;
}

function terminalRunStatus(status) {
  if (status === "FINISHED") return "finished";
  if (status === "CANCELLED") return "cancelled";
  if (status === "ERROR" || status === "EXPIRED") return "error";
  return null;
}

function assertTerminalStatus(previous, current) {
  if (!previous || previous.status === current.status) return current;
  throw sdkSemanticUnknownError({
    sdkType: "status",
    reason: "conflicting_terminal_status",
    previousStatus: previous.status,
    status: current.status
  });
}

function assertRunResultMatchesTerminalStatus(terminal, result) {
  if (!isRecord(result) || !new Set(["finished", "error", "cancelled"]).has(result.status)) {
    throw sdkSemanticUnknownError({ sdkType: "result", reason: "invalid_run_result" });
  }
  if (!terminal) return;
  const expected = terminalRunStatus(terminal.status);
  if (expected !== result.status) {
    throw sdkSemanticUnknownError({
      sdkType: "status",
      reason: "terminal_status_mismatch",
      status: terminal.status,
      resultStatus: result.status
    });
  }
}

function logSdkTraceEvent(pending, run, event) {
  pending.traceSequence += 1;
  console.info(JSON.stringify({
    event: "sdk_trace_event",
    sequence: pending.traceSequence,
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    agentId: pending.agentId,
    runId: run.id,
    sdk: traceSdkPayload(event)
  }));
}

async function consumePendingAgentRun(pending, run) {
  let usage = null;
  let turnUsage = null;
  let terminalStatus = null;
  try {
    for await (const rawEvent of run.stream()) {
      if (pending.terminalError) throw pending.terminalError;
      activePendingAgentSubscriber(pending)?.progressSink?.();
      logSdkTraceEvent(pending, run, rawEvent);
      for (const event of normalizeSdkEvent(rawEvent)) {
        if (event.kind === "semantic-unknown") {
          closePendingReasoningSegment(pending, "semantic_unknown");
          const error = sdkSemanticUnknownError(event);
          logSdkSemanticUnknown(pending, run, error);
          throw error;
        }
        if (event.kind === "tool_call") {
          closePendingReasoningSegment(pending, "tool_call");
          const phase = `stream_${event.status}`;
          const record = logToolArgsTrace({
            pending,
            runId: run.id,
            phase,
            callId: event.callId,
            toolName: event.toolName,
            args: event.args
          });
          const callId = event.callId;
          const streamCount = (pending.streamToolCallCounts.get(callId) || 0) + 1;
          pending.streamToolCallCounts.set(callId, streamCount);
          pending.streamToolArgsByCallId.set(callId, record);
          console.info(JSON.stringify({
            event: "sdk_tool_event_observed",
            ...pendingDiagnosticClock(pending),
            phase,
            requestId: pending.requestId,
            sessionKey: pending.sessionKey,
            runId: run.id,
            callId,
            toolName: event.toolName,
            streamCount,
            state: pendingToolState(pending)
          }));
          recordPendingToolCallStatus(pending, callId, event.status);
          continue;
        }
        if (event.kind === "usage") {
          turnUsage = event.usage;
          continue;
        }
        if (event.kind === "text") {
          closePendingReasoningSegment(pending, "assistant_text");
          pending.outputAcceptedAt ??= new Date().toISOString();
          const outputId = currentTrajectoryOutputId(pending);
          pending.segmentText += event.text;
          pending.fullText += event.text;
          const subscriber = activePendingAgentSubscriber(pending);
          if (subscriber?.eventSink && event.text) {
            subscriber.eventSink({
              type: "text",
              text: event.text,
              outputId,
              executionId: pending.executionId,
              runId: run.id,
              agentId: pending.agentId
            });
          }
          continue;
        }
        if (event.kind === "reasoning") {
          emitPendingReasoningEvent(pending, event);
          continue;
        }
        if (event.kind === "terminal-impacting") {
          closePendingReasoningSegment(pending, "terminal_status");
          terminalStatus = assertTerminalStatus(terminalStatus, event);
        }
      }
    }
    closePendingReasoningSegment(pending, "stream_ended");
    const result = await run.wait();
    assertRunResultMatchesTerminalStatus(terminalStatus, result);
    const cumulativeUsage = normalizeSdkUsage(result.usage);
    if (result.usage !== undefined && !cumulativeUsage) {
      throw sdkSemanticUnknownError({ sdkType: "result", reason: "invalid_result_usage" });
    }
    console.info(JSON.stringify({
      event: "cursor_usage_observed",
      runId: run.id,
      agentId: pending.agentId,
      turnUsage,
      cumulativeRunUsage: cumulativeUsage,
      exposedUsage: turnUsage ? "per_turn" : "prompt_estimate"
    }));
    // RunResult.usage is cumulative across turns. Only the usage event emitted
    // for this turn may cross the bridge boundary; the caller falls back to its
    // full prompt estimate when the SDK did not emit a per-turn usage event.
    usage = turnUsage;
    if (result.status === "error") throw sdkRunFailureError(result);
    let finalText = pending.segmentText;
    if (!pending.fullText && typeof result.result === "string") {
      pending.fullText = result.result;
      finalText = result.result;
    }
    const publishedFinalText = stripFinalMarker(finalText);
    console.info(JSON.stringify({
      event: "sdk_trace_output",
      requestId: pending.requestId,
      sessionKey: pending.sessionKey,
      agentId: pending.agentId,
      runId: run.id,
      status: result.status,
      textChars: publishedFinalText.length
    }));
    const outputId = finalizeTrajectoryOutput(pending, run.id, "final", publishedFinalText);
    const output = {
      text: publishedFinalText,
      toolCalls: [],
      agentID: pending.agentId,
      runID: run.id,
      executionID: pending.executionId,
      outputID: outputId,
      outputType: "final",
      status: result.status,
      ...(usage ? { usage } : {})
    };
    if (output.text) appendPendingContextItem(pending, assistantContextItem(output.text));
    logTrajectoryExecutionTerminal(pending, result.status, null, "run_wait");
    await completePendingAgentRun(pending, output);
    return output;
  } catch (error) {
    closePendingReasoningSegment(pending, "run_error");
    if (error?.code === "sdk_semantic_unknown" && !error.semanticUnknownLogged) {
      logSdkSemanticUnknown(pending, run, error);
    }
    await failPendingAgentRun(pending, error, { cancelRun: true });
    throw error;
  }
}

function emitPendingReasoningEvent(pending, event) {
  if (!pending.emitReasoning) return;
  if (event.text) {
    pending.reasoningSegmentOpen = true;
    activePendingAgentSubscriber(pending)?.eventSink?.({ type: "reasoning", text: event.text, done: false });
  }
  if (event.thinkingDurationMs === undefined || !pending.reasoningSegmentOpen) return;
  activePendingAgentSubscriber(pending)?.eventSink?.({
    type: "reasoning",
    text: "",
    done: true,
    thinkingDurationMs: event.thinkingDurationMs
  });
  pending.reasoningSegmentOpen = false;
}

function closePendingReasoningSegment(pending, reason) {
  if (!pending.reasoningSegmentOpen) return;
  pending.reasoningSegmentOpen = false;
  activePendingAgentSubscriber(pending)?.eventSink?.({ type: "reasoning", text: "", done: true });
  console.warn(JSON.stringify({
    event: "cursor_sdk_reasoning_segment_closed",
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    runId: pending.run?.id || pending.cacheKey,
    reason
  }));
}

async function waitForPendingAgentEvent(pending, subscriberInput) {
  if (pending.terminalError) throw pending.terminalError;
  const subscriber = subscriberInput ?? attachPendingAgentSubscriber(pending);
  const detachOnReturn = subscriberInput === undefined;
  try {
    for (;;) {
      if (pending.terminalError) throw pending.terminalError;
      if (pending.leaseExpiresAt && pending.leaseExpiresAt <= Date.now()) throw pendingLeaseExpiredError();
      if (pending.actor.subscriber !== subscriber) {
        throw new HttpError(
          "Cursor SDK stream subscriber was replaced by a newer request.",
          499,
          "cursor_sdk_subscriber_replaced"
        );
      }
      const event = takePendingAgentEvent(pending);
      if (event?.type === "tool_call") {
        renewPendingLease(pending);
        for (const call of event.calls) {
          const comparedTo = call.sdkCallId ? pending.callbackToolArgsByCallId.get(call.sdkCallId) : undefined;
          logToolArgsTrace({
            pending,
            runId: pending.run?.id || pending.cacheKey,
            phase: "bridge_output",
            callId: call.sdkCallId,
            toolName: call.toolCall.type,
            args: call.toolCall.args,
            comparedTo
          });
        }
        return {
          text: String(event.narration ?? "").trim(),
          toolCalls: event.calls.map((call) => ({
            ...(call.callId ? { callId: call.callId } : {}),
            name: call.toolCall.type,
            arguments: call.toolCall.args,
            trajectoryId: call.outputId,
            executionId: pending.executionId,
            runId: pending.run?.id || pending.cacheKey,
            agentId: pending.agentId
          })),
          agentID: pending.agentId,
          runID: pending.run?.id || pending.cacheKey,
          executionID: pending.executionId,
          ...(event.narrationOutputId ? {
            outputID: event.narrationOutputId
          } : {}),
          outputType: "commentary",
          status: "tool_call"
        };
      }
      if (event?.type === "done") {
        clearPendingToolBatchTimer(pending);
        pending.readyBatch = null;
        const usage = combineSdkUsage(pending.carriedUsage, event.output.usage);
        const output = usage ? { ...event.output, usage } : { ...event.output };
        Object.defineProperty(output, pendingAgentOutputOwner, {
          value: { pending, delivery: pending.delivery },
          enumerable: false
        });
        return output;
      }

      const wakeup = pending.nextEvent;
      await wakeup.promise;
      if (pending.nextEvent === wakeup) pending.nextEvent = deferred();
    }
  } finally {
    if (detachOnReturn) detachPendingAgentSubscriber(subscriber);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function takePendingAgentEvent(pending) {
  if (pending.terminalError) throw pending.terminalError;
  if (pending.delivery) return pending.delivery.event;
  if (pending.emitted.size === 0 && pending.readyBatch?.size > 0) {
    const batch = [...pending.readyBatch].flatMap((key) => {
      const parked = pending.parked.get(key);
      return parked ? [[key, parked]] : [];
    });
    pending.readyBatch = null;
    if (batch.length > 0) {
      for (const [key] of batch) pending.emitted.add(key);
      pending.batchEmittedAt = Date.now();
      pending.batchEmissionCount += 1;
      console.info(JSON.stringify({
        event: "sdk_tool_batch_emitted",
        ...pendingDiagnosticClock(pending),
        requestId: pending.requestId,
        sessionKey: pending.sessionKey,
        runId: pending.run?.id || pending.cacheKey,
        batchIndex: pending.batchEmissionCount,
        callIds: batch.map(([, parked]) => parked.callId).filter(Boolean),
        state: pendingToolState(pending)
      }));
      schedulePendingToolBatch(pending);
      const runId = pending.run?.id || pending.cacheKey;
      const narration = takePendingNarration(pending);
      const narrationOutputId = String(narration ?? "").trim()
        ? finalizeTrajectoryOutput(pending, runId, "commentary", narration)
        : undefined;
      const event = {
        type: "tool_call",
        calls: batch.map(([, parked]) => ({
          sdkCallId: parked.callId,
          callId: parked.externalCallId,
          toolCall: parked.toolCall,
          outputId: logTrajectoryToolOutput(pending, runId, parked)
        })),
        narration,
        narrationOutputId
      };
      const narrationText = String(event.narration ?? "").trim();
      if (narrationText) appendPendingContextItem(pending, assistantContextItem(narrationText));
      const preToolCallCheckpointLength = pending.transcriptItemHashes?.length;
      for (const [, parked] of batch) appendPendingContextItem(pending, toolCallContextItem(parked));
      pending.delivery = { type: "tool_call", event, preToolCallCheckpointLength };
      return event;
    }
  }
  if (pending.terminalOutput && pending.parked.size === 0 && pending.emitted.size === 0
    && !pending.actor.inbox.some((turn) => turn.state === "native_pending")) {
    const event = { type: "done", output: pending.terminalOutput };
    pending.delivery = { type: "done", event };
    return event;
  }
  return null;
}

function acknowledgePendingAgentOutput(output) {
  const owner = output?.[pendingAgentOutputOwner];
  if (!owner || owner.delivery?.type !== "done") return false;
  const { pending, delivery } = owner;
  if (pending.delivery !== delivery) return false;
  const resumable = output.status === "finished"
    && !pending.terminalError
    && actorOwnsPendingRun(pending)
    && pending.parked.size === 0
    && pending.emitted.size === 0
    && typeof pending.model === "string"
    && Boolean(pending.model);
  owner.acknowledgement = resumable
    ? writePersistedAgentState(pending.cacheKey, {
        sdkAgentId: pending.agentId,
        model: pending.model,
        dirty: false,
        ...pendingAgentContextState(pending)
      }, {
        guard: () => !pending.terminalError && actorOwnsAgentGeneration(pending)
      }).catch((error) => {
        console.warn(JSON.stringify({
          event: "sdk_agent_state_clean_failed",
          requestId: pending.requestId,
          cacheKey: pending.cacheKey,
          sessionKey: pending.sessionKey,
          agentId: pending.agentId,
          runId: pending.run?.id,
          model: sdkModelSelection(pending.model),
          message: error instanceof Error ? error.message : String(error)
        }));
      })
    : Promise.resolve();
  pending.delivery = null;
  clearPendingLease(pending);
  if (actorOwnsPendingRun(pending)) {
    pending.actor.activeRun = null;
    pending.actor.touchedAt = Date.now();
  }
  return true;
}

function pendingAgentOutputAcknowledgement(output) {
  return output?.[pendingAgentOutputOwner]?.acknowledgement ?? Promise.resolve();
}

function parkPendingToolCall(pending, { callId, toolCall }) {
  if (pending.terminalError) return Promise.reject(pending.terminalError);
  const settledSdkToolResults = pending.settledSdkToolResults ??= new Map();
  const key = callId ? `sdk:${callId}` : `anonymous:${pending.nextInternalToolId++}`;
  const parked = pending.parked.get(key);
  const settled = callId ? settledSdkToolResults.get(callId) : undefined;
  const previous = parked || settled;
  if (previous) {
    const argsSha256 = summarizeToolTraceValue(toolCall.args).sha256;
    const previousToolName = parked ? previous.toolCall.type : previous.toolName;
    const previousArgsSha256 = parked
      ? summarizeToolTraceValue(previous.toolCall.args).sha256
      : previous.argsSha256;
    const argsMatch = previousToolName === toolCall.type && previousArgsSha256 === argsSha256;
    const action = argsMatch
      ? parked
        ? "reuse_parked_callback"
        : "reuse_settled_result"
      : "reject_mismatched_duplicate";
    console.warn(JSON.stringify({
      event: "sdk_tool_call_duplicate",
      ...pendingDiagnosticClock(pending),
      requestId: pending.requestId,
      sessionKey: pending.sessionKey,
      runId: pending.run?.id || pending.cacheKey,
      callId,
      toolName: toolCall.type,
      reason: parked ? "parked" : "settled",
      action,
      argsMatch,
      streamCount: callId ? pending.streamToolCallCounts.get(callId) || 0 : 0,
      callbackCount: callId ? pending.callbackToolCallCounts.get(callId) || 0 : 0,
      state: pendingToolState(pending)
    }));
    if (argsMatch) return parked?.promise ?? Promise.resolve(settled.result);
    return Promise.reject(new HttpError(
      `Cursor SDK repeated forwarded tool call ${callId || key}.`,
      409,
      "cursor_sdk_tool_call_duplicate"
    ));
  }
  const result = deferred();
  pending.firstCallbackAt ??= Date.now();
  pending.parked.set(key, {
    callId,
    externalCallId: externalToolCallId(
      pending.sessionKey,
      `${pending.executionId}\0${callId || key}`,
      toolCall.type
    ),
    toolCall,
    promise: result.promise,
    resolve: result.resolve,
    reject: result.reject
  });
  pending.firstParkedAt ??= Date.now();
  schedulePendingToolBatch(pending);
  return result.promise;
}

function recordPendingToolCallStatus(pending, callId, status) {
  if (!callId) return;
  if (status === "running") {
    if (pending.settledSdkCallIds.has(callId) || pending.expected.has(callId)) return;
    pending.expected.add(callId);
  } else if (status === "completed" || status === "error") {
    pending.expected.delete(callId);
    pending.settledSdkCallIds.add(callId);
  }
  schedulePendingToolBatch(pending);
}

function schedulePendingToolBatch(pending) {
  if (pending.emitted.size > 0) return;
  if (pending.readyBatch?.size > 0) return;
  const hasUnemitted = [...pending.parked.keys()].some((key) => !pending.emitted.has(key));
  if (!hasUnemitted) {
    clearPendingToolBatchTimer(pending);
    return;
  }
  const observedCallKeys = new Set([...pending.expected].map((callId) => `sdk:${callId}`));
  for (const key of pending.parked.keys()) observedCallKeys.add(key);
  // shortcut: timers approximate the missing SDK batch-end event; remove when the SDK exposes one.
  const delayMs = Math.max(0, observedCallKeys.size > 1
    ? pending.toolBatchGraceMs
    : pending.toolBatchDiscoveryMs);
  if (delayMs === 0) {
    freezePendingToolBatch(pending);
    return;
  }
  clearPendingToolBatchTimer(pending);
  const timer = setTimeout(() => {
    if (pending.batchTimer !== timer) return;
    pending.batchTimer = null;
    freezePendingToolBatch(pending);
  }, delayMs);
  pending.batchTimer = timer;
  timer.unref?.();
}

function freezePendingToolBatch(pending) {
  if (pending.readyBatch?.size > 0) return;
  const available = [...pending.parked.entries()].filter(([key]) => !pending.emitted.has(key));
  if (available.length === 0) {
    clearPendingToolBatchTimer(pending);
    return;
  }
  // shortcut: anonymous SDK calls remain singleton; remove when SDK call IDs are always available.
  const batch = available.some(([, parked]) => !parked.callId) ? available.slice(0, 1) : available;
  clearPendingToolBatchTimer(pending);
  pending.batchFrozenAt = Date.now();
  pending.batchFreezeCount += 1;
  pending.readyBatch = new Set(batch.map(([key]) => key));
  console.info(JSON.stringify({
    event: "sdk_tool_batch_frozen",
    ...pendingDiagnosticClock(pending),
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    agentId: pending.agentId,
    runId: pending.run?.id || pending.cacheKey,
    model: sdkModelSelection(pending.model),
    batchIndex: pending.batchFreezeCount,
    callIds: batch.map(([, parked]) => parked.callId).filter(Boolean),
    availableCallIds: available.map(([, parked]) => parked.callId).filter(Boolean),
    expected: [...pending.expected],
    state: pendingToolState(pending)
  }));
  signalPendingAgentRun(pending);
}

function clearPendingToolBatchTimer(pending) {
  if (pending.batchTimer) clearTimeout(pending.batchTimer);
  pending.batchTimer = null;
}

function resolvePendingToolResults(pending, results, options = {}) {
  if (pending.terminalError) throw pending.terminalError;
  if (pending.leaseExpiresAt && pending.leaseExpiresAt <= Date.now()) {
    throw pendingLeaseExpiredError();
  }
  if (pending.emitted.size === 0) {
    throw new HttpError("No pending Cursor SDK tool call matches the returned results.", 409, "cursor_sdk_tool_result_unmatched");
  }
  const emitted = [...pending.emitted].map((key) => ({ key, parked: pending.parked.get(key) }));
  console.info(JSON.stringify({
    event: "sdk_tool_results_resolving",
    ...pendingDiagnosticClock(pending),
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    runId: pending.run?.id || pending.cacheKey,
    resultCallIds: results.map((result) => result.callId).filter(Boolean),
    emittedCallIds: emitted.map(({ parked }) => parked?.callId).filter(Boolean),
    state: pendingToolState(pending)
  }));
  if (emitted.some(({ parked }) => !parked)) {
    throw new HttpError("No pending Cursor SDK tool call matches the returned results.", 409, "cursor_sdk_tool_result_unmatched");
  }

  if (emitted.some(({ parked }) => !parked.callId)) {
    // shortcut: singleton anonymous calls pair by position; remove when SDK call IDs are always available.
    if (emitted.length !== 1 || results.length !== 1) {
      throw new HttpError(
        `Expected ${emitted.length} Cursor SDK tool result(s), received ${results.length}.`,
        409,
        "cursor_sdk_tool_result_batch_mismatch"
      );
    }
    const [{ key, parked }] = emitted;
    if (results[0].callId && results[0].callId !== parked.externalCallId) {
      throw new HttpError("Tool result does not match the pending callback.", 409, "cursor_sdk_tool_result_batch_mismatch");
    }
    const annotationTurns = options.annotationTurns ?? [];
    const result = annotationTurns.length > 0
      ? toolResultWithSteeringAnnotation(results[0], annotationTurns)
      : results[0];
    if (annotationTurns.length > 0) recordSteeringAnnotation(pending, annotationTurns);
    if (pending.delivery?.type === "tool_call") pending.delivery = null;
    pending.emitted.delete(key);
    pending.parked.delete(key);
    if (parked.callId) {
      pending.expected.delete(parked.callId);
      pending.settledSdkCallIds.add(parked.callId);
    }
    const sdkResult = toSdkToolResult(result);
    if (parked.callId) {
      pending.settledSdkToolResults.set(parked.callId, {
        toolName: parked.toolCall.type,
        argsSha256: summarizeToolTraceValue(parked.toolCall.args).sha256,
        result: sdkResult
      });
    }
    parked.resolve(sdkResult);
    clearPendingLease(pending);
    logTrajectoryInputsAccepted(pending, [result], "tool_callback");
    schedulePendingToolBatch(pending);
    signalPendingAgentRun(pending);
    return;
  }

  const emittedByCallId = new Map(emitted.map((entry) => [entry.parked.externalCallId, entry]));
  const matchedResults = new Map();
  for (const result of results) {
    const callId = typeof result.callId === "string" ? result.callId : "";
    if (!emittedByCallId.has(callId) || matchedResults.has(callId)) {
      console.warn(JSON.stringify({
        event: "sdk_tool_result_ignored",
        reason: matchedResults.has(callId) ? "replayed" : "unknown",
        requestId: pending.requestId,
        sessionKey: pending.sessionKey,
        callId
      }));
      continue;
    }
    matchedResults.set(callId, result);
  }

  const missingCallIds = [...emittedByCallId.keys()].filter((callId) => !matchedResults.has(callId));
  if (missingCallIds.length > 0) {
    throw new HttpError(
      `Missing Cursor SDK tool result(s) for: ${missingCallIds.join(", ")}.`,
      409,
      "cursor_sdk_tool_result_batch_mismatch"
    );
  }

  const annotationTurns = options.annotationTurns ?? [];
  clearPendingLease(pending);
  if (annotationTurns.length > 0) {
    const finalCallId = emitted.at(-1).parked.externalCallId;
    matchedResults.set(
      finalCallId,
      toolResultWithSteeringAnnotation(matchedResults.get(finalCallId), annotationTurns)
    );
    recordSteeringAnnotation(pending, annotationTurns);
  }
  if (pending.delivery?.type === "tool_call") pending.delivery = null;
  for (const [callId, { key, parked }] of emittedByCallId) {
    pending.emitted.delete(key);
    pending.parked.delete(key);
    if (parked.callId) {
      pending.expected.delete(parked.callId);
      pending.settledSdkCallIds.add(parked.callId);
    }
    const sdkResult = toSdkToolResult(matchedResults.get(callId));
    if (parked.callId) {
      pending.settledSdkToolResults.set(parked.callId, {
        toolName: parked.toolCall.type,
        argsSha256: summarizeToolTraceValue(parked.toolCall.args).sha256,
        result: sdkResult
      });
    }
    parked.resolve(sdkResult);
    logTrajectoryInputsAccepted(pending, [matchedResults.get(callId)], "tool_callback");
  }
  schedulePendingToolBatch(pending);
  signalPendingAgentRun(pending);
}

function toolResultWithSteeringAnnotation(result, turns) {
  const annotation = turns
    .map((turn) => `<user_interjection>\n${turn.prompt}\n</user_interjection>`)
    .join("\n\n");
  const output = stringifyToolResult(result.output);
  return {
    ...result,
    output: output ? `${output}\n\n${annotation}` : annotation
  };
}

function recordSteeringAnnotation(pending, turns) {
  logTrajectoryInputsAccepted(
    pending,
    turns.flatMap((turn) => turn.trajectoryInputs ?? []),
    "tool_annotation"
  );
  markSteeringTurnsDelivered(pending.actor, turns, "annotated");
  console.info(JSON.stringify({
    event: "sdk_steering_turns_annotated",
    cacheKey: pending.cacheKey,
    sessionKey: pending.sessionKey,
    runId: pending.run?.id || pending.cacheKey,
    turnCount: turns.length
  }));
}

async function completePendingAgentRun(pending, output) {
  if (pending.terminalError || pending.cancelledByRequest) return;
  pending.terminalOutput = output;
  if (pending.parked.size === 0 && pending.emitted.size === 0) {
    clearPendingToolBatchTimer(pending);
    pending.readyBatch = null;
  }
  signalPendingAgentRun(pending);
  if (!activePendingAgentSubscriber(pending) && !pending.leaseExpiresAt) renewPendingLease(pending);
}

function failPendingAgentRun(pending, error, options = {}) {
  if (pending.terminalError) return pending.failurePromise ?? pending.cleanupPromise ?? Promise.resolve();
  const ownsRun = actorOwnsPendingRun(pending);
  closePendingReasoningSegment(pending, "failure");
  const runId = pending.run?.id || pending.cacheKey;
  if (pending.segmentText) {
    finalizeTrajectoryOutput(pending, runId, "commentary", pending.segmentText, true);
    pending.segmentText = "";
  }
  logTrajectory("trajectory_error", {
    sessionKey: pending.trajectorySessionId,
    sdkSessionKey: pending.sessionKey,
    ingressRequestId: pending.ingressRequestId,
    requestId: pending.requestId,
    executionId: pending.executionId,
    agentId: pending.agentId,
    ...(pending.run?.id ? { runId: pending.run.id } : {}),
    errorCode: error?.code ?? "cursor_sdk_run_failed",
    phase: pending.run ? "run" : "agent_send",
    retryable: isRetryableSDKRunError(error),
    terminal: true
  });
  logTrajectoryExecutionTerminal(
    pending,
    pending.run ? "failed" : "send_failed",
    error,
    pending.run ? "run" : "agent_send"
  );
  console.warn(JSON.stringify({
    event: "sdk_pending_run_failed",
    ...pendingDiagnosticClock(pending),
    requestId: pending.requestId,
    sessionKey: pending.sessionKey,
    agentId: pending.agentId,
    runId: pending.run?.id || pending.cacheKey,
    model: sdkModelSelection(pending.model),
    error: {
      name: error?.name,
      code: error?.code,
      message: error?.message || String(error)
    },
    cancelRun: options.cancelRun === true,
    state: pendingToolState(pending)
  }));
  pending.terminalError = error;
  pending.terminalOutput = null;
  clearPendingLease(pending);
  if (ownsRun) recordRunTermination(pending, error, "failed");
  const stateBarrier = ownsRun && typeof pending.model === "string" && pending.model
    ? writePersistedAgentState(pending.cacheKey, {
        sdkAgentId: pending.agentId,
        model: pending.model,
        dirty: true,
        ...pendingAgentContextState(pending)
      }).then(() => true).catch((stateError) => {
        console.warn(JSON.stringify({
          event: "sdk_agent_state_dirty_failed",
          requestId: pending.requestId,
          cacheKey: pending.cacheKey,
          sessionKey: pending.sessionKey,
          agentId: pending.agentId,
          runId: pending.run?.id,
          model: sdkModelSelection(pending.model),
          message: stateError instanceof Error ? stateError.message : String(stateError)
        }));
        return false;
      })
    : Promise.resolve(false);
  pending.carriedUsage = null;
  clearPendingToolBatchTimer(pending);
  pending.readyBatch = null;
  pending.delivery = null;
  for (const parked of pending.parked.values()) parked.reject(error);
  pending.parked.clear();
  pending.emitted.clear();
  if (ownsRun) {
    pending.actor.activeRun = null;
    pending.actor.touchedAt = Date.now();
  }
  if (ownsRun && pending.actor.subscriber?.pending === pending) {
    pending.actor.subscriber.unbindAbort?.();
    pending.actor.subscriber = null;
  }
  const contextOverflow = error?.code === "cursor_sdk_context_compacted";
  const cleanupDeadline = Date.now() + runCleanupTimeoutMs;
  const cancellationRequested = options.cancelRun === true && Boolean(pending.run);
  const cancellation = cancellationRequested
    ? awaitRunCleanup(pending, "cancel", () => cancelPendingSdkRun(pending), cleanupDeadline)
    : Promise.resolve();
  const dispose = () => ownsRun
    ? awaitRunCleanup(pending, "dispose", () => evictAgent(pending.cacheKey, pending.agent, {
        invalidatePersistedPromise: stateBarrier,
        awaitDispose: isAuthenticationSDKError(error) || contextOverflow,
        keepActor: true
      }), cleanupDeadline)
    : Promise.resolve();
  const eviction = contextOverflow ? cancellation.then(dispose) : dispose();
  signalPendingAgentRun(pending);
  pending.failurePromise = Promise.all([stateBarrier, eviction, cancellation])
    .then(([, disposed, cancelled]) => {
      if (!contextOverflow) return;
      error.contextRetrySafe = ownsRun && cancellationRequested
        && disposed !== null && cancelled !== null;
      try {
        console.info(JSON.stringify({
          event: "sdk_context_overflow_cleanup",
          requestId: pending.requestId,
          sessionKey: pending.sessionKey,
          executionId: pending.executionId,
          runId: pending.run?.id,
          generation: pending.generation,
          contextRetrySafe: error.contextRetrySafe
        }));
      } catch { /* Cleanup ownership does not depend on observation. */ }
    });
  if (contextOverflow) error.contextRecoveryBarrier = pending.failurePromise;
  return pending.failurePromise;
}

async function attachPendingAgentRun(pending, run) {
  pending.run = run;
  settlePendingRunAttachment(pending);
  const cancellation = pending.terminalError ?? pending.cancelledByRequest;
  if (!cancellation) {
    startNativeSteering(pending);
    return;
  }
  await awaitRunCleanup(pending, "late_attachment_cancel", () => cancelPendingSdkRun(pending));
  throw cancellation;
}

async function cancelPendingSdkRun(pending) {
  if (!pending.run || pending.runCancelled) return;
  pending.runCancelled = true;
  await pending.run.cancel();
}

function settlePendingRunAttachment(pending) {
  if (pending.runAttachmentSettled) return;
  pending.runAttachmentSettled = true;
  pending.runAttachment.resolve();
}

function bindPendingAgentRunAbort(pending, signal, subscriber) {
  if (!signal) return () => {};
  const abort = () => {
    if (subscriber && pending.actor.subscriber !== subscriber) return;
    void withSessionActorTransition(pending.actor, () => {
      if (subscriber && pending.actor.subscriber !== subscriber) return;
      if (signal.reason?.code === "cursor_sdk_subscriber_disconnected") {
        detachPendingAgentSubscriber(subscriber);
        signalPendingAgentRun(pending);
        return;
      }
      return cancelActiveRunAndEvictAgent(pending, {
        source: "subscriber_abort",
        error: signal.reason ?? cancelledAgentRequestError()
      });
    }).catch((error) => {
      console.warn(JSON.stringify({
        event: "sdk_pending_run_cancel_agent_eviction_failed",
        requestId: pending.requestId,
        cacheKey: pending.cacheKey,
        sessionKey: pending.sessionKey,
        agentId: pending.agentId,
        runId: pending.run?.id,
        model: sdkModelSelection(pending.model),
        message: error instanceof Error ? error.message : String(error)
      }));
    });
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function openAgentRequestLifecycle(requestId, request, response, options = {}) {
  const idleTimeoutMs = options.idleTimeoutMs ?? runIdleTimeoutMs;
  const maxTimeoutMs = options.maxTimeoutMs ?? runMaxTimeoutMs;
  let entry = agentRequestLifecycles.get(requestId);
  if (entry && !entry.expiry) {
    throw new HttpError("Another request is already using this Cursor SDK request ID.", 409, "cursor_sdk_request_conflict");
  }
  if (!entry) {
    entry = { controller: new AbortController(), expiry: null };
    agentRequestLifecycles.set(requestId, entry);
  }
  if (entry.expiry) clearTimeout(entry.expiry);
  entry.expiry = null;

  const abortFromTransport = () => {
    if (response?.writableEnded) return;
    entry.controller.abort(new HttpError("Cursor SDK subscriber disconnected.", 499, "cursor_sdk_subscriber_disconnected"));
  };
  request?.once("aborted", abortFromTransport);
  response?.once("close", abortFromTransport);
  response?.once("error", abortFromTransport);
  let idleDeadline = null;
  const touch = () => {
    if (entry.controller.signal.aborted) return;
    if (idleDeadline) clearTimeout(idleDeadline);
    idleDeadline = setTimeout(() => {
      entry.controller.abort(new HttpError("Cursor SDK bridge run became idle.", 504, "cursor_sdk_idle_timeout"));
    }, idleTimeoutMs);
    idleDeadline.unref?.();
  };
  touch();
  const maxDeadline = entry.controller.signal.aborted
    ? null
    : setTimeout(() => {
        entry.controller.abort(new HttpError("Cursor SDK bridge run timed out.", 504, "cursor_sdk_timeout"));
      }, maxTimeoutMs);
  maxDeadline?.unref?.();

  return {
    signal: entry.controller.signal,
    touch,
    close: () => {
      if (idleDeadline) clearTimeout(idleDeadline);
      if (maxDeadline) clearTimeout(maxDeadline);
      request?.off("aborted", abortFromTransport);
      response?.off("close", abortFromTransport);
      response?.off("error", abortFromTransport);
      if (agentRequestLifecycles.get(requestId) === entry) {
        agentRequestLifecycles.delete(requestId);
      }
    }
  };
}

async function cancelAgentRequest(requestId, error, ownership) {
  const actor = ownership
    ? sessionActors.get(agentCacheKey(ownership))
    : [...sessionActors.values()].find((actor) => actor.activeRun?.requestIds.has(requestId));
  const pending = actor?.activeRun;
  const generation = pending?.generation;
  const matches = () => {
    if (!pending || !actorOwnsPendingRun(pending) || pending.generation !== generation || pending.cancelledByRequest) return false;
    if (pending.requestIds.has(requestId)) return pending.lastRequestId === requestId;
    if (actor.subscriber) return false;
    const ids = ownership?.pendingToolCallIds;
    const emitted = pendingExternalCallIds(pending);
    return Array.isArray(ids) && ids.length > 0 && ids.length === emitted.length
      && ids.every((id) => typeof id === "string" && id.length > 0)
      && new Set(ids).size === ids.length && emitted.every((id) => ids.includes(id));
  };
  let entry = agentRequestLifecycles.get(requestId);
  const cancelled = Boolean(entry && !entry.expiry && !entry.controller.signal.aborted);
  if (!entry) {
    entry = { controller: new AbortController(), expiry: null };
    entry.expiry = setTimeout(() => {
      if (agentRequestLifecycles.get(requestId) === entry) {
        agentRequestLifecycles.delete(requestId);
      }
    }, runMaxTimeoutMs);
    entry.expiry.unref?.();
    agentRequestLifecycles.set(requestId, entry);
    pruneAgentRequestLifecycles();
  }
  entry.controller.abort(error);
  if (!pending) return cancelled;
  const runCancelled = await withSessionActorTransition(actor, async () => {
    if (!matches()) return false;
    await cancelActiveRunAndEvictAgent(pending, { source: "caller_cancel", error });
    return true;
  });
  return cancelled || runCancelled;
}

function pruneAgentRequestLifecycles() {
  if (agentRequestLifecycles.size <= maxAgentRequestLifecycles) return;
  for (const [requestId, entry] of agentRequestLifecycles) {
    if (agentRequestLifecycles.size <= maxAgentRequestLifecycles) return;
    if (!entry.expiry) continue;
    clearTimeout(entry.expiry);
    agentRequestLifecycles.delete(requestId);
  }
}

function cancelledAgentRequestError() {
  return new HttpError("Cursor SDK run was cancelled by its caller.", 499, "cursor_sdk_cancelled");
}

function signalPendingAgentRun(pending) {
  pending.nextEvent.resolve();
}

function toSdkToolResult(result) {
  if (result.isError) {
    return { content: [{ type: "text", text: stringifyToolResult(result.output) }], isError: true };
  }
  return typeof result.output === "string" ? result.output : result.output ?? "";
}

function stringifyToolResult(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function normalizeSdkUsage(value) {
  if (!isRecord(value)) return null;
  const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"];
  if (keys.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)) {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "reasoningTokens")
    && (
      typeof value.reasoningTokens !== "number"
      || !Number.isFinite(value.reasoningTokens)
      || value.reasoningTokens < 0
    )
  ) return null;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    totalTokens: value.totalTokens,
    ...(typeof value.reasoningTokens === "number" && Number.isFinite(value.reasoningTokens)
      ? { reasoningTokens: value.reasoningTokens }
      : {})
  };
}

function combineSdkUsage(first, second) {
  if (!first) return second ?? null;
  if (!second) return first;
  const usage = {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
    totalTokens: first.totalTokens + second.totalTokens
  };
  if (typeof first.reasoningTokens === "number" || typeof second.reasoningTokens === "number") {
    usage.reasoningTokens = (first.reasoningTokens ?? 0) + (second.reasoningTokens ?? 0);
  }
  return usage;
}

function persistedAgentStatePath(cacheKey) {
  if (!/^[a-f0-9]{32}$/.test(cacheKey)) {
    throw new Error("Invalid Cursor SDK Agent cache key.");
  }
  return path.join(agentStateDirectory, `${cacheKey}.json`);
}

async function ensureAgentStateDirectory() {
  if (!agentStateDirectoryReady) {
    agentStateDirectoryReady = (async () => {
      await mkdir(agentStateDirectory, { recursive: true, mode: 0o700 });
      await chmod(agentStateDirectory, 0o700);
      await prunePersistedAgentStates(true);
    })().catch((error) => {
      agentStateDirectoryReady = null;
      throw error;
    });
  }
  await agentStateDirectoryReady;
}

async function prunePersistedAgentStates(force = false) {
  if (!force && agentStateWritesSincePrune < agentStatePruneInterval) return;
  if (agentStatePrunePromise) return agentStatePrunePromise;
  agentStateWritesSincePrune = 0;
  agentStatePrunePromise = (async () => {
    let entries;
    try {
      entries = await readdir(agentStateDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(JSON.stringify({
          event: "sdk_agent_state_prune_failed",
          message: error instanceof Error ? error.message : String(error)
        }));
      }
      return;
    }
    const now = Date.now();
    const retained = [];
    for (const entry of entries) {
      const entryPath = path.join(agentStateDirectory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".tmp")) {
        await unlink(entryPath).catch(() => undefined);
        continue;
      }
      if (!entry.isFile() || !/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      try {
        const metadata = await stat(entryPath);
        if (now - metadata.mtimeMs > agentStateMaxAgeMs) {
          await unlink(entryPath);
        } else {
          retained.push({ entryPath, mtimeMs: metadata.mtimeMs });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn(JSON.stringify({
            event: "sdk_agent_state_prune_failed",
            file: entry.name,
            message: error instanceof Error ? error.message : String(error)
          }));
        }
      }
    }
    retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const entry of retained.slice(agentStateMaxEntries)) {
      await unlink(entry.entryPath).catch((error) => {
        if (error?.code !== "ENOENT") {
          console.warn(JSON.stringify({
            event: "sdk_agent_state_prune_failed",
            file: path.basename(entry.entryPath),
            message: error instanceof Error ? error.message : String(error)
          }));
        }
      });
    }
  })().finally(() => {
    agentStatePrunePromise = null;
  });
  return agentStatePrunePromise;
}

function runAgentStateOperation(cacheKey, operation) {
  const previous = agentStateOperations.get(cacheKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  agentStateOperations.set(cacheKey, current);
  void current.finally(() => {
    if (agentStateOperations.get(cacheKey) === current) agentStateOperations.delete(cacheKey);
  }).catch(() => undefined);
  return current;
}

function removePersistedAgentState(cacheKey, guard) {
  return runAgentStateOperation(cacheKey, async () => {
    await ensureAgentStateDirectory();
    if (guard && !guard()) return;
    await unlink(persistedAgentStatePath(cacheKey)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  });
}

function readPersistedAgentState(cacheKey) {
  return runAgentStateOperation(cacheKey, async () => {
    await ensureAgentStateDirectory();
    const filePath = persistedAgentStatePath(cacheKey);
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    const hashPattern = /^[a-f0-9]{64}$/;
    const validHashes = (hashes) => Array.isArray(hashes)
      && hashes.every((hash) => typeof hash === "string" && hashPattern.test(hash));
    const legacyContextValid = value?.version === 2
      && (
        (value.bootstrapFingerprint === null && value.transcriptItemHashes === null)
        || (
          typeof value.bootstrapFingerprint === "string"
          && hashPattern.test(value.bootstrapFingerprint)
          && validHashes(value.transcriptItemHashes)
        )
      );
    const dualContextValid = value?.version === 3
      && (
        (
          value.bootstrapFingerprint === null
          && value.transcriptItemHashes === null
          && value.provisionalTranscriptItemHashes === null
        )
        || (
          typeof value.bootstrapFingerprint === "string"
          && hashPattern.test(value.bootstrapFingerprint)
          && validHashes(value.transcriptItemHashes)
          && validHashes(value.provisionalTranscriptItemHashes)
          && isTranscriptPrefix(value.transcriptItemHashes, value.provisionalTranscriptItemHashes)
        )
      );
    const contextValid = isRecord(value)
      && (value.version === 1 || legacyContextValid || dualContextValid);
    const valid = contextValid
      && (value.systemPromptFingerprint == null || (
        typeof value.systemPromptFingerprint === "string"
        && hashPattern.test(value.systemPromptFingerprint)
      ))
      && value.cacheKey === cacheKey
      && typeof value.sdkAgentId === "string"
      && Boolean(value.sdkAgentId)
      && typeof value.model === "string"
      && Boolean(value.model)
      && typeof value.updatedAt === "number"
      && Number.isFinite(value.updatedAt)
      && typeof value.dirty === "boolean";
    if (!valid || Date.now() - value.updatedAt > agentStateMaxAgeMs) {
      console.warn(JSON.stringify({
        event: "sdk_agent_state_ignored",
        cacheKey,
        reason: valid ? "expired" : "invalid"
      }));
      await unlink(filePath).catch(() => undefined);
      return null;
    }
    return value;
  });
}

function writePersistedAgentState(cacheKey, state, options = {}) {
  return runAgentStateOperation(cacheKey, async () => {
    if (options.guard && !options.guard()) return false;
    await ensureAgentStateDirectory();
    const filePath = persistedAgentStatePath(cacheKey);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const value = {
      version: 3,
      cacheKey,
      sdkAgentId: state.sdkAgentId,
      model: state.model,
      updatedAt: Date.now(),
      dirty: state.dirty,
      systemPromptFingerprint: state.systemPromptFingerprint ?? null,
      bootstrapFingerprint: state.bootstrapFingerprint ?? null,
      transcriptItemHashes: Array.isArray(state.transcriptItemHashes)
        ? [...state.transcriptItemHashes]
        : null,
      provisionalTranscriptItemHashes: Array.isArray(state.provisionalTranscriptItemHashes)
        ? [...state.provisionalTranscriptItemHashes]
        : null
    };
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    agentStateWritesSincePrune += 1;
    await prunePersistedAgentStates();
    return true;
  });
}

async function getAgent(input, signal, actorInput) {
  signal?.throwIfAborted();
  const cacheKey = agentCacheKey(input);
  const actor = actorInput ?? sessionActor(cacheKey);
  let cached = actor.agentEntry;
  const forceFreshAgent = input.fullReplayCause === "empty_turn_recovery";
  if (cached && forceFreshAgent) {
    await evictAgent(cacheKey, cached.agent, { keepActor: true });
    cached = null;
  }
  if (cached) {
    const replayCause = systemPromptReplayCause(cached, input)
      ?? agentReuseReplayCause(cached, input.agentContext);
    if (replayCause) {
      input.fullReplayCause = replayCause;
      input.fullReplayDetail = transcriptDivergenceDetail(replayCause, cached, input);
      await evictAgent(cacheKey, cached.agent, { keepActor: true });
      cached = null;
    } else {
      cached.touchedAt = Date.now();
      cached.contextSnapshot = agentContextSnapshot(input) ?? cached.contextSnapshot;
      actor.touchedAt = cached.touchedAt;
      return {
        agent: cached.agent,
        cacheKey,
        cached: true,
        cacheHit: true,
        resumed: false,
        model: input.model,
        systemPromptFingerprint: cached.systemPromptFingerprint,
        bootstrapFingerprint: cached.bootstrapFingerprint,
        transcriptItemHashes: cached.transcriptItemHashes,
        provisionalTranscriptItemHashes: cached.provisionalTranscriptItemHashes
      };
    }
  }

  const persisted = await readPersistedAgentState(cacheKey);
  let replayCause = input.fullReplayCause;
  let replayDetail = input.fullReplayDetail ?? null;
  let resumeFailed = false;
  const persistedContextCause = persisted?.dirty === false
    ? input.agentContext && persisted.version !== 3
      ? "agent_context_missing"
      : systemPromptReplayCause(persisted, input)
        ?? agentReuseReplayCause(persisted, input.agentContext)
    : null;
  if (!replayCause && persistedContextCause) {
    replayDetail = transcriptDivergenceDetail(persistedContextCause, persisted, input);
  }
  const persistedSuffixCheckpoint = persisted?.version === 3 && input.agentContext
    ? transcriptSuffixCheckpoint(
        persisted,
        {
          bootstrapFingerprint: persisted.bootstrapFingerprint,
          transcriptItemHashes: persisted.provisionalTranscriptItemHashes
        },
        input.agentContext
      )
    : persisted?.transcriptItemHashes;
  if (
    persisted
    && persisted.dirty === false
    && persisted.model === input.model
    && !forceFreshAgent
    && !persistedContextCause
    && input.agentContext
    && Array.isArray(persistedSuffixCheckpoint)
    && persistedSuffixCheckpoint.length === input.agentContext.transcriptItemHashes.length
  ) {
    throw new HttpError(
      "Responses transcript does not contain a new item for the persisted Cursor Agent.",
      409,
      "cursor_sdk_transcript_not_extended"
    );
  }
  if (
    persisted
    && persisted.dirty === false
    && persisted.model === input.model
    && !forceFreshAgent
    && !persistedContextCause
    && (
      hasIndependentIncrementalPrompt(input)
      || agentContextStrictlyExtends({
        bootstrapFingerprint: persisted.bootstrapFingerprint,
        transcriptItemHashes: persistedSuffixCheckpoint
      }, input.agentContext)
    )
  ) {
    try {
      const agent = await Agent.resume(persisted.sdkAgentId, localAgentCreateOptions(input));
      if (signal?.aborted) {
        await evictAgent(cacheKey, agent, { invalidatePersisted: false });
        signal.throwIfAborted();
      }
      actor.agentEntry = {
        agent,
        touchedAt: Date.now(),
        systemPromptFingerprint: persisted.systemPromptFingerprint,
        bootstrapFingerprint: persisted.bootstrapFingerprint,
        transcriptItemHashes: persisted.transcriptItemHashes,
        provisionalTranscriptItemHashes: persisted.provisionalTranscriptItemHashes,
        contextSnapshot: agentContextSnapshot(input)
      };
      actor.touchedAt = actor.agentEntry.touchedAt;
      evictAgents();
      return {
        agent,
        cacheKey,
        cached: true,
        cacheHit: false,
        resumed: true,
        model: input.model,
        systemPromptFingerprint: persisted.systemPromptFingerprint,
        bootstrapFingerprint: persisted.bootstrapFingerprint,
        transcriptItemHashes: persisted.transcriptItemHashes,
        provisionalTranscriptItemHashes: persisted.provisionalTranscriptItemHashes
      };
    } catch (error) {
      if (isAuthenticationSDKError(error)) throw error;
      resumeFailed = true;
      signal?.throwIfAborted();
      console.warn(JSON.stringify({
        event: "sdk_agent_resume_failed",
        requestId: input.requestId,
        cacheKey,
        sessionKey: input.sessionKey,
        agentId: persisted.sdkAgentId,
        model: sdkModelSelection(input.model),
        message: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  replayCause ??= resumeFailed
    ? "agent_resume_failed"
    : persistedContextCause
      ? persistedContextCause
      : persisted?.dirty
        ? "agent_state_dirty"
        : !hasIndependentIncrementalPrompt(input)
          ? persisted
            ? "missing_incremental_prompt"
            : "first_turn"
          : !persisted
            ? "agent_state_missing"
            : persisted.model !== input.model
              ? "agent_model_mismatch"
              : "agent_unavailable";
  const agent = await Agent.create(localAgentCreateOptions(input));
  if (signal?.aborted) {
    await evictAgent(cacheKey, agent, { invalidatePersisted: false });
    signal.throwIfAborted();
  }
  actor.agentEntry = {
    agent,
    touchedAt: Date.now(),
    systemPromptFingerprint: systemPromptFingerprint(input),
    bootstrapFingerprint: input.agentContext?.bootstrapFingerprint,
    transcriptItemHashes: input.agentContext ? [...input.agentContext.transcriptItemHashes] : undefined,
    provisionalTranscriptItemHashes: input.agentContext ? [...input.agentContext.transcriptItemHashes] : undefined,
    contextSnapshot: agentContextSnapshot(input)
  };
  actor.touchedAt = actor.agentEntry.touchedAt;
  evictAgents();
  return {
    agent,
    cacheKey,
    cached: false,
    cacheHit: false,
    resumed: false,
    replayCause,
    replayDetail,
    model: input.model,
    systemPromptFingerprint: actor.agentEntry.systemPromptFingerprint,
    bootstrapFingerprint: actor.agentEntry.bootstrapFingerprint,
    transcriptItemHashes: actor.agentEntry.transcriptItemHashes,
    provisionalTranscriptItemHashes: actor.agentEntry.provisionalTranscriptItemHashes
  };
}

function optionalSystemPrompt(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError("systemPrompt must be a non-empty string.", 400, "invalid_request");
  }
  return value;
}

function systemPromptFingerprint(input) {
  const prompt = optionalSystemPrompt(input.systemPrompt);
  return prompt === undefined ? null : crypto.createHash("sha256").update(prompt).digest("hex");
}

function systemPromptReplayCause(entry, input) {
  return (entry.systemPromptFingerprint ?? null) === systemPromptFingerprint(input)
    ? null
    : "agent_bootstrap_mismatch";
}

function agentContextReplayCause(entry, current) {
  if (!current) return null;
  if (
    typeof entry.bootstrapFingerprint !== "string"
    || !Array.isArray(entry.transcriptItemHashes)
  ) return "agent_context_missing";
  if (entry.bootstrapFingerprint !== current.bootstrapFingerprint) return "agent_bootstrap_mismatch";
  if (!isTranscriptPrefix(entry.transcriptItemHashes, current.transcriptItemHashes)) {
    return "agent_transcript_diverged";
  }
  return null;
}

function agentReuseReplayCause(entry, current) {
  return agentContextReplayCause(entry, current)
    ?? agentProvisionalReplayCause(
      entry,
      {
        bootstrapFingerprint: entry.bootstrapFingerprint,
        transcriptItemHashes: entry.provisionalTranscriptItemHashes
      },
      current
    );
}

function agentProvisionalReplayCause(authoritative, provisional, current) {
  if (!agentContextStrictlyExtends(authoritative, current)) return null;
  if (
    provisional?.bootstrapFingerprint !== current.bootstrapFingerprint
    || !Array.isArray(provisional.transcriptItemHashes)
  ) return "agent_context_missing";
  if (!isTranscriptPrefix(provisional.transcriptItemHashes, current.transcriptItemHashes)) {
    return "agent_provisional_transcript_diverged";
  }
  return null;
}

function isTranscriptPrefix(prefix, transcript) {
  return prefix.length <= transcript.length
    && prefix.every((hash, index) => hash === transcript[index]);
}

// Pinpoints where the client transcript stopped matching the known per-item
// hashes. Captured at detection time because the known hashes live only in
// memory / agent state and are unrecoverable once the agent rotates. Carries
// its cause so a later, different replay cause cannot pair with stale detail.
function transcriptDivergenceDetail(cause, entry, input) {
  try {
    return describeTranscriptDivergence(cause, entry, input);
  } catch {
    logTrajectoryObservationError("context_divergence", "trace_context_divergence_failed");
    return null;
  }
}

function describeTranscriptDivergence(cause, entry, input) {
  const current = input.agentContext;
  const known = cause === "agent_transcript_diverged"
    ? entry.transcriptItemHashes
    : cause === "agent_provisional_transcript_diverged"
      ? entry.provisionalTranscriptItemHashes
      : null;
  if (!current || !Array.isArray(known)) return null;
  const client = current.transcriptItemHashes;
  let index = 0;
  while (index < known.length && index < client.length && known[index] === client[index]) index += 1;
  const detail = {
    cause,
    divergedItemIndex: index,
    knownTranscriptItemCount: known.length,
    clientTranscriptItemCount: client.length,
    knownItemHash: known[index],
    clientItemHash: client[index],
    divergenceKind: index >= client.length ? "client_history_truncated" : "item_mismatch"
  };
  if (detail.divergenceKind === "item_mismatch") {
    const clientText = transcriptItemText(agentContextSnapshot(input), index);
    const knownSnapshot = entry.contextSnapshot;
    const knownText = knownSnapshot?.hashes?.[index] === known[index]
      ? transcriptItemText(knownSnapshot, index)
      : null;
    if (knownText !== null) detail.knownRequestId = knownSnapshot.requestId;
    if (clientText !== null) {
      let offset = 0;
      if (knownText !== null) {
        const limit = Math.min(knownText.length, clientText.length);
        while (offset < limit && knownText[offset] === clientText[offset]) offset += 1;
        detail.divergedCharOffset = offset;
        detail.knownItemPreview = divergencePreview(knownText, offset);
      }
      detail.divergedItemPreview = divergencePreview(clientText, offset);
    }
  }
  return detail;
}

// A snapshot keeps the raw prompt text of the request whose per-item hashes
// became the agent's known context, so a later divergence can show what the
// known version of the diverged item said. Validated by hash at lookup time,
// so a snapshot that fell behind the entry's hashes degrades to "no preview",
// never to a wrong one.
function agentContextSnapshot(input) {
  try {
    const context = input.agentContext;
    if (!context || typeof input.prompt !== "string"
      || context.promptTextChars !== input.prompt.length) return null;
    return {
      requestId: input.requestId,
      prompt: input.prompt,
      hashes: context.transcriptItemHashes,
      offsets: context.transcriptItemOffsets,
      endOffset: context.transcriptEndOffset
    };
  } catch {
    logTrajectoryObservationError("context_snapshot", "trace_context_snapshot_failed");
    return null;
  }
}

function transcriptItemText(snapshot, index) {
  if (!snapshot) return null;
  const start = snapshot.offsets?.[index];
  const end = snapshot.offsets?.[index + 1] ?? snapshot.endOffset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= end || end > snapshot.prompt.length) return null;
  return snapshot.prompt.slice(start, end);
}

function divergencePreview(text, offset) {
  const start = Math.max(0, offset - 60);
  const slice = text.slice(start, start + 180).trim();
  if (!slice) return undefined;
  return `${start > 0 ? "…" : ""}${slice}${start + 180 < text.length ? "…" : ""}`;
}

function agentContextStrictlyExtends(entry, current) {
  return Boolean(
    current
    && Array.isArray(entry.transcriptItemHashes)
    && entry.transcriptItemHashes.length < current.transcriptItemHashes.length
    && isTranscriptPrefix(entry.transcriptItemHashes, current.transcriptItemHashes)
  );
}

function pendingContextRetry(pending, current) {
  if (!current) return false;
  const equals = (hashes) => Array.isArray(hashes)
    && hashes.length === current.transcriptItemHashes.length
    && hashes.every((hash, index) => hash === current.transcriptItemHashes[index]);
  return (
    pending.acceptedBootstrapFingerprint === current.bootstrapFingerprint
    && equals(pending.acceptedTranscriptItemHashes)
  ) || pending.actor.inbox.some((turn) => (
    turn.agentContext?.bootstrapFingerprint === current.bootstrapFingerprint
    && equals(turn.agentContext.transcriptItemHashes)
  )) || (
    pending.nativeSteeringDelivered
    && pending.authoritativeBootstrapFingerprint === current.bootstrapFingerprint
    && equals(pending.authoritativeTranscriptItemHashes)
  ) || (
    pending.delivery
    && pending.bootstrapFingerprint === current.bootstrapFingerprint
    && equals(pending.transcriptItemHashes)
  );
}

async function evictAgent(cacheKey, agent, options = {}) {
  const actor = sessionActors.get(cacheKey);
  const cached = actor?.agentEntry;
  const generation = actor?.generation;
  if (cached?.agent === agent) {
    actor.agentEntry = null;
    actor.inbox = [];
    actor.steeringTurns.clear();
    if (!options.keepActor && !actor.activeRun && !actor.subscriber) sessionActors.delete(cacheKey);
  }
  forceNextRunAgentKeys.delete(cacheKey);
  if (options.awaitDispose) await disposeAgentHandle(agent);
  if (!options.awaitDispose) {
    try {
      agent.close();
    } catch {}
  }
  const invalidatePersisted = options.invalidatePersistedPromise
    ? !(await options.invalidatePersistedPromise)
    : options.invalidatePersisted !== false;
  if (!invalidatePersisted) return;
  await removePersistedAgentState(cacheKey, () => {
    const current = sessionActors.get(cacheKey);
    return !current || (current === actor && current.generation === generation && !current.agentEntry);
  }).catch((error) => {
    console.warn(JSON.stringify({
      event: "sdk_agent_state_invalidate_failed",
      cacheKey,
      message: error instanceof Error ? error.message : String(error)
    }));
  });
}

async function evictCachedAgent(input) {
  const cacheKey = agentCacheKey(input);
  const cached = sessionActors.get(cacheKey)?.agentEntry;
  if (cached) {
    await evictAgent(cacheKey, cached.agent);
  } else {
    await removePersistedAgentState(cacheKey).catch(() => undefined);
  }
}

function registerActiveClientToolCapture(cacheKey, handler) {
  if (!activeClientToolCaptures.has(cacheKey)) {
    activeClientToolCaptures.set(cacheKey, new Set());
  }
  const handlers = activeClientToolCaptures.get(cacheKey);
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) activeClientToolCaptures.delete(cacheKey);
  };
}

async function captureActiveClientToolCall(cacheKey, toolCall) {
  const handlers = activeClientToolCaptures.get(cacheKey);
  if (!handlers || handlers.size === 0) return false;
  for (const handler of [...handlers]) {
    if (await handler(toolCall)) return true;
  }
  return false;
}

function localAgentCreateOptions(input) {
  const systemPrompt = optionalSystemPrompt(input.systemPrompt);
  return {
    apiKey: input.apiKey,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    model: sdkModelSelection(input.model),
    mode: "agent",
    name: "cursor2response local bridge",
    // Restrict the model to the MCP tool family (which includes
    // local.customTools) so Composer cannot bypass forwarded client tools
    // with built-in shell/read/edit calls.
    tools: ["mcp"],
    local: {
      cwd: process.env.CURSOR_SDK_WORKING_DIRECTORY?.trim() || input.workingDirectory,
      settingSources: []
    }
  };
}

function localAgentSendOptions(input, optionsInput = {}) {
  const options = {
    model: sdkModelSelection(input.model),
    mode: "agent"
  };
  if (typeof optionsInput.onDelta === "function") options.onDelta = optionsInput.onDelta;
  const local = {};
  if (optionsInput.force === true) {
    local.force = true;
  }
  if (input.clientTools.length > 0) {
    local.customTools = clientForwardingCustomTools(input.clientTools, optionsInput.pending);
  }
  if (Object.keys(local).length > 0) options.local = local;
  return options;
}

function clientForwardingCustomTools(clientTools = [], pending) {
  return Object.fromEntries(clientTools.flatMap((tool) => {
    const name = typeof tool?.name === "string" ? tool.name.trim() : "";
    if (!name) return [];
    const inputSchema = isRecord(tool.parameters)
      ? normalizeJsonValue(tool.parameters)
      : { type: "object", properties: {} };
    return [[name, {
      ...(typeof tool.description === "string" && tool.description ? { description: tool.description } : {}),
      inputSchema,
      ...clientToolMetadata(tool),
      execute: async (args, context) => {
        if (!pending || !actorOwnsPendingRun(pending)) {
          throw new Error(`No pending outer client session for forwarded tool call ${name}.`);
        }
        const toolCall = {
          type: name,
          args: isRecord(args) && !Array.isArray(args) ? args : {}
        };
        const callId = typeof context?.toolCallId === "string" ? context.toolCallId : undefined;
        const comparedTo = callId ? pending.streamToolArgsByCallId.get(callId) : undefined;
        const callbackCount = callId ? (pending.callbackToolCallCounts.get(callId) || 0) + 1 : 1;
        if (callId) pending.callbackToolCallCounts.set(callId, callbackCount);
        console.info(JSON.stringify({
          event: "sdk_tool_callback_enter",
          ...pendingDiagnosticClock(pending),
          requestId: pending.requestId,
          sessionKey: pending.sessionKey,
          runId: pending.run?.id || pending.cacheKey,
          callId,
          toolName: name,
          callbackCount,
          streamCount: callId ? pending.streamToolCallCounts.get(callId) || 0 : 0,
          state: pendingToolState(pending)
        }));
        const callbackTrace = logToolArgsTrace({
          pending,
          runId: pending.run?.id || pending.cacheKey,
          phase: "custom_callback",
          callId,
          toolName: name,
          args: toolCall.args,
          comparedTo
        });
        if (callId) pending.callbackToolArgsByCallId.set(callId, callbackTrace);
        try {
          const result = await parkPendingToolCall(pending, { callId, toolCall });
          console.info(JSON.stringify({
            event: "sdk_tool_callback_parked",
            ...pendingDiagnosticClock(pending),
            requestId: pending.requestId,
            sessionKey: pending.sessionKey,
            runId: pending.run?.id || pending.cacheKey,
            callId,
            toolName: name,
            callbackCount,
            state: pendingToolState(pending)
          }));
          return result;
        } catch (error) {
          console.warn(JSON.stringify({
            event: "sdk_tool_callback_rejected",
            ...pendingDiagnosticClock(pending),
            requestId: pending.requestId,
            sessionKey: pending.sessionKey,
            runId: pending.run?.id || pending.cacheKey,
            callId,
            toolName: name,
            callbackCount,
            error: {
              name: error?.name,
              code: error?.code,
              message: error?.message || String(error)
            },
            state: pendingToolState(pending)
          }));
          throw error;
        }
      }
    }]];
  }));
}

function clientToolsNeedingMcp(clientTools = []) {
  return clientTools.filter((tool) => tool?.name);
}

function clientForwardingMcpServers(clientTools = [], cacheKey = "") {
  return {
    [clientMcpServerName]: {
      type: "stdio",
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), clientMcpServerMode],
      env: {
        CURSOR_SDK_BRIDGE_CALLBACK_URL: `http://${host}:${port}${clientToolCallbackPath}`,
        CURSOR_SDK_BRIDGE_CALLBACK_TOKEN: bridgeToken,
        CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY: cacheKey,
        CURSOR_SDK_BRIDGE_CLIENT_TOOLS_JSON: JSON.stringify(clientMcpToolDefinitions(clientTools))
      }
    }
  };
}

async function runClientForwardingMcpServerFromEnvironment() {
  await runClientForwardingMcpServer({
    tools: parseClientMcpToolsJSON(process.env.CURSOR_SDK_BRIDGE_CLIENT_TOOLS_JSON),
    callbackUrl: process.env.CURSOR_SDK_BRIDGE_CALLBACK_URL || "",
    callbackToken: process.env.CURSOR_SDK_BRIDGE_CALLBACK_TOKEN || "",
    callbackCacheKey: process.env.CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY || ""
  });
}

function parseClientMcpToolsJSON(value) {
  if (typeof value !== "string" || !value.trim()) return clientMcpToolDefinitions([]);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : clientMcpToolDefinitions([]);
  } catch {
    return clientMcpToolDefinitions([]);
  }
}

async function runClientForwardingMcpServer({
  tools,
  callbackUrl,
  callbackToken,
  callbackCacheKey,
  input = process.stdin,
  output = process.stdout
}) {
  const rl = readline.createInterface({ input });
  let outputClosed = false;
  const writeOutput = (payload) => {
    if (outputClosed) return false;
    try {
      return output.write(payload);
    } catch (error) {
      if (!isBenignPipeError(error)) throw error;
      outputClosed = true;
      return false;
    }
  };
  output.on?.("error", (error) => {
    outputClosed = true;
    if (!isBenignPipeError(error)) process.exitCode = 1;
  });
  const send = (id, result) => {
    if (id === undefined || id === null) return;
    writeOutput(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const sendError = (id, message) => {
    if (id === undefined || id === null) return;
    writeOutput(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
  };
  const pending = new Set();

  const handleLine = async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message.id && String(message.method || "").startsWith("notifications/")) return;
    if (message.method === "initialize") {
      send(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cursor2response-client-tools", version: "0.1.0" }
      });
      return;
    }
    if (message.method === "tools/list") {
      send(message.id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const params = message.params || {};
      const toolName = params.name || params.toolName;
      const toolInput = params.arguments || params.input || {};
      const validationError = validateClientMcpToolCall(tools, toolName, toolInput);
      if (validationError) {
        sendError(message.id, validationError);
        return;
      }
      const accepted = await notifyParentToolCall({ callbackUrl, callbackToken, callbackCacheKey, toolName, input: toolInput });
      if (!accepted) {
        sendError(message.id, "Outer client callback unavailable for forwarded tool call.");
        return;
      }
      send(message.id, {
        content: [{ type: "text", text: "FORWARDED_TO_OUTER_CLIENT" }],
        isError: false
      });
      return;
    }
    sendError(message.id, `Unsupported MCP method: ${message.method}`);
  };

  await new Promise((resolve) => {
    rl.on("line", (line) => {
      const task = handleLine(line)
        .catch((error) => {
          if (!isBenignPipeError(error)) process.exitCode = 1;
        })
        .finally(() => {
          pending.delete(task);
        });
      pending.add(task);
    });
    rl.on("close", async () => {
      await Promise.allSettled([...pending]);
      resolve();
    });
  });
}

async function notifyParentToolCall({ callbackUrl, callbackToken, callbackCacheKey, toolName, input }) {
  if (!callbackUrl || !callbackCacheKey) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const headers = { "Content-Type": "application/json" };
    if (callbackToken) headers.Authorization = `Bearer ${callbackToken}`;
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cacheKey: callbackCacheKey,
        toolName,
        arguments: input && typeof input === "object" && !Array.isArray(input) ? input : {}
      }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return body && body.accepted === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function clientForwardingMcpServerSource(clientTools = []) {
  const tools = JSON.stringify(clientMcpToolDefinitions(clientTools));
  return `
const readline = require("node:readline");
const tools = ${tools};
const callbackUrl = process.env.CURSOR_SDK_BRIDGE_CALLBACK_URL || "";
const callbackToken = process.env.CURSOR_SDK_BRIDGE_CALLBACK_TOKEN || "";
const callbackCacheKey = process.env.CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY || "";
const validateClientMcpToolCall = ${validateClientMcpToolCall.toString()};
const validateJsonSchemaValue = ${validateJsonSchemaValue.toString()};
const canonicalJsonSchema = ${canonicalJsonSchema.toString()};
const schemaHasStructuralKeyword = ${schemaHasStructuralKeyword.toString()};
const schemaReferenceTarget = ${schemaReferenceTarget.toString()};
const jsonPointerTarget = ${jsonPointerTarget.toString()};
const decodeJsonPointerSegment = ${decodeJsonPointerSegment.toString()};
const schemaTypes = ${schemaTypes.toString()};
const schemaAllowsNull = ${schemaAllowsNull.toString()};
const validateStringConstraints = ${validateStringConstraints.toString()};
const validateNumberConstraints = ${validateNumberConstraints.toString()};
const patternPropertySchemasForKey = ${patternPropertySchemasForKey.toString()};
const schemaEvaluatesObjectProperty = ${schemaEvaluatesObjectProperty.toString()};
const jsonValueMatchesType = ${jsonValueMatchesType.toString()};
const jsonValuesEqual = ${jsonValuesEqual.toString()};
const isRecord = ${isRecord.toString()};
const stableJson = ${stableJson.toString()};
const sortJson = ${sortJson.toString()};
const rl = readline.createInterface({ input: process.stdin });
let stdoutClosed = false;
function isBenignPipeError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}
function writeStdout(payload) {
  if (stdoutClosed) return false;
  try {
    return process.stdout.write(payload);
  } catch (error) {
    if (!isBenignPipeError(error)) throw error;
    stdoutClosed = true;
    return false;
  }
}
process.stdout.on("error", (error) => {
  stdoutClosed = true;
  if (isBenignPipeError(error)) process.exit(0);
  process.exitCode = 1;
});
function send(id, result) {
  if (id === undefined || id === null) return;
  writeStdout(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function sendError(id, message) {
  if (id === undefined || id === null) return;
  writeStdout(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\\n");
}
async function notifyParentToolCall(toolName, input) {
  if (!callbackUrl || !callbackCacheKey) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const headers = { "Content-Type": "application/json" };
    if (callbackToken) headers.Authorization = "Bearer " + callbackToken;
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cacheKey: callbackCacheKey,
        toolName,
        arguments: input && typeof input === "object" && !Array.isArray(input) ? input : {}
      }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return body && body.accepted === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message.id && String(message.method || "").startsWith("notifications/")) return;
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "cursor2response-client-tools", version: "0.1.0" }
    });
  } else if (message.method === "tools/list") {
    send(message.id, { tools });
  } else if (message.method === "tools/call") {
    const params = message.params || {};
    const toolName = params.name || params.toolName;
    const input = params.arguments || params.input || {};
    const validationError = validateClientMcpToolCall(tools, toolName, input);
    if (validationError) {
      sendError(message.id, validationError);
      return;
    }
    const accepted = await notifyParentToolCall(toolName, input);
    if (!accepted) {
      sendError(message.id, "Outer client callback unavailable for forwarded tool call.");
      return;
    }
    send(message.id, {
      content: [{ type: "text", text: "FORWARDED_TO_OUTER_CLIENT" }],
      isError: false
    });
  } else {
    sendError(message.id, "Unsupported MCP method: " + message.method);
  }
});
`;
}

function validateClientMcpToolCall(tools, toolName, input = {}) {
  if (typeof toolName !== "string" || !toolName.trim()) {
    return "Missing MCP tool name.";
  }
  const tool = Array.isArray(tools) ? tools.find((candidate) => candidate && candidate.name === toolName) : null;
  if (!tool) {
    return `Unknown client MCP forwarding tool: ${toolName}`;
  }
  const schema = canonicalJsonSchema(tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {});
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return validateJsonSchemaValue(args, schema, toolName, schema);
}

function validateJsonSchemaValue(value, schema, path, rootSchema = schema, seenRefs = new Set()) {
  if (schema === true) return null;
  if (schema === false) return `Invalid value for ${path}: schema disallows value`;
  schema = canonicalJsonSchema(schema);
  const root = canonicalJsonSchema(rootSchema || schema);
  if (schema === true) return null;
  if (schema === false) return `Invalid value for ${path}: schema disallows value`;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const reference = schemaReferenceTarget(schema, root, seenRefs);
  if (reference) return validateJsonSchemaValue(value, reference.schema, path, root, reference.seenRefs);

  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonValuesEqual(value, schema.const)) {
    return `Invalid value for ${path}: expected constant ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) {
    return `Invalid value for ${path}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (anyOf.length && !anyOf.some((candidate) => validateJsonSchemaValue(value, candidate, path, root, new Set(seenRefs)) === null)) {
    return `Invalid value for ${path}: did not match any allowed schema`;
  }
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (oneOf.length) {
    const matches = oneOf.filter((candidate) => validateJsonSchemaValue(value, candidate, path, root, new Set(seenRefs)) === null).length;
    if (matches === 0) {
      return `Invalid value for ${path}: did not match any allowed schema`;
    }
    if (matches > 1) {
      return `Invalid value for ${path}: matched more than one allowed schema`;
    }
  }
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  for (const candidate of allOf) {
    const error = validateJsonSchemaValue(value, candidate, path, root, new Set(seenRefs));
    if (error) return error;
  }
  if ((isRecord(schema.not) || typeof schema.not === "boolean")
      && validateJsonSchemaValue(value, schema.not, path, root, new Set(seenRefs)) === null) {
    return `Invalid value for ${path}: matched disallowed schema`;
  }
  if (isRecord(schema.if) || typeof schema.if === "boolean") {
    const matchesIf = validateJsonSchemaValue(value, schema.if, path, root, new Set(seenRefs)) === null;
    if (matchesIf && (isRecord(schema.then) || typeof schema.then === "boolean")) {
      const error = validateJsonSchemaValue(value, schema.then, path, root, new Set(seenRefs));
      if (error) return error;
    }
    if (!matchesIf && (isRecord(schema.else) || typeof schema.else === "boolean")) {
      const error = validateJsonSchemaValue(value, schema.else, path, root, new Set(seenRefs));
      if (error) return error;
    }
  }

  if (value === null && schemaAllowsNull(schema, root, seenRefs)) return null;

  const types = schemaTypes(schema);
  if (types.length && !types.some((type) => jsonValueMatchesType(value, type))) {
    return `Invalid value for ${path}: expected ${types.join(" or ")}`;
  }
  const stringConstraintError = validateStringConstraints(value, schema, path);
  if (stringConstraintError) return stringConstraintError;
  const numberConstraintError = validateNumberConstraints(value, schema, path);
  if (numberConstraintError) return numberConstraintError;

  const objectLike = schema.properties
    || schema.patternProperties
    || schema.propertyNames
    || schema.required
    || schema.dependentRequired
    || schema.dependentSchemas
    || schema.minProperties !== undefined
    || schema.maxProperties !== undefined
    || schema.additionalProperties !== undefined
    || schema.unevaluatedProperties !== undefined
    || types.includes("object");
  if (objectLike) {
    if (!isRecord(value)) return `Invalid value for ${path}: expected object`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string" && key.trim()) : [];
    const entries = Object.entries(value);
    if (Number.isInteger(schema.minProperties) && entries.length < schema.minProperties) {
      return `Invalid value for ${path}: expected at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}`;
    }
    if (Number.isInteger(schema.maxProperties) && entries.length > schema.maxProperties) {
      return `Invalid value for ${path}: expected at most ${schema.maxProperties} propert${schema.maxProperties === 1 ? "y" : "ies"}`;
    }
    for (const key of required) {
      if (!(key in value) || value[key] === undefined || value[key] === null) {
        return `Missing required argument for ${path}: ${key}`;
      }
    }
    if (isRecord(schema.dependentRequired)) {
      for (const [key, dependencies] of Object.entries(schema.dependentRequired)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (!Array.isArray(dependencies)) continue;
        for (const dependency of dependencies) {
          if (typeof dependency !== "string" || !dependency.trim()) continue;
          if (!(dependency in value) || value[dependency] === undefined || value[dependency] === null) {
            return `Missing dependent argument for ${path}: ${dependency}`;
          }
        }
      }
    }
    if (isRecord(schema.dependentSchemas)) {
      for (const [key, dependentSchema] of Object.entries(schema.dependentSchemas)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const error = validateJsonSchemaValue(value, dependentSchema, path, root, new Set(seenRefs));
        if (error) return error;
      }
    }
    for (const [key, nestedValue] of entries) {
      if (isRecord(schema.propertyNames) || typeof schema.propertyNames === "boolean") {
        const error = validateJsonSchemaValue(key, schema.propertyNames, `${path} property name ${key}`, root, new Set(seenRefs));
        if (error) return error;
      }
      let validated = false;
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const error = validateJsonSchemaValue(nestedValue, properties[key], `${path}.${key}`, root, new Set(seenRefs));
        if (error) return error;
        validated = true;
      }
      const patternSchemas = patternPropertySchemasForKey(schema, key);
      for (const patternSchema of patternSchemas) {
        const error = validateJsonSchemaValue(nestedValue, patternSchema, `${path}.${key}`, root, new Set(seenRefs));
        if (error) return error;
        validated = true;
      }
      const evaluatedByComposedSchema = schemaEvaluatesObjectProperty(schema, key, root, value, new Set(seenRefs));
      if (!validated && !evaluatedByComposedSchema && schema.additionalProperties === false) {
        return `Unexpected argument for ${path}: ${key}`;
      } else if (!validated && schema.additionalProperties === true) {
        validated = true;
      } else if (!validated && isRecord(schema.additionalProperties)) {
        const error = validateJsonSchemaValue(nestedValue, schema.additionalProperties, `${path}.${key}`, root, new Set(seenRefs));
        if (error) return error;
        validated = true;
      }
      if (!validated && !evaluatedByComposedSchema && schema.unevaluatedProperties === false) {
        return `Unexpected argument for ${path}: ${key}`;
      } else if (!validated && !evaluatedByComposedSchema && isRecord(schema.unevaluatedProperties)) {
        const error = validateJsonSchemaValue(nestedValue, schema.unevaluatedProperties, `${path}.${key}`, root, new Set(seenRefs));
        if (error) return error;
      }
    }
  }

  const arrayLike = schema.items
    || schema.prefixItems
    || schema.additionalItems !== undefined
    || schema.contains !== undefined
    || schema.minItems !== undefined
    || schema.maxItems !== undefined
    || schema.minContains !== undefined
    || schema.maxContains !== undefined
    || schema.unevaluatedItems !== undefined
    || schema.uniqueItems !== undefined
    || types.includes("array");
  if (arrayLike) {
    if (!Array.isArray(value)) return `Invalid value for ${path}: expected array`;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      return `Invalid value for ${path}: expected at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`;
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return `Invalid value for ${path}: expected at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}`;
    }
    if (schema.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (jsonValuesEqual(value[left], value[right])) {
            return `Invalid value for ${path}: expected unique items`;
          }
        }
      }
    }
    const evaluatedItems = new Set();
    if (isRecord(schema.contains) || typeof schema.contains === "boolean") {
      let matches = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (validateJsonSchemaValue(value[index], schema.contains, path, root, new Set(seenRefs)) === null) {
          matches += 1;
          evaluatedItems.add(index);
        }
      }
      const minContains = Number.isInteger(schema.minContains) ? schema.minContains : 1;
      const maxContains = Number.isInteger(schema.maxContains) ? schema.maxContains : null;
      if (matches < minContains) {
        return `Invalid value for ${path}: expected at least ${minContains} matching item${minContains === 1 ? "" : "s"}`;
      }
      if (maxContains !== null && matches > maxContains) {
        return `Invalid value for ${path}: expected at most ${maxContains} matching item${maxContains === 1 ? "" : "s"}`;
      }
    }
    const prefixItems = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : Array.isArray(schema.items)
        ? schema.items
        : [];
    for (let index = 0; index < Math.min(prefixItems.length, value.length); index += 1) {
      const error = validateJsonSchemaValue(value[index], prefixItems[index], `${path}[${index}]`, root, new Set(seenRefs));
      if (error) return error;
      evaluatedItems.add(index);
    }
    if (schema.additionalItems === false && value.length > prefixItems.length) {
      return `Unexpected array item for ${path}: ${prefixItems.length}`;
    }
    if (schema.additionalItems === true) {
      for (let index = prefixItems.length; index < value.length; index += 1) {
        evaluatedItems.add(index);
      }
    }
    if (isRecord(schema.additionalItems)) {
      for (let index = prefixItems.length; index < value.length; index += 1) {
        const error = validateJsonSchemaValue(value[index], schema.additionalItems, `${path}[${index}]`, root, new Set(seenRefs));
        if (error) return error;
        evaluatedItems.add(index);
      }
    }
    if (schema.items === false && value.length > prefixItems.length) {
      return `Unexpected array item for ${path}: ${prefixItems.length}`;
    }
    if (schema.items === true) {
      for (let index = prefixItems.length; index < value.length; index += 1) {
        evaluatedItems.add(index);
      }
    }
    if (!Array.isArray(schema.items) && isRecord(schema.items)) {
      for (let index = prefixItems.length; index < value.length; index += 1) {
        const error = validateJsonSchemaValue(value[index], schema.items, `${path}[${index}]`, root, new Set(seenRefs));
        if (error) return error;
        evaluatedItems.add(index);
      }
    }
    if (schema.unevaluatedItems === false) {
      const unevaluatedIndex = value.findIndex((_item, index) => !evaluatedItems.has(index));
      if (unevaluatedIndex >= 0) {
        return `Unexpected array item for ${path}: ${unevaluatedIndex}`;
      }
    }
    if (isRecord(schema.unevaluatedItems)) {
      for (let index = 0; index < value.length; index += 1) {
        if (evaluatedItems.has(index)) continue;
        const error = validateJsonSchemaValue(value[index], schema.unevaluatedItems, `${path}[${index}]`, root, new Set(seenRefs));
        if (error) return error;
      }
    }
  }

  return null;
}

function canonicalJsonSchema(schema) {
  let current = schema;
  const visited = new Set();
  while (isRecord(current)) {
    if (schemaHasStructuralKeyword(current)) return current;
    if (visited.has(current)) return current;
    visited.add(current);
    const wrapped = ["schema", "json_schema", "input_schema", "inputSchema"].map((key) => current[key]).find(isRecord);
    if (!wrapped) return current;
    current = wrapped;
  }
  return current;
}

function schemaHasStructuralKeyword(schema) {
  return [
    "$defs",
    "$ref",
    "additionalProperties",
    "additionalItems",
    "allOf",
    "anyOf",
    "const",
    "contains",
    "definitions",
    "else",
    "enum",
    "if",
    "items",
    "maxContains",
    "maxItems",
    "maxProperties",
    "minContains",
    "minItems",
    "minProperties",
    "not",
    "oneOf",
    "patternProperties",
    "prefixItems",
    "properties",
    "propertyNames",
    "required",
    "then",
    "dependentRequired",
    "dependentSchemas",
    "type",
    "unevaluatedItems",
    "unevaluatedProperties",
    "uniqueItems"
  ].some((key) => Object.prototype.hasOwnProperty.call(schema, key));
}

function schemaReferenceTarget(schema, rootSchema, seenRefs = new Set()) {
  if (!isRecord(schema) || typeof schema.$ref !== "string") return null;
  const ref = schema.$ref.trim();
  if (!ref.startsWith("#") || seenRefs.has(ref)) return null;
  const target = jsonPointerTarget(rootSchema, ref);
  if (!isRecord(target)) return null;
  const nextSeenRefs = new Set(seenRefs);
  nextSeenRefs.add(ref);
  return { schema: target, seenRefs: nextSeenRefs };
}

function jsonPointerTarget(root, ref) {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return null;
  let pointer = ref.slice(1);
  try {
    pointer = decodeURIComponent(pointer);
  } catch {}
  let target = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment);
    if (Array.isArray(target) && /^\d+$/.test(segment)) {
      target = target[Number(segment)];
    } else if (isRecord(target) && Object.prototype.hasOwnProperty.call(target, segment)) {
      target = target[segment];
    } else {
      return null;
    }
  }
  return target;
}

function decodeJsonPointerSegment(segment) {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function schemaTypes(schema) {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((type) => typeof type === "string");
  return [];
}

function schemaAllowsNull(schema, rootSchema = schema, seenRefs = new Set()) {
  schema = canonicalJsonSchema(schema);
  if (!isRecord(schema)) return false;
  const root = canonicalJsonSchema(rootSchema || schema);
  const reference = schemaReferenceTarget(schema, root, seenRefs);
  if (reference) return schemaAllowsNull(reference.schema, root, reference.seenRefs);
  if (schema?.nullable === true) return true;
  if (schemaTypes(schema).includes("null")) return true;
  for (const key of ["anyOf", "oneOf"]) {
    const variants = Array.isArray(schema[key]) ? schema[key] : [];
    if (variants.some((candidate) => candidate && typeof candidate === "object" && schemaAllowsNull(candidate, root, new Set(seenRefs)))) {
      return true;
    }
  }
  return false;
}

function validateStringConstraints(value, schema, path) {
  if (typeof value !== "string") return null;
  const length = [...value].length;
  if (Number.isInteger(schema.minLength) && length < schema.minLength) {
    return `Invalid value for ${path}: expected at least ${schema.minLength} character(s)`;
  }
  if (Number.isInteger(schema.maxLength) && length > schema.maxLength) {
    return `Invalid value for ${path}: expected at most ${schema.maxLength} character(s)`;
  }
  if (typeof schema.pattern === "string" && schema.pattern) {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        return `Invalid value for ${path}: expected to match pattern ${schema.pattern}`;
      }
    } catch {}
  }
  return null;
}

function validateNumberConstraints(value, schema, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return `Invalid value for ${path}: expected >= ${schema.minimum}`;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return `Invalid value for ${path}: expected <= ${schema.maximum}`;
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    return `Invalid value for ${path}: expected > ${schema.exclusiveMinimum}`;
  }
  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) {
    return `Invalid value for ${path}: expected > ${schema.minimum}`;
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    return `Invalid value for ${path}: expected < ${schema.exclusiveMaximum}`;
  }
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) {
    return `Invalid value for ${path}: expected < ${schema.maximum}`;
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 100) {
      return `Invalid value for ${path}: expected a multiple of ${schema.multipleOf}`;
    }
  }
  return null;
}

function patternPropertySchemasForKey(schema, key) {
  if (!isRecord(schema.patternProperties)) return [];
  const output = [];
  for (const [pattern, patternSchema] of Object.entries(schema.patternProperties)) {
    if (!isRecord(patternSchema) && typeof patternSchema !== "boolean") continue;
    try {
      if (new RegExp(pattern).test(key)) output.push(patternSchema);
    } catch {}
  }
  return output;
}

function schemaEvaluatesObjectProperty(schema, key, rootSchema, value, seenRefs = new Set()) {
  schema = canonicalJsonSchema(schema);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const reference = schemaReferenceTarget(schema, rootSchema, seenRefs);
  if (reference) return schemaEvaluatesObjectProperty(reference.schema, key, rootSchema, value, reference.seenRefs);
  if (isRecord(schema.properties) && Object.prototype.hasOwnProperty.call(schema.properties, key)) return true;
  if (patternPropertySchemasForKey(schema, key).length > 0) return true;
  if (schema.additionalProperties === true || isRecord(schema.additionalProperties)) return true;
  if (isRecord(schema.dependentSchemas) && isRecord(value)) {
    for (const [dependency, dependentSchema] of Object.entries(schema.dependentSchemas)) {
      if (!Object.prototype.hasOwnProperty.call(value, dependency)) continue;
      if (schemaEvaluatesObjectProperty(dependentSchema, key, rootSchema, value, new Set(seenRefs))) return true;
    }
  }
  if (Array.isArray(schema.allOf)) {
    if (schema.allOf.some((candidate) => schemaEvaluatesObjectProperty(candidate, key, rootSchema, value, new Set(seenRefs)))) return true;
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const candidate of schema[keyword]) {
      if (validateJsonSchemaValue(value, candidate, "$", rootSchema, new Set(seenRefs)) !== null) continue;
      if (schemaEvaluatesObjectProperty(candidate, key, rootSchema, value, new Set(seenRefs))) return true;
    }
  }
  if (isRecord(schema.if) || typeof schema.if === "boolean") {
    const matchesIf = validateJsonSchemaValue(value, schema.if, "$", rootSchema, new Set(seenRefs)) === null;
    if (matchesIf && schemaEvaluatesObjectProperty(schema.if, key, rootSchema, value, new Set(seenRefs))) return true;
    const branch = matchesIf ? schema.then : schema.else;
    if ((isRecord(branch) || typeof branch === "boolean")
        && schemaEvaluatesObjectProperty(branch, key, rootSchema, value, new Set(seenRefs))) {
      return true;
    }
  }
  return false;
}

function jsonValueMatchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  return stableJson(left) === stableJson(right);
}

function clientMcpToolDefinitions(clientTools = []) {
  const pathProperty = { type: "string", description: "File or directory path for the outer client." };
  const fallbackTools = [
    {
      name: "client_write",
      description: "Forward a file write to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          fileText: { type: "string" }
        },
        required: ["path", "fileText"],
        additionalProperties: true
      }
    },
    {
      name: "client_shell",
      description: "Forward a shell command to the outer client. The bridge never executes it locally.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          workingDirectory: { type: "string" },
          timeout: { type: "number" }
        },
        required: ["command"],
        additionalProperties: true
      }
    },
    {
      name: "client_read",
      description: "Forward a file read to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["path"],
        additionalProperties: true
      }
    },
    {
      name: "client_edit",
      description: "Forward a text replacement edit to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          path: pathProperty,
          oldString: { type: "string" },
          newString: { type: "string" }
        },
        required: ["path", "oldString", "newString"],
        additionalProperties: true
      }
    },
    {
      name: "client_delete",
      description: "Forward a file or directory delete to the outer client.",
      inputSchema: {
        type: "object",
        properties: { path: pathProperty },
        required: ["path"],
        additionalProperties: true
      }
    },
    {
      name: "client_glob",
      description: "Forward a glob file search to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          targetDirectory: { type: "string" },
          globPattern: { type: "string" }
        },
        required: ["globPattern"],
        additionalProperties: true
      }
    },
    {
      name: "client_grep",
      description: "Forward a text search to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" }
        },
        required: ["pattern"],
        additionalProperties: true
      }
    },
    {
      name: "client_ls",
      description: "Forward a directory listing to the outer client.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        additionalProperties: true
      }
    },
    {
      name: "client_read_lints",
      description: "Forward diagnostics/lint reads to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } }
        },
        required: ["paths"],
        additionalProperties: true
      }
    },
    {
      name: "client_sem_search",
      description: "Forward semantic code search to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          targetDirectories: { type: "array", items: { type: "string" } }
        },
        required: ["query"],
        additionalProperties: true
      }
    },
    {
      name: "client_todo_write",
      description: "Forward todo list updates to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          todos: { type: "array", items: { type: "object", additionalProperties: true } }
        },
        required: ["todos"],
        additionalProperties: true
      }
    },
    {
      name: "client_task",
      description: "Forward a subagent/task request to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string" },
          prompt: { type: "string" },
          subagentType: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }] },
          model: { type: "string" },
          resume: { type: "string" },
          agentId: { type: "string" },
          attachments: { type: "array", items: { type: "string" } },
          mode: { type: "string" }
        },
        required: ["description", "prompt"],
        additionalProperties: true
      }
    },
    {
      name: "client_create_plan",
      description: "Forward a plan creation/update request to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          plan: { type: "string" },
          overview: { type: "string" },
          name: { type: "string" },
          todos: { type: "array", items: { type: "object", additionalProperties: true } },
          phases: { type: "array", items: { type: "object", additionalProperties: true } },
          isProject: { type: "boolean" }
        },
        additionalProperties: true
      }
    },
    {
      name: "client_generate_image",
      description: "Forward an image generation request to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string" },
          filePath: pathProperty
        },
        required: ["description"],
        additionalProperties: true
      }
    },
    {
      name: "client_record_screen",
      description: "Forward a screen recording control request to the outer client.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["START_RECORDING", "SAVE_RECORDING", "DISCARD_RECORDING"] }
        },
        required: ["mode"],
        additionalProperties: true
      }
    }
  ];
  const tools = [];
  const seen = new Set();
  for (const tool of clientTools) {
    if (!tool.name || seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push({
      name: tool.name,
      description: tool.description || `Forward ${tool.name} to the outer client.`,
      inputSchema: clientMcpInputSchema(tool.parameters)
    });
  }
  for (const tool of fallbackTools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

function bridgePrompt(prompt, clientTools = []) {
  const mcpClientTools = clientToolsNeedingMcp(clientTools);
  const exactTools = clientTools
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string" && name.trim())
    .join(", ");
  const exactMcpTools = mcpClientTools
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string" && name.trim())
    .join(", ");
  const toolInstruction = exactTools
    ? `The outer client tools are: ${exactTools}.`
    : "No outer client tools were provided for this request.";
  const mcpInstruction = exactMcpTools
    ? `Client-only tools are exposed through the client MCP server by exact name: ${exactMcpTools}.`
    : "No client MCP forwarding tools are attached for this turn; answer without new local tool calls unless the prompt contains TOOL RESULT records to continue from.";
  const localServerInstruction = exactMcpTools
    ? "A local MCP server named client exposes forwarding tools such as client_shell, client_write, client_read, client_edit, client_delete, client_glob, client_grep, and the exact outer client tool names."
    : "No local MCP server tools are available on this turn.";

  return [
    "You are running through the real Cursor SDK local runtime behind an OpenAI-compatible client.",
    "The outer client owns local tool execution. The bridge must forward local operations; it must not execute SDK built-in shell/read/write/edit/glob/grep/ls/delete tools inside the bridge runtime.",
    toolInstruction,
    mcpInstruction,
    localServerInstruction,
    "Prefer exact client tools and dedicated client MCP tools such as write, read, edit, glob, grep, ls, delete, client_write, client_read, client_edit, client_glob, client_grep, client_ls, and client_delete before bash/client_shell. Use shell only for commands or when no dedicated client tool fits.",
    "Use SDK mcp with providerIdentifier \"client\" for every local operation. Do not use SDK built-in shell, write, edit, read, glob, grep, ls, delete, readLints, semSearch, todowrite, task, createPlan, generateImage, or recordScreen.",
    "If the prompt says LOCAL TOOL REQUIRED, emit exactly one client MCP forwarding tool call and no prose.",
    "If TOOL RESULT records are present, treat those tools as already executed by the outer client and continue from the result.",
    "",
    prompt
  ].join("\n");
}

function toolCallFromDelta(update) {
  if (!update || typeof update !== "object") return null;
  if (update.type !== "tool-call-started") return null;
  const toolCall = update.toolCall;
  if (!toolCall || typeof toolCall !== "object") return null;
  return toolCall;
}

function normalizeSDKToolCall(toolCall, clientTools = []) {
  const name = typeof toolCall.type === "string" ? toolCall.type : typeof toolCall.name === "string" ? toolCall.name : "";
  if (!name) return null;
  const args = objectArgumentFrom(toolCall, "args", "arguments", "input", "parameters", "params");
  const clientMcpTool = normalizeClientMcpToolCall(name, args);
  if (clientMcpTool) return clientMcpTool;
  const directClientTool = normalizeDirectClientToolCall(name, args, clientTools);
  if (directClientTool) return directClientTool;
  return {
    name,
    arguments: normalizeArguments(args)
  };
}

function normalizeClientMcpToolCall(name, args) {
  if (canonicalToolName(name) !== "mcp") return null;
  const provider = firstString(args, "providerIdentifier", "provider", "server", "serverName", "server_name");
  if (provider && provider !== clientMcpServerName) return null;
  const toolName = firstString(args, "toolName", "tool_name", "tool", "name");
  const sdkName = sdkToolNameFromClientMcpTool(toolName);
  const payload = clientMcpPayloadArguments(args);
  if (!sdkName) {
    return {
      name: "mcp",
      arguments: {
        providerIdentifier: clientMcpServerName,
        toolName,
        args: normalizeArguments(payload)
      }
    };
  }
  return {
    name: sdkName,
    arguments: normalizeArguments(payload)
  };
}

function normalizeDirectClientToolCall(name, args, clientTools = []) {
  const sdkName = sdkToolNameFromClientMcpTool(name);
  const normalizedName = normalizeToolName(name);
  const matchingClientTool = clientTools.find((tool) => normalizeToolName(tool.name) === normalizedName);
  if (matchingClientTool && normalizedName === "exec") {
    return {
      name: matchingClientTool.name,
      arguments: normalizeArguments(args)
    };
  }
  if (sdkName && (normalizedName.startsWith("client") || matchingClientTool)) {
    return {
      name: sdkName,
      arguments: normalizeArguments(args)
    };
  }
  if (!matchingClientTool) return null;
  return {
    name: "mcp",
    arguments: {
      providerIdentifier: clientMcpServerName,
      toolName: matchingClientTool.name,
      args: normalizeArguments(args)
    }
  };
}

function sdkToolNameFromClientMcpTool(toolName) {
  const normalized = normalizeToolName(toolName).replace(/^client/, "");
  switch (normalized) {
    case "shell":
    case "shellcommand":
    case "bash":
    case "run":
    case "runcommand":
      return "shell";
    case "write":
    case "writefile":
      return "write";
    case "read":
    case "readfile":
      return "read";
    case "edit":
    case "editfile":
      return "edit";
    case "delete":
    case "deletefile":
    case "remove":
    case "removefile":
      return "delete";
    case "glob":
    case "fileglob":
      return "glob";
    case "grep":
    case "search":
      return "grep";
    case "ls":
    case "list":
    case "listfiles":
      return "ls";
    case "readlints":
    case "diagnostics":
      return "readLints";
    case "semsearch":
    case "semanticsearch":
      return "semSearch";
    case "todowrite":
    case "todos":
    case "updatetodos":
      return "todowrite";
    case "task":
    case "subagent":
    case "subagenttask":
      return "task";
    case "createplan":
      return "createPlan";
    case "generateimage":
    case "imagegeneration":
    case "imagegen":
      return "generateImage";
    case "recordscreen":
    case "screenrecord":
    case "screenrecording":
      return "recordScreen";
    default:
      return null;
  }
}

function isForwardableSDKToolCall(toolCall, clientTools = []) {
  const args = toolCall.arguments || {};
  if (matchingClientToolByName(toolCall.name, clientTools)) {
    return clientToolPayloadIsComplete(toolCall.name, args, clientTools);
  }
  switch (canonicalToolName(toolCall.name)) {
    case "shell":
      return hasString(args, "command");
    case "write":
      return hasString(args, "path", "filePath", "targetFile")
        && hasStringAllowEmpty(args, "fileText", "content", "contents", "text", "data");
    case "edit":
      return hasString(args, "path", "filePath", "targetFile")
        && (
          hasStringAllowEmpty(args, "patchContent", "patch_content", "streamContent", "stream_content")
          || (hasStringAllowEmpty(args, "oldText", "oldString", "old_str") && hasStringAllowEmpty(args, "newText", "newString", "replacement"))
        );
    case "delete":
    case "read":
      return hasString(args, "path", "filePath", "targetFile");
    case "glob":
      return hasString(args, "globPattern", "glob_pattern", "pattern", "fileGlob", "file_glob", "includePattern", "include_pattern", "glob")
        || hasGlobString(args, "targetDirectory", "target_directory", "targeting", "path", "directory", "dir", "root", "basePath", "base_path");
    case "grep":
      return hasString(args, "pattern", "query");
    case "ls":
      return true;
    case "mcp":
      if (!hasString(args, "providerIdentifier", "provider", "server")
          || !hasString(args, "toolName", "tool", "name")) {
        return false;
      }
      return mcpClientToolPayloadIsComplete(args, clientTools);
    case "readlints":
      return hasStringOrStringArray(args, "paths", "files", "filePaths", "file_paths", "path", "file_path", "filePath", "filename", "file");
    case "semsearch":
      return hasString(args, "query", "pattern", "search", "searchQuery", "search_query", "semanticQuery", "semantic_query", "prompt");
    case "todowrite":
      return hasArray(args, "todos", "todoList", "todo_list", "todoItems", "todo_items", "items", "tasks", "taskList", "task_list");
    case "task":
      return hasString(args, "description", "desc", "summary")
        && hasString(args, "prompt", "instructions", "input", "query");
    case "createplan":
      return hasString(args, "plan", "overview", "name", "title", "description")
        || hasArray(args, "todos", "todoList", "todo_list", "todoItems", "todo_items", "items", "tasks", "taskList", "task_list", "phases");
    case "generateimage":
      return hasString(args, "description", "desc", "summary", "prompt", "input", "query");
    case "recordscreen":
      return hasString(args, "mode", "action", "operation", "op");
    default:
      return false;
  }
}

function clientToolPayloadIsComplete(toolName, payload, clientTools = []) {
  const tool = matchingClientToolByName(toolName, clientTools);
  if (!tool) return true;
  const schema = clientMcpInputSchema(tool.parameters);
  return validateJsonSchemaValue(payload, schema, tool.name, schema) === null;
}

function mcpClientToolPayloadIsComplete(args, clientTools = []) {
  const tool = matchingClientToolForMcpCall(args, clientTools);
  if (tool) {
    const payload = clientMcpPayloadArguments(args);
    const schema = clientMcpInputSchema(tool.parameters);
    return validateJsonSchemaValue(payload, schema, tool.name, schema) === null;
  }
  const wrapper = matchingClientMcpWrapperTool(args, clientTools);
  if (!wrapper) return false;
  const schema = clientMcpInputSchema(wrapper.parameters);
  const wrapperArgs = clientMcpWrapperArguments(args, schema);
  if (!wrapperArgs) return false;
  if (validateJsonSchemaValue(wrapperArgs, schema, wrapper.name, schema) === null) return true;
  return mcpWrapperPayloadLooksComplete(args);
}

function matchingClientToolByName(toolName, clientTools = []) {
  const normalized = normalizeToolName(toolName);
  return clientTools.find((tool) => normalizeToolName(tool?.name) === normalized) || null;
}

function matchingClientToolForMcpCall(args, clientTools = []) {
  const provider = firstString(args, "providerIdentifier", "provider_identifier", "provider", "server", "serverName", "server_name");
  const toolName = firstString(args, "toolName", "tool_name", "tool", "name");
  if (!toolName) return null;
  const candidates = new Set([toolName]);
  for (const variant of mcpProviderNameVariants(provider)) {
    candidates.add(`${variant}__${toolName}`);
    candidates.add(`${variant}_${toolName}`);
    candidates.add(`mcp__${variant}__${toolName}`);
    candidates.add(`mcp_${variant}_${toolName}`);
  }
  const normalizedCandidates = new Set([...candidates].map(normalizeToolName));
  return clientTools.find((tool) => normalizedCandidates.has(normalizeToolName(tool?.name))) || null;
}

function matchingClientMcpWrapperTool(args, clientTools = []) {
  const provider = firstString(args, "providerIdentifier", "provider_identifier", "provider", "server", "serverName", "server_name");
  const toolName = firstString(args, "toolName", "tool_name", "tool", "name");
  if (!provider || !toolName) return null;
  return clientTools.find((tool) => clientToolLooksLikeMcpWrapper(tool)) || null;
}

function clientToolLooksLikeMcpWrapper(tool) {
  if (!tool || typeof tool.name !== "string") return false;
  const schema = clientMcpInputSchema(tool.parameters);
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  return Boolean(
    schemaPropertyName(properties, mcpProviderKeys())
    && schemaPropertyName(properties, mcpToolNameKeys())
    && schemaPropertyName(properties, mcpPayloadKeys())
  );
}

function clientMcpWrapperArguments(args, schema) {
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const providerKey = schemaPropertyName(properties, mcpProviderKeys());
  const toolKey = schemaPropertyName(properties, mcpToolNameKeys());
  const payloadKey = schemaPropertyName(properties, mcpPayloadKeys());
  if (!providerKey || !toolKey || !payloadKey) return null;
  const provider = firstString(args, ...mcpProviderKeys());
  const toolName = firstString(args, ...mcpToolNameKeys());
  if (!provider || !toolName) return null;
  return {
    [providerKey]: provider,
    [toolKey]: toolName,
    [payloadKey]: clientMcpPayloadArguments(args)
  };
}

function mcpWrapperPayloadLooksComplete(args) {
  const toolName = canonicalToolName(firstString(args, ...mcpToolNameKeys()));
  const payload = clientMcpPayloadArguments(args);
  switch (toolName) {
    case "write":
    case "writefile":
    case "create":
    case "createfile":
    case "overwrite":
    case "overwritefile":
      return hasString(payload, "path", "filePath", "file_path", "targetFile", "target_file")
        && hasStringAllowEmpty(payload, "fileText", "file_text", "content", "contents", "text", "data");
    case "edit":
    case "editfile":
    case "replace":
    case "replacefile":
    case "strreplace":
    case "strreplacefile":
      return hasString(payload, "path", "filePath", "file_path", "targetFile", "target_file")
        && (
          hasStringAllowEmpty(payload, "patchContent", "patch_content", "streamContent", "stream_content")
          || (
            hasStringAllowEmpty(payload, "oldText", "old_text", "oldString", "old_string", "old_str")
            && hasStringAllowEmpty(payload, "newText", "new_text", "newString", "new_string", "replacement")
          )
        );
    case "read":
    case "readfile":
    case "open":
    case "openfile":
    case "delete":
    case "deletefile":
    case "remove":
    case "removefile":
      return hasString(payload, "path", "filePath", "file_path", "targetFile", "target_file");
    case "run":
    case "runcommand":
    case "shell":
    case "bash":
      return hasString(payload, "command", "cmd", "script", "input");
    case "glob":
    case "fileglob":
    case "find":
    case "findfile":
    case "findfiles":
      return hasString(payload, "globPattern", "glob_pattern", "pattern", "fileGlob", "file_glob", "includePattern", "include_pattern", "glob")
        || hasGlobString(payload, "targetDirectory", "target_directory", "targeting", "path", "directory", "dir", "root", "basePath", "base_path");
    case "grep":
    case "search":
    case "query":
      return hasString(payload, "pattern", "query", "search", "regex");
    case "task":
    case "subagent":
    case "subagenttask":
      return hasString(payload, "description", "desc", "summary")
        && hasString(payload, "prompt", "instructions", "input", "query");
    case "createplan":
    case "plan":
    case "planupdate":
    case "setplan":
      return hasString(payload, "plan", "overview", "name", "title", "description")
        || hasArray(payload, "todos", "todoList", "todo_list", "todoItems", "todo_items", "items", "tasks", "taskList", "task_list", "phases");
    case "generateimage":
    case "imagegeneration":
    case "imagegen":
      return hasString(payload, "description", "desc", "summary", "prompt", "input", "query");
    case "recordscreen":
    case "screenrecord":
    case "screenrecording":
      return hasString(payload, "mode", "action", "operation", "op");
    default:
      return false;
  }
}

function schemaPropertyName(properties, keys) {
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  return properties.find((property) => normalizedKeys.has(normalizeToolName(property))) || "";
}

function mcpProviderKeys() {
  return ["providerIdentifier", "provider_identifier", "provider", "server", "serverName", "server_name"];
}

function mcpToolNameKeys() {
  return ["toolName", "tool_name", "tool", "name"];
}

function mcpPayloadKeys() {
  return ["args", "arguments", "input", "parameters", "params", "payload", "data"];
}

function mcpProviderNameVariants(provider) {
  const trimmed = typeof provider === "string" ? provider.trim() : "";
  if (!trimmed) return [];
  const output = [];
  const append = (value) => {
    const candidate = String(value || "").trim();
    if (candidate && !output.includes(candidate)) output.push(candidate);
  };
  append(trimmed);
  for (const separator of [":", "/", "\\", "."]) {
    const pieces = trimmed.split(separator).filter(Boolean);
    if (pieces.length) append(pieces[pieces.length - 1]);
  }
  for (const prefix of ["mcp__", "mcp_", "mcp-", "mcp:"]) {
    if (trimmed.toLowerCase().startsWith(prefix)) append(trimmed.slice(prefix.length));
  }
  return output;
}

function canonicalToolName(name) {
  return String(name || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function normalizeToolName(name) {
  return canonicalToolName(name);
}

function hasString(args, ...keys) {
  return keys.some((key) => typeof args[key] === "string" && args[key].trim().length > 0);
}

function firstString(args, ...keys) {
  for (const key of keys) {
    if (typeof args[key] === "string" && args[key].trim()) return args[key].trim();
  }
  return "";
}

function firstMatchingKey(source, ...keys) {
  if (!isRecord(source)) return "";
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return key;
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const key of Object.keys(source)) {
    if (normalizedKeys.has(normalizeToolName(key))) return key;
  }
  return "";
}

function hasStringAllowEmpty(args, ...keys) {
  return keys.some((key) => typeof args[key] === "string");
}

function hasArray(args, ...keys) {
  return keys.some((key) => Array.isArray(args[key]));
}

function hasStringOrStringArray(args, ...keys) {
  return keys.some((key) => {
    const value = args[key];
    if (typeof value === "string") return value.trim().length > 0;
    return Array.isArray(value) && value.some((item) => typeof item === "string" && item.trim().length > 0);
  });
}

function hasGlobString(args, ...keys) {
  return keys.some((key) => typeof args[key] === "string" && /[*?[\]{}]/.test(args[key]));
}

function normalizeArguments(args) {
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
    output[key] = normalizeJsonValue(value);
  }
  return output;
}

function objectArgumentFrom(source, ...keys) {
  if (!isRecord(source)) return {};
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      if (parsed) return parsed;
    }
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(source)) {
    if (!normalizedKeys.has(normalizeToolName(key))) continue;
    if (isRecord(value)) return value;
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      if (parsed) return parsed;
    }
  }
  return {};
}

function objectArgumentEntryFrom(source, ...keys) {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return { key, value };
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      if (parsed) return { key, value: parsed };
    }
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(source)) {
    if (!normalizedKeys.has(normalizeToolName(key))) continue;
    if (isRecord(value)) return { key, value };
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      if (parsed) return { key, value: parsed };
    }
  }
  return null;
}

function clientMcpPayloadArguments(args) {
  const envelope = objectArgumentEntryFrom(args, "args", "arguments", "input", "parameters", "params", "payload", "data");
  if (envelope && Object.keys(envelope.value).length > 0) return envelope.value;
  if (!isRecord(args)) return {};
  const providerKey = firstMatchingKey(args, "providerIdentifier", "provider", "server", "serverName", "server_name");
  const toolKey = firstMatchingKey(args, "toolName", "tool_name", "tool", "name");
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === providerKey || key === toolKey || key === envelope?.key) continue;
    output[key] = value;
  }
  return output;
}

function parseJsonObject(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (typeof value === "object") return normalizeArguments(value);
  return String(value);
}

function clientMcpInputSchema(parameters) {
  if (isRecord(parameters) && Object.keys(parameters).length > 0) {
    return canonicalJsonSchema(normalizeJsonValue(parameters));
  }
  return {
    type: "object",
    additionalProperties: true
  };
}

function agentCacheKey(input) {
  const digest = crypto
    .createHash("sha256")
    .update([input.apiKey, input.model, input.workingDirectory, input.sessionKey].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return digest;
}


function activeAgentCount() {
  return [...sessionActors.values()].filter((actor) => actor.agentEntry).length;
}

function evictAgents() {
  while (activeAgentCount() > maxAgents) {
    const oldest = [...sessionActors.entries()]
      .filter(([, actor]) => actor.agentEntry && !actor.activeRun)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) return;
    sessionActors.delete(oldest[0]);
    forceNextRunAgentKeys.delete(oldest[0]);
    try {
      oldest[1].agentEntry.agent.close();
    } catch {}
  }
}

function normalizeModel(model) {
  const raw = model.trim();
  const leaf = raw.split("/").filter(Boolean).at(-1) || "";
  const bracketStart = leaf.indexOf("[");
  const base = (bracketStart >= 0 ? leaf.slice(0, bracketStart) : leaf).trim();
  const suffix = bracketStart >= 0 ? leaf.slice(bracketStart) : "";
  const normalized = base.toLowerCase();
  if (!normalized || normalized === "default") return `auto${suffix}`;
  if (normalized === "composer-latest" || normalized === "composer" || normalized === "composer-2-5") {
    return `composer-2.5${suffix}`;
  }
  if (normalized === "composer-2.5-sdk" || normalized === "composer-2-5-sdk") return `composer-2.5${suffix}`;
  if (normalized === "composer-2-5-fast") return `composer-2.5-fast${suffix}`;
  return `${base || "auto"}${suffix}`;
}

function sdkModelSelection(model) {
  const normalized = normalizeModel(typeof model === "string" ? model : "");
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(normalized);
  let id = (match?.[1] || "auto").trim();
  const params = [];

  if (id === "composer-2.5-fast") {
    id = "composer-2.5";
    params.push({ id: "fast", value: "true" });
  } else if (id === "composer-2.5-slow") {
    id = "composer-2.5";
    params.push({ id: "fast", value: "false" });
  }

  const rawParams = match?.[2]?.trim();
  if (rawParams) {
    for (const entry of rawParams.split(",")) {
      const separator = entry.indexOf("=");
      const shorthand = entry.trim();
      const contextShorthand = separator <= 0 && /^\d+(?:\.\d+)?[km]$/i.test(shorthand);
      if (separator <= 0 && !contextShorthand) continue;
      let paramId = contextShorthand ? "context" : entry.slice(0, separator).trim();
      const value = separator <= 0
        ? shorthand.toLowerCase()
        : entry.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (!paramId || !value) continue;
      // Grok 4.7 registers reasoning_effort; older models use the effort alias.
      if (paramId === "reasoning_effort" && id !== "grok-4.7") paramId = "effort";
      if (id === "auto-smart" && paramId === "mode") paramId = "optimize_for";
      const existing = params.findIndex((item) => item.id === paramId);
      const param = { id: paramId, value };
      if (existing >= 0) params[existing] = param;
      else params.push(param);
    }
  }

  return params.length ? { id, params } : { id };
}

function sdkWorkingDirectory(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.toLowerCase() === "undefined" || trimmed.toLowerCase() === "null") return defaultCwd;
  return trimmed;
}

function stripFinalMarker(text) {
  return text.replace(/\s*<\/?(?:final_answer|answer)>\s*$/gi, "").trim();
}

function composerToolCallFromText(text) {
  if (typeof text !== "string") return null;
  const callsStart = text.indexOf("<|tool_calls_begin|>");
  const callsEnd = text.indexOf("<|tool_calls_end|>", callsStart + 1);
  if (callsStart < 0 || callsEnd < 0) return null;
  const callStart = text.indexOf("<|tool_call_begin|>", callsStart);
  const callEnd = text.indexOf("<|tool_call_end|>", callStart + 1);
  if (callStart < 0 || callEnd < 0 || callEnd > callsEnd) return null;

  const body = text.slice(callStart + "<|tool_call_begin|>".length, callEnd);
  const parts = body.split("<|tool_sep|>");
  const type = (parts.shift() || "").trim();
  if (!type) return null;

  const args = {};
  for (const part of parts) {
    const match = /^\s*([^\r\n]+)(?:\r?\n([\s\S]*))?$/.exec(part);
    if (!match?.[1]) continue;
    args[match[1].trim()] = parseComposerToolArgument((match[2] || "").trim());
  }
  return { type, args };
}

function parseComposerToolArgument(value) {
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

function requiredString(value, key) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(`Missing ${key}`, 400, "invalid_request");
  }
  return value;
}

function parseClientTools(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name.trim()) return [];
    const description = typeof tool.description === "string" ? tool.description : undefined;
    const parameters = isJsonSerializable(tool.parameters) ? tool.parameters : undefined;
    return [{
      name: tool.name.trim(),
      ...(description ? { description } : {}),
      ...(parameters !== undefined ? { parameters: normalizeJsonValue(parameters) } : {}),
      ...clientToolMetadata(tool)
    }];
  });
}

function clientToolMetadata(tool) {
  const metadata = {};
  if (tool.outputSchema !== undefined) {
    if (!isRecord(tool.outputSchema) || Array.isArray(tool.outputSchema) || !isJsonSerializable(tool.outputSchema)) {
      throw new HttpError("Tool outputSchema must be a JSON object.", 400, "invalid_request");
    }
    metadata.outputSchema = normalizeJsonValue(tool.outputSchema);
  }
  if (tool.annotations !== undefined) {
    if (!isRecord(tool.annotations) || Array.isArray(tool.annotations)) {
      throw new HttpError("Tool annotations must be an object.", 400, "invalid_request");
    }
    metadata.annotations = {};
    for (const key of ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      const value = tool.annotations[key];
      if (value === undefined) continue;
      if (typeof value !== (key === "title" ? "string" : "boolean")) {
        throw new HttpError(`Invalid tool annotation ${key}.`, 400, "invalid_request");
      }
      metadata.annotations[key] = value;
    }
  }
  return metadata;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxJsonBytes) {
      throw new HttpError(
        `Request body too large: exceeds the ${formatBytes(maxJsonBytes)} bridge limit `
        + `(CURSOR_SDK_BRIDGE_MAX_JSON_BYTES=${maxJsonBytes}). `
        + "This is a bridge-side cap, not a Cursor account limit. "
        + "Shorten the conversation, send fewer tool definitions, or raise CURSOR_SDK_BRIDGE_MAX_JSON_BYTES.",
        413,
        "request_too_large"
      );
    }
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError("Invalid JSON", 400, "invalid_json");
  }
}

function writeJson(response, body, status = 200) {
  if (response.writableEnded || response.destroyed) return false;
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(data.length),
    "Cache-Control": "no-cache, no-transform",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(data);
  return true;
}

function writeNdjson(response, body) {
  if (response.writableEnded || response.destroyed) return false;
  try {
    response.write(`${JSON.stringify(body)}\n`);
    return true;
  } catch (error) {
    if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") {
      return false;
    }
    throw error;
  }
}

function installBridgeProcessHandlers() {
  process.on("unhandledRejection", (reason) => {
    if (isBenignCancellationError(reason) || isBenignPipeError(reason)) return;
    if (isRetryableSDKRunError(reason)) {
      console.warn("Ignored late retryable Cursor SDK upstream error.");
      return;
    }
    console.error(reason);
    closeAndExit(1);
  });
  process.on("uncaughtException", (error) => {
    if (isBenignCancellationError(error) || isBenignPipeError(error)) return;
    if (isRetryableSDKRunError(error)) {
      console.warn("Ignored late retryable Cursor SDK upstream error.");
      return;
    }
    console.error(error);
    closeAndExit(1);
  });
}

function isBenignCancellationError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function isBenignPipeError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}

function isRetryableSDKRunError(error) {
  const values = flattenErrorValues(error);
  if (values.some((value) => ["cursor_sdk_steer_failed", "cursor_sdk_system_prompt_unavailable"].includes(value?.code))) return false;
  if (values.some((value) => value?.isRetryable === true)) return true;
  if (values.some((value) => value?.status === 429 || value?.status === 503 || value?.code === 8 || value?.code === 14)) return true;
  return values
    .flatMap((value) => [value?.message, value?.rawMessage, value?.code, value?.status, value?.name])
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).toLowerCase())
    .some((text) =>
      text.includes("server at capacity")
        || text.includes("temporarily unavailable")
        || text.includes("resource exhausted")
        || text.includes("rate limit")
        || text.includes("too many requests")
        || text.includes("try again")
        || text.includes("socket connection was closed unexpectedly")
        || text.includes("socket hang up")
        || text.includes("connection reset")
        || text.includes("connection closed unexpectedly")
        || text.includes("premature close")
        || text.includes("fetch failed")
        || text.includes("network error")
        || text === "econnreset"
        || text === "etimedout"
        || text === "und_err_socket"
        || text === "err_stream_premature_close"
        || text === "unavailable"
        || text === "resource_exhausted"
    );
}

function sdkRunFailureError(result) {
  const summary = sdkRunFailureSummary(result);
  if (/\[invalid_argument\].*unknown option ['"]--system-prompt['"]/.test(summary.message)) {
    return new HttpError(
      "Native system_prompt is unavailable for this Cursor account. Set system_prompt to false to use the default prompt.",
      400,
      "cursor_sdk_system_prompt_unavailable"
    );
  }
  const error = new HttpError(
    summary.message || "Cursor SDK run failed",
    summary.retryable ? 503 : 502,
    "cursor_sdk_error"
  );
  error.rawMessage = summary.message;
  error.isRetryable = summary.retryable;
  error.cause = summary;
  console.warn(`Cursor SDK run returned error status${summary.code ? ` (${summary.code})` : ""}.`);
  return error;
}

function sdkRunFailureSummary(result) {
  const source = firstRecord(result?.error, result?.cause, result?.details, result?.result);
  const message = firstNonEmptyString(
    source?.message,
    source?.rawMessage,
    source?.error,
    source?.details,
    typeof result?.result === "string" ? result.result : undefined
  );
  const code = firstNonEmptyString(source?.code, result?.code);
  return {
    status: result?.status,
    code,
    message,
    retryable: isRetryableSDKRunError(source) || (!message && !code)
  };
}

function firstRecord(...values) {
  return values.find((value) => isRecord(value)) || {};
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function flattenErrorValues(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = current.cause;
  }
  return values;
}

function retryDelayMs(attempt) {
  return Math.min(5000, retryBaseDelayMs * 2 ** attempt);
}

function openAiError(error) {
  const status = statusFromError(error);
  const message = messageFromError(error, status);
  const code = codeFromError(error, status);
  return {
    error: {
      message,
      type: error?.type || (status >= 500 ? "api_error" : "invalid_request_error"),
      code,
      status,
      ...(code === "cursor_sdk_context_compacted" ? { contextRetrySafe: error?.contextRetrySafe === true } : {})
    }
  };
}

function statusFromError(error) {
  if (isAuthenticationSDKError(error)) return 401;
  for (const value of flattenErrorValues(error)) {
    const status = parseHTTPStatus(value?.status);
    if (status) return status;
  }
  if (isRetryableSDKRunError(error)) return 503;
  return 500;
}

function messageFromError(error, status) {
  if (status === 401 && isAuthenticationSDKError(error)) {
    return "Missing or invalid authorization";
  }
  const message = firstNonEmptyString(
    error?.message,
    error?.rawMessage,
    error?.error,
    error?.details
  );
  if (message && message !== "Error") return message;
  if (status === 401) return "Missing or invalid authorization";
  return message || "Cursor SDK request failed";
}

function codeFromError(error, status) {
  if (status === 401 && isAuthenticationSDKError(error)) return "unauthorized";
  const code = firstNonEmptyString(error?.code, error?.cause?.code);
  if (code && !(status === 401 && code === "internal")) return code;
  if (status === 401) return "unauthorized";
  if (status === 503) return "cursor_sdk_unavailable";
  return code || "cursor_sdk_error";
}

function isAuthenticationSDKError(error) {
  return flattenErrorValues(error).some((value) => {
    const name = String(value?.name || "").toLowerCase();
    const code = String(value?.code || "").toLowerCase();
    const message = String(value?.message || value?.rawMessage || "").toLowerCase();
    const status = parseHTTPStatus(value?.status);
    return status === 401
      || name.includes("authentication")
      || code === "unauthorized"
      || code === "authentication_error"
      || message.includes("authentication error")
      || message.includes("invalid user api key")
      || message.includes("invalid cursor api key")
      || message.includes("missing or invalid authorization")
      || message.includes("invalid authorization")
      || message.includes("unauthorized");
  });
}

function parseHTTPStatus(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    if (parsed >= 100 && parsed <= 599) return parsed;
  }
  return 0;
}

class HttpError extends Error {
  constructor(message, status = 500, code = "api_error") {
    super(message);
    this.status = status;
    this.code = code;
    this.type = status >= 500 ? "api_error" : "invalid_request_error";
  }
}

function bearerToken(request) {
  const value = request.headers.authorization || "";
  const [scheme, token] = value.split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configureCursorSdkNetwork(cursor, environment) {
  const useHttp1ForAgent = optionalEnvironmentBoolean(
    environment.CURSOR_SDK_USE_HTTP1_FOR_AGENT,
    "CURSOR_SDK_USE_HTTP1_FOR_AGENT"
  );
  if (useHttp1ForAgent === undefined) return undefined;
  cursor.configure({ local: { useHttp1ForAgent } });
  return useHttp1ForAgent;
}

function optionalEnvironmentBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be one of: 1, 0, true, false, yes, no, on, off.`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonSerializable(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || Array.isArray(value) || isRecord(value);
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    let value = normalized.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function closeAndExit(code) {
  for (const actor of sessionActors.values()) {
    try {
      actor.agentEntry?.agent.close();
    } catch {}
  }
  server?.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500).unref();
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
