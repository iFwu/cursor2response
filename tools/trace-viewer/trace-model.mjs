const MAX_CONTENT_CHARS = 128 * 1024;

const TRAJECTORY_EVENTS = new Set([
  "trajectory_agent_transition",
  "trajectory_context_checkpoint",
  "trajectory_context_decision",
  "trajectory_error",
  "trajectory_execution_attached",
  "trajectory_execution_started",
  "trajectory_execution_terminal",
  "trajectory_input_accepted",
  "trajectory_input_content_chunk",
  "trajectory_output_content_chunk",
  "trajectory_output_published",
  "trajectory_replay",
  "trajectory_route_decision",
  "trajectory_request"
]);

const CONTENT_EVENTS = new Set([
  "trajectory_input_content_chunk",
  "trajectory_output_content_chunk"
]);

const STRING_FIELDS = new Set([
  "acceptedAt", "acceptedBy", "agentId", "attachmentKind", "callId", "checkpointHash",
  "checkpointState", "clientPlatform", "clientSource", "contentKind", "contentSha256", "decision",
  "decisionCause", "divergenceKind", "divergedItemPreview", "errorCode", "eventId",
  "executionId", "fromAgentId", "ingressRequestId",
  "inputId", "knownItemPreview", "logicalRequestId", "outputId", "outputType", "parentRequestId", "phase", "promptSha256",
  "promptMode", "publicationKind", "publishedAt", "replayCause", "replayKind",
  "requestId", "requestKind", "requestPurpose", "responseId", "runId", "sdkSessionKey", "serviceInvocationId",
  "sessionKey", "sessionSource", "source", "status", "toolName", "toAgentId", "transcriptSha256", "transitionCause", "transitionKind",
  "route", "routeCause", "logicalModel", "upstreamModel", "fallbackBlockedReason"
]);
const NUMBER_FIELDS = new Set([
  "attemptIndex", "chunkCount", "chunkIndex", "clientTranscriptItemCount", "contentChars",
  "contextItemCount", "divergedCharOffset", "divergedItemIndex", "durationMs",
  "inputCount", "itemIndex", "knownTranscriptItemCount", "observedChars", "promptChars",
  "sentPromptChars", "totalChars", "totalItemCount",
  "replayedTranscriptItemCount", "toolResultCount", "transcriptItemCount", "userInputCount",
  "inputTokens", "outputTokens", "cachedInputTokens", "upstreamStatus"
]);
const BOOLEAN_FIELDS = new Set(["isError", "provisional", "retryable", "terminal", "truncated",
  "routeStickyHit", "outputPublished", "contextRetrySafe", "fallbackAttempted"]);
const ARRAY_FIELDS = new Set(["addedSemanticIds", "inputHashes", "inputIds"]);

// shortcut: backfill bounded journals emitted before requestPurpose existed;
// remove once the viewer's maximum journal window can no longer contain them.
const OPENCLAW_COMPACTION_INPUT_PREFIX = "<conversation>\n";
const OPENCLAW_COMPACTION_PROMPT_MARKERS = [
  "\n</conversation>\n\nThe messages above are a conversation to summarize.",
  "\n</conversation>\n\nThe messages above are NEW conversation messages to incorporate into the existing summary",
  "\n</conversation>\n\nThis is the PREFIX of a turn that was too large to keep."
];

export const TRAJECTORY_PRIORITY = Object.freeze({
  user_input: 0,
  turn_aborted: 0,
  final_output: 1,
  error: 2,
  agent_transition: 2,
  recovery: 2,
  replay: 3,
  retry: 3,
  context_decision: 3,
  commentary: 4,
  harness_context: 4,
  tool_call: 5,
  tool_result: 5,
  metadata: 6,
  checkpoint: 7
});

// Display-only decomposition of accepted user Inputs into Harness context and
// real user text. Wrappers are matched exactly against what each client is
// known to emit; anything unrecognized stays a user input (fail open). The
// Input fact itself (inputId, occurrence, hashes) is never altered.
const OPENCLAW_TIMESTAMP_PREFIX = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
// Sentinels mirror OpenClaw's strip-inbound-meta.ts; blocks are always a
// sentinel line followed by one fenced ```json object.
const OPENCLAW_META_SENTINELS = new Set([
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Reply target of current user message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):"
]);
const OPENCLAW_RUNTIME_HEADERS = new Set([
  "OpenClaw runtime context for the immediately preceding user message.",
  "OpenClaw runtime event.",
  "This context is runtime-generated, not user-authored. Keep internal details private."
]);
const OPENCLAW_CONTEXT_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const OPENCLAW_CONTEXT_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

function isCodexHarnessItem(text) {
  let trimmed = text.trim();
  // Codex may send environment_context standalone or appended to the AGENTS item.
  if (trimmed.endsWith("</environment_context>")) {
    const start = trimmed.lastIndexOf("<environment_context>");
    if (start < 0) return false;
    trimmed = trimmed.slice(0, start).trim();
    if (!trimmed) return true;
  }
  return trimmed.startsWith("# AGENTS.md instructions for ") && trimmed.endsWith("</INSTRUCTIONS>");
}

// OpenClaw escapes the delimiters inside user-authored text, so raw delimiter
// lines are trustworthy. The whole item is Harness only when nothing but the
// fixed runtime headers remains outside the delimited blocks.
function isOpenclawRuntimeContextItem(text) {
  const lines = text.split("\n").map((line) => line.trim());
  if (!lines.includes(OPENCLAW_CONTEXT_BEGIN)) return false;
  let inBlock = false;
  for (const line of lines) {
    if (line === OPENCLAW_CONTEXT_BEGIN) {
      if (inBlock) return false;
      inBlock = true;
    } else if (line === OPENCLAW_CONTEXT_END) {
      if (!inBlock) return false;
      inBlock = false;
    } else if (!inBlock && line && !OPENCLAW_RUNTIME_HEADERS.has(line)) {
      return false;
    }
  }
  return !inBlock;
}

function splitOpenclawInboundEnvelope(text) {
  const lines = text.split("\n");
  const firstLine = (lines[0] ?? "").replace(OPENCLAW_TIMESTAMP_PREFIX, "");
  if (!OPENCLAW_META_SENTINELS.has(firstLine.trim())) return null;
  let index = 0;
  let consumed = 0;
  while (index < lines.length) {
    const sentinel = index === 0 ? firstLine : lines[index];
    if (!OPENCLAW_META_SENTINELS.has(sentinel.trim())) break;
    if ((lines[index + 1] ?? "").trim() !== "```json") return null;
    index += 2;
    while (index < lines.length && lines[index].trim() !== "```") index += 1;
    if (index >= lines.length) return null;
    index += 1;
    consumed += 1;
    while (index < lines.length && lines[index].trim() === "") index += 1;
  }
  if (!consumed) return null;
  return {
    harness: lines.slice(0, index).join("\n").trimEnd(),
    user: lines.slice(index).join("\n")
  };
}

function splitHarnessContent(content, clientSources) {
  // Codex traffic can arrive through a gateway that rewrites the user agent,
  // so its highly distinctive wrappers remain display-safe under unknown or
  // Superconductor source labels.
  const maybeCodex = clientSources.length === 0
    || clientSources.includes("codex")
    || clientSources.includes("superconductor")
    || clientSources.includes("unknown");
  if (maybeCodex && isCodexHarnessItem(content)) {
    return { harness: content, user: null };
  }
  if (clientSources.includes("openclaw")) {
    if (isOpenclawRuntimeContextItem(content)) return { harness: content, user: null };
    const envelope = splitOpenclawInboundEnvelope(content);
    if (envelope) return envelope.user.trim() ? envelope : { harness: content, user: null };
  }
  return null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value, max = 240) {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e15 ? value / 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || !value) return null;
  if (/^\d{13,16}$/.test(value)) return normalizeTimestamp(Number(value));
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function safeModel(value) {
  if (typeof value === "string" && value.length <= 160) return { id: value };
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length > 160) return null;
  const params = Array.isArray(value.params)
    ? value.params.flatMap((param) => {
        if (!isRecord(param)) return [];
        const id = safeString(param.id, 80);
        const paramValue = safeString(param.value, 120);
        return id && paramValue ? [{ id, value: paramValue }] : [];
      })
    : [];
  return params.length ? { id: value.id, params } : { id: value.id };
}

function modelKey(model) {
  if (!model) return "unknown";
  const params = model.params?.map((param) => `${param.id}=${param.value}`).join(",") ?? "";
  return params ? `${model.id}[${params}]` : model.id;
}

function unwrapRecord(value, index, diagnostics) {
  if (!isRecord(value)) return [];
  if (typeof value.MESSAGE === "string") {
    try {
      const message = JSON.parse(value.MESSAGE);
      return unwrapRecord({
        ...message,
        invocationId: message.invocationId ?? value._SYSTEMD_INVOCATION_ID,
        unit: message.unit ?? value.service ?? value._SYSTEMD_USER_UNIT,
        timestamp: message.timestamp ?? value.__REALTIME_TIMESTAMP
      }, index, diagnostics);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value.events) && value.schemaVersion === 3) {
    return value.events.flatMap((event, childIndex) => normalizeRecord(event, {
      index: index + childIndex / Math.max(1, value.events.length),
      invocationId: value.invocationId,
      unit: value.unit,
      timestamp: value.timestamp
    }, diagnostics) ?? []);
  }
  const record = normalizeRecord(value, { index }, diagnostics);
  return record ? [record] : [];
}

function normalizeRecord(raw, envelope, diagnostics) {
  if (
    !isRecord(raw)
    || raw.trajectorySchemaVersion !== 1
    || !TRAJECTORY_EVENTS.has(raw.event)
    || typeof raw.eventId !== "string"
    || !raw.eventId
    || typeof raw.serviceInvocationId !== "string"
    || !raw.serviceInvocationId
  ) return null;
  const fields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || ["event", "model", "trajectorySchemaVersion", "wallTime", "timestamp", "time", "unit", "invocationId"].includes(key)) continue;
    if (key === "content" && CONTENT_EVENTS.has(raw.event)) {
      if (typeof value === "string" && value.length <= MAX_CONTENT_CHARS) fields.content = value;
      else diagnostics.strippedFields += 1;
      continue;
    }
    if (STRING_FIELDS.has(key)) {
      const text = safeString(value);
      if (text !== undefined) fields[key] = text;
      else diagnostics.strippedFields += 1;
      continue;
    }
    if (NUMBER_FIELDS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) fields[key] = value;
      else diagnostics.strippedFields += 1;
      continue;
    }
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value === "boolean") fields[key] = value;
      else diagnostics.strippedFields += 1;
      continue;
    }
    if (ARRAY_FIELDS.has(key)) {
      if (Array.isArray(value)) fields[key] = value.filter((entry) => typeof entry === "string" && entry.length <= 240).slice(0, 500);
      else diagnostics.strippedFields += 1;
      continue;
    }
    diagnostics.strippedFields += 1;
  }
  if (typeof fields.sessionKey !== "string" || fields.sessionKey.includes("…")) return null;
  const model = safeModel(raw.model);
  if (raw.model !== undefined && !model) diagnostics.strippedFields += 1;
  const timestamp = normalizeTimestamp(raw.wallTime ?? raw.timestamp ?? raw.time ?? fields.acceptedAt ?? fields.publishedAt ?? envelope.timestamp);
  return {
    id: fields.eventId ?? "",
    index: envelope.index,
    event: raw.event,
    timestamp,
    timestampMs: timestamp ? Date.parse(timestamp) : null,
    offsetMs: null,
    invocationId: fields.serviceInvocationId ?? safeString(raw.invocationId ?? envelope.invocationId, 160) ?? "unknown-invocation",
    unit: safeString(raw.unit ?? envelope.unit, 160) ?? "unknown-unit",
    model,
    modelKey: modelKey(model),
    laneId: "transport",
    severity: "normal",
    fields
  };
}

function eventOrder(left, right) {
  if (left.timestampMs !== null && right.timestampMs !== null) return left.timestampMs - right.timestampMs || left.index - right.index;
  if (left.timestampMs !== null) return -1;
  if (right.timestampMs !== null) return 1;
  return left.index - right.index;
}

function classifyEvent(event) {
  if (isCancellationError(event)) return "notice";
  if (event.event === "trajectory_error") return "error";
  if (event.event === "trajectory_execution_terminal") {
    if (["failed", "error"].includes(event.fields.status)) return "error";
    if (event.fields.status === "cancelled") return "warning";
  }
  if (event.event === "trajectory_input_content_chunk" && event.fields.isError === true) return "error";
  if (event.event === "trajectory_agent_transition") {
    if (event.fields.transitionKind === "replaced") return "warning";
    if (event.fields.transitionKind === "resumed") return "notice";
  }
  if (event.event === "trajectory_replay") {
    // client_transcript is stateless-protocol bookkeeping: the client resends
    // its history on every request and the Bridge matches it without feeding
    // anything back to the SDK. Only an actual SDK-layer replay is notable.
    if (event.fields.replayKind === "sdk_context") return "warning";
    if (event.fields.replayKind === "client_transcript") return "normal";
    return "notice";
  }
  if (event.fields.provisional === true) return "notice";
  return "normal";
}

const COMPACTION_ERROR_CODES = new Set([
  "cursor_sdk_context_compacted",
  "context_length_exceeded"
]);
const CANCELLATION_ERROR_CODES = new Set([
  "cursor_sdk_cancelled",
  "client_disconnect"
]);
const COMPACTION_REPLAY_CAUSE = "agent_state_dirty";
const SUCCESS_TERMINAL_STATUSES = new Set(["finished", "completed", "succeeded"]);

function isCompactionError(event) {
  return event.event === "trajectory_error" && COMPACTION_ERROR_CODES.has(event.fields.errorCode);
}

function isCancellationError(event) {
  return event.event === "trajectory_error" && CANCELLATION_ERROR_CODES.has(event.fields.errorCode);
}

// Compaction is an SDK boundary failure, followed by an intentional Agent
// replacement and full replay. Once the replacement finishes successfully,
// those raw observations describe one recovered operation rather than an
// unresolved session issue. This is derived in the viewer because the
// input contract records accepted content, not SDK context-window state.
function buildCompactionRecoveries(events) {
  const marked = new Set();
  const recoveries = [];

  for (const error of events.filter(isCompactionError)) {
    if (!error.fields.agentId || !error.fields.requestId) continue;
    const errorIndex = events.indexOf(error);
    const transitionIndex = events.findIndex((candidate, index) => (
      index > errorIndex
      && candidate.event === "trajectory_agent_transition"
      && candidate.fields.transitionKind === "replaced"
      && candidate.fields.fromAgentId === error.fields.agentId
      && candidate.fields.requestId
    ));
    if (transitionIndex < 0) continue;
    const transition = events[transitionIndex];
    const replacementEvents = events.filter((event, index) => index > transitionIndex && (
      event.fields.requestId === transition.fields.requestId
      && event.fields.agentId === transition.fields.toAgentId
    ));
    const replay = replacementEvents.find((event) => (
      (event.event === "trajectory_context_decision"
        && event.fields.decision === "start_full"
        && event.fields.decisionCause === COMPACTION_REPLAY_CAUSE)
      || (event.event === "trajectory_replay"
        && event.fields.replayKind === "sdk_context"
        && event.fields.replayCause === COMPACTION_REPLAY_CAUSE)
    ));
    const replayIndex = replacementEvents.indexOf(replay);
    const terminal = replacementEvents.find((event, index) => index > replayIndex && (
      event.event === "trajectory_execution_terminal" && SUCCESS_TERMINAL_STATUSES.has(event.fields.status)
    ));
    if (!replay || !terminal) continue;

    marked.add(error.id);
    for (const event of events) {
      if (isCompactionError(event) && event.fields.requestId === error.fields.requestId) marked.add(event.id);
      if (event.event === "trajectory_execution_terminal"
        && event.fields.requestId === error.fields.requestId
        && event.fields.executionId === error.fields.executionId) marked.add(event.id);
      if (replacementEvents.includes(event)) marked.add(event.id);
    }
    marked.add(transition.id);
    marked.add(replay.id);
    marked.add(terminal.id);
    recoveries.push({
      kind: "context_compaction",
      state: "recovered",
      requestId: error.fields.requestId ?? null,
      fromAgentId: error.fields.agentId,
      toAgentId: transition.fields.toAgentId,
      sourceEventIds: [error, transition, replay, terminal].map((event) => event.id)
    });
  }

  for (const event of events) {
    if (!marked.has(event.id)) continue;
    event.recoveryKind = "context_compaction";
    event.severity = "normal";
  }
  return recoveries;
}

function assignLanes(events) {
  const executionAgents = new Map();
  const requestAgents = new Map();
  const inputAgents = new Map();
  for (const event of events) {
    const resolved = event.fields.agentId ?? event.fields.toAgentId;
    if (event.fields.executionId && resolved) executionAgents.set(event.fields.executionId, resolved);
    if (event.fields.requestId && resolved) requestAgents.set(event.fields.requestId, resolved);
    if (event.event === "trajectory_input_accepted" && event.fields.inputId && resolved) inputAgents.set(event.fields.inputId, resolved);
  }
  for (const event of events) {
    const agentId = event.fields.agentId
      ?? event.fields.toAgentId
      ?? executionAgents.get(event.fields.executionId)
      ?? requestAgents.get(event.fields.requestId)
      ?? inputAgents.get(event.fields.inputId);
    event.laneId = agentId ? `agent:${agentId}` : "transport";
    event.severity = classifyEvent(event);
  }
}

function chunkGroups(events, idField, eventName) {
  const groups = new Map();
  for (const event of events) {
    if (event.event !== eventName || typeof event.fields[idField] !== "string") continue;
    const key = event.fields[idField];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return new Map([...groups.entries()].map(([key, sourceEvents]) => {
    sourceEvents.sort(eventOrder);
    const byChunk = new Map();
    for (const event of sourceEvents) {
      const chunkIndex = event.fields.chunkIndex ?? 0;
      if (!byChunk.has(chunkIndex)) byChunk.set(chunkIndex, event);
    }
    const chunks = [...byChunk.values()].sort((left, right) => (left.fields.chunkIndex ?? 0) - (right.fields.chunkIndex ?? 0));
    return [key, { content: chunks.map((event) => event.fields.content ?? "").join(""), sourceEvents }];
  }));
}

function projectionBase(kind, event, sourceEvents) {
  return {
    id: `projection-${kind}-${event.id}`,
    kind,
    priority: TRAJECTORY_PRIORITY[kind],
    title: kind.replaceAll("_", " "),
    content: null,
    timestamp: event.timestamp,
    timestampMs: event.timestampMs,
    laneId: event.laneId,
    agentId: event.laneId.startsWith("agent:") ? event.laneId.slice(6) : null,
    requestId: event.fields.requestId ?? null,
    requestKind: event.fields.requestKind ?? null,
    requestPurpose: event.fields.requestPurpose ?? null,
    sessionSource: event.fields.sessionSource ?? null,
    ingressRequestId: event.fields.ingressRequestId ?? null,
    executionId: event.fields.executionId ?? null,
    runId: event.fields.runId ?? null,
    inputId: event.fields.inputId ?? null,
    outputId: event.fields.outputId ?? null,
    callId: event.fields.callId ?? null,
    toolName: event.fields.toolName ?? null,
    status: event.fields.status ?? null,
    decision: event.fields.decision ?? null,
    reason: event.fields.replayCause
      ?? event.fields.transitionCause
      ?? event.fields.decisionCause
      ?? event.fields.errorCode
      ?? null,
    replayKind: event.fields.replayKind ?? null,
    divergenceKind: event.fields.divergenceKind ?? null,
    divergedItemIndex: event.fields.divergedItemIndex ?? null,
    knownTranscriptItemCount: event.fields.knownTranscriptItemCount ?? null,
    clientTranscriptItemCount: event.fields.clientTranscriptItemCount ?? null,
    divergedItemPreview: event.fields.divergedItemPreview ?? null,
    knownItemPreview: event.fields.knownItemPreview ?? null,
    divergedCharOffset: event.fields.divergedCharOffset ?? null,
    transcriptItemCount: event.fields.transcriptItemCount ?? null,
    replayedTranscriptItemCount: event.fields.replayedTranscriptItemCount ?? null,
    transcriptSha256: event.fields.transcriptSha256 ?? null,
    contextItemCount: event.fields.contextItemCount ?? null,
    sentPromptChars: event.fields.sentPromptChars ?? null,
    checkpointHash: event.fields.checkpointHash ?? null,
    transitionKind: event.fields.transitionKind ?? null,
    fromAgentId: event.fields.fromAgentId ?? null,
    toAgentId: event.fields.toAgentId ?? null,
    recoveryKind: event.recoveryKind ?? null,
    provisional: event.fields.provisional === true,
    severity: event.severity,
    secondary: kind === "commentary" || kind === "harness_context",
    sourceEventIds: sourceEvents.map((source) => source.id)
  };
}

function isOpenClawCompactionInput(content) {
  return typeof content === "string"
    && content.startsWith(OPENCLAW_COMPACTION_INPUT_PREFIX)
    && OPENCLAW_COMPACTION_PROMPT_MARKERS.some((marker) => content.includes(marker));
}

function buildProjections(events, clientSources = []) {
  const projections = [];
  const requestKinds = new Map(events
    .filter((event) => event.event === "trajectory_request" && event.fields.requestId)
    .map((event) => [event.fields.requestId, event.fields.requestKind]));
  const requestSources = new Map(events
    .filter((event) => event.event === "trajectory_request" && event.fields.requestId)
    .map((event) => [event.fields.requestId, event.fields.clientSource]));
  const inferredCompactionRequestIds = new Set();
  const inputChunks = chunkGroups(events, "inputId", "trajectory_input_content_chunk");
  const inputAccepted = new Map();
  for (const event of events.filter((candidate) => candidate.event === "trajectory_input_accepted")) {
    if (!inputAccepted.has(event.fields.inputId)) inputAccepted.set(event.fields.inputId, []);
    inputAccepted.get(event.fields.inputId).push(event);
  }
  for (const inputId of new Set([...inputChunks.keys(), ...inputAccepted.keys()])) {
    const chunks = inputChunks.get(inputId);
    const accepts = inputAccepted.get(inputId) ?? [];
    const sources = [...(chunks?.sourceEvents ?? []), ...accepts].sort(eventOrder);
    const first = sources[0];
    if (!first) continue;
    const source = sources.map((event) => event.fields.source).find(Boolean) ?? "user";
    const marker = source !== "tool_result" && isTurnAbortedContent(chunks?.content);
    const kind = source === "tool_result" ? "tool_result" : marker ? "turn_aborted" : "user_input";
    const accepted = accepts[0];
    if (
      accepted?.fields.requestId
      && requestSources.get(accepted.fields.requestId) === "openclaw"
      && isOpenClawCompactionInput(chunks?.content)
    ) {
      inferredCompactionRequestIds.add(accepted.fields.requestId);
    }
    const executionIds = [...new Set(accepts.map((event) => event.fields.executionId).filter(Boolean))];
    const shared = {
      inputId,
      callId: sources.map((event) => event.fields.callId).find(Boolean) ?? null,
      status: accepted ? "accepted" : "received",
      requestKind: requestKinds.get(accepted?.fields.requestId) ?? null,
      executionIds
    };
    let content = chunks?.content ?? null;
    if (kind === "user_input" && content !== null) {
      const split = splitHarnessContent(content, clientSources);
      if (split) {
        projections.push({
          ...projectionBase("harness_context", accepted ?? first, sources),
          ...shared,
          id: `projection-harness_context-${inputId}`,
          title: "Harness context",
          content: split.harness,
          severity: "normal"
        });
        if (split.user === null) continue;
        content = split.user;
      }
    }
    projections.push({
      ...projectionBase(kind, accepted ?? first, sources),
      ...shared,
      id: `projection-${kind}-${inputId}`,
      title: kind === "user_input" ? "User input" : kind === "turn_aborted" ? "Turn aborted" : "Tool result",
      content,
      severity: sources.some((event) => event.severity === "error") ? "error" : "normal"
    });
  }

  const outputChunks = chunkGroups(events, "outputId", "trajectory_output_content_chunk");
  const outputPublished = new Map();
  for (const event of events.filter((candidate) => candidate.event === "trajectory_output_published")) {
    if (!outputPublished.has(event.fields.outputId)) outputPublished.set(event.fields.outputId, []);
    outputPublished.get(event.fields.outputId).push(event);
  }
  for (const outputId of new Set([...outputChunks.keys(), ...outputPublished.keys()])) {
    const chunks = outputChunks.get(outputId);
    const publishes = outputPublished.get(outputId) ?? [];
    const sources = [...(chunks?.sourceEvents ?? []), ...publishes].sort(eventOrder);
    const first = sources[0];
    if (!first) continue;
    const outputType = sources.map((event) => event.fields.outputType).find(Boolean) ?? "final";
    const kind = outputType === "commentary" ? "commentary" : outputType === "tool_call" ? "tool_call" : "final_output";
    const completedPublication = publishes.findLast((event) => event.fields.publicationKind === "completed");
    const presentation = completedPublication ?? publishes.at(-1) ?? first;
    projections.push({
      ...projectionBase(kind, presentation, sources),
      id: `projection-${kind}-${outputId}`,
      title: kind === "final_output" ? "Final output" : kind === "commentary" ? "Commentary" : (presentation.fields.toolName ?? "Tool call"),
      content: chunks?.content ?? null,
      outputId,
      callId: sources.map((event) => event.fields.callId).find(Boolean) ?? null,
      toolName: sources.map((event) => event.fields.toolName).find(Boolean) ?? null,
      status: completedPublication ? "published" : publishes.length ? "partial" : "streaming",
      provisional: sources.some((event) => event.fields.provisional === true)
        || (outputType === "final" && !completedPublication),
      severity: sources.some((event) => event.severity === "error") ? "error" : sources.some((event) => event.severity === "notice") ? "notice" : "normal"
    });
  }

  const projectedEvents = new Set([
    "trajectory_input_content_chunk", "trajectory_input_accepted",
    "trajectory_output_content_chunk", "trajectory_output_published"
  ]);
  const routineDecisions = new Set(["start_full", "send_incremental", "continue_run", "steer_run", "reattach"]);
  for (const event of events) {
    if (projectedEvents.has(event.event)) continue;
    let kind = "metadata";
    let title = event.event.replace(/^trajectory_/, "").replaceAll("_", " ");
    if (event.event === "trajectory_agent_transition" && event.fields.transitionKind !== "created") kind = "agent_transition";
    else if (event.event === "trajectory_error") {
      kind = event.recoveryKind === "context_compaction"
        ? "recovery"
        : isCancellationError(event) ? "metadata" : "error";
    }
    else if (event.event === "trajectory_execution_terminal" && event.severity !== "normal") kind = "error";
    else if (event.event === "trajectory_replay") {
      // The per-request "client resent its history" confirmation stays
      // available as ordinary metadata; only SDK-layer replays are prominent.
      kind = event.fields.replayKind === "client_transcript" ? "metadata" : "replay";
      if (event.fields.replayKind === "client_transcript") title = "客户端携带历史";
    }
    else if (event.event === "trajectory_context_decision") {
      // Routine prompt-selection decisions describe the default path; a real
      // full replay already surfaces through its paired trajectory_replay row.
      kind = routineDecisions.has(event.fields.decision) ? "metadata" : "context_decision";
    }
    else if (event.event === "trajectory_context_checkpoint") kind = "checkpoint";
    else if (event.event === "trajectory_route_decision") {
      kind = event.fields.route === "cursor_sdk" ? "metadata" : "context_decision";
      title = event.fields.fallbackBlockedReason ? "Fallback armed; current request not retried"
        : event.fields.routeStickyHit ? "Fallback route retained"
        : event.fields.route === "fallback" ? "Switch to fallback upstream" : "Cursor SDK primary route";
    }
    else if (event.event === "trajectory_request" && event.fields.replayKind && event.fields.replayKind !== "none") kind = "replay";
    if (event.event === "trajectory_request") {
      const requestPurpose = event.fields.requestPurpose
        ?? (inferredCompactionRequestIds.has(event.fields.requestId) ? "compaction" : undefined);
      title = requestPurpose === "compaction"
        ? "OpenClaw 压缩请求"
        : {
            continuation: "Continuation request", retry: "Retry request", steering: "Steering request"
          }[event.fields.requestKind] ?? "Initial request";
    } else if (event.event === "trajectory_agent_transition") title = event.fields.transitionKind === "created" ? "Agent created" : "Agent transition";
    else if (event.event === "trajectory_execution_started") title = "Execution started";
    else if (event.event === "trajectory_execution_attached") title = "Execution attached";
    else if (event.event === "trajectory_execution_terminal") title = `Execution ${event.fields.status ?? "terminal"}`;
    else if (isCancellationError(event)) title = "Request cancelled";
    else if (event.event === "trajectory_error" && event.recoveryKind === "context_compaction") title = "Context compaction recovery";
    const projection = { ...projectionBase(kind, event, [event]), title };
    if (event.event === "trajectory_request" && inferredCompactionRequestIds.has(event.fields.requestId)) {
      projection.requestPurpose = "compaction";
    }
    projections.push(projection);
  }
  return projections.sort((left, right) => (
    (left.timestampMs ?? Number.MAX_SAFE_INTEGER) - (right.timestampMs ?? Number.MAX_SAFE_INTEGER)
    || left.priority - right.priority
    || left.id.localeCompare(right.id)
  ));
}

function isTurnAbortedContent(content) {
  if (typeof content !== "string") return false;
  const value = content.trim();
  return value === "<turn_aborted>"
    || /^<turn_aborted>\s*[\s\S]*?\s*<\/turn_aborted>$/.test(value);
}

function buildGraph(events) {
  const edges = [];
  const seen = new Set();
  const add = (from, to, type) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ id: `edge-${edges.length}`, from, to, type });
  };
  const linkBy = (field, type) => {
    const groups = new Map();
    for (const event of events) {
      const value = field === "laneId" ? event.laneId : event.fields[field];
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(event);
    }
    for (const group of groups.values()) {
      group.sort(eventOrder);
      for (let index = 1; index < group.length; index += 1) add(group[index - 1].id, group[index].id, type);
    }
  };
  linkBy("laneId", "lane_sequence");
  linkBy("ingressRequestId", "ingress_request");
  linkBy("requestId", "request");
  linkBy("executionId", "execution");
  linkBy("inputId", "input");
  linkBy("outputId", "output");
  return { nodeIds: events.map((event) => event.id), edges };
}

// One incident emits several warning/error events (agent_transition +
// trajectory_replay for a divergence, trajectory_error + failed terminal for
// a crash), so anomaly counts dedupe by the request they belong to.
function issueKey(event) {
  return event.fields.requestId ?? event.fields.ingressRequestId ?? event.id;
}

function countIssues(events, severities = ["error", "warning"]) {
  return new Set(
    events
      .filter((event) => severities.includes(event.severity))
      .map(issueKey)
  ).size;
}

function buildLanes(events) {
  const lanes = new Map();
  const failureKeys = new Map();
  for (const event of events) {
    if (!lanes.has(event.laneId)) {
      lanes.set(event.laneId, {
        id: event.laneId,
        agentId: event.laneId.startsWith("agent:") ? event.laneId.slice(6) : null,
        model: event.model,
        modelKey: event.modelKey,
        status: "observed",
        provisional: false,
        failureCount: 0,
        executionIds: [],
        eventIds: [],
        firstSeen: event.timestamp,
        lastSeen: event.timestamp
      });
    }
    const lane = lanes.get(event.laneId);
    lane.eventIds.push(event.id);
    if (event.fields.executionId && !lane.executionIds.includes(event.fields.executionId)) lane.executionIds.push(event.fields.executionId);
    if (event.fields.provisional === true) lane.provisional = true;
    if (event.severity === "error") {
      if (!failureKeys.has(event.laneId)) failureKeys.set(event.laneId, new Set());
      failureKeys.get(event.laneId).add(issueKey(event));
      lane.failureCount = failureKeys.get(event.laneId).size;
    }
    if (event.event === "trajectory_execution_started" || event.event === "trajectory_execution_attached") lane.status = "running";
    if (event.event === "trajectory_execution_terminal") lane.status = event.fields.status ?? "terminal";
    if (event.timestamp) {
      lane.firstSeen = !lane.firstSeen || event.timestamp < lane.firstSeen ? event.timestamp : lane.firstSeen;
      lane.lastSeen = !lane.lastSeen || event.timestamp > lane.lastSeen ? event.timestamp : lane.lastSeen;
    }
    if (!lane.model && event.model) {
      lane.model = event.model;
      lane.modelKey = event.modelKey;
    }
  }
  return [...lanes.values()].sort((left, right) => {
    if (left.id === "transport") return -1;
    if (right.id === "transport") return 1;
    return (left.firstSeen ?? "").localeCompare(right.firstSeen ?? "");
  });
}

function buildAuthenticationRecoveries(events) {
  return events
    .filter((event) => (
      event.event === "trajectory_agent_transition"
      && event.fields.transitionKind === "replaced"
      && event.fields.transitionCause === "authentication_reset"
      && event.fields.requestId
      && event.fields.fromAgentId
      && event.fields.toAgentId
    ))
    .map((transition) => {
      const matchesRequestAndAgent = (event) => (
        event.fields.requestId === transition.fields.requestId
        && event.fields.agentId === transition.fields.toAgentId
      );
      const decision = events.find((event) => (
        event.event === "trajectory_context_decision"
        && matchesRequestAndAgent(event)
        && event.fields.decision === "start_full"
        && event.fields.decisionCause === "authentication_reset"
      ));
      const replay = events.find((event) => (
        event.event === "trajectory_replay"
        && matchesRequestAndAgent(event)
        && event.fields.replayKind === "sdk_context"
        && event.fields.replayCause === "authentication_reset"
      ));
      const terminal = events.findLast((event) => (
        event.event === "trajectory_execution_terminal" && matchesRequestAndAgent(event)
      ));
      const recovered = terminal && ["finished", "completed", "succeeded"].includes(terminal.fields.status);
      return {
        state: recovered ? "recovered" : terminal ? "failed" : "recovering",
        requestId: transition.fields.requestId,
        fromAgentId: transition.fields.fromAgentId,
        toAgentId: transition.fields.toAgentId,
        rotated: true,
        replayed: Boolean(decision && replay),
        sourceEventIds: [transition, decision, replay, terminal].filter(Boolean).map((event) => event.id)
      };
    });
}

function sessionStatus(events, projections) {
  const latest = events.filter((event) => event.event === "trajectory_execution_terminal").at(-1);
  if (latest?.fields.status === "failed" || latest?.fields.status === "error") return "failed";
  if (latest?.fields.status === "cancelled") return "cancelled";
  if (latest && ["finished", "completed", "succeeded"].includes(latest.fields.status)) return "completed";
  if (events.some((event) => ["trajectory_execution_started", "trajectory_execution_attached"].includes(event.event))) return "running";
  return projections.some((item) => item.kind === "final_output" && item.status === "published") ? "completed" : "observed";
}

function sessionCompleteness(events) {
  const reasons = [];
  const requestIds = new Set(events.map((event) => event.fields.requestId).filter(Boolean));
  const inputContentIds = new Set(events
    .filter((event) => event.event === "trajectory_input_content_chunk")
    .map((event) => event.fields.inputId)
    .filter(Boolean));
  const outputContentIds = new Set(events
    .filter((event) => event.event === "trajectory_output_content_chunk")
    .map((event) => event.fields.outputId)
    .filter(Boolean));
  const startedExecutions = new Set(events
    .filter((event) => event.event === "trajectory_execution_started")
    .map((event) => event.fields.executionId)
    .filter(Boolean));
  if (!events.some((event) => (
    event.event === "trajectory_request"
    && !event.fields.parentRequestId
    && (event.fields.attemptIndex ?? 0) === 0
  ))) {
    reasons.push("session_start_outside_window");
  }
  if (events.some((event) => event.fields.parentRequestId && !requestIds.has(event.fields.parentRequestId))) {
    reasons.push("missing_parent_request");
  }
  if (events.some((event) => event.event === "trajectory_input_accepted" && !inputContentIds.has(event.fields.inputId))) {
    reasons.push("missing_input_content");
  }
  if (events.some((event) => event.event === "trajectory_output_published" && !outputContentIds.has(event.fields.outputId))) {
    reasons.push("missing_output_content");
  }
  if (events.some((event) => (
    ["trajectory_execution_attached", "trajectory_execution_terminal"].includes(event.event)
    && event.fields.executionId
    && !startedExecutions.has(event.fields.executionId)
  ))) {
    reasons.push("missing_execution_start");
  }
  return { partial: reasons.length > 0, partialReasons: [...new Set(reasons)] };
}

function summarizeSessions(records) {
  const sessions = new Map();
  for (const record of records) {
    if (!sessions.has(record.fields.sessionKey)) sessions.set(record.fields.sessionKey, []);
    sessions.get(record.fields.sessionKey).push(record);
  }
  const result = [];
  for (const [sessionKey, events] of sessions) {
    events.sort(eventOrder);
    events.forEach((event, index) => { event.id ||= `event-${index}`; });
    assignLanes(events);
    const compactionRecoveries = buildCompactionRecoveries(events);
    const baseTime = events.find((event) => event.timestampMs !== null)?.timestampMs ?? null;
    for (const event of events) event.offsetMs = baseTime !== null && event.timestampMs !== null ? Math.max(0, event.timestampMs - baseTime) : null;
    const clientSources = [...new Set(events.map((event) => event.fields.clientSource).filter(Boolean))];
    const clientPlatforms = [...new Set(events.map((event) => event.fields.clientPlatform).filter(Boolean))];
    const requestEvents = events.filter((event) => event.event === "trajectory_request");
    const projections = buildProjections(events, clientSources);
    const requestPurposeById = new Map(projections
      .filter((projection) => projection.requestId && projection.requestPurpose)
      .map((projection) => [projection.requestId, projection.requestPurpose]));
    const requestPurposes = [...new Set(requestPurposeById.values())];
    const compactionOnly = requestEvents.length > 0
      && requestEvents.every((event) => requestPurposeById.get(event.fields.requestId) === "compaction");
    const lanes = buildLanes(events);
    const authenticationRecoveries = buildAuthenticationRecoveries(events);
    const firstSeen = events.find((event) => event.timestamp)?.timestamp ?? null;
    const lastSeen = events.findLast((event) => event.timestamp)?.timestamp ?? null;
    const userInputs = projections.filter((item) => item.kind === "user_input");
    const models = [...new Map(events.filter((event) => event.model).map((event) => [event.modelKey, event.model])).values()];
    const issueCount = countIssues(events);
    const severity = events.some((event) => event.severity === "error")
      ? "error"
      : events.some((event) => event.severity === "warning")
        ? "warning"
        : events.some((event) => event.severity === "notice") ? "notice" : "normal";
    const completeness = sessionCompleteness(events);
    result.push({
      id: sessionKey,
      title: compactionOnly
        ? "OpenClaw 压缩请求"
        : userInputs.find((item) => item.content)?.content ?? null,
      status: sessionStatus(events, projections),
      severity,
      ...completeness,
      issueCount,
      errorCount: countIssues(events, ["error"]),
      warningCount: countIssues(events, ["warning"]),
      firstSeen,
      lastSeen,
      durationMs: firstSeen && lastSeen ? Math.max(0, Date.parse(lastSeen) - Date.parse(firstSeen)) : null,
      clientSources,
      clientPlatforms,
      requestPurposes,
      models,
      events,
      graph: buildGraph(events),
      lanes,
      authenticationRecoveries,
      compactionRecoveries,
      projections
    });
  }
  return result.sort((left, right) => (right.lastSeen ?? "").localeCompare(left.lastSeen ?? ""));
}

export function parseTraceText(text, source = {}) {
  const diagnostics = { totalRecords: 0, acceptedRecords: 0, malformedLines: 0, ignoredRecords: 0, strippedFields: 0 };
  const trimmed = text.trim();
  if (!trimmed) return { schemaVersion: 3, source, diagnostics, sessions: [] };
  let values;
  try {
    const whole = JSON.parse(trimmed);
    values = Array.isArray(whole) ? whole : [whole];
  } catch {
    values = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); }
      catch { diagnostics.malformedLines += 1; }
    }
  }
  const records = [];
  values.forEach((value, index) => {
    diagnostics.totalRecords += 1;
    const unwrapped = unwrapRecord(value, index, diagnostics);
    if (!unwrapped.length) diagnostics.ignoredRecords += 1;
    records.push(...unwrapped);
  });
  records.sort(eventOrder);
  diagnostics.acceptedRecords = records.length;
  const sessions = summarizeSessions(records);
  if (source.partial) {
    for (const session of sessions) {
      session.partial = true;
      session.partialReasons.push("log_source_incomplete");
    }
  }
  return { schemaVersion: 3, source, diagnostics, sessions };
}

export { modelKey };
