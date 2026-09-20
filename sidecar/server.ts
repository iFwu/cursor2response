import { createHash } from "node:crypto";
import { createSidecarServer } from "./http-server.ts";
import type { CursorTextEvent, CursorUsage } from "../core/cursor.ts";
import { errorResponse, HttpError, json, notFound, openAiError, sseResponse, unauthorized } from "../core/http.ts";
import {
  chatToolResults,
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  EMPTY_RESPONSES_TURN_MESSAGE,
  isEmptyResponsesTurn,
  prepareChatRequest,
  prepareResponsesFollowUpPrompt,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseFailedEvent,
  responseObject,
  responseToolContinuation,
  responseToolResultsCanReplay,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls,
  toolCallRetryHint,
  type OpenAiToolCall,
  type OpenAiToolSpec,
  type ToolCallContext
} from "../core/openai.ts";
import {
  createCursorSdkCompletion,
  collectCursorSdkOutput,
  isTransientCursorSdkError
} from "../core/cursor-sdk.ts";
import { encodeSse } from "../core/sse.ts";
import type { CursorToolCall, Deps, Env } from "../core/types.ts";
import {
  anthropicError,
  anthropicMessage,
  anthropicSseEvents,
  anthropicToChatBody,
  contextFromAnthropicBeta,
  estimateTokens,
  mapModel
} from "./anthropic.ts";

import { applyCursorModelSelection, isGrok46Family } from "./cursor-model-selection.ts";
import {
  inferClientPlatform,
  inferClientSource,
  type ClientPlatform,
  type ClientSource
} from "./client-source.ts";
import {
  createFailureTraceCapture,
  failureTraceStoreOptionsFromEnv,
  initializeFailureTraceStore,
  type FailureTraceCapture
} from "./failure-trace.ts";
import { resolveSessionAffinity, type SessionAffinityResolution } from "./session-affinity.ts";
import {
  API_FALLBACK_MODEL,
  ApiFallbackRoute,
  apiFallbackConfig,
  isApiFallbackModel
} from "./api-fallback.ts";

const HOST = process.env.HOST?.trim() || "127.0.0.1";
const DEFAULT_PORT = 8787;
const LOCAL_API_KEY_LITERAL = "cursor-local";
const PRIMARY_MODEL = "auto";
const serviceInvocationId = process.env.INVOCATION_ID || `sidecar_${crypto.randomUUID()}`;
const trajectoryRequestSessions = new Map<string, { lastRequestId?: string; touchedAt: number }>();
const maxTrajectoryRequestSessions = 4096;
let promptCacheKeyFallbackWarned = false;
const failureTraceStoreOptions = failureTraceStoreOptionsFromEnv();
const OPENCLAW_COMPACTION_INPUT_PREFIX = "<conversation>\n";
const OPENCLAW_COMPACTION_PROMPT_MARKERS = [
  "\n</conversation>\n\nThe messages above are a conversation to summarize.",
  "\n</conversation>\n\nThe messages above are NEW conversation messages to incorporate into the existing summary",
  "\n</conversation>\n\nThis is the PREFIX of a turn that was too large to keep."
];

function traceContentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function trajectoryRequestPurpose(
  clientSource: ClientSource,
  userInputs: string[]
): "compaction" | undefined {
  if (clientSource !== "openclaw" || userInputs.length !== 1) return undefined;
  const input = userInputs[0];
  return input.startsWith(OPENCLAW_COMPACTION_INPUT_PREFIX)
    && OPENCLAW_COMPACTION_PROMPT_MARKERS.some((marker) => input.includes(marker))
    ? "compaction"
    : undefined;
}

function logTrajectory(event: string, input: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      event,
      trajectorySchemaVersion: 1,
      eventId: crypto.randomUUID(),
      serviceInvocationId,
      ...input
    });
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

function logTrajectoryObservationError(scope: string, errorCode: string): void {
  console.warn(JSON.stringify({
    event: "trajectory_observation_error",
    trajectorySchemaVersion: 1,
    eventId: crypto.randomUUID(),
    serviceInvocationId,
    scope,
    errorCode
  }));
}

function stableTraceJson(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableTraceJson(item))));
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, JSON.parse(stableTraceJson(item))])
  ));
}

function trajectoryRequestSession(sessionKey: string): { lastRequestId?: string; touchedAt: number } {
  let state = trajectoryRequestSessions.get(sessionKey);
  if (!state) {
    state = { touchedAt: Date.now() };
    trajectoryRequestSessions.set(sessionKey, state);
    if (trajectoryRequestSessions.size > maxTrajectoryRequestSessions) {
      const oldest = [...trajectoryRequestSessions.entries()]
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (oldest) trajectoryRequestSessions.delete(oldest[0]);
    }
  }
  state.touchedAt = Date.now();
  return state;
}

const deps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID()
};

function buildEnv(): Env {
  return {
    CURSOR_SDK_BRIDGE_URL: process.env.CURSOR_SDK_BRIDGE_URL,
    CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN,
    CURSOR_SDK_BRIDGE_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_TIMEOUT_MS
  };
}

const env = buildEnv();

function hasSdkBridge(): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_URL?.trim());
}

/**
 * Derive a stable session key so multi-turn conversations reuse the same SDK
 * agent, falling back to a fresh UUID when the client provides none.
 */
function sessionAffinity(request: Request, body?: unknown): SessionAffinityResolution {
  const resolution = resolveSessionAffinity(request.headers, body, () => `session-${crypto.randomUUID()}`);
  if (resolution.source === "prompt_cache_key" && !promptCacheKeyFallbackWarned) {
    promptCacheKeyFallbackWarned = true;
    console.warn(JSON.stringify({
      tag: "session-affinity-fallback",
      kind: "responses",
      sessionSource: resolution.source
    }));
  }
  return resolution;
}

/**
 * Owner key for SDK session scoping. We key the session cache to the resolved
 * Cursor API key so distinct keys never share an agent.
 */
function sdkSessionOwner(apiKey: string): string {
  return `cursor-key:${apiKey}`;
}

/**
 * Resolve the Cursor API key for a request. The incoming bearer wins unless it
 * is absent or the local placeholder literal (`cursor-local`), in which case we
 * fall back to `CURSOR_API_KEY` from the environment.
 */
function resolveApiKey(request: Request): string {
  // Anthropic clients (Claude Code) send the key as `x-api-key`; OpenAI clients use
  // `Authorization: Bearer`. Either source, with `cursor-local`/empty falling back to the
  // env key (Credential Manager).
  const apiKeyHeader = (request.headers.get("x-api-key") || "").trim();
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const bearer = match ? match[1].trim() : "";
  const candidate = apiKeyHeader || bearer;
  if (candidate && candidate !== LOCAL_API_KEY_LITERAL) return candidate;
  return (process.env.CURSOR_API_KEY || "").trim();
}

async function cursorModelSelection(requestedModel: string, body: unknown, apiKey?: string): Promise<{ id: string }> {
  const rawModel = requestedModel.trim() || PRIMARY_MODEL;
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(rawModel);
  let modelId = (match?.[1] || PRIMARY_MODEL).trim();
  if (modelId.toLowerCase() === "default") modelId = "auto";
  let supportedParameters: Set<string> | undefined;
  if (apiKey && !isGrok46Family(modelId)) {
    const catalog = await liveCursorModels(apiKey);
    const normalizedModelId = modelId.split("/").filter(Boolean).at(-1) || modelId;
    const model = catalog.find((item) => item.id === normalizedModelId || item.aliases?.includes(normalizedModelId));
    supportedParameters = model ? new Set((model.parameters ?? []).map((parameter) => parameter.id)) : undefined;
  }
  return applyCursorModelSelection(requestedModel, body, supportedParameters);
}

function healthResponse(port: number): Response {
  return json({
    ok: true,
    service: "cursor2response",
    ...(process.env.CURSOR2RESPONSE_LAUNCH_ID ? {
      launchId: process.env.CURSOR2RESPONSE_LAUNCH_ID,
      launcherPid: Number(process.env.CURSOR2RESPONSE_LAUNCHER_PID),
      pid: process.pid
    } : {}),
    host: HOST,
    modelCatalog: "live-account-specific",
    baseUrl: `http://${HOST}:${port}/v1`
  });
}

interface CursorCatalogParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

interface CursorCatalogVariant {
  params: Array<{ id: string; value: string }>;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

interface CursorCatalogModel {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorCatalogParameter[];
  variants?: CursorCatalogVariant[];
}

const MODEL_CATALOG_TTL_MS = 60_000;
const modelCatalogCache = new Map<string, { models: CursorCatalogModel[]; expiresAt: number }>();

async function apiKeyHash(apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function cursorSdkModelsUrl(): string {
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  if (!bridgeUrl) {
    throw new HttpError("CURSOR_SDK_BRIDGE_URL is required for the local SDK Bridge.", 500, "cursor_sdk_bridge_missing");
  }
  const url = new URL(bridgeUrl);
  url.pathname = "/models";
  url.search = "";
  return url.toString();
}

async function liveCursorModels(apiKey: string): Promise<CursorCatalogModel[]> {
  const cacheKey = await apiKeyHash(apiKey);
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const headers: Record<string, string> = { "content-type": "application/json" };
  const bridgeToken = env.CURSOR_SDK_BRIDGE_TOKEN?.trim();
  if (bridgeToken) headers.authorization = `Bearer ${bridgeToken}`;

  const response = await deps.fetch(cursorSdkModelsUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ apiKey })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `Cursor model discovery failed with status ${response.status}`;
    try {
      const payload = JSON.parse(text) as { error?: { message?: string } };
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Keep the raw response text.
    }
    const status = response.status === 401 ? 401 : response.status === 429 ? 429 : 502;
    throw new HttpError(message, status, response.status === 401 ? "cursor_unauthorized" : "cursor_models_error");
  }

  const payload = await response.json() as { models?: CursorCatalogModel[] };
  const models = Array.isArray(payload.models)
    ? payload.models.filter((model) => model && typeof model.id === "string" && typeof model.displayName === "string")
    : [];
  modelCatalogCache.set(cacheKey, { models, expiresAt: Date.now() + MODEL_CATALOG_TTL_MS });
  return models;
}

function openAiCatalogItem(
  model: CursorCatalogModel,
  id: string,
  displayName: string
): Record<string, unknown> {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    name: displayName,
    description: model.description ?? null,
    cursor_base_model: model.id,
    cursor_aliases: model.aliases ?? [],
    cursor_parameters: model.parameters ?? []
  };
}

function openAiCatalogData(models: CursorCatalogModel[]): Array<Record<string, unknown>> {
  const data: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const add = (item: Record<string, unknown>) => {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    data.push(item);
  };

  for (const model of models) {
    add(openAiCatalogItem(model, model.id, model.displayName));
    if (model.id === "cursor-grok") {
      add(openAiCatalogItem(model, "cursor-grok-fast", "Cursor Grok 4.6 Fast"));
    }
  }

  return data;
}

async function handleModels(request: Request): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) return unauthorized();
  const models = await liveCursorModels(apiKey);
  const data = openAiCatalogData(models);
  try {
    if (apiFallbackConfig()) {
      data.push({ id: API_FALLBACK_MODEL, object: "model", created: 0, owned_by: "cursor2response" });
    }
  } catch { /* An optional route cannot make the existing model catalog unavailable. */ }
  return json({ object: "list", data });
}

async function handleModel(request: Request, id: string): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) return unauthorized();
  if (isApiFallbackModel(id) && apiFallbackConfig()) {
    return json({ id, object: "model", created: 0, owned_by: "cursor2response" });
  }
  const models = openAiCatalogData(await liveCursorModels(apiKey));
  const model = models.find((item) => item.id === id);
  if (!model) return openAiError(`Model '${id}' not found`, 404, "not_found", "model");
  return json(model);
}

async function handleChatCompletions(request: Request): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) return unauthorized();

  const body = await request.json();
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : PRIMARY_MODEL;
  const cursorModel = await cursorModelSelection(requestedModel, body, apiKey);
  const prepared = prepareChatRequest(body, cursorModel);

  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  return handleSdkRoute(
    "chat",
    request,
    prepared,
    apiKey,
    id,
    created,
    chatIncrementalPrompt(body, cursorModel),
    sessionAffinity(request),
    chatToolResults(body)
  );
}

async function handleResponses(request: Request): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) return unauthorized();

  const body = await request.json();
  const requestedModel = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : PRIMARY_MODEL;
  const fallbackEnabled = isApiFallbackModel(requestedModel);
  const config = fallbackEnabled ? apiFallbackConfig() : undefined;
  if (fallbackEnabled && (!config || !hasSdkBridge())) {
    throw new HttpError("api-fallback requires SDK Bridge and fallback configuration.", 503, "api_fallback_not_configured");
  }
  const cursorModel = await cursorModelSelection(config?.primaryModel ?? requestedModel, body, apiKey);
  const prepared = prepareResponsesRequest(body, cursorModel);
  const toolContinuation = responseToolContinuation(body);
  const followUpPrompt = prepareResponsesFollowUpPrompt(body, cursorModel, toolContinuation.followUpInput);

  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);

  const incrementalPrompt = followUpPrompt ?? responsesIncrementalPrompt(body, cursorModel);
  const session = sessionAffinity(request, body);
  const fallbackRoute = config ? new ApiFallbackRoute(config, {
    body, apiKey, session, workingDirectory: prepared.toolContext?.workingDirectory,
    signal: request.signal, requestId: id,
    clientSource: inferClientSource(request.headers), clientPlatform: inferClientPlatform(request.headers),
    inputs: [
      ...(prepared.trajectoryUserInputs ?? []).map((content) => ({ source: "user" as const, content })),
      ...toolContinuation.results.map((result) => ({ source: "tool_result" as const,
        content: traceContentText(result.output), callId: result.callId }))
    ]
  }, logTrajectory) : undefined;
  const directFallback = await fallbackRoute?.initialResponse();
  if (directFallback) return directFallback;
  const failureTrace = createFailureTraceCapture({
    requestBody: body,
    responseId: id,
    model: prepared.model,
    stream: prepared.stream,
    session,
    clientSource: inferClientSource(request.headers),
    clientPlatform: inferClientPlatform(request.headers),
    prompt: prepared.prompt.text,
    incrementalPrompt: incrementalPrompt?.text,
    toolNames: prepared.tools.map((tool) => tool.name),
    resumeToolResultsCount: toolContinuation.results.length,
    supersedePendingRun: toolContinuation.supersedePendingRun,
    supersedingTurnAborted: toolContinuation.supersedingTurnAborted,
    supersededToolCallIds: toolContinuation.supersededToolCallIds
  }, failureTraceStoreOptions);
  return handleSdkRoute(
    "responses",
    request,
    prepared,
    apiKey,
    id,
    created,
    incrementalPrompt,
    session,
    toolContinuation.results,
    !toolContinuation.supersedePendingRun && responseToolResultsCanReplay(body),
    toolContinuation.supersedePendingRun,
    toolContinuation.supersedingTurnAborted,
    toolContinuation.supersededToolCallIds,
    failureTrace,
    fallbackRoute
  );
}

type PreparedRequest = ReturnType<typeof prepareChatRequest> | ReturnType<typeof prepareResponsesRequest>;

/**
 * A freshly created SDK agent can fail during the handshake before producing output.
 * Request cancellation and either SDK deadline are terminal and never reach this retry path.
 */
function isTransientSdkError(error: unknown): boolean {
  return isTransientCursorSdkError(error);
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return String(record.name ?? "").toLowerCase() === "aborterror"
    || String(record.code ?? "").toLowerCase() === "abort_err";
}

function streamTrajectoryErrorCode(error: unknown, signal?: AbortSignal): string {
  if (error instanceof HttpError) return error.code;
  if (signal?.aborted || isAbortLikeError(error)) return "cursor_sdk_cancelled";
  return "cursor_stream_failed";
}

/**
 * Wrap an SDK event stream so a transient failure *before any event is emitted* retries
 * with a fresh attempt (the factory decides what changes per attempt). Once any event has
 * been yielded we never retry, so partial output is never duplicated.
 */
function retryingSdkStream(
  make: (attempt: number) => Promise<AsyncIterable<CursorTextEvent>>,
  maxAttempts = 2,
  signal?: AbortSignal
): AsyncIterable<CursorTextEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let attempt = 0; ; attempt += 1) {
        const iterator = (await make(attempt))[Symbol.asyncIterator]();
        let emitted = false;
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            emitted = true;
            yield next.value;
          }
        } catch (error) {
          try {
            await iterator.return?.();
          } catch {
            /* ignore */
          }
          signal?.throwIfAborted();
          if (!emitted && attempt + 1 < maxAttempts && isTransientSdkError(error)) continue;
          throw error;
        }
      }
    }
  };
}

/**
 * The incremental "new turn" for a follow-up chat request: every message after the last
 * assistant message. Returned as a CursorPrompt so a still-cached SDK agent receives only
 * the new turn instead of the whole conversation. Undefined on the first turn (no prior
 * assistant) — then the bridge uses the full prompt.
 */
function chatIncrementalPrompt(
  body: unknown,
  cursorModel: { id: string }
): ReturnType<typeof prepareChatRequest>["prompt"] | undefined {
  const messages = (body as { messages?: Array<{ role?: string }> } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0 || lastAssistant >= messages.length - 1) return undefined;
  const leadingInstructions = messages
    .slice(0, lastAssistant)
    .filter((message) => message?.role === "system" || message?.role === "developer");
  const tail = [...leadingInstructions, ...messages.slice(lastAssistant + 1)];
  try {
    const deltaBody = {
      ...(body as Record<string, unknown>),
      messages: tail,
      stream: false
    };
    return prepareChatRequest(deltaBody as Parameters<typeof prepareChatRequest>[0], cursorModel).prompt;
  } catch {
    return undefined;
  }
}

function responsesIncrementalPrompt(
  body: unknown,
  cursorModel: { id: string }
): ReturnType<typeof prepareResponsesRequest>["prompt"] | undefined {
  const input = (body as { input?: unknown } | null)?.input;
  if (!Array.isArray(input) || input.length === 0) return undefined;
  let lastAssistant = -1;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i] as { role?: unknown } | null;
    const type = (item as { type?: unknown } | null)?.type;
    if (item?.role === "assistant" || type === "function_call" || type === "custom_tool_call") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0 || lastAssistant >= input.length - 1) return undefined;
  const lastItem = input[lastAssistant] as { type?: unknown } | null;
  const lastItemType = lastItem?.type;
  const isToolCall = lastItemType === "function_call" || lastItemType === "custom_tool_call";
  const tail = isToolCall
    ? [
        ...latestUserInstructionBefore(input, lastAssistant),
        ...input.slice(lastAssistant)
      ]
    : input.slice(lastAssistant + 1);
  try {
    const deltaBody = {
      ...(body as Record<string, unknown>),
      input: tail,
      stream: false
    };
    return prepareResponsesRequest(deltaBody, cursorModel).prompt;
  } catch {
    return undefined;
  }
}

/**
 * The SDK bridge cancels immediately after exposing a tool call to the outer
 * client. Keep enough of that exchange in the next incremental prompt for the
 * SDK agent to recover even if cancellation did not commit its tool-call item
 * to the cached agent history.
 */
function latestUserInstructionBefore(input: unknown[], before: number): unknown[] {
  for (let index = before - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    const record = item as { role?: unknown; type?: unknown };
    if (record.role === "user" || (record.type === "message" && record.role === "user")) {
      return [item];
    }
  }
  return [];
}

/** Shared tool-call gate for the SDK paths (OpenAI + Anthropic): allow a tool call only
 * if it maps to a known client tool, else return a retry hint string. */
function sdkAllowToolCall(prepared: PreparedRequest, toolCall: CursorToolCall) {
  if (!prepared.tools.length) return "No client tool inventory was available for this request.";
  const toolCalls = toOpenAiToolCalls({
    toolCalls: [toolCall],
    tools: prepared.tools,
    responseId: "probe",
    context: prepared.toolContext
  });
  const decision = toolCalls.length > 0
    || toolCallRetryHint({ toolCall, tools: prepared.tools, context: prepared.toolContext });
  return decision;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (Claude Code). Translates Anthropic <-> the OpenAI/Cursor SDK
// path via `anthropic.ts`. See docs/specs/protocol-support.md.
// ---------------------------------------------------------------------------

/** Wrap an Anthropic SSE event generator into a streaming Response. On mid-stream failure
 * (after `message_start`), emit an Anthropic `error` event rather than a broken stream. */
function anthropicSseResponse(events: AsyncGenerator<{ event: string; data: Record<string, unknown> }>): Response {
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const { event, data } of events) controller.enqueue(encodeSse(data, event));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encodeSse(anthropicError(message, "api_error"), "error"));
      } finally {
        controller.close();
      }
    }
  });
  return sseResponse(readable);
}

async function handleAnthropicMessages(request: Request): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) return json(anthropicError("Missing or invalid x-api-key.", "authentication_error"), { status: 401 });

  const body = await request.json();
  const requestedModel =
    body && typeof body === "object" && typeof (body as { model?: unknown }).model === "string"
      ? (body as { model: string }).model
      : PRIMARY_MODEL;
  const translatedBody = anthropicToChatBody(body);
  const requestedContext = contextFromAnthropicBeta(request.headers.get("anthropic-beta"));
  if (requestedContext) translatedBody.cursor_context = requestedContext;
  const cursorModel = await cursorModelSelection(mapModel(requestedModel), translatedBody, apiKey);
  const prepared = prepareChatRequest(translatedBody, cursorModel);
  logToolForwarding("anthropic", prepared);
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const inputTokens = estimateTokens(prepared.promptChars);

  // Claude Code resends the full conversation (incl. tool_result) every turn, so /v1/messages is
  // stateless: a fresh SDK session + full prompt per request, plus the transparent auto-retry.
  const makeStream = async (_attempt: number): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env, deps, apiKey, {
      prompt: prepared.prompt,
      systemPrompt: prepared.systemPrompt,
      model: prepared.cursorModel,
      sessionKey: `cc-${crypto.randomUUID()}`,
      sessionOwnerKey: sdkSessionOwner(apiKey),
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      streamEvents: prepared.stream,
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall),
      signal: request.signal
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream, 2, request.signal);

  if (prepared.stream) {
    return anthropicSseResponse(anthropicSseEvents({
      id,
      model: requestedModel,
      inputTokens,
      stream,
      tools: prepared.tools,
      toolContext: prepared.toolContext
    }));
  }

  const output = await collectCursorSdkOutput(stream);
  return json(
    anthropicMessage({
      id,
      model: requestedModel,
      text: output.text,
      toolCalls: output.toolCalls,
      tools: prepared.tools,
      toolContext: prepared.toolContext,
      inputTokens,
      outputTokens: estimateTokens(output.text.length)
    })
  );
}

/** `POST /v1/messages/count_tokens` — Claude Code's pre-send estimate. Same body shape as
 * `/v1/messages`. Auth is not required (it's only an estimate). */
async function handleCountTokens(request: Request): Promise<Response> {
  const body = await request.json();
  const translatedBody = anthropicToChatBody(body);
  const prepared = prepareChatRequest(translatedBody, await cursorModelSelection(mapModel(""), translatedBody));
  return json({ input_tokens: estimateTokens(prepared.promptChars) });
}

async function handleSdkRoute(
  kind: "chat" | "responses",
  request: Request,
  prepared: PreparedRequest,
  apiKey: string,
  id: string,
  created: number,
  incrementalPrompt?: ReturnType<typeof prepareChatRequest>["prompt"],
  session = sessionAffinity(request),
  resumeToolResults: Array<{ callId?: string; output: unknown; isError?: boolean }> = [],
  replayToolResultsOnMissingPending = false,
  supersedePendingRun = false,
  supersedingTurnAborted = false,
  supersededToolCallIds: string[] = [],
  failureTrace?: FailureTraceCapture,
  fallbackRoute?: ApiFallbackRoute
): Promise<Response> {
  const clientSource = inferClientSource(request.headers);
  const clientPlatform = inferClientPlatform(request.headers);
  const requestPurpose = kind === "responses"
    ? trajectoryRequestPurpose(clientSource, prepared.trajectoryUserInputs ?? [])
    : undefined;
  const trajectoryInputs = kind === "responses"
    ? (prepared.trajectoryUserInputs ?? []).flatMap((content, itemIndex) => {
        try {
          const contentText = traceContentText(content);
          const contentSha256 = createHash("sha256").update(contentText).digest("hex");
          return [{
            source: "user" as const,
            content: contentText,
            contentSha256,
            contentChars: contentText.length,
            itemIndex
          }];
        } catch {
          logTrajectoryObservationError("user_input_hash", "trace_user_input_hash_failed");
          return [];
        }
      })
    : [];
  const trajectoryToolResults = kind === "responses"
    ? resumeToolResults.flatMap((result, itemIndex) => {
        try {
          const contentText = traceContentText(result.output);
          const contentSha256 = createHash("sha256").update(contentText).digest("hex");
          return [{ ...result, contentSha256, contentChars: contentText.length, itemIndex }];
        } catch {
          logTrajectoryObservationError("tool_result_hash", "trace_tool_result_hash_failed");
          return [];
        }
      })
    : [];
  const transcriptItems = kind === "responses" ? prepared.responseInputItems ?? [] : [];
  const transcriptItemCount = transcriptItems.length;
  const replayedTranscriptItemCount = Math.max(
    0,
    transcriptItemCount - trajectoryInputs.length - trajectoryToolResults.length
  );
  let transcriptSha256: string | undefined;
  try {
    transcriptSha256 = createHash("sha256").update(stableTraceJson(transcriptItems)).digest("hex");
  } catch {
    transcriptSha256 = undefined;
    logTrajectoryObservationError("transcript_hash", "trace_transcript_hash_failed");
  }
  const failureTraceContext: FailureTraceJournalContext | undefined = failureTrace
    ? {
        responseId: id,
        model: prepared.model,
        clientSource,
        clientPlatform
      }
    : undefined;
  logToolForwarding(kind, prepared);
  // Maintain one SDK agent per client session "under the hood": attempt 0 reuses the
  // session (stable affinity key) and sends only the new turn (incrementalPrompt). The
  // bridge re-feeds nothing while the agent is still cached and falls back to the full
  // prompt if it was evicted, so context is never lost. A transparent retry (attempt >= 1)
  // uses a FRESH session + the full prompt for a pre-output transient transport failure.
  const trajectoryRequestState = kind === "responses" ? trajectoryRequestSession(session.key) : undefined;
  let previousBridgeRequestId = trajectoryRequestState?.lastRequestId;
  let bridgeAttemptIndex = 0;
  const onBridgeAttempt = (bridgeAttempt: {
    requestId: string;
    sdkSessionKey: string;
    replayCause?: string;
    internalToolCorrection: boolean;
    resumeToolResultsCount: number;
  }) => {
    const attemptIndex = bridgeAttemptIndex;
    bridgeAttemptIndex += 1;
    const replayCause = attemptIndex > 0
      ? bridgeAttempt.replayCause ?? (bridgeAttempt.internalToolCorrection ? "internal_tool_correction" : "bridge_retry")
      : undefined;
    try {
      if (kind === "responses") {
        const inputHashes = [
          ...trajectoryInputs.map((entry) => entry.contentSha256),
          ...(attemptIndex === 0 ? trajectoryToolResults.map((entry) => entry.contentSha256) : [])
        ];
        logTrajectory("trajectory_request", {
          sessionKey: session.key,
          ingressRequestId: id,
          requestId: bridgeAttempt.requestId,
          logicalRequestId: id,
          ...(previousBridgeRequestId ? { parentRequestId: previousBridgeRequestId } : {}),
          sdkSessionKey: bridgeAttempt.sdkSessionKey,
          attemptIndex,
          requestKind: attemptIndex > 0
            ? "retry"
            : supersedePendingRun
              ? "steering"
              : resumeToolResults.length > 0
                ? "continuation"
                : previousBridgeRequestId
                  ? "continuation"
                  : "initial",
          sessionSource: session.source,
          ...(requestPurpose ? { requestPurpose } : {}),
          decision: "forwarded",
          ...(attemptIndex > 0 ? { replayKind: "transport_retry", replayCause } : {}),
          inputHashes,
          inputCount: inputHashes.length,
          userInputCount: trajectoryInputs.length,
          toolResultCount: attemptIndex === 0 ? trajectoryToolResults.length : 0,
          transcriptItemCount,
          replayedTranscriptItemCount,
          transcriptSha256,
          promptSha256: createHash("sha256").update(prepared.prompt.text).digest("hex"),
          promptChars: prepared.promptChars,
          model: prepared.cursorModel,
          clientSource,
          clientPlatform
        });
        if (attemptIndex > 0) {
          logTrajectory("trajectory_replay", {
            sessionKey: session.key,
            requestId: bridgeAttempt.requestId,
            logicalRequestId: id,
            parentRequestId: previousBridgeRequestId,
            replayKind: "transport_retry",
            replayCause,
            inputCount: inputHashes.length,
            inputHashes,
            clientSource,
            clientPlatform
          });
        } else if (replayedTranscriptItemCount > 0) {
          logTrajectory("trajectory_replay", {
            sessionKey: session.key,
            ingressRequestId: id,
            requestId: bridgeAttempt.requestId,
            logicalRequestId: id,
            ...(previousBridgeRequestId ? { parentRequestId: previousBridgeRequestId } : {}),
            replayKind: "client_transcript",
            replayCause: "request_contains_history",
            transcriptItemCount,
            replayedTranscriptItemCount,
            transcriptSha256,
            inputCount: inputHashes.length,
            inputHashes,
            clientSource,
            clientPlatform
          });
        }
      }
    } catch {
      logTrajectoryObservationError("request_recording", "trace_request_record_failed");
    }
    previousBridgeRequestId = bridgeAttempt.requestId;
    if (trajectoryRequestState) {
      trajectoryRequestState.lastRequestId = bridgeAttempt.requestId;
      trajectoryRequestState.touchedAt = Date.now();
    }
    if (failureTraceContext) {
      failureTraceContext.requestId = bridgeAttempt.requestId;
      failureTraceContext.sessionKey = bridgeAttempt.sdkSessionKey;
    }
  };
  const makeStream = async (attempt: number): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env, deps, apiKey, {
      prompt: prepared.prompt,
      systemPrompt: prepared.systemPrompt,
      model: prepared.cursorModel,
      sessionKey: attempt === 0 ? session.key : `retry-${crypto.randomUUID()}`,
      sessionOwnerKey: sdkSessionOwner(apiKey),
      incrementalPrompt: attempt === 0 ? incrementalPrompt : undefined,
      workingDirectory: prepared.toolContext?.workingDirectory,
      clientTools: prepared.tools,
      streamEvents: prepared.stream,
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall),
      resumeToolResults: attempt === 0 ? resumeToolResults : undefined,
      supersedePendingRun: attempt === 0 && supersedePendingRun,
      supersedingTurnAborted: attempt === 0 && supersedingTurnAborted,
      supersededToolCallIds: attempt === 0 ? supersededToolCallIds : undefined,
      fullReplayCause: kind === "responses" && attempt > 0 ? "sidecar_transient_retry" : undefined,
      agentContext: kind === "responses" ? prepared.agentContext : undefined,
      replayToolResultsOnMissingPending: attempt === 0 && replayToolResultsOnMissingPending,
      clientSource,
      clientPlatform,
      ingressRequestId: id,
      trajectorySessionId: session.key,
      trajectoryInputs,
      onBridgeAttempt,
      signal: request.signal
    });
    logCacheObservation(kind, session, incrementalPrompt, prepared, {
      requestId: completion.runId,
      sessionKey: completion.sessionKey,
      attemptIndex: attempt,
      clientSource,
      clientPlatform
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream, resumeToolResults.length > 0 || supersedePendingRun ? 1 : 2, request.signal);

  if (prepared.stream) {
    return streamOpenAiEvents(kind, stream, {
      id,
      created,
      model: prepared.model,
      promptChars: prepared.promptChars,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      tools: prepared.tools,
      context: prepared.toolContext,
      signal: request.signal,
      failureTrace,
      failureTraceContext,
      fallbackRoute,
      trajectory: kind === "responses" ? {
        sessionKey: session.key,
        ingressRequestId: id,
        clientSource,
        clientPlatform
      } : undefined
    });
  }

  let output;
  try {
    output = await collectCursorSdkOutput(stream);
  } catch (error) {
    const fallback = await fallbackRoute?.recover(error, false);
    if (fallback) return fallback;
    if (kind === "responses") {
      logTrajectory("trajectory_error", {
        sessionKey: session.key,
        ingressRequestId: id,
        requestId: failureTraceContext?.requestId,
        errorCode: error instanceof HttpError ? error.code : "cursor_sdk_request_failed",
        phase: "bridge_request",
        retryable: isTransientSdkError(error),
        terminal: true,
        clientSource,
        clientPlatform
      });
    }
    await captureFailureTrace(failureTrace, error, failureTraceContext);
    throw error;
  }
  const toolCalls = toOpenAiToolCalls({
    toolCalls: output.toolCalls,
    tools: prepared.tools,
    responseId: id,
    context: prepared.toolContext
  });

  if (kind === "chat") {
    return json(
      chatCompletionResponse({
        id,
        created,
        model: prepared.model,
        text: output.text,
        toolCalls,
        promptChars: prepared.promptChars,
        usage: output.usage,
        metadata: prepared.responseMetadata
      })
    );
  }

  if (isEmptyResponsesTurn({ text: output.text, toolCallCount: toolCalls.length })) {
    logEmptyResponsesTurn({ id, model: prepared.model, promptChars: prepared.promptChars }, 0);
    const error = new Error(EMPTY_RESPONSES_TURN_MESSAGE);
    await captureFailureTrace(failureTrace, error, failureTraceContext);
    throw error;
  }

  const response = responseObject({
    id,
    created,
    model: prepared.model,
    text: output.text,
    toolCalls,
    promptChars: prepared.promptChars,
    usage: output.usage,
    phase: output.outputType === "final" ? "final_answer" : output.outputType,
    metadata: prepared.responseMetadata
  });
  for (const toolCall of output.toolCalls) {
    if (!toolCall.trajectoryId) continue;
    logTrajectory("trajectory_output_published", {
      sessionKey: session.key,
      ingressRequestId: id,
      requestId: failureTraceContext?.requestId,
      outputId: toolCall.trajectoryId,
      outputType: "tool_call",
      publicationKind: "completed",
      ...(toolCall.executionId ? { executionId: toolCall.executionId } : {}),
      ...(toolCall.runId ? { runId: toolCall.runId } : {}),
      ...(toolCall.agentId ? { agentId: toolCall.agentId } : {}),
      clientSource,
      clientPlatform
    });
  }
  if (output.outputId) {
    logTrajectory("trajectory_output_published", {
      sessionKey: session.key,
      ingressRequestId: id,
      requestId: failureTraceContext?.requestId,
      outputId: output.outputId,
      outputType: output.outputType ?? (output.toolCalls.length > 0 ? "commentary" : "final"),
      publicationKind: "completed",
      ...(output.executionId ? { executionId: output.executionId } : {}),
      ...(output.runId ? { runId: output.runId } : {}),
      ...(output.agentId ? { agentId: output.agentId } : {}),
      clientSource,
      clientPlatform
    });
  }
  return json(response);
}

/** Structured one-line cache observability: which session header arrived, whether an
 * incremental prompt was built, and how large the full prompt was. Pair with the usage
 * numbers reported by the client to judge real cache behaviour. */
function logCacheObservation(
  kind: "chat" | "responses",
  session: SessionAffinityResolution,
  incrementalPrompt: ReturnType<typeof prepareChatRequest>["prompt"] | undefined,
  prepared: PreparedRequest,
  identity: {
    requestId: string;
    sessionKey: string;
    attemptIndex: number;
    clientSource: ClientSource;
    clientPlatform: ClientPlatform;
  }
): void {
  const incrementalChars = incrementalPrompt?.text?.length ?? 0;
  console.log(JSON.stringify({
    tag: "cache-observe",
    kind,
    ...identity,
    model: prepared.cursorModel?.id ?? prepared.model,
    sessionHeaders: session.sessionHeaders.length > 0 ? session.sessionHeaders : ["<none>"],
    sessionSource: session.source,
    incremental: incrementalPrompt ? "yes" : "no",
    promptChars: prepared.promptChars,
    incrementalChars
  }));
}

function logToolForwarding(surface: string, prepared: PreparedRequest): void {
  console.info(JSON.stringify({
    event: "client_tool_forwarding",
    surface,
    mode: prepared.prompt.mode,
    toolCount: prepared.tools.length,
    toolNames: prepared.tools.map((tool) => tool.name),
  }));
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

interface StreamInput {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  includeUsage: boolean;
  metadata?: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  context?: ToolCallContext;
  signal?: AbortSignal;
  failureTrace?: FailureTraceCapture;
  failureTraceContext?: FailureTraceJournalContext;
  fallbackRoute?: ApiFallbackRoute;
  trajectory?: {
    sessionKey: string;
    ingressRequestId: string;
    clientSource: ClientSource;
    clientPlatform: ClientPlatform;
  };
}

interface FailureTraceJournalContext {
  responseId: string;
  model: string;
  clientSource: ClientSource;
  clientPlatform: ClientPlatform;
  requestId?: string;
  sessionKey?: string;
}

function logEmptyResponsesTurn(
  input: Pick<StreamInput, "id" | "model" | "promptChars">,
  textDeltaCount: number
): void {
  console.warn(JSON.stringify({
    event: "empty_responses_turn",
    id: input.id,
    model: input.model,
    textDeltaCount,
    promptChars: input.promptChars
  }));
}

function streamOpenAiEvents(
  kind: "chat" | "responses",
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: StreamInput
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    const writeEvent = async (event: Uint8Array): Promise<void> => {
      await writer.write(event);
      input.failureTrace?.recordSse(event);
    };
    let text = "";
    let toolCallCount = 0;
    let finishReason: "stop" | "tool_calls" = "stop";
    const streamedToolCalls: OpenAiToolCall[] = [];
    let responseNextOutputIndex = 0;
    let responseTextOutputIndex: number | null = null;
    let textDeltaCount = 0;
    let usage: CursorUsage | undefined;
    let terminalOutput: Extract<CursorTextEvent, { type: "done" }> | undefined;
    const publishedPrefixes = new Set<string>();
    let responseStarted = false;
    const startResponse = async () => {
      if (responseStarted) return;
      responseStarted = true;
      if (kind === "chat") {
        await writeEvent(chatChunk({ id: input.id, created: input.created, model: input.model, role: "assistant" }));
      } else {
        for (const event of responseCreatedEvents(input)) await writeEvent(event);
      }
    };
    const logPublished = (
      identity: { outputId?: string; executionId?: string; runId?: string; agentId?: string },
      outputType: "commentary" | "final" | "tool_call" | undefined,
      publicationKind: "prefix" | "completed"
    ) => {
      if (!input.trajectory || !identity.outputId) return;
      logTrajectory("trajectory_output_published", {
        sessionKey: input.trajectory.sessionKey,
        ingressRequestId: input.trajectory.ingressRequestId,
        requestId: input.failureTraceContext?.requestId,
        outputId: identity.outputId,
        ...(outputType ? { outputType } : {}),
        publicationKind,
        ...(identity.executionId ? { executionId: identity.executionId } : {}),
        ...(identity.runId ? { runId: identity.runId } : {}),
        ...(identity.agentId ? { agentId: identity.agentId } : {}),
        clientSource: input.trajectory.clientSource,
        clientPlatform: input.trajectory.clientPlatform
      });
    };
    try {
      if (!input.fallbackRoute) await startResponse();

      for await (const event of cursorEvents) {
        if (event.type === "text" && event.text) {
          await startResponse();
          text += event.text;
          if (kind === "chat") {
            await writeEvent(chatChunk({ id: input.id, created: input.created, model: input.model, delta: event.text }));
          } else {
            if (responseTextOutputIndex === null) {
              responseTextOutputIndex = responseNextOutputIndex;
              responseNextOutputIndex += 1;
              for (const chunk of responseTextStartEvents({ id: input.id, outputIndex: responseTextOutputIndex })) {
                await writeEvent(chunk);
              }
            }
            await writeEvent(responseDeltaEvent({ id: input.id, delta: event.text, outputIndex: responseTextOutputIndex }));
            textDeltaCount += 1;
            if (event.outputId && !publishedPrefixes.has(event.outputId)) {
              publishedPrefixes.add(event.outputId);
              logPublished(event, undefined, "prefix");
            }
          }
        }
        if (event.type === "tool_call") {
          const [toolCall] = toOpenAiToolCalls({
            toolCalls: [event.toolCall],
            tools: input.tools,
            responseId: input.id,
            startIndex: toolCallCount,
            context: input.context
          });
          if (!toolCall) continue;
          await startResponse();
          finishReason = "tool_calls";
          streamedToolCalls.push(toolCall);
          if (kind === "chat") {
            await writeEvent(
              chatChunk({ id: input.id, created: input.created, model: input.model, toolCall: { index: toolCallCount, value: toolCall } })
            );
          } else {
            for (const chunk of responseToolCallEvents({ id: input.id, toolCall, outputIndex: responseNextOutputIndex })) {
              await writeEvent(chunk);
            }
            logPublished({
              outputId: event.toolCall.trajectoryId,
              executionId: event.toolCall.executionId,
              runId: event.toolCall.runId,
              agentId: event.toolCall.agentId
            }, "tool_call", "completed");
            responseNextOutputIndex += 1;
          }
          toolCallCount += 1;
        }
        if (event.type === "done") {
          if (event.finalText.trim().length > 0 || text.length === 0) text = event.finalText;
          usage = event.usage;
          terminalOutput = event;
        }
      }

      await startResponse();
      if (kind === "chat") {
        const completionChars = completionCharsFromOutput(text, streamedToolCalls);
        await writeEvent(chatChunk({ id: input.id, created: input.created, model: input.model, finish: true, finishReason }));
        if (input.includeUsage) {
          await writeEvent(
            chatUsageChunk({
              id: input.id,
              created: input.created,
              model: input.model,
              promptChars: input.promptChars,
              completionChars,
              usage
            })
          );
        }
        await writeEvent(doneChunk());
      } else {
        if (isEmptyResponsesTurn({ text, toolCallCount: streamedToolCalls.length })) {
          logEmptyResponsesTurn(input, textDeltaCount);
          const error = new Error(EMPTY_RESPONSES_TURN_MESSAGE);
          await writeEvent(responseFailedEvent({ ...input, error }));
          return;
        }
        for (const event of responseDoneEvents({
          ...input,
          text,
          toolCalls: streamedToolCalls,
          textStarted: responseTextOutputIndex !== null,
          textOutputIndex: responseTextOutputIndex ?? 0,
          // Text deltas precede the Bridge's tool/terminal classification.
          // Finalize the same item with its confirmed phase for replay and progress delivery.
          phase: terminalOutput?.outputType === "final" ? "final_answer" : terminalOutput?.outputType,
          usage
        })) {
          await writeEvent(event);
        }
        if (terminalOutput?.outputId) {
          logPublished(
            terminalOutput,
            terminalOutput.outputType ?? (streamedToolCalls.length > 0 ? "commentary" : "final"),
            "completed"
          );
        }
      }
    } catch (error) {
      let fallbackPublished = false;
      try {
        const fallback = await input.fallbackRoute?.recover(error, responseStarted);
        if (fallback) {
          if (!fallback.ok) {
            const body = await fallback.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
            throw new HttpError(body.error?.message || "Fallback request failed.", fallback.status,
              body.error?.code || "api_fallback_http_error");
          }
          if (!fallback.headers.get("content-type")?.includes("text/event-stream") || !fallback.body) {
            await fallback.body?.cancel();
            throw new HttpError("Fallback did not return a Responses event stream.", 502, "api_fallback_invalid_stream");
          }
          const reader = fallback.body.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              await writer.write(value);
              fallbackPublished = true;
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          return;
        }
      } catch (recoveryError) {
        if (fallbackPublished) {
          await writer.abort(recoveryError).catch(() => undefined);
          return;
        }
        error = recoveryError;
      }
      await startResponse().catch(() => undefined);
      const message = error instanceof Error ? error.message : "Stream failed";
      await writeEvent(
          kind === "responses"
            ? responseFailedEvent({ ...input, error })
            : encodeSse({ error: { message, type: "cursor_error", code: "cursor_stream_error" } }, "error")
        ).catch(() => undefined);
      if (input.trajectory) {
        logTrajectory("trajectory_error", {
          sessionKey: input.trajectory.sessionKey,
          ingressRequestId: input.trajectory.ingressRequestId,
          requestId: input.failureTraceContext?.requestId,
          errorCode: streamTrajectoryErrorCode(error, input.signal),
          phase: "public_response_stream",
          retryable: isTransientSdkError(error),
          terminal: true,
          clientSource: input.trajectory.clientSource,
          clientPlatform: input.trajectory.clientPlatform
        });
      }
      await captureFailureTrace(input.failureTrace, error, input.failureTraceContext);
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  void pump();
  return sseResponse(readable);
}

async function captureFailureTrace(
  trace: FailureTraceCapture | undefined,
  error: unknown,
  context?: FailureTraceJournalContext
): Promise<void> {
  if (!trace) return;
  try {
    const filePath = await trace.capture(error);
    if (!filePath) return;
    console.warn(JSON.stringify({
      event: "cursor2response_failure_trace_saved",
      ...context,
      file: filePath
    }));
  } catch (captureError) {
    console.warn(JSON.stringify({
      event: "cursor2response_failure_trace_write_failed",
      ...context,
      message: captureError instanceof Error ? captureError.message : String(captureError)
    }));
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

async function route(request: Request, port: number): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "authorization,content-type,x-api-key"
      }
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return notFound();
      return healthResponse(port);
    }

    const v1Path = pathname.startsWith("/v1/") ? pathname.slice(3) : pathname === "/v1" ? "/" : "";

    if (v1Path === "/models") {
      if (request.method !== "GET") return notFound();
      return await handleModels(request);
    }

    const modelMatch = /^\/models\/(.+)$/.exec(v1Path);
    if (modelMatch) {
      if (request.method !== "GET") return notFound();
      return await handleModel(request, decodeURIComponent(modelMatch[1]));
    }

    if (v1Path === "/chat/completions") {
      if (request.method !== "POST") return notFound();
      return await handleChatCompletions(request);
    }

    if (v1Path === "/responses") {
      if (request.method !== "POST") return notFound();
      return await handleResponses(request);
    }

    if (v1Path === "/messages/count_tokens") {
      if (request.method !== "POST") return notFound();
      return await handleCountTokens(request);
    }

    if (v1Path === "/messages") {
      if (request.method !== "POST") return notFound();
      return await handleAnthropicMessages(request);
    }

    return notFound();
  } catch (error) {
    return errorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

function parsePort(): number {
  const raw = process.env.PORT;
  if (!raw) return DEFAULT_PORT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
}

async function main(): Promise<void> {
  const port = parsePort();
  if (hasSdkBridge()) {
    await initializeFailureTraceStore(failureTraceStoreOptions).catch((error) => {
      console.warn(JSON.stringify({
        event: "cursor2response_failure_trace_init_failed",
        message: error instanceof Error ? error.message : String(error)
      }));
    });
  }
  const server = createSidecarServer((request) => route(request, port));
  server.listen(port, HOST, () => {
    console.log(`cursor2response server running at http://${HOST}:${port}/v1`);
  });
}

void main();
