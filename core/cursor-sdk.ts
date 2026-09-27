import { sha256Hex } from "./crypto.ts";
import { HttpError } from "./http.ts";
import type { CursorCollectedOutput, CursorTextEvent, CursorUsage } from "./cursor.ts";
import type { OpenAiToolSpec, ResponsesAgentContextSource } from "./openai.ts";
import type { CursorImage, CursorToolCall, Deps, Env } from "./types.ts";

export class CursorSdkContextOverflowError extends HttpError {
  constructor(message: string, readonly contextRetrySafe: boolean) {
    super(message, 413, "context_length_exceeded");
  }
}

interface CursorSdkSession {
  agentId: string;
  updatedAt: number;
}

interface CursorSdkCompletion {
  agentId: string;
  runId: string;
  sessionKey: string;
  stream: AsyncGenerator<CursorTextEvent>;
}

interface CursorSdkBridgeOutput {
  text?: string;
  toolCalls?: CursorToolCall[];
  agentID?: string;
  runID?: string;
  executionID?: string;
  outputID?: string;
  outputType?: "commentary" | "final";
  status?: string;
  usage?: CursorUsage;
}

interface CursorSdkBridgeStreamEvent {
  type?: string;
  text?: string;
  outputId?: string;
  executionId?: string;
  runId?: string;
  agentId?: string;
  done?: boolean;
  thinkingDurationMs?: number;
  output?: unknown;
  error?: unknown;
}

interface CursorSdkBridgeResponse {
  response: Response;
  signal: AbortSignal;
  close: () => Promise<void>;
}

type ClientToolSpec = OpenAiToolSpec;

interface CursorSdkToolResult {
  callId?: string;
  output: unknown;
  images?: CursorImage[];
  isError?: boolean;
  contentSha256?: string;
  contentChars?: number;
}

interface TrajectoryInputRef {
  source: "user";
  content: string;
  contentSha256: string;
  contentChars: number;
  itemIndex?: number;
  contextCheckpointHash?: string;
}

interface CursorSdkBridgeRunInput {
  agentId: string;
  runId: string;
  sessionKey: string;
  prompt: string;
  images?: CursorImage[];
  incrementalImages?: CursorImage[];
  systemPrompt?: string;
  modelId: string;
  workingDirectory?: string;
  clientTools?: ClientToolSpec[];
  allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  incrementalPrompt?: string;
  resumeToolResults?: CursorSdkToolResult[];
  supersedePendingRun?: boolean;
  supersedingTurnAborted?: boolean;
  supersededToolCallIds?: string[];
  fullReplayCause?: string;
  agentContext?: CursorSdkAgentContext;
  internalToolCorrection?: boolean;
  replayToolResultsOnMissingPending?: boolean;
  streamEvents?: boolean;
  reasoningEvents?: boolean;
  clientSource?: string;
  clientPlatform?: string;
  ingressRequestId?: string;
  trajectorySessionId?: string;
  trajectoryInputs?: TrajectoryInputRef[];
  onBridgeAttempt?: (attempt: {
    requestId: string;
    sdkSessionKey: string;
    replayCause?: string;
    internalToolCorrection: boolean;
    resumeToolResultsCount: number;
  }) => void;
  signal?: AbortSignal;
}

interface CursorSdkAgentContext {
  bootstrapFingerprint: string;
  transcriptItemHashes: string[];
  transcriptItemOffsets: number[];
  transcriptItemImageCounts: number[];
  transcriptEndOffset: number;
  promptTextChars: number;
}

type ToolCallDecision = boolean | string;

const sdkSessions = new Map<string, CursorSdkSession>();
const SDK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS = 310_000;
const SDK_TOOL_RETRY_ATTEMPTS = 3;
const TERMINAL_SDK_ERROR_CODES = new Set([
  "abort_err",
  "cursor_sdk_cancelled",
  "cursor_sdk_steer_failed",
  "cursor_sdk_system_prompt_unavailable",
  "cursor_sdk_pending_lease_expired",
  "cursor_sdk_idle_timeout",
  "cursor_sdk_timeout",
  "cursor_sdk_bridge_timeout",
  "cursor_sdk_bridge_duplicate_done",
  "cursor_sdk_bridge_event_after_done",
  "cursor_sdk_bridge_invalid_event",
  "cursor_sdk_bridge_missing_done",
  "cursor_sdk_bridge_unknown_event"
]);

export function isTransientCursorSdkError(error: unknown): boolean {
  const values: unknown[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const value = pending.shift();
    if (value == null || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    pending.push(record.cause, record.error, record.reason);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }

  if (values.some((value) => {
    if (typeof value === "string") return TERMINAL_SDK_ERROR_CODES.has(value.toLowerCase());
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return String(record.name || "").toLowerCase() === "aborterror"
      || TERMINAL_SDK_ERROR_CODES.has(String(record.code || "").toLowerCase());
  })) return false;

  const text = values
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (typeof value !== "object" || value === null) return [];
      const record = value as Record<string, unknown>;
      return [record.message, record.rawMessage, record.code, record.name];
    })
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map((value) => String(value).toLowerCase());

  if (text.some((value) =>
    value.includes("authentication error") ||
    value.includes("invalid user api key") ||
    value.includes("invalid cursor api key") ||
    value.includes("missing or invalid authorization") ||
    value.includes("invalid authorization") ||
    value.includes("unauthorized")
  )) return false;

  const statuses = values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const status = Number((value as Record<string, unknown>).status);
    return Number.isFinite(status) ? [status] : [];
  });
  if (statuses.some((status) => [408, 429, 502, 503, 504].includes(status))) return true;

  return text.some((value) =>
    value === "econnreset" ||
    value === "epipe" ||
    value === "etimedout" ||
    value === "econnrefused" ||
    value === "enetwork" ||
    value === "und_err_socket" ||
    value === "und_err_connect_timeout" ||
    value === "err_stream_premature_close" ||
    value.includes("socket connection was closed unexpectedly") ||
    value.includes("socket hang up") ||
    value.includes("connection reset") ||
    value.includes("connection closed unexpectedly") ||
    value.includes("premature close") ||
    value.includes("fetch failed") ||
    value.includes("network error") ||
    value.includes("unable to connect") ||
    value.includes("timed out") ||
    value.includes("timeout")
  );
}

function isUnmatchedCursorSdkToolResultError(error: unknown): boolean {
  return hasCursorSdkErrorCode(error, "cursor_sdk_tool_result_unmatched");
}

function hasCursorSdkErrorCode(error: unknown, code: string): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const value = pending.shift();
    if (value == null || seen.has(value)) continue;
    seen.add(value);
    if (typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.code === code) return true;
    pending.push(record.cause, record.error, record.reason);
  }
  return false;
}

/** A successful SDK run with no text or tool call is an upstream empty turn. */
export function isEmptyCursorSdkTurn(events: CursorTextEvent[]): boolean {
  const terminal = events.at(-1);
  if (terminal?.type !== "done" || terminal.finalText.trim() || terminal.toolCalls.length > 0) return false;
  return !events.some((event) =>
    (event.type === "text" && event.text.trim().length > 0) ||
    (event.type === "reasoning" && event.text.trim().length > 0) ||
    event.type === "tool_call" ||
    event.type === "rejected_tool_call"
  );
}

export async function createCursorSdkCompletion(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    prompt: { text: string; images?: CursorImage[] };
    systemPrompt?: string;
    model?: { id: string };
    sessionKey?: string;
    sessionOwnerKey?: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    resumeToolResults?: CursorSdkToolResult[];
    supersedePendingRun?: boolean;
    supersedingTurnAborted?: boolean;
    supersededToolCallIds?: string[];
    fullReplayCause?: string;
    agentContext?: ResponsesAgentContextSource;
    replayToolResultsOnMissingPending?: boolean;
    // Optional delta for a follow-up turn. When the bridge's agent for this session is
    // still cached, the bridge sends only this (the new turn) instead of re-feeding the
    // full prompt; if the agent was evicted it falls back to `prompt`, so this is safe.
    incrementalPrompt?: { text: string; images?: CursorImage[] };
    // The bridge preserves text/tool-call order and leaves a forwarded tool run
    // pending for the next request, so tool-capable turns can use the same stream.
    streamEvents?: boolean;
    reasoningEvents?: boolean;
    clientSource?: string;
    clientPlatform?: string;
    ingressRequestId?: string;
    trajectorySessionId?: string;
    trajectoryInputs?: TrajectoryInputRef[];
    onBridgeAttempt?: CursorSdkBridgeRunInput["onBridgeAttempt"];
    signal?: AbortSignal;
  }
): Promise<CursorSdkCompletion> {
  if (!env.CURSOR_SDK_BRIDGE_URL?.trim()) {
    throw new HttpError("CURSOR_SDK_BRIDGE_URL is required for the local SDK Bridge.", 500, "cursor_sdk_bridge_missing");
  }
  const now = deps.now();
  pruneSessions(now.getTime());
  const sessionIdentity = await sdkSessionIdentity(apiKey, input.sessionKey || "default", input.sessionOwnerKey);
  const session = sdkSessions.get(sessionIdentity.id);
  const agentId = session?.agentId || newLocalSdkAgentId(deps.randomUUID());
  const runId = newLocalSdkRunId(deps.randomUUID());
  const updatedAt = deps.now();

  sdkSessions.set(sessionIdentity.id, { agentId, updatedAt: updatedAt.getTime() });

  const images = sdkImages(input.prompt.images);
  const incrementalImages = sdkImages(input.incrementalPrompt?.images);
  input.resumeToolResults?.forEach((result) => sdkImages(result.images));
  const agentContext = input.agentContext
    ? await sdkAgentContext(input.agentContext, input.prompt.text.length, input.systemPrompt)
    : undefined;
  const contextCheckpointHash = agentContext
    ? await sha256Hex(stableJson({
        bootstrapFingerprint: agentContext.bootstrapFingerprint,
        transcriptItemHashes: agentContext.transcriptItemHashes
      }))
    : undefined;
  const runInput = {
    agentId,
    runId,
    sessionKey: sessionIdentity.id,
    prompt: input.prompt.text,
    images,
    incrementalImages,
    systemPrompt: input.systemPrompt,
    modelId: input.model?.id || "composer-2.5",
    workingDirectory: input.workingDirectory,
    clientTools: input.clientTools,
    allowToolCall: input.allowToolCall,
    incrementalPrompt: input.incrementalPrompt?.text,
    resumeToolResults: input.resumeToolResults,
    supersedePendingRun: input.supersedePendingRun === true,
    supersedingTurnAborted: input.supersedingTurnAborted === true,
    supersededToolCallIds: input.supersededToolCallIds,
    fullReplayCause: input.fullReplayCause,
    agentContext,
    replayToolResultsOnMissingPending: input.replayToolResultsOnMissingPending,
    streamEvents: input.streamEvents === true,
    reasoningEvents: input.reasoningEvents === true,
    clientSource: input.clientSource,
    clientPlatform: input.clientPlatform,
    ingressRequestId: input.ingressRequestId,
    trajectorySessionId: input.trajectorySessionId,
    trajectoryInputs: input.trajectoryInputs?.map((entry) => ({
      ...entry,
      ...(contextCheckpointHash ? { contextCheckpointHash } : {})
    })),
    onBridgeAttempt: input.onBridgeAttempt,
    signal: input.signal
  };

  return {
    agentId,
    runId,
    sessionKey: sessionIdentity.id,
    stream: streamCursorLocalSdkBridgeRunWithRetry(env, deps, apiKey, runInput)
  };
}

export async function collectCursorSdkOutput(stream: AsyncIterable<CursorTextEvent>): Promise<CursorCollectedOutput> {
  let text = "";
  let toolCalls: CursorToolCall[] = [];
  let usage: CursorUsage | undefined;
  const reasoning: string[] = [];
  let reasoningText = "";
  let outputId: string | undefined;
  let outputType: "commentary" | "final" | undefined;
  let executionId: string | undefined;
  let runId: string | undefined;
  let agentId: string | undefined;
  for await (const event of stream) {
    if (event.type === "text" && event.text) text += event.text;
    if (event.type === "reasoning") {
      reasoningText += event.text;
      if (event.done) {
        if (reasoningText) reasoning.push(reasoningText);
        reasoningText = "";
      }
    }
    if (event.type === "tool_call") toolCalls.push(event.toolCall);
    if (event.type === "done") {
      text = event.finalText;
      toolCalls = event.toolCalls;
      usage = event.usage;
      outputId = event.outputId;
      outputType = event.outputType;
      executionId = event.executionId;
      runId = event.runId;
      agentId = event.agentId;
    }
  }
  if (reasoningText) reasoning.push(reasoningText);
  return {
    text,
    toolCalls,
    usage,
    ...(reasoning.length ? { reasoning } : {}),
    ...(outputId ? { outputId } : {}),
    ...(outputType ? { outputType } : {}),
    ...(executionId ? { executionId } : {}),
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {})
  };
}

async function* streamCursorLocalSdkBridgeRun(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: CursorSdkBridgeRunInput
): AsyncGenerator<CursorTextEvent> {
  if (input.streamEvents || input.reasoningEvents) {
    yield* streamCursorLocalSdkBridgeEvents(env, deps, apiKey, input);
    return;
  }

  const output = await cursorLocalSdkBridgeJson(env, deps, apiKey, input);
  yield* bridgeOutputEvents(output, input);
}

async function* streamCursorLocalSdkBridgeEvents(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: CursorSdkBridgeRunInput
): AsyncGenerator<CursorTextEvent> {
  const bridgeRequest = await cursorLocalSdkBridgeResponse(env, deps, apiKey, input, true);
  try {
    const { response, signal } = bridgeRequest;
    if (!response.ok) {
      await parseCursorLocalSdkBridgeJsonResponse(response, signal);
      return;
    }
    if ((response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      yield* bridgeOutputEvents(await parseCursorLocalSdkBridgeJsonResponse(response, signal), input);
      return;
    }

    let streamedText = "";
    let terminalOutput: CursorSdkBridgeOutput | undefined;
    for await (const raw of parseNdjson(response.body, signal)) {
      if (!isRecord(raw)) {
        throw new HttpError("Cursor SDK bridge returned an invalid stream event", 502, "cursor_sdk_bridge_invalid_json");
      }
      const event = raw as CursorSdkBridgeStreamEvent;
      if (terminalOutput) {
        const code = event.type === "done"
          ? "cursor_sdk_bridge_duplicate_done"
          : "cursor_sdk_bridge_event_after_done";
        throw new HttpError("Cursor SDK bridge emitted an event after done", 502, code);
      }
      if (event.type === "text") {
        if (typeof event.text !== "string") {
          throw new HttpError("Cursor SDK bridge returned an invalid text event", 502, "cursor_sdk_bridge_invalid_event");
        }
        const text = event.text;
        if (text) {
          streamedText += text;
          yield {
            type: "text",
            text,
            ...(typeof event.outputId === "string" ? { outputId: event.outputId } : {}),
            ...(typeof event.executionId === "string" ? { executionId: event.executionId } : {}),
            ...(typeof event.runId === "string" ? { runId: event.runId } : {}),
            ...(typeof event.agentId === "string" ? { agentId: event.agentId } : {})
          };
        }
        continue;
      }
      if (event.type === "reasoning") {
        if (typeof event.text !== "string" || typeof event.done !== "boolean") {
          throw new HttpError("Cursor SDK bridge returned an invalid reasoning event", 502, "cursor_sdk_bridge_invalid_event");
        }
        const thinkingDurationMs = event.thinkingDurationMs;
        if (
          thinkingDurationMs !== undefined
          && (typeof thinkingDurationMs !== "number" || !Number.isFinite(thinkingDurationMs) || thinkingDurationMs < 0)
        ) {
          throw new HttpError("Cursor SDK bridge returned an invalid reasoning duration", 502, "cursor_sdk_bridge_invalid_event");
        }
        yield {
          type: "reasoning",
          text: event.text,
          done: event.done,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {})
        };
        continue;
      }
      if (event.type === "error") {
        throw cursorSdkBridgeStreamError(event.error);
      }
      if (event.type === "done") {
        if (!isRecord(event.output)) {
          throw new HttpError("Cursor SDK bridge returned an invalid done event", 502, "cursor_sdk_bridge_invalid_event");
        }
        terminalOutput = cursorSdkBridgeOutputFromJson(event.output);
        continue;
      }
      throw new HttpError("Cursor SDK bridge returned an unknown stream event", 502, "cursor_sdk_bridge_unknown_event");
    }

    if (!terminalOutput) {
      throw new HttpError("Cursor SDK bridge stream ended before done", 502, "cursor_sdk_bridge_missing_done");
    }
    yield* bridgeOutputEvents(terminalOutput, input, streamedText.length > 0);
  } finally {
    await bridgeRequest.close();
  }
}

async function* bridgeOutputEvents(
  output: CursorSdkBridgeOutput,
  input: { allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision },
  textAlreadyStreamed = false
): AsyncGenerator<CursorTextEvent> {
  const text = typeof output.text === "string" ? output.text : "";
  const toolCalls: CursorToolCall[] = [];
  const rawToolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];

  if (text && !textAlreadyStreamed) yield {
    type: "text",
    text,
    ...(output.outputID ? { outputId: output.outputID } : {}),
    ...(output.executionID ? { executionId: output.executionID } : {}),
    ...(output.runID ? { runId: output.runID } : {}),
    ...(output.agentID ? { agentId: output.agentID } : {})
  };

  const candidates = rawToolCalls.flatMap((rawToolCall) => {
    if (!rawToolCall || typeof rawToolCall.name !== "string") return [];
    const toolCall = normalizeSdkToolCallForOpenCode({
      callId: rawToolCall.callId,
      name: rawToolCall.name,
      arguments: isRecord(rawToolCall.arguments) ? rawToolCall.arguments : {},
      trajectoryId: rawToolCall.trajectoryId,
      executionId: rawToolCall.executionId,
      runId: rawToolCall.runId,
      agentId: rawToolCall.agentId
    });
    return [{ toolCall, decision: input.allowToolCall?.(toolCall) ?? true }];
  });
  const rejectedIndex = candidates.findIndex(({ decision }) => decision !== true);
  if (rejectedIndex >= 0) {
    for (const { toolCall, decision } of candidates) {
      const reason = decision !== true
        ? typeof decision === "string" ? decision : undefined
        : "Another tool call in the same batch was rejected before execution.";
      yield { type: "rejected_tool_call", toolCall, reason };
    }
    yield bridgeDoneEvent(output, text, toolCalls);
    return;
  }

  for (const { toolCall } of candidates) {
    toolCalls.push(toolCall);
    yield { type: "tool_call", toolCall };
  }
  yield bridgeDoneEvent(output, text, toolCalls);
}

function bridgeDoneEvent(
  output: CursorSdkBridgeOutput,
  finalText: string,
  toolCalls: CursorToolCall[]
): Extract<CursorTextEvent, { type: "done" }> {
  return {
    type: "done",
    finalText,
    toolCalls,
    usage: output.usage,
    ...(output.outputID ? { outputId: output.outputID } : {}),
    ...(output.outputType ? { outputType: output.outputType } : {}),
    ...(output.executionID ? { executionId: output.executionID } : {}),
    ...(output.runID ? { runId: output.runID } : {}),
    ...(output.agentID ? { agentId: output.agentID } : {})
  };
}

async function* streamCursorLocalSdkBridgeRunWithRetry(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: CursorSdkBridgeRunInput
): AsyncGenerator<CursorTextEvent> {
  let attemptInput = input;
  let fallbackAttempts = 0;
  let transportAttempts = 0;
  let toolResultReplayAttempted = false;
  let outputCommitted = false;
  let publishedText = "";
  const toolCorrectionDeadline = Date.now() + cursorLocalSdkBridgeTimeoutMs(env);
  for (;;) {
    if (input.signal?.aborted) {
      await cancelCursorLocalSdkBridgeRun(env, deps, apiKey, attemptInput);
      input.signal.throwIfAborted();
    }
    attemptInput.onBridgeAttempt?.({
      requestId: attemptInput.runId,
      sdkSessionKey: attemptInput.sessionKey,
      replayCause: attemptInput.fullReplayCause,
      internalToolCorrection: attemptInput.internalToolCorrection === true,
      resumeToolResultsCount: attemptInput.resumeToolResults?.length ?? 0
    });
    const events: CursorTextEvent[] = [];
    try {
      for await (const event of streamCursorLocalSdkBridgeRun(env, deps, apiKey, attemptInput)) {
        events.push(event);
        if (input.streamEvents && (event.type === "text" || event.type === "reasoning")) {
          outputCommitted = true;
          if (event.type === "text") publishedText += event.text;
          yield event;
        }
      }
    } catch (error) {
      input.signal?.throwIfAborted();
      if (
        events.length === 0 &&
        !outputCommitted &&
        Boolean(attemptInput.resumeToolResults?.length) &&
        !attemptInput.supersedePendingRun &&
        input.replayToolResultsOnMissingPending === true &&
        !toolResultReplayAttempted &&
        isUnmatchedCursorSdkToolResultError(error)
      ) {
        toolResultReplayAttempted = true;
        console.warn(JSON.stringify({
          event: "sdk_unmatched_tool_results_full_replay_recovery",
          sessionKey: input.sessionKey,
          promptChars: input.prompt.length,
          resumeToolResultsCount: attemptInput.resumeToolResults?.length ?? 0
        }));
        attemptInput = {
          ...input,
          runId: newLocalSdkRunId(deps.randomUUID()),
          incrementalPrompt: undefined,
          resumeToolResults: undefined,
          fullReplayCause: "unmatched_tool_results"
        };
        continue;
      }
      if (
        events.length === 0 &&
        !outputCommitted &&
        !attemptInput.resumeToolResults?.length &&
        !attemptInput.supersedePendingRun &&
        transportAttempts < SDK_TOOL_RETRY_ATTEMPTS - 1 &&
        isTransientCursorSdkError(error)
      ) {
        transportAttempts += 1;
        attemptInput = {
          ...input,
          runId: newLocalSdkRunId(deps.randomUUID()),
          fullReplayCause: "transient_sdk_error"
        };
        continue;
      }
      throw error;
    }

    const outcome = classifyCursorSdkBridgeAttempt(events);
    if (outcome.kind === "rejected_tool_batch") {
      if (Date.now() >= toolCorrectionDeadline) {
        throw new HttpError(
          "Cursor SDK tool correction timed out.",
          504,
          "cursor_sdk_tool_correction_timeout"
        );
      }
      attemptInput = {
        ...input,
        runId: newLocalSdkRunId(deps.randomUUID()),
        supersedePendingRun: false,
        supersedingTurnAborted: false,
        supersededToolCallIds: [],
        internalToolCorrection: true,
        resumeToolResults: outcome.calls.map(({ toolCall, reason }) => ({
          callId: toolCall.callId,
          output: rejectedSdkToolResultMessage(toolCall, reason),
          isError: true
        }))
      };
      continue;
    }

    if (
      outcome.kind === "empty" &&
      !outputCommitted &&
      !attemptInput.resumeToolResults?.length &&
      !attemptInput.supersedePendingRun &&
      fallbackAttempts < SDK_TOOL_RETRY_ATTEMPTS - 1
    ) {
      fallbackAttempts += 1;
      console.warn(`Cursor SDK returned an empty turn; retrying with a fresh agent (${fallbackAttempts + 1}/${SDK_TOOL_RETRY_ATTEMPTS}).`);
      attemptInput = {
        ...input,
        runId: newLocalSdkRunId(deps.randomUUID()),
        incrementalPrompt: undefined,
        resumeToolResults: undefined,
        fullReplayCause: "empty_turn_recovery"
      };
      continue;
    }

    if (input.streamEvents) {
      for (const event of events) {
        if (event.type === "tool_call") yield event;
      }
      yield {
        ...outcome.terminal,
        finalText: publishedText || outcome.terminal.finalText
      };
    } else {
      for (const event of events) {
        if (event.type !== "done") yield event;
      }
      yield outcome.terminal;
    }
    return;
  }
}

type CursorSdkBridgeAttemptOutcome =
  | {
      kind: "accepted_tool_batch" | "empty" | "response";
      terminal: Extract<CursorTextEvent, { type: "done" }>;
    }
  | {
      kind: "rejected_tool_batch";
      terminal: Extract<CursorTextEvent, { type: "done" }>;
      calls: Array<{ toolCall: CursorToolCall; reason?: string }>;
    };

function classifyCursorSdkBridgeAttempt(events: CursorTextEvent[]): CursorSdkBridgeAttemptOutcome {
  const acceptedToolCalls = events.filter((event) => event.type === "tool_call");
  const rejectedToolCalls = events.flatMap((event) => event.type === "rejected_tool_call"
    ? [{ toolCall: event.toolCall, reason: event.reason }]
    : []);
  const terminal = events
    .slice()
    .reverse()
    .find((event): event is Extract<CursorTextEvent, { type: "done" }> => event.type === "done")
    ?? { type: "done", finalText: "", toolCalls: [] };

  if (acceptedToolCalls.length > 0 && rejectedToolCalls.length > 0) {
    throw new HttpError(
      "Cursor SDK bridge mixed accepted and rejected calls in one tool batch.",
      502,
      "cursor_sdk_tool_batch_invalid"
    );
  }
  if (acceptedToolCalls.length > 0) {
    return { kind: "accepted_tool_batch", terminal };
  }
  if (rejectedToolCalls.length > 0) {
    return { kind: "rejected_tool_batch", terminal, calls: rejectedToolCalls };
  }
  if (isEmptyCursorSdkTurn([...events.filter((event) => event.type !== "done"), terminal])) {
    return { kind: "empty", terminal };
  }
  return { kind: "response", terminal };
}

function rejectedSdkToolResultMessage(toolCall: CursorToolCall, reason?: string): string {
  const detail = reason?.trim() || "the generated arguments did not satisfy the client tool schema";
  return [
    `Tool call ${toolCall.name} was rejected: ${detail}`,
    "Correct the arguments and call an allowed tool again."
  ].join(" ");
}

async function cursorLocalSdkBridgeJson(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    images?: CursorImage[];
    incrementalImages?: CursorImage[];
    systemPrompt?: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    incrementalPrompt?: string;
    resumeToolResults?: CursorSdkToolResult[];
    supersedePendingRun?: boolean;
    supersedingTurnAborted?: boolean;
    supersededToolCallIds?: string[];
    fullReplayCause?: string;
    agentContext?: CursorSdkAgentContext;
    internalToolCorrection?: boolean;
    streamEvents?: boolean;
    reasoningEvents?: boolean;
    clientSource?: string;
    clientPlatform?: string;
    ingressRequestId?: string;
    trajectorySessionId?: string;
    trajectoryInputs?: TrajectoryInputRef[];
    signal?: AbortSignal;
  }
): Promise<CursorSdkBridgeOutput> {
  const bridgeRequest = await cursorLocalSdkBridgeResponse(env, deps, apiKey, input, false);
  try {
    return await parseCursorLocalSdkBridgeJsonResponse(bridgeRequest.response, bridgeRequest.signal);
  } finally {
    await bridgeRequest.close();
  }
}

async function cursorLocalSdkBridgeResponse(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    images?: CursorImage[];
    incrementalImages?: CursorImage[];
    systemPrompt?: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    incrementalPrompt?: string;
    resumeToolResults?: CursorSdkToolResult[];
    supersedePendingRun?: boolean;
    supersedingTurnAborted?: boolean;
    supersededToolCallIds?: string[];
    fullReplayCause?: string;
    agentContext?: CursorSdkAgentContext;
    internalToolCorrection?: boolean;
    streamEvents?: boolean;
    reasoningEvents?: boolean;
    clientSource?: string;
    clientPlatform?: string;
    ingressRequestId?: string;
    trajectorySessionId?: string;
    trajectoryInputs?: TrajectoryInputRef[];
    signal?: AbortSignal;
  },
  streamEvents: boolean
): Promise<CursorSdkBridgeResponse> {
  const resuming = Boolean(input.resumeToolResults?.length) && input.supersedePendingRun !== true;
  const body = JSON.stringify({
    apiKey,
    requestId: input.runId,
    model: input.modelId,
    systemPrompt: input.systemPrompt,
    sessionKey: input.sessionKey || input.agentId,
    workingDirectory: sdkWorkingDirectory(input.workingDirectory),
    ...(resuming
      ? input.agentContext
        ? {
            prompt: input.prompt,
            promptAlreadyPrepared: true,
            tools: bridgeClientTools(input.clientTools)
          }
        : {}
      : {
          prompt: input.prompt,
          promptAlreadyPrepared: true,
          incrementalPrompt: input.incrementalPrompt,
          tools: bridgeClientTools(input.clientTools)
        }),
    images: input.images,
    incrementalImages: input.incrementalImages,
    resumeToolResults: input.resumeToolResults,
    fullReplayCause: input.fullReplayCause,
    agentContext: input.agentContext,
    ingressRequestId: input.ingressRequestId,
    trajectorySessionId: input.trajectorySessionId,
    trajectoryInputs: input.trajectoryInputs,
    ...(input.internalToolCorrection ? { internalToolCorrection: true } : {}),
    ...(input.supersedePendingRun ? {
      supersedePendingRun: true,
      supersedingTurnAborted: input.supersedingTurnAborted === true,
      supersededToolCallIds: input.supersededToolCallIds
    } : {}),
    ...(streamEvents ? { streamEvents: true } : {}),
    ...(input.reasoningEvents ? { emitReasoning: true } : {}),
    ...(input.clientSource ? { clientSource: input.clientSource } : {}),
    ...(input.clientPlatform ? { clientPlatform: input.clientPlatform } : {})
  });
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  const deadline = cursorLocalSdkBridgeDeadline(env, input.signal);
  let response: Response | undefined;
  try {
    deadline.signal.throwIfAborted();
    if (!bridgeUrl) throw new HttpError("CURSOR_SDK_BRIDGE_URL is required for the local SDK Bridge.", 500, "cursor_sdk_bridge_missing");
    response = await cursorLocalSdkUrlBridge(env, deps, bridgeUrl, body, deadline.signal);
  } catch (error) {
    if (deadline.signal.aborted) {
      await cancelCursorLocalSdkBridgeRun(env, deps, apiKey, input);
    }
    deadline.close();
    deadline.signal.throwIfAborted();
    throw error;
  }
  if (!response) {
    deadline.close();
    throw new HttpError("Cursor SDK bridge is not configured", 500, "cursor_sdk_bridge_missing");
  }
  return {
    response,
    signal: deadline.signal,
    close: async () => {
      if (deadline.signal.aborted) {
        await cancelCursorLocalSdkBridgeRun(env, deps, apiKey, input);
      }
      deadline.close();
    }
  };
}

async function cancelCursorLocalSdkBridgeRun(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: CursorSdkBridgeRunInput
): Promise<void> {
  const body = JSON.stringify({
    requestId: input.runId,
    apiKey,
    model: input.modelId,
    sessionKey: input.sessionKey || input.agentId,
    workingDirectory: sdkWorkingDirectory(input.workingDirectory),
    pendingToolCallIds: input.supersedePendingRun || input.internalToolCorrection
      ? []
      : (input.resumeToolResults ?? []).map((result) => result.callId)
  });
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  let response: Response | undefined;
  try {
    if (bridgeUrl) {
      response = await deps.fetch(`${bridgeUrl.replace(/\/$/, "")}/cancel`, {
        method: "POST",
        headers: cursorLocalSdkBridgeHeaders(env),
        body,
        signal: AbortSignal.timeout(5_000)
      });
    }
    if (response && !response.ok) throw new Error(`Bridge cancellation returned HTTP ${response.status}`);
  } catch {
    console.warn(JSON.stringify({ event: "sdk_bridge_cancel_failed", requestId: input.runId, sessionKey: input.sessionKey }));
  } finally {
    if (response?.body) await response.body.cancel().catch(() => undefined);
  }
}

async function cursorLocalSdkUrlBridge(env: Env, deps: Deps, bridgeUrl: string, body: string, signal?: AbortSignal): Promise<Response> {
  return deps.fetch(bridgeUrl, {
    method: "POST",
    headers: cursorLocalSdkBridgeHeaders(env),
    body,
    signal
  });
}

function cursorLocalSdkBridgeDeadline(
  env: Env,
  externalSignal?: AbortSignal
): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const timeoutMs = cursorLocalSdkBridgeTimeoutMs(env);
  const abortFromExternal = () => {
    const reason = externalSignal?.reason ?? new DOMException("The operation was aborted", "AbortError");
    controller.abort(reason);
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new HttpError("Cursor SDK bridge request timed out.", 504, "cursor_sdk_bridge_timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    }
  };
}

function cursorLocalSdkBridgeTimeoutMs(env: Env): number {
  const value = Number.parseInt(env.CURSOR_SDK_BRIDGE_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS;
}

async function parseCursorLocalSdkBridgeJsonResponse(
  response: Response,
  signal?: AbortSignal
): Promise<CursorSdkBridgeOutput> {
  const text = await readBridgeResponseText(response.body, signal);
  let object: unknown;
  if (text.trim()) {
    try {
      object = JSON.parse(text);
    } catch {
      throw new HttpError("Cursor SDK bridge returned invalid JSON", 502, "cursor_sdk_bridge_invalid_json");
    }
  } else {
    object = {};
  }
  if (!response.ok) {
    const error = isRecord(object) && isRecord(object.error) ? object.error : undefined;
    const message = typeof error?.message === "string" && error.message
      ? error.message
      : `Cursor SDK bridge failed with status ${response.status}`;
    const code = typeof error?.code === "string" && error.code ? error.code : "cursor_sdk_bridge_error";
    if (code === "cursor_sdk_context_compacted") {
      throw new CursorSdkContextOverflowError(message, error?.contextRetrySafe === true);
    }
    const status = response.status === 401
      ? 502
      : response.status === 409 || response.status === 429
        ? response.status
        : response.status >= 500 ? 502 : 400;
    throw new HttpError(message, status, code);
  }
  if (!isRecord(object)) {
    throw new HttpError("Cursor SDK bridge returned invalid JSON", 502, "cursor_sdk_bridge_invalid_json");
  }
  return cursorSdkBridgeOutputFromJson(object);
}

function cursorSdkBridgeOutputFromJson(value: unknown): CursorSdkBridgeOutput {
  if (!isRecord(value)) return {};
  return {
    text: typeof value.text === "string" ? value.text : "",
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.flatMap(cursorToolCallFromJson) : [],
    agentID: typeof value.agentID === "string" ? value.agentID : undefined,
    runID: typeof value.runID === "string" ? value.runID : undefined,
    executionID: typeof value.executionID === "string" ? value.executionID : undefined,
    outputID: typeof value.outputID === "string" ? value.outputID : undefined,
    outputType: value.outputType === "commentary" || value.outputType === "final" ? value.outputType : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    usage: cursorUsageFromJson(value.usage)
  };
}

function cursorSdkBridgeStreamError(value: unknown): HttpError {
  const error = isRecord(value) ? value : {};
  const message = typeof error.message === "string" && error.message
    ? error.message
    : "Cursor SDK bridge stream failed";
  const code = typeof error.code === "string" && error.code ? error.code : "cursor_sdk_bridge_error";
  const rawStatus = Number(error.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 502;
  if (code === "cursor_sdk_context_compacted") {
    return new CursorSdkContextOverflowError(message, error.contextRetrySafe === true);
  }
  return new HttpError(message, status, code);
}

async function* parseNdjson(
  stream: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): AsyncGenerator<unknown> {
  if (!stream) throw new HttpError("Cursor SDK bridge returned no event stream", 502, "cursor_sdk_bridge_invalid_stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw new HttpError("Cursor SDK bridge returned invalid NDJSON", 502, "cursor_sdk_bridge_invalid_json");
    }
  };
  for await (const chunk of readBridgeResponseChunks(stream, signal)) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield parseLine(line);
    }
  }
  buffer += decoder.decode();
  const line = buffer.trim();
  if (line) yield parseLine(line);
}

async function readBridgeResponseText(
  stream: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of readBridgeResponseChunks(stream, signal)) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function* readBridgeResponseChunks(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  signal?.throwIfAborted();
  const reader = stream.getReader();
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel(signal?.reason).catch(() => undefined);
    return cancellation;
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
      signal?.throwIfAborted();
      if (result.done) return;
      if (result.value) yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await cancel();
    reader.releaseLock();
  }
}

function cursorUsageFromJson(value: unknown): CursorUsage | undefined {
  if (!isRecord(value)) return undefined;
  const read = (key: string): number | undefined => {
    const number = value[key];
    return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const inputTokens = read("inputTokens");
  const outputTokens = read("outputTokens");
  const cacheReadTokens = read("cacheReadTokens");
  const cacheWriteTokens = read("cacheWriteTokens");
  const totalTokens = read("totalTokens");
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens].some((item) => item === undefined)) {
    return undefined;
  }
  const reasoningTokens = read("reasoningTokens");
  return {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    cacheReadTokens: cacheReadTokens!,
    cacheWriteTokens: cacheWriteTokens!,
    totalTokens: totalTokens!,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  };
}

function cursorToolCallFromJson(value: unknown): CursorToolCall[] {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return [];
  return [{
    ...(typeof value.callId === "string" && value.callId ? { callId: value.callId } : {}),
    name: value.name.trim(),
    arguments: isRecord(value.arguments) ? value.arguments : {},
    ...(typeof value.trajectoryId === "string" ? { trajectoryId: value.trajectoryId } : {}),
    ...(typeof value.executionId === "string" ? { executionId: value.executionId } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {})
  }];
}

function bridgeClientTools(tools: ClientToolSpec[] | undefined): ClientToolSpec[] {
  return (tools ?? []).flatMap((tool) => {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) return [];
    return [{
      name,
      ...(typeof tool.description === "string" && tool.description ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
    }];
  });
}

function cursorLocalSdkBridgeHeaders(env: Env): Headers {
  const headers = new Headers({
    "Content-Type": "application/json"
  });
  if (env.CURSOR_SDK_BRIDGE_TOKEN?.trim()) {
    headers.set("Authorization", `Bearer ${env.CURSOR_SDK_BRIDGE_TOKEN.trim()}`);
  }
  return headers;
}

function sdkWorkingDirectory(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "undefined" || trimmed.toLowerCase() === "null") return ".";
  return trimmed;
}

function normalizeSdkToolCallForOpenCode(toolCall: CursorToolCall): CursorToolCall {
  if (toolCall.name.toLowerCase() !== "edit") return toolCall;
  const path = stringArg(toolCall.arguments, "path");
  const streamContent = stringArgAllowEmpty(toolCall.arguments, "streamContent", "stream_content");
  if (!path || streamContent === undefined) return toolCall;
  return {
    ...(toolCall.callId ? { callId: toolCall.callId } : {}),
    name: "write",
    arguments: {
      path,
      fileText: streamContent
    },
    ...(toolCall.trajectoryId ? { trajectoryId: toolCall.trajectoryId } : {}),
    ...(toolCall.executionId ? { executionId: toolCall.executionId } : {}),
    ...(toolCall.runId ? { runId: toolCall.runId } : {}),
    ...(toolCall.agentId ? { agentId: toolCall.agentId } : {})
  };
}

function stringArgAllowEmpty(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function sdkImages(images?: CursorImage[]): CursorImage[] | undefined {
  if (images?.some((image) => "url" in image)) {
    throw new HttpError("Local Cursor SDK image inputs require a base64 data URL; remote image URLs are unsupported.", 400, "unsupported_parameter", "image_url");
  }
  return images;
}

async function sdkAgentContext(
  source: ResponsesAgentContextSource,
  promptTextChars: number,
  systemPrompt?: string
): Promise<CursorSdkAgentContext> {
  if (
    source.promptTextChars !== promptTextChars
    || source.transcriptEndOffset < source.bootstrap.length
    || source.transcriptEndOffset > promptTextChars
    || source.transcriptItems.some((item, index) => (
      !Number.isSafeInteger(item.offset)
      || item.offset < source.bootstrap.length
      || item.offset > source.transcriptEndOffset
      || (index > 0 && item.offset <= source.transcriptItems[index - 1].offset)
      || !Number.isSafeInteger(item.imageCount)
      || item.imageCount < 0
    ))
  ) {
    throw new HttpError("Invalid Responses Agent context metadata.", 500, "cursor_sdk_agent_context_invalid");
  }
  return {
    bootstrapFingerprint: await sha256Hex(systemPrompt === undefined
      ? source.bootstrap
      : stableJson({ bootstrap: source.bootstrap, systemPrompt })),
    transcriptItemHashes: await Promise.all(
      source.transcriptItems.map((item) => sha256Hex(stableJson(item.value)))
    ),
    transcriptItemOffsets: source.transcriptItems.map((item) => item.offset),
    transcriptItemImageCounts: source.transcriptItems.map((item) => item.imageCount),
    transcriptEndOffset: source.transcriptEndOffset,
    promptTextChars
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

async function sdkSessionIdentity(
  apiKey: string,
  sessionKey: string,
  sessionOwnerKey?: string
): Promise<{ id: string; ownerHash: string; sessionHash: string }> {
  const ownerHash = await sha256Hex(sessionOwnerKey || `cursor-key:${await sha256Hex(apiKey)}`);
  const sessionHash = await sha256Hex(sessionKey);
  return {
    id: await sha256Hex(`${ownerHash}\n${sessionHash}`),
    ownerHash,
    sessionHash
  };
}

function pruneSessions(now: number) {
  for (const [key, session] of sdkSessions) {
    if (session.updatedAt + SDK_SESSION_TTL_MS < now) sdkSessions.delete(key);
  }
}

function newLocalSdkAgentId(uuid: string): string {
  return uuid.startsWith("agent-") ? uuid : `agent-${uuid}`;
}

function newLocalSdkRunId(uuid: string): string {
  return uuid.startsWith("run-") ? uuid : `run-${uuid}`;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
