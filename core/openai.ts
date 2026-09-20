import { HttpError } from "./http.ts";
import { encodeSse } from "./sse.ts";
import type { CursorUsage } from "./cursor.ts";
import type { CursorImage, CursorPrompt, CursorToolCall } from "./types.ts";

export type ApiKind = "chat" | "responses";

export interface PreparedRequest {
  model: string;
  cursorModel?: { id: string };
  prompt: CursorPrompt;
  systemPrompt?: string;
  stream: boolean;
  includeUsage: boolean;
  promptChars: number;
  responseMetadata: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  previousResponseId?: string;
  responseInputItems?: unknown[];
  trajectoryUserInputs?: string[];
  agentContext?: ResponsesAgentContextSource;
  toolContext?: ToolCallContext;
}

export interface ResponsesAgentContextSource {
  bootstrap: string;
  transcriptItems: Array<{
    value: unknown;
    offset: number;
    imageCount: number;
  }>;
  transcriptEndOffset: number;
  promptTextChars: number;
}

export interface OpenAiToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ToolCallContext {
  workingDirectory?: string;
}

export interface CursorSdkToolResult {
  callId?: string;
  output: unknown;
  isError?: boolean;
}

export interface ResponsesToolContinuation {
  results: CursorSdkToolResult[];
  followUpInput: unknown[];
  supersedePendingRun: boolean;
  supersedingTurnAborted: boolean;
  supersededToolCallIds: string[];
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export function chatToolResults(body: unknown): CursorSdkToolResult[] {
  const messages = (body as { messages?: unknown[] } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  const results: CursorSdkToolResult[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!isRecord(item) || item.role !== "tool") break;
    results.push({
      callId: typeof item.tool_call_id === "string" ? item.tool_call_id : undefined,
      output: item.content
    });
  }
  return results.reverse();
}

export function responseToolResults(body: unknown): CursorSdkToolResult[] {
  return responseToolContinuation(body).results;
}

export function responseToolContinuation(
  body: unknown,
  options: { previousOutput?: unknown[]; previousInputItems?: unknown[] } = {}
): ResponsesToolContinuation {
  const rawInput = (body as { input?: unknown } | null)?.input;
  if (rawInput === undefined || rawInput === null) {
    return {
      results: [],
      followUpInput: [],
      supersedePendingRun: false,
      supersedingTurnAborted: false,
      supersededToolCallIds: []
    };
  }
  const rawItems = responseInputArray(rawInput);
  const input = responseInputArray(responseInputWithPrevious(rawItems, options));
  let lastToolCall = -1;
  let lastUser = -1;
  for (const [index, item] of input.entries()) {
    if (isResponseToolCall(item)) lastToolCall = index;
    if (isResponseUserMessage(item)) lastUser = index;
  }
  if (lastToolCall >= 0 && lastUser > lastToolCall) {
    let firstFollowUpUser = lastToolCall + 1;
    while (firstFollowUpUser <= lastUser && !isResponseUserMessage(input[firstFollowUpUser])) {
      firstFollowUpUser += 1;
    }
    let batchStart = lastToolCall;
    while (batchStart > 0) {
      const previousItem = input[batchStart - 1];
      if (isResponseUserMessage(previousItem) || isResponseToolOutput(previousItem)) break;
      batchStart -= 1;
    }
    const callIds = input
      .slice(batchStart, lastToolCall + 1)
      .filter(isResponseToolCall)
      .map((item) => typeof item.call_id === "string" ? item.call_id.trim() : "")
      .filter((callId): callId is string => Boolean(callId));
    const supersededToolCallIds = [...new Set(callIds)];
    const supersededCallIdSet = new Set(supersededToolCallIds);
    let lastAssistant = -1;
    let lastMatchingToolOutput = -1;
    let lastTurnAbortedMarker = -1;
    for (let index = lastToolCall + 1; index < firstFollowUpUser; index += 1) {
      if (isResponseAssistantMessage(input[index])) lastAssistant = index;
      const result = responseToolResult(input[index]);
      if (result?.callId && supersededCallIdSet.has(result.callId)) lastMatchingToolOutput = index;
      if (isResponseTurnAbortedMarker(input[index])) lastTurnAbortedMarker = index;
    }
    if (
      lastAssistant >= 0
      && lastAssistant > lastMatchingToolOutput
      && lastTurnAbortedMarker < lastAssistant
    ) {
      return {
        results: [],
        followUpInput: [],
        supersedePendingRun: false,
        supersedingTurnAborted: false,
        supersededToolCallIds: []
      };
    }
    if (supersededToolCallIds.length > 0) {
      const results = input
        .slice(batchStart, firstFollowUpUser)
        .flatMap((item) => {
          const result = responseToolResult(item);
          return result?.callId && supersededCallIdSet.has(result.callId) ? [result] : [];
        });
      let boundary = lastToolCall;
      for (let index = lastToolCall + 1; index < firstFollowUpUser; index += 1) {
        if (isResponseToolOutput(input[index])) boundary = index;
      }
      return {
        results,
        followUpInput: input.slice(boundary + 1),
        supersedePendingRun: true,
        supersedingTurnAborted: lastTurnAbortedMarker >= 0,
        supersededToolCallIds
      };
    }
  }

  const results: CursorSdkToolResult[] = [];
  let index = rawItems.length - 1;
  while (index >= 0) {
    const item = rawItems[index];
    if (!isRecord(item)) break;
    if (item.role !== "system" && item.role !== "developer") break;
    index -= 1;
  }
  for (; index >= 0; index -= 1) {
    const result = responseToolResult(rawItems[index]);
    if (!result) break;
    results.push(result);
  }
  results.reverse();
  return {
    results,
    followUpInput: [],
    supersedePendingRun: false,
    supersedingTurnAborted: false,
    supersededToolCallIds: []
  };
}

function responseToolResult(item: unknown): CursorSdkToolResult | undefined {
  if (!isResponseToolOutput(item)) return undefined;
  return {
    callId: typeof item.call_id === "string" ? item.call_id : undefined,
    output: item.output,
    isError: item.type === "custom_tool_call_output" && item.is_error === true
  };
}

function isResponseToolCall(item: unknown): item is Record<string, unknown> {
  return isRecord(item) && (item.type === "function_call" || item.type === "custom_tool_call");
}

function isResponseToolOutput(item: unknown): item is Record<string, unknown> {
  return isRecord(item) && (item.type === "function_call_output" || item.type === "custom_tool_call_output");
}

function isResponseUserMessage(item: unknown): boolean {
  return typeof item === "string"
    || (isRecord(item) && item.role === "user" && (item.type === undefined || item.type === "message"));
}

function isResponseAssistantMessage(item: unknown): boolean {
  return isRecord(item)
    && item.role === "assistant"
    && (item.type === undefined || item.type === "message");
}

function isResponseTurnAbortedMarker(item: unknown): boolean {
  return isRecord(item)
    && item.role === "developer"
    && responseInputText(item.content).includes("<turn_aborted>");
}

export function prepareResponsesFollowUpPrompt(
  body: unknown,
  cursorModel: { id: string } | undefined,
  followUpInput: unknown[]
): CursorPrompt | undefined {
  if (followUpInput.length === 0) return undefined;
  const prepared = prepareResponsesRequest({
    ...expectRecord(body, "body"),
    input: followUpInput,
    stream: false
  }, cursorModel);
  return {
    ...prepared.prompt,
    text: `INPUT:\n${prepared.prompt.text.slice(prepared.agentContext!.bootstrap.length)}`
  };
}

export function responseToolResultsCanReplay(
  body: unknown,
  options: { previousOutput?: unknown[]; previousInputItems?: unknown[] } = {}
): boolean {
  const results = responseToolResults(body);
  const resultCallIds = results
    .map((result) => result.callId?.trim())
    .filter((callId): callId is string => Boolean(callId));
  if (!results.length || resultCallIds.length !== results.length || new Set(resultCallIds).size !== resultCallIds.length) {
    return false;
  }

  const input = responseInputArray(responseInputWithPrevious(
    (body as { input?: unknown } | null)?.input,
    options
  ));
  const callIndexes = new Map<string, number[]>();
  const outputIndexes = new Map<string, number[]>();
  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) continue;
    const callId = typeof item.call_id === "string" ? item.call_id.trim() : "";
    if (!callId) continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      callIndexes.set(callId, [...(callIndexes.get(callId) ?? []), index]);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      outputIndexes.set(callId, [...(outputIndexes.get(callId) ?? []), index]);
    }
  }

  return resultCallIds.every((callId) => {
    const matchingCalls = callIndexes.get(callId) ?? [];
    const matchingOutputs = outputIndexes.get(callId) ?? [];
    return matchingCalls.length === 1 && matchingOutputs.length === 1 && matchingCalls[0] < matchingOutputs[0];
  });
}

interface ToolParameterSchemaShape {
  properties: string[];
  required: string[];
  allowAdditionalProperties: boolean;
  propertySchemas: Record<string, unknown>;
}

interface CursorModelPricing {
  input: number;
  output: number;
  source: string;
}

interface SdkToolCallMemory {
  name: string;
  args: Record<string, unknown>;
}

const sdkToolCallMemory = new Map<string, SdkToolCallMemory>();
const SDK_TOOL_CALL_MEMORY_LIMIT = 2048;

const CURSOR_COMPOSER_2_5_PRICING_SOURCE = "https://cursor.com/changelog/composer-2-5";
const CURSOR_MODEL_PRICING: Record<string, CursorModelPricing> = {
  default: { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  auto: { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-latest": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2.5": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2.5-sdk": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2-5": { input: 0.5, output: 2.5, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2.5-fast": { input: 3, output: 15, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE },
  "composer-2-5-fast": { input: 3, output: 15, source: CURSOR_COMPOSER_2_5_PRICING_SOURCE }
};

const SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request through Cursor Composer.",
  "Answer the user directly in chat style.",
  "Do not modify files, run terminal commands, open pull requests, or use coding-agent workflow unless the user explicitly asks for code as text.",
  "Return only the final answer content."
].join("\n");

const TOOL_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request through Cursor Composer.",
  "This request is already in Agent mode because the client provided executable tools.",
  "Client tools are registered natively with Cursor SDK. Call the exact provided tool name when local work is required.",
  "Answer directly only when no tool is needed.",
  "Do not emit duplicate tool calls. Call each required operation once, then continue after the client returns the tool result.",
  "Never claim that tools are unavailable. Never tell the user to switch modes."
].join("\n");

const AGENT_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI-compatible API request through Cursor Composer.",
  "This request is already in Agent mode.",
  "Answer directly when no tool is needed.",
  "Never tell the user to switch modes."
].join("\n");

const RESPONSES_TOOL_SYSTEM_DIRECTIVE = [
  "You are serving an OpenAI Responses API request through Cursor Composer.",
  "The client owns local tool execution. When local inspection, shell commands, or file changes are needed, request a tool call and wait for its returned output.",
  "Client tools are registered natively with Cursor SDK. Call the exact provided tool name directly.",
  "Do not claim that you created, edited, inspected, or ran anything locally unless you emitted a function_call and received a function_call_output confirming it.",
  "When starting a dev server or other long-running watcher, start it in the background with output redirected and return immediately.",
  "Do not say that agent mode or tools are unavailable."
].join("\n");

export function prepareChatRequest(body: unknown, cursorModel: { id: string } | undefined, options: { forceAgentMode?: boolean } = {}): PreparedRequest {
  const record = expectRecord(body, "body");
  const messages = expectArray(record.messages, "messages");
  validateCommonUnsupported(record);
  if (record.functions !== undefined) {
    throw new HttpError("Legacy function calling is not supported by this adapter.", 400, "unsupported_parameter", "functions");
  }

  const tools = record.tool_choice === "none" ? [] : parseChatTools(record.tools);
  const toolContext = toolCallContextFromMessages(messages);
  const agentMode = options.forceAgentMode === true || tools.length > 0;
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : "composer-2.5";
  const transcript: string[] = [tools.length ? TOOL_SYSTEM_DIRECTIVE : agentMode ? AGENT_SYSTEM_DIRECTIVE : SYSTEM_DIRECTIVE];
  appendNativeToolChoice(transcript, tools, record.tool_choice);
  transcript.push("", "Conversation:");
  const images: CursorImage[] = [];
  for (const message of messages) {
    const item = expectRecord(message, "messages[]");
    const role = typeof item.role === "string" ? item.role : "user";
    const { text, images: messageImages } = contentToTextAndImages(item.content, role);
    images.push(...messageImages);
    if (role === "tool") {
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id : "";
      const toolName = typeof item.name === "string" ? item.name : "";
      const label = [toolName ? `name=${toolName}` : "", toolCallId ? `tool_call_id=${toolCallId}` : ""].filter(Boolean).join(" ");
      transcript.push(`TOOL RESULT${label ? ` (${label})` : ""}: ${text || "[empty]"}`);
    } else {
      transcript.push(`${role.toUpperCase()}: ${text || "[empty]"}`);
    }
    if (Array.isArray(item.tool_calls)) {
      transcript.push(`${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(item.tool_calls)}`);
    }
  }
  appendChatOptions(transcript, record);
  const text = transcript.join("\n");
  return {
    model,
    cursorModel,
    prompt: { text, mode: agentMode ? "agent" : "ask", ...(images.length ? { images } : {}) },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: text.length,
    responseMetadata: {
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p)
    },
    tools,
    toolContext
  };
}

export function prepareOpencodeSdkChatRequest(body: unknown, cursorModel: { id: string } | undefined): PreparedRequest {
  const record = expectRecord(body, "body");
  const messages = expectArray(record.messages, "messages");
  validateCommonUnsupported(record);
  if (record.functions !== undefined) {
    throw new HttpError("Legacy function calling is not supported by this adapter.", 400, "unsupported_parameter", "functions");
  }

  const tools = record.tool_choice === "none" ? [] : parseChatTools(record.tools);
  const toolContext = toolCallContextFromMessages(messages);
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : "composer-2.5";
  const transcript: string[] = [
    "You are running through an SDK-compatible OpenCode harness.",
    "OpenCode owns local tool execution. When local inspection, shell commands, or file changes are needed, request a tool call and wait for the tool result.",
    "When the conversation includes LOCAL OPENCODE TOOL RESULT records, treat them as completed SDK tool_call results for your previous tool requests and continue from those results.",
    "Client tools are registered natively with Cursor SDK. Call the exact provided tool name when local work is required.",
    "For creating new files when no specific client tool is requested, request write calls with both path and fileText. Do not use edit for new files or emit edit calls without complete replacement details.",
    "For project scaffolding when no specific client tool is requested, prefer shell with a complete command that creates files using heredocs, installs dependencies, and runs tests; shell requires the command argument.",
    "When starting a dev server or other long-running watcher, start it in the background with output redirected and return immediately; do not request a foreground server command.",
    "Do not say that agent mode or tools are unavailable. Do not ask the user to switch modes."
  ];
  appendNativeToolChoice(transcript, tools, record.tool_choice);
  transcript.push("", "Conversation:");

  const images: CursorImage[] = [];
  const toolCallById = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages) {
    const item = expectRecord(message, "messages[]");
    const role = typeof item.role === "string" ? item.role : "user";
    const { text, images: messageImages } = contentToTextAndImages(item.content, role);
    images.push(...messageImages);
    if (role === "tool") {
      const toolCallId = typeof item.tool_call_id === "string" ? item.tool_call_id : "";
      const toolName = typeof item.name === "string" ? item.name : "";
      const label = [toolName ? `name=${toolName}` : "", toolCallId ? `tool_call_id=${toolCallId}` : ""].filter(Boolean).join(" ");
      transcript.push(`TOOL RESULT${label ? ` (${label})` : ""}: ${text || "[empty]"}`);
      transcript.push(`LOCAL OPENCODE TOOL RESULT: ${JSON.stringify(sdkToolResultFeedback(toolCallId, toolName, text, toolCallById, tools))}`);
    } else {
      transcript.push(`${role.toUpperCase()}: ${text || "[empty]"}`);
    }
    if (Array.isArray(item.tool_calls)) {
      transcript.push(`${role.toUpperCase()} TOOL_CALLS: ${JSON.stringify(item.tool_calls)}`);
      rememberOpenCodeToolCalls(item.tool_calls, toolCallById);
    }
  }
  appendChatOptions(transcript, record);
  const text = transcript.join("\n");
  return {
    model,
    cursorModel,
    prompt: { text, mode: "agent", ...(images.length ? { images } : {}) },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: text.length,
    responseMetadata: {
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p)
    },
    tools,
    toolContext
  };
}

export function prepareResponsesRequest(
  body: unknown,
  cursorModel: { id: string } | undefined,
  options: { previousOutput?: unknown[]; previousInputItems?: unknown[] } = {}
): PreparedRequest {
  const record = expectRecord(body, "body");
  validateCommonUnsupported(record);
  if (record.background === true) {
    throw new HttpError("background responses are not supported.", 400, "unsupported_parameter", "background");
  }
  if (record.store === true) {
    throw new HttpError("Response storage is not supported.", 400, "unsupported_parameter", "store");
  }
  validateResponsesToolChoice(record.tool_choice);
  validateResponsesReasoning(record.reasoning);
  if (record.system_prompt !== undefined && record.system_prompt !== false
    && (typeof record.system_prompt !== "string" || !record.system_prompt.trim())) {
    throw new HttpError("system_prompt must be false or a non-empty string.", 400, "invalid_request_error", "system_prompt");
  }
  const systemPrompt = typeof record.system_prompt === "string" ? record.system_prompt : undefined;

  const tools = record.tool_choice === "none"
    ? []
    : dedupeToolSpecs([
        ...parseChatTools(record.tools),
        ...parseChatTools(responseAdditionalTools(record.input))
      ]);
  const toolContext = toolCallContextFromResponseInput(record.input, record.instructions);
  const model = typeof record.model === "string" && record.model.trim() ? record.model.trim() : "composer-2.5";
  const transcript: string[] = [
    tools.length ? RESPONSES_TOOL_SYSTEM_DIRECTIVE : SYSTEM_DIRECTIVE,
    "TOOL RESULT records are already executed by the client. Match each result to its ASSISTANT TOOL_CALLS entry by tool_call_id; continue from the result without repeating the operation. is_error=true marks a failed result."
  ];
  const instructions = typeof record.instructions === "string" ? record.instructions.trim() : "";
  if (instructions) transcript.push("", `INSTRUCTIONS:\n${instructions}`);
  transcript.push("", "INPUT:");
  const bootstrap = `${transcript.join("\n")}\n`;
  const effectiveInput = responseInputWithPrevious(record.input, options);
  validateResponseReasoningInput(effectiveInput);
  const renderedInput = responseInputToTextAndImages(effectiveInput);
  let prompt = bootstrap;
  const transcriptItems = renderedInput.items.map((item, index) => {
    if (index > 0) prompt += "\n";
    const offset = prompt.length;
    prompt += item.text;
    return { value: item.value, offset, imageCount: item.images.length };
  });
  if (transcriptItems.length === 0) prompt += "[empty]";
  const transcriptEndOffset = prompt.length;
  const responseOptions: string[] = [];
  appendResponseOptions(responseOptions, record);
  if (responseOptions.length > 0) prompt += `\n${responseOptions.join("\n")}`;
  const previousResponseId = typeof record.previous_response_id === "string" && record.previous_response_id.trim()
    ? record.previous_response_id.trim()
    : undefined;
  return {
    model,
    cursorModel,
    prompt: {
      text: prompt,
      mode: tools.length ? "agent" : "ask",
      ...(renderedInput.images.length ? { images: renderedInput.images } : {})
    },
    stream: record.stream === true,
    includeUsage: includeStreamUsage(record),
    promptChars: prompt.length,
    systemPrompt,
    responseMetadata: {
      instructions: instructions || null,
      max_output_tokens: integerOrNull(record.max_output_tokens),
      temperature: numberOrNull(record.temperature),
      top_p: numberOrNull(record.top_p),
      text: isRecord(record.text) ? record.text : { format: { type: "text" } },
      previous_response_id: previousResponseId || null,
      store: false,
      ...(tools.length ? { tools: responseToolMetadata(tools), tool_choice: responseToolChoiceMetadata(record.tool_choice) } : {})
    },
    tools,
    previousResponseId,
    responseInputItems: normalizedResponseInputItems(record.input),
    trajectoryUserInputs: responsesTrajectoryUserInputs(record.input),
    agentContext: {
      bootstrap,
      transcriptItems,
      transcriptEndOffset,
      promptTextChars: prompt.length
    },
    toolContext
  };
}

export function chatCompletionResponse(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  usage?: CursorUsage;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const toolCalls = input.toolCalls ?? [];
  const completionChars = completionCharsFromOutput(input.text, toolCalls);
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length && !input.text ? null : input.text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          refusal: null,
          annotations: []
        },
        logprobs: null,
        finish_reason: toolCalls.length ? "tool_calls" : "stop"
      }
    ],
    usage: usageFromChars(input.model, input.promptChars, completionChars, input.usage),
    service_tier: "default",
    system_fingerprint: null,
    ...input.metadata
  };
}

export function responseObject(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  phase?: "commentary" | "final_answer";
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  usage?: CursorUsage;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const messageId = `msg_${input.id.slice(5)}`;
  const output: Record<string, unknown>[] = [];
  if (input.text || !input.toolCalls?.length) {
    output.push({
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      ...(input.phase ? { phase: input.phase } : {}),
      content: [
        {
          type: "output_text",
          text: input.text,
          annotations: []
        }
      ]
    });
  }
  for (const [index, toolCall] of (input.toolCalls ?? []).entries()) {
    const customCall = codeModeCustomToolCall(toolCall);
    output.push(customCall
      ? {
          id: `ctc_${input.id.slice(5)}_${index}`,
          type: "custom_tool_call",
          status: "completed",
          call_id: toolCall.id,
          name: customCall.name,
          input: customCall.input
        }
      : {
          id: `fc_${input.id.slice(5)}_${index}`,
          type: "function_call",
          status: "completed",
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        });
  }
  const outputChars = completionCharsFromOutput(input.text, input.toolCalls ?? []);
  return {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: "completed",
    completed_at: Math.max(input.created, Math.floor(Date.now() / 1000)),
    error: null,
    incomplete_details: null,
    model: input.model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: responseUsageFromChars(input.model, input.promptChars, outputChars, input.usage),
    user: null,
    metadata: {},
    ...input.metadata
  };
}

function responseToolMetadata(tools: OpenAiToolSpec[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    ...(tool.outputSchema !== undefined ? { output_schema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {})
  }));
}

function responseToolChoiceMetadata(toolChoice: unknown): unknown {
  return toolChoice === undefined ? "auto" : toolChoice;
}

export function chatChunk(input: {
  id: string;
  created: number;
  model: string;
  delta?: string;
  role?: "assistant";
  toolCall?: { index: number; value: OpenAiToolCall };
  finish?: boolean;
  finishReason?: "stop" | "tool_calls";
}): Uint8Array {
  const delta = input.finish
    ? {}
    : {
        ...(input.role ? { role: input.role } : {}),
        ...(input.delta ? { content: input.delta } : {}),
        ...(input.toolCall
          ? {
              tool_calls: [
                {
                  index: input.toolCall.index,
                  id: input.toolCall.value.id,
                  type: input.toolCall.value.type,
                  function: input.toolCall.value.function
                }
              ]
            }
          : {})
      };
  const chunk = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: input.finish ? input.finishReason || "stop" : null
      }
    ]
  };
  return encodeSse(chunk);
}

export function doneChunk(): Uint8Array {
  return encodeSse("[DONE]");
}

export function chatUsageChunk(input: {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  completionChars: number;
  usage?: CursorUsage;
}): Uint8Array {
  return encodeSse({
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [],
    usage: usageFromChars(input.model, input.promptChars, input.completionChars, input.usage)
  });
}

export function responseCreatedEvents(input: { id: string; created: number; model: string; metadata?: Record<string, unknown> }): Uint8Array[] {
  const base = {
    id: input.id,
    object: "response",
    created_at: input.created,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    model: input.model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
    ...input.metadata
  };
  return [
    encodeSse({ type: "response.created", response: base }, "response.created"),
    encodeSse({ type: "response.in_progress", response: base }, "response.in_progress")
  ];
}

export function responseFailedEvent(input: {
  id: string;
  created: number;
  model: string;
  error: unknown;
  metadata?: Record<string, unknown>;
  sequenceNumber?: number;
}): Uint8Array {
  const status = input.error instanceof HttpError ? input.error.status : 500;
  const code = input.error instanceof HttpError ? input.error.code : "cursor_stream_error";
  const message = input.error instanceof Error ? input.error.message : "Stream failed";
  const param = input.error instanceof HttpError ? input.error.param ?? null : null;
  return encodeSse(
    {
      type: "response.failed",
      sequence_number: input.sequenceNumber ?? 0,
      response: {
        id: input.id,
        object: "response",
        created_at: input.created,
        status: "failed",
        error: {
          type: "cursor_error",
          code,
          message,
          param,
          status_code: status
        },
        incomplete_details: null,
        model: input.model,
        output: [],
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        tool_choice: "auto",
        tools: [],
        truncation: "disabled",
        usage: null,
        user: null,
        metadata: {},
        ...input.metadata
      }
    },
    "response.failed"
  );
}

/**
 * A Cursor turn that ends with neither text nor tool calls carries no answer. The
 * upstream SDK does this occasionally (`output_text.done` with no preceding delta),
 * and synthesising an empty assistant message here would hand callers a
 * protocol-valid reply whose content is blank, which reads downstream as a
 * successful-but-silent turn instead of a failed one.
 */
export function isEmptyResponsesTurn(input: { text: string; toolCallCount: number }): boolean {
  return input.toolCallCount === 0 && input.text.trim().length === 0;
}

export const EMPTY_RESPONSES_TURN_MESSAGE =
  "Cursor returned no assistant content for this turn (no output text and no tool calls)";

export function responseTextStartEvents(input: { id: string; outputIndex: number }): Uint8Array[] {
  const item = {
    id: `msg_${input.id.slice(5)}`,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: []
  };
  return [
    encodeSse({ type: "response.output_item.added", output_index: input.outputIndex, item }, "response.output_item.added"),
    encodeSse(
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: input.outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      },
      "response.content_part.added"
    )
  ];
}

export function responseDeltaEvent(input: { id: string; delta: string; outputIndex?: number }): Uint8Array {
  return encodeSse(
    {
      type: "response.output_text.delta",
      item_id: `msg_${input.id.slice(5)}`,
      output_index: input.outputIndex ?? 0,
      content_index: 0,
      delta: input.delta
    },
    "response.output_text.delta"
  );
}

export function responseToolCallEvents(input: { id: string; toolCall: OpenAiToolCall; outputIndex: number }): Uint8Array[] {
  const customCall = codeModeCustomToolCall(input.toolCall);
  if (customCall) {
    const item = {
      id: `ctc_${input.id.slice(5)}_${input.outputIndex}`,
      type: "custom_tool_call",
      status: "in_progress",
      call_id: input.toolCall.id,
      name: customCall.name,
      input: ""
    };
    const doneItem = { ...item, status: "completed", input: customCall.input };
    return [
      encodeSse({ type: "response.output_item.added", output_index: input.outputIndex, item }, "response.output_item.added"),
      encodeSse(
        {
          type: "response.custom_tool_call_input.delta",
          item_id: item.id,
          output_index: input.outputIndex,
          delta: customCall.input
        },
        "response.custom_tool_call_input.delta"
      ),
      encodeSse(
        {
          type: "response.custom_tool_call_input.done",
          item_id: item.id,
          output_index: input.outputIndex,
          input: customCall.input
        },
        "response.custom_tool_call_input.done"
      ),
      encodeSse({ type: "response.output_item.done", output_index: input.outputIndex, item: doneItem }, "response.output_item.done")
    ];
  }
  const item = {
    id: `fc_${input.id.slice(5)}_${input.outputIndex}`,
    type: "function_call",
    status: "in_progress",
    call_id: input.toolCall.id,
    name: input.toolCall.function.name,
    arguments: ""
  };
  const doneItem = { ...item, status: "completed", arguments: input.toolCall.function.arguments };
  return [
    encodeSse({ type: "response.output_item.added", output_index: input.outputIndex, item }, "response.output_item.added"),
    encodeSse(
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: input.outputIndex,
        delta: input.toolCall.function.arguments
      },
      "response.function_call_arguments.delta"
    ),
    encodeSse(
      {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: input.outputIndex,
        arguments: input.toolCall.function.arguments
      },
      "response.function_call_arguments.done"
    ),
    encodeSse({ type: "response.output_item.done", output_index: input.outputIndex, item: doneItem }, "response.output_item.done")
  ];
}

function codeModeCustomToolCall(toolCall: OpenAiToolCall): { name: string; input: string } | undefined {
  if (normalizeToolName(toolCall.function.name) !== "exec") return undefined;
  const args = parseToolCallArguments(toolCall.function.arguments);
  const code = firstStringArgAllowEmpty(args, "code", "input", "source");
  return code === undefined ? undefined : { name: toolCall.function.name, input: code };
}

export function responseDoneEvents(input: {
  id: string;
  created: number;
  model: string;
  text: string;
  phase?: "commentary" | "final_answer";
  toolCalls?: OpenAiToolCall[];
  promptChars: number;
  usage?: CursorUsage;
  metadata?: Record<string, unknown>;
  textStarted?: boolean;
  textOutputIndex?: number;
}): Uint8Array[] {
  const itemId = `msg_${input.id.slice(5)}`;
  const part = { type: "output_text", text: input.text, annotations: [] };
  const item = {
    id: itemId, type: "message", status: "completed", role: "assistant",
    ...(input.phase ? { phase: input.phase } : {}),
    content: [part]
  };
  const textEvents = input.textStarted || !(input.toolCalls ?? []).length ? [
    encodeSse(
      { type: "response.output_text.done", item_id: itemId, output_index: input.textOutputIndex ?? 0, content_index: 0, text: input.text },
      "response.output_text.done"
    ),
    encodeSse(
      { type: "response.content_part.done", item_id: itemId, output_index: input.textOutputIndex ?? 0, content_index: 0, part },
      "response.content_part.done"
    ),
    encodeSse({ type: "response.output_item.done", output_index: input.textOutputIndex ?? 0, item }, "response.output_item.done")
  ] : [];
  return [
    ...textEvents,
    encodeSse(
      { type: "response.completed", response: responseObject(input) },
      "response.completed"
    )
  ];
}

export function modelList(options: { opencode?: boolean; sdk?: boolean } = {}): Record<string, unknown> {
  return {
    object: "list",
    data: [
      modelItem("default", "Auto"),
      modelItem("composer-2.5", options.opencode ? "Composer 2.5" : "Cursor Composer 2.5"),
      ...(options.sdk ? [modelItem("composer-2.5-sdk", "Composer 2.5 SDK Harness")] : []),
      modelItem("composer-2.5-fast", "Cursor Composer 2.5 Fast"),
      modelItem("composer-2", "Cursor Composer 2"),
      modelItem("composer-latest", "Cursor Composer latest alias"),
      modelItem("gpt-5.3-codex", "Codex 5.3"),
      modelItem("gpt-5.2-codex", "Codex 5.2"),
      modelItem("gpt-5.1-codex-max", "Codex 5.1 Max"),
      modelItem("gpt-5.1-codex-mini", "Codex 5.1 Mini"),
      modelItem("gpt-5.2", "GPT-5.2"),
      modelItem("gpt-5.1", "GPT-5.1"),
      modelItem("gpt-5-mini", "GPT-5 Mini"),
      modelItem("gemini-3.1-pro", "Gemini 3.1 Pro"),
      modelItem("gemini-3.5-flash", "Gemini 3.5 Flash"),
      modelItem("gemini-3-flash", "Gemini 3 Flash"),
      modelItem("gemini-2.5-flash", "Gemini 2.5 Flash"),
      modelItem("grok-build-0.1", "Grok Build 0.1"),
      modelItem("grok-4.3", "Grok 4.3"),
      modelItem("kimi-k2.5", "Kimi K2.5")
    ]
  };
}

export function toOpenAiToolCalls(input: {
  toolCalls: CursorToolCall[];
  tools?: OpenAiToolSpec[];
  responseId: string;
  startIndex?: number;
  context?: ToolCallContext;
}): OpenAiToolCall[] {
  const tools = input.tools ?? [];
  return input.toolCalls.flatMap((toolCall, offset) => {
    const index = (input.startIndex ?? 0) + offset;
    const normalizedToolCall = normalizeSdkToolCall(toolCall);
    const tool = resolveToolSpec(normalizedToolCall.name, normalizedToolCall.arguments ?? {}, tools);
    if (!tool && tools.length > 0) return [];
    const name = tool?.name ?? normalizedToolCall.name;
    const sdkCanonical = canonicalToolName(normalizedToolCall.name);
    const toolArguments = normalizeToolArguments(normalizedToolCall.arguments ?? {}, tool, normalizedToolCall.name, 0, input.context);
    if (tool && !toolArgumentsSatisfySchema(toolArguments, tool)) return [];
    const id = typeof normalizedToolCall.callId === "string" && /^call_sdk_[a-f0-9]{32}_[A-Za-z0-9_-]{1,16}$/.test(normalizedToolCall.callId)
      ? normalizedToolCall.callId
      : `call_${input.responseId.replace(/[^A-Za-z0-9]/g, "").slice(-18)}_${sdkCanonical}_${index}`;
    rememberSdkToolCall(id, normalizedToolCall.name, normalizedToolCall.arguments ?? {});
    return [{
      id,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(toolArguments)
      }
    }];
  });
}

export function toolCallRetryHint(input: {
  toolCall: CursorToolCall;
  tools?: OpenAiToolSpec[];
  context?: ToolCallContext;
}): string {
  const tools = input.tools ?? [];
  const normalizedToolCall = normalizeSdkToolCall(input.toolCall);
  const args = normalizedToolCall.arguments ?? {};
  const tool = resolveToolSpec(normalizedToolCall.name, args, tools);
  if (!tool) {
    if (!tools.length) return `No client tool inventory was available for SDK ${normalizedToolCall.name}.`;
    return `SDK ${normalizedToolCall.name} did not match any client tool. Available client tools: ${tools.map((item) => item.name).join(", ")}.`;
  }
  const toolArguments = normalizeToolArguments(args, tool, normalizedToolCall.name, 0, input.context);
  if (toolArgumentsSatisfySchema(toolArguments, tool)) {
    return `SDK ${normalizedToolCall.name} maps to client ${tool.name}; retry with complete arguments for that route.`;
  }
  return [
    `SDK ${normalizedToolCall.name} mapped to client ${tool.name}, but normalized arguments do not satisfy the client JSON schema.`,
    `Normalized arguments: ${safeJsonForPrompt(toolArguments)}.`,
    `Required client arguments: ${toolRequiredArgumentSummary(tool)}.`,
    `Client schema properties: ${toolSchemaPropertySummary(tool)}.`
  ].join(" ");
}

function rememberSdkToolCall(id: string, name: string, args: Record<string, unknown>) {
  sdkToolCallMemory.set(id, { name: canonicalToolName(name), args: { ...args } });
  if (sdkToolCallMemory.size <= SDK_TOOL_CALL_MEMORY_LIMIT) return;
  const overflow = sdkToolCallMemory.size - SDK_TOOL_CALL_MEMORY_LIMIT;
  for (const key of Array.from(sdkToolCallMemory.keys()).slice(0, overflow)) {
    sdkToolCallMemory.delete(key);
  }
}

function normalizeSdkToolCall(toolCall: CursorToolCall): CursorToolCall {
  const args = toolCall.arguments ?? {};
  if (canonicalToolName(toolCall.name) === "edit") {
    const streamContent = firstStringArgAllowEmpty(args, "streamContent", "stream_content");
    const path = firstArg(args, [...pathCandidates(), "target_file", "targetFile"]);
    if (streamContent !== undefined && shouldIncludeOptionalPath(path)) {
      const nextArgs: Record<string, unknown> = { ...args, path, fileText: streamContent };
      delete nextArgs.streamContent;
      delete nextArgs.stream_content;
      return { ...toolCall, name: "write", arguments: nextArgs };
    }
  }
  return toolCall;
}

function modelItem(id: string, name: string) {
  const pricing = pricingForModel(id);
  return {
    id,
    object: "model",
    created: 1779148800,
    owned_by: "cursor",
    name,
    ...(pricing ? { cost: { input: pricing.input, output: pricing.output } } : {})
  };
}

export function completionCharsFromOutput(text: string, toolCalls: OpenAiToolCall[] = []): number {
  return text.length + serializedToolCallLength(toolCalls);
}

function parseChatTools(value: unknown): OpenAiToolSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError("tools must be an array.", 400, "invalid_request_error", "tools");
  return value.flatMap((tool, index) => {
    const record = expectRecord(tool, `tools[${index}]`);
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (type === "namespace") {
      const namespace = typeof record.name === "string" ? normalizeToolName(record.name) : "";
      return namespace === "functions" ? parseChatTools(record.tools) : [];
    }
    const fn = isRecord(record.function) ? record.function : record;
    const name = typeof fn.name === "string" && fn.name.trim()
      ? fn.name.trim()
      : typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : "";
    if (!name) {
      if (type && type !== "function") return [];
      throw new HttpError("Tool function name is required.", 400, "invalid_request_error", `tools[${index}].function.name`);
    }
    const rawDescription = typeof fn.description === "string"
      ? fn.description
      : typeof record.description === "string"
        ? record.description
        : undefined;
    const description = type === "custom"
      ? [
          rawDescription,
          "Cursor SDK invocation: call this tool with a JSON object containing the raw custom-tool source in the `code` field."
        ].filter(Boolean).join("\n\n")
      : rawDescription;
    const parameters = toolParametersFrom(fn, record)
      ?? (type === "custom"
        ? {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "Raw source text for this custom tool."
              }
            },
            required: ["code"],
            additionalProperties: false
          }
        : undefined);
    return [{
      name,
      ...(description ? { description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
      ...parseToolMetadata(fn, record, index)
    }];
  });
}

function parseToolMetadata(fn: Record<string, unknown>, record: Record<string, unknown>, index: number): Pick<OpenAiToolSpec, "outputSchema" | "annotations"> {
  const outputSchema = [fn.output_schema, fn.outputSchema, record.output_schema, record.outputSchema]
    .find((value) => value !== undefined);
  const annotations = [fn.annotations, record.annotations].find((value) => value !== undefined);
  const result: Pick<OpenAiToolSpec, "outputSchema" | "annotations"> = {};
  if (outputSchema !== undefined) {
    if (!isRecord(outputSchema) || Array.isArray(outputSchema)) {
      throw new HttpError("Tool output schema must be an object.", 400, "invalid_request_error", `tools[${index}].output_schema`);
    }
    result.outputSchema = outputSchema;
  }
  if (annotations !== undefined) {
    if (!isRecord(annotations) || Array.isArray(annotations)) {
      throw new HttpError("Tool annotations must be an object.", 400, "invalid_request_error", `tools[${index}].annotations`);
    }
    result.annotations = {};
    for (const key of ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      const value = annotations[key];
      if (value === undefined) continue;
      if (key === "title") {
        if (typeof value !== "string") throw new HttpError("Tool annotation title must be a string.", 400, "invalid_request_error", `tools[${index}].annotations.${key}`);
        result.annotations.title = value;
      } else {
        if (typeof value !== "boolean") throw new HttpError("Tool annotation hints must be boolean.", 400, "invalid_request_error", `tools[${index}].annotations.${key}`);
        result.annotations[key] = value;
      }
    }
  }
  return result;
}

function responseAdditionalTools(input: unknown): unknown[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const tools: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) continue;
    tools.push(...item.tools);
  }
  return tools.length ? tools : undefined;
}

function dedupeToolSpecs(tools: OpenAiToolSpec[]): OpenAiToolSpec[] {
  const byName = new Map<string, OpenAiToolSpec>();
  for (const tool of tools) {
    const key = normalizeToolName(tool.name);
    if (key && !byName.has(key)) byName.set(key, tool);
  }
  return [...byName.values()];
}

function toolParametersFrom(...records: Record<string, unknown>[]): unknown {
  for (const record of records) {
    for (const key of ["parameters", "input_schema", "inputSchema", "schema", "json_schema"]) {
      if (record[key] !== undefined) return record[key];
    }
  }
  return undefined;
}

function appendNativeToolChoice(transcript: string[], tools: OpenAiToolSpec[], toolChoice: unknown) {
  if (tools.length === 0) return;
  const selected = toolChoiceFunctionName(toolChoice);
  if (selected) {
    transcript.push("", `TOOL CHOICE: Call the registered client tool ${selected}.`);
    return;
  }
  if (toolChoice === "required") {
    transcript.push("", "TOOL CHOICE: You must call at least one registered client tool.");
  }
}

function appendChatTools(transcript: string[], tools: OpenAiToolSpec[], toolChoice: unknown) {
  if (!tools.length) return;
  transcript.push(
    "",
    "CLIENT TOOL INVENTORY:",
    `Allowed tool names: ${tools.map((tool) => tool.name).join(", ")}`,
    "Use only the exact tool names above. Use the argument names from each tool's JSON schema.",
    "If the task requires creating or changing files, call write/edit/bash. Do not provide a code block and ask the user to save it.",
    "To call one tool, output this exact shape and no explanatory prose:",
    "<|tool_calls_begin|><|tool_call_begin|>",
    "tool_name",
    "<|tool_sep|>argument_name",
    "argument value",
    "<|tool_call_end|><|tool_calls_end|>",
    "Do not call switch_mode; that setup already completed."
  );
  for (const tool of tools) {
    transcript.push(JSON.stringify(toolInventoryRecord(tool, { includeSdkMcp: false })));
  }
  if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
    transcript.push(directToolChoiceHint(toolChoice.function.name));
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

function appendResponsesToolInventory(transcript: string[], tools: OpenAiToolSpec[], toolChoice: unknown, context?: ToolCallContext) {
  if (!tools.length) return;
  transcript.push(
    "",
    "LOCAL TOOL INVENTORY:",
    `Client tool targets: ${tools.map((tool) => tool.name).join(", ")}`,
    "These are client execution targets, not the names you should emit.",
    "For local work, emit only SDK tool names from the SDK TOOL ROUTING MAP. The adapter forwards those SDK calls to the matching client tool names and schemas.",
    "Prefer built-in SDK routes for shell/read/write/edit/glob/grep/ls-style client tools. Use SDK mcp for unique client tools and MCP/server tools.",
    "When the user names a specific allowed client tool, use the matching SDK TOOL ROUTING MAP route and do not substitute a different tool.",
    "If you need a local tool, emit the tool call before prose. Do not write progress text such as \"creating the file\" instead of calling a tool."
  );
  if (hasCodeModeExecTool(tools)) {
    transcript.push(
      "CODEX CODE MODE:",
      "The SDK custom tool `exec` is directly callable. Call exec itself.",
      "Pass one JSON argument named `code` containing raw JavaScript.",
      "For project inspection, use code like: const r = await tools.shell_command({\"command\":\"Get-ChildItem -Name\"}); text(r);",
      "The adapter will return this as a Responses custom_tool_call so Codex can execute it locally."
    );
  }
  if (hasCompatibleTool("shell", tools)) {
    transcript.push("A shell client tool is available. For general file creation or overwrite requests, prefer an SDK shell call using mkdir -p and a quoted heredoc.");
  }
  for (const tool of tools) {
    transcript.push(JSON.stringify(toolInventoryRecord(tool, { includeSdkMcp: true })));
  }
  appendSdkRoutingMap(transcript, tools, context);
  const selected = toolChoiceFunctionName(toolChoice);
  if (selected) {
    transcript.push(requestedToolHint(selected));
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

function appendSdkToolInventory(transcript: string[], tools: OpenAiToolSpec[], toolChoice: unknown, context?: ToolCallContext) {
  if (!tools.length) return;
  transcript.push(
    "",
    "OPENCODE TOOL INVENTORY:",
    `Client tool targets: ${tools.map((tool) => tool.name).join(", ")}`,
    "These are OpenCode execution targets, not the names you should emit.",
    "For local work, emit only SDK tool names from the SDK TOOL ROUTING MAP. The adapter forwards those SDK calls to the matching OpenCode tool names and schemas.",
    "Prefer built-in SDK routes for shell/read/write/edit/glob/grep/ls-style OpenCode tools. Use SDK mcp for unique OpenCode tools and MCP/server tools.",
    "When the user names a specific allowed client tool, use the matching SDK TOOL ROUTING MAP route and do not substitute a different tool.",
    "For general local work, prefer shell/read/write/edit/glob/grep/ls style tool requests when those capabilities are present."
  );
  for (const tool of tools) {
    transcript.push(JSON.stringify(toolInventoryRecord(tool, { includeSdkMcp: true })));
  }
  appendSdkRoutingMap(transcript, tools, context);
  if (isRecord(toolChoice) && toolChoice.type === "function" && isRecord(toolChoice.function) && typeof toolChoice.function.name === "string") {
    transcript.push(requestedToolHint(toolChoice.function.name));
  } else if (toolChoice === "required") {
    transcript.push("You must call at least one tool.");
  }
}

function appendSdkRoutingMap(transcript: string[], tools: OpenAiToolSpec[], context?: ToolCallContext) {
  const routes = sdkRoutingRecords(tools, context);
  if (!routes.length) return;
  transcript.push(
    "SDK TOOL ROUTING MAP:",
    "Use these SDK tool names; the adapter forwards them to the listed client tool and argument shape."
  );
  for (const route of routes) {
    transcript.push(JSON.stringify(route));
  }
}

function sdkRoutingRecords(tools: OpenAiToolSpec[], context?: ToolCallContext): Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = [];
  for (const sample of sdkRoutingSamples()) {
    const tool = resolveToolSpec(sample.name, sample.arguments, tools);
    if (!tool) continue;
    const clientArgs = normalizeToolArguments(sample.arguments, tool, sample.name, 0, context);
    if (!toolArgumentsSatisfySchema(clientArgs, tool)) continue;
    routes.push({
      sdk: sample.name,
      client: tool.name,
      clientArgs
    });
  }
  for (const tool of tools) {
    if (normalizeToolName(tool.name) === "exec") {
      routes.push({
        sdk: "exec",
        client: tool.name,
        clientArgs: {
          code: "raw JavaScript source; call tools.shell_command/read/etc. and pass the result to text(...)"
        }
      });
      continue;
    }
    const target = mcpTargetForClientToolName(tool.name, { includeMapped: false });
    if (!target) continue;
    routes.push({
      sdk: "mcp",
      client: tool.name,
      sdkArgs: {
        providerIdentifier: target.provider,
        toolName: target.toolName,
        args: "match client schema"
      }
    });
  }
  return routes.slice(0, 24);
}

function sdkRoutingSamples(): CursorToolCall[] {
  return [
    { name: "shell", arguments: { command: "<command>", workingDirectory: "/workspace", timeout: 120_000 } },
    { name: "read", arguments: { path: "src/App.tsx", offset: 1, limit: 80 } },
    { name: "write", arguments: { path: "src/App.tsx", fileText: "<file content>" } },
    { name: "edit", arguments: { path: "src/App.tsx", oldString: "<old text>", newString: "<new text>" } },
    { name: "delete", arguments: { path: "src/old.tsx" } },
    { name: "glob", arguments: { targetDirectory: ".", globPattern: "**/*" } },
    { name: "grep", arguments: { pattern: "<pattern>", path: ".", glob: "*" } },
    { name: "ls", arguments: { path: "." } },
    { name: "readLints", arguments: { paths: ["src/App.tsx"] } },
    { name: "semSearch", arguments: { query: "<query>", targetDirectories: ["."] } },
    { name: "todowrite", arguments: { todos: [{ content: "<task>", status: "in_progress", priority: "medium" }] } }
  ];
}

function toolInventoryRecord(tool: OpenAiToolSpec, options: { includeSdkMcp: boolean }): Record<string, unknown> {
  const target = options.includeSdkMcp && normalizeToolName(tool.name) !== "exec"
    ? mcpTargetForClientToolName(tool.name, { includeMapped: false })
    : undefined;
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    ...(target
      ? {
          sdk_mcp: {
            providerIdentifier: target.provider,
            toolName: target.toolName,
            args: "match this tool schema"
          }
        }
      : {})
  };
}

function directToolChoiceHint(toolName: string): string {
  return `Use the ${toolName} tool if you call a tool.`;
}

function requestedToolHint(toolName: string): string {
  if (normalizeToolName(toolName) === "exec") {
    return "Use the SDK custom tool exec directly with a `code` argument containing raw JavaScript.";
  }
  if (canonicalToolName(toolName) === "glob" && normalizeToolName(toolName) !== "glob") {
    return `Use SDK glob now; it will be forwarded to client tool ${toolName} with arguments matching its schema. Do not substitute shell or prose for this explicitly requested client tool.`;
  }
  const canonical = canonicalToolName(toolName);
  if (isKnownMappedToolName(toolName)) {
    return `Use SDK ${canonical} now; it will be forwarded to client tool ${toolName} with arguments matching its schema. Do not substitute a different tool.`;
  }
  const target = mcpTargetForClientToolName(toolName, { includeMapped: false });
  if (target) {
    return `Call the registered client tool ${toolName} directly with arguments matching its schema.`;
  }
  return `Call the registered client tool ${toolName} directly with arguments matching its schema. Do not substitute a different tool.`;
}

function toolChoiceFunctionName(toolChoice: unknown): string | undefined {
  if (!isRecord(toolChoice) || toolChoice.type !== "function") return undefined;
  if (typeof toolChoice.name === "string" && toolChoice.name.trim()) return toolChoice.name.trim();
  if (isRecord(toolChoice.function) && typeof toolChoice.function.name === "string" && toolChoice.function.name.trim()) {
    return toolChoice.function.name.trim();
  }
  return undefined;
}

function hasCompatibleTool(sdkToolName: string, tools: OpenAiToolSpec[]): boolean {
  return tools.some((tool) => schemaLooksCompatible(sdkToolName, tool));
}

function hasCodeModeExecTool(tools: OpenAiToolSpec[]): boolean {
  return tools.some((tool) => normalizeToolName(tool.name) === "exec");
}

function mcpTargetForClientToolName(name: string, options: { includeMapped?: boolean } = {}): { provider: string; toolName: string } | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  if (isKnownMappedToolName(trimmed)) {
    return options.includeMapped ? { provider: "client", toolName: trimmed } : undefined;
  }
  if (trimmed.startsWith("mcp__")) {
    const parts = trimmed.split("__").filter(Boolean);
    if (parts.length >= 3) return { provider: parts[1], toolName: parts.slice(2).join("__") };
  }
  const index = trimmed.indexOf("_");
  if (index > 0 && index < trimmed.length - 1) {
    return { provider: trimmed.slice(0, index), toolName: trimmed.slice(index + 1) };
  }
  return { provider: "client", toolName: trimmed };
}

function isKnownMappedToolName(name: string): boolean {
  return new Set([
    "bash", "shell", "shellcommand", "terminal", "runterminalcmd", "runterminalcommand", "runshellcommand",
    "write", "writefile", "createfile",
    "read", "readfile", "openfile",
    "edit", "editfile", "replacefile", "searchreplace",
    "delete", "deletefile", "removefile",
    "grep", "search", "searchfiles", "ripgrep", "rg",
    "glob", "fileglob", "filesearch", "find", "findfile", "findfiles",
    "ls", "list", "listfiles", "listdirectory",
    "mcp", "callmcptool",
    "semsearch", "semanticsearch", "searchcode",
    "todowrite", "todowritetoolcall", "updatetodos", "writetodos"
  ]).has(normalizeToolName(name));
}

function validateCommonUnsupported(record: Record<string, unknown>) {
  if (typeof record.n === "number" && record.n !== 1) {
    throw new HttpError("Only n=1 is supported.", 400, "unsupported_parameter", "n");
  }
  if (record.logprobs === true || record.top_logprobs !== undefined) {
    throw new HttpError("logprobs are not available through Cursor's API.", 400, "unsupported_parameter", "logprobs");
  }
  if (Array.isArray(record.modalities) && record.modalities.some((value) => value !== "text")) {
    throw new HttpError("Only text output is supported.", 400, "unsupported_parameter", "modalities");
  }
  if (record.audio !== undefined) {
    throw new HttpError("Audio output is not supported.", 400, "unsupported_parameter", "audio");
  }
}

function validateResponsesToolChoice(toolChoice: unknown) {
  if (toolChoice === undefined || toolChoice === "auto" || toolChoice === "none") return;
  throw new HttpError(
    'Responses tool_choice currently supports only "auto" and "none".',
    400,
    "unsupported_parameter",
    "tool_choice"
  );
}

function validateResponsesReasoning(reasoning: unknown): void {
  if (reasoning === undefined || reasoning === null) return;
  if (!isRecord(reasoning)) {
    throw new HttpError("reasoning must be an object.", 400, "invalid_request_error", "reasoning");
  }
  if (reasoning.summary === undefined || reasoning.summary === null) return;
  if (
    reasoning.summary === "auto"
    || reasoning.summary === "concise"
    || reasoning.summary === "detailed"
    || reasoning.summary === "none"
  ) return;
  throw new HttpError(
    'reasoning.summary must be one of "auto", "concise", "detailed", or "none".',
    400,
    "unsupported_value",
    "reasoning.summary"
  );
}

function validateResponseReasoningInput(input: unknown): void {
  for (const [index, item] of responseInputArray(input).entries()) {
    if (!isRecord(item) || item.type !== "reasoning") continue;
    const encryptedContent = item.encrypted_content;
    if (encryptedContent === undefined || encryptedContent === null || encryptedContent === "") continue;
    throw new HttpError(
      "Cursor cannot restore encrypted reasoning state from another provider.",
      400,
      "invalid_encrypted_content",
      `input[${index}].encrypted_content`
    );
  }
}

function appendChatOptions(transcript: string[], record: Record<string, unknown>) {
  const constraints: string[] = [];
  const maxTokens = integerOrNull(record.max_completion_tokens ?? record.max_tokens);
  if (maxTokens) constraints.push(`Keep the answer within about ${maxTokens} output tokens.`);
  appendStopConstraint(constraints, record.stop);
  appendJsonConstraint(constraints, record.response_format);
  if (constraints.length) transcript.push("", "OUTPUT CONSTRAINTS:", ...constraints.map((item) => `- ${item}`));
}

function appendResponseOptions(transcript: string[], record: Record<string, unknown>) {
  const constraints: string[] = [];
  const maxTokens = integerOrNull(record.max_output_tokens);
  if (maxTokens) constraints.push(`Keep the answer within about ${maxTokens} output tokens.`);
  appendStopConstraint(constraints, record.stop);
  const text = isRecord(record.text) ? record.text : undefined;
  appendJsonConstraint(constraints, text?.format);
  if (constraints.length) transcript.push("", "OUTPUT CONSTRAINTS:", ...constraints.map((item) => `- ${item}`));
}

function appendStopConstraint(constraints: string[], stop: unknown) {
  if (typeof stop === "string") constraints.push(`Do not include text after this stop sequence: ${stop}`);
  else if (Array.isArray(stop) && stop.length) constraints.push(`Stop before any of these sequences: ${stop.join(", ")}`);
}

function appendJsonConstraint(constraints: string[], format: unknown) {
  if (!isRecord(format)) return;
  if (format.type === "json_object") constraints.push("Return a single valid JSON object and no surrounding prose.");
  if (format.type === "json_schema") {
    const schema = isRecord(format.json_schema) ? format.json_schema.schema : format.schema;
    constraints.push(`Return JSON that matches this schema: ${JSON.stringify(schema ?? format)}`);
  }
}

interface RenderedResponseInputItem {
  text: string;
  images: CursorImage[];
  value: unknown;
}

function responseInputToTextAndImages(
  input: unknown
): { items: RenderedResponseInputItem[]; images: CursorImage[] } {
  if (typeof input === "string") {
    const item = responseMessageContextItem("user", input, 0);
    return { items: [{ text: input, images: [], value: item }], images: [] };
  }
  if (!Array.isArray(input)) {
    if (input === undefined) return { items: [], images: [] };
    const text = JSON.stringify(input);
    return {
      items: [{ text, images: [], value: { type: "other", value: responseContextValue(input) } }],
      images: []
    };
  }
  const items: RenderedResponseInputItem[] = [];
  const images: CursorImage[] = [];
  const toolCallById = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const item of input) {
    if (typeof item === "string") {
      items.push({ text: item, images: [], value: responseMessageContextItem("user", item, 0) });
      continue;
    }
    const record = expectRecord(item, "input[]");
    if (record.type === "additional_tools") {
      continue;
    }
    if (record.type === "reasoning") {
      continue;
    }
    if (record.type === "message" || typeof record.role === "string") {
      const role = typeof record.role === "string" ? record.role : "user";
      const content = contentToTextAndImages(record.content, role);
      items.push({
        text: `${role.toUpperCase()}: ${content.text || "[empty]"}`,
        images: content.images,
        value: responseMessageContextItem(role, content.text, content.images.length)
      });
      images.push(...content.images);
    } else if (record.type === "function_call" || record.type === "custom_tool_call") {
      const callId = typeof record.call_id === "string" && record.call_id.trim()
        ? record.call_id.trim()
        : typeof record.id === "string" && record.id.trim()
          ? record.id.trim()
          : `call_response_${toolCallById.size}`;
      const name = typeof record.name === "string" ? record.name : "unknown";
      const args = record.type === "custom_tool_call"
        ? { code: typeof record.input === "string" ? record.input : responseInputText(record.input) }
        : parseToolCallArguments(record.arguments);
      toolCallById.set(callId, { name, args });
      items.push({
        text: `ASSISTANT TOOL_CALLS: ${JSON.stringify([{ id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }])}`,
        images: [],
        value: { type: "tool_call", callId, name, arguments: responseContextValue(args) }
      });
    } else if (record.type === "function_call_output" || record.type === "custom_tool_call_output") {
      const callId = typeof record.call_id === "string" ? record.call_id : "";
      const content = contentToTextAndImages(record.output, "tool");
      const output = content.text;
      images.push(...content.images);
      const remembered = toolCallById.get(callId);
      const isError = record.type === "custom_tool_call_output" && record.is_error === true;
      const label = [remembered?.name ? `name=${remembered.name}` : "", callId ? `tool_call_id=${callId}` : "", isError ? "is_error=true" : ""].filter(Boolean).join(" ");
      items.push({
        text: `TOOL RESULT${label ? ` (${label})` : ""}: ${output || "[empty]"}`,
        images: content.images,
        value: {
          type: "tool_output",
          callId,
          output,
          imageCount: content.images.length,
          isError
        }
      });
    } else {
      const { id: _id, status: _status, ...visible } = record;
      items.push({
        text: JSON.stringify(record),
        images: [],
        value: { type: "other", value: responseContextValue(visible) }
      });
    }
  }
  return { items, images };
}

function responseMessageContextItem(role: string, text: string, imageCount: number): Record<string, unknown> {
  return { type: "message", role, text, imageCount };
}

function responseContextValue(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(responseContextValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined && !["function", "symbol"].includes(typeof item))
      .map(([key, item]) => [key, responseContextValue(item)]));
  }
  return String(value);
}

function responseInputWithPrevious(
  input: unknown,
  options: { previousOutput?: unknown[]; previousInputItems?: unknown[] }
): unknown {
  const previous = [
    ...(options.previousInputItems ?? []),
    ...(options.previousOutput ?? [])
  ];
  if (!previous.length) return input;
  return [...previous, ...responseInputArray(input)];
}

function responseInputArray(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}

function responsesTrajectoryUserInputs(input: unknown): string[] {
  const items = responseInputArray(input);
  let boundary = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isResponseAssistantMessage(items[index]) || isResponseToolCall(items[index])) {
      boundary = index;
      break;
    }
  }
  return items.slice(boundary + 1).flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isRecord(item) || item.role !== "user") return [];
    const content = contentToTextAndImages(item.content, "user").text;
    return [content || "[empty]"];
  });
}

function normalizedResponseInputItems(input: unknown): unknown[] {
  return responseInputArray(input)
    .filter((item) => !isRecord(item) || item.type !== "reasoning")
    .map(normalizeResponseInputItem);
}

function normalizeResponseInputItem(item: unknown, index: number): unknown {
  if (isRecord(item)) {
    return item.id === undefined ? { ...item, id: `item_${index}` } : item;
  }
  return responseInputMessage(responseInputText(item), `item_${index}`);
}

function responseInputMessage(text: string, id: string): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }]
  };
}

function responseInputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function contentToTextAndImages(content: unknown, role: string): { text: string; images: CursorImage[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (content === null || content === undefined) return { text: "", images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };

  const parts: string[] = [];
  const images: CursorImage[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) {
      parts.push(JSON.stringify(part));
      continue;
    }
    const type = part.type;
    if ((type === "text" || type === "input_text" || type === "output_text") && typeof part.text === "string") {
      parts.push(part.text);
    } else if (type === "image_url" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      images.push(imageFromUrl(part.image_url.url, part.image_url));
      parts.push("[image]");
    } else if (type === "input_image" && typeof part.image_url === "string") {
      images.push(imageFromUrl(part.image_url));
      parts.push("[image]");
    } else if (type === "input_image" && isRecord(part.image_url) && typeof part.image_url.url === "string") {
      images.push(imageFromUrl(part.image_url.url, part.image_url));
      parts.push("[image]");
    } else if (type === "tool_result" || type === "function_call_output") {
      parts.push(`${role} ${String(type)}: ${JSON.stringify(part)}`);
    } else {
      parts.push(JSON.stringify(part));
    }
  }
  return { text: parts.join("\n"), images };
}

function contentToPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

function toolCallContextFromMessages(messages: unknown[]): ToolCallContext | undefined {
  const workingDirectory = messages
    .map((message) => isRecord(message) ? contentToPlainText(message.content) : "")
    .map(workingDirectoryFromText)
    .find(Boolean);
  return workingDirectory ? { workingDirectory } : undefined;
}

function toolCallContextFromResponseInput(input: unknown, instructions: unknown): ToolCallContext | undefined {
  const texts: string[] = [];
  if (typeof instructions === "string") texts.push(instructions);
  for (const item of responseInputArray(input)) {
    if (typeof item === "string") {
      texts.push(item);
    } else if (isRecord(item)) {
      texts.push(contentToPlainText(item.content));
      if (typeof item.instructions === "string") texts.push(item.instructions);
    }
  }
  const workingDirectory = texts.map(workingDirectoryFromText).find(Boolean);
  return workingDirectory ? { workingDirectory } : undefined;
}

function workingDirectoryFromText(text: string): string | undefined {
  for (const pattern of [
    /^\s*Working directory:\s*(.+)$/im,
    /^\s*Current working directory:\s*(.+)$/im,
    /^\s*Workspace root folder:\s*(.+)$/im,
    /^\s*Workspace root:\s*(.+)$/im
  ]) {
    const match = pattern.exec(text);
    const value = sanitizeContextPath(match?.[1]);
    if (value) return value;
  }
  return undefined;
}

function sanitizeContextPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed === "." || trimmed.toLowerCase() === "undefined" || trimmed.toLowerCase() === "null") return undefined;
  return trimmed;
}

function rememberOpenCodeToolCalls(toolCalls: unknown[], output: Map<string, { name: string; args: Record<string, unknown> }>) {
  for (const toolCall of toolCalls) {
    if (!isRecord(toolCall) || typeof toolCall.id !== "string") continue;
    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
    if (!fn || typeof fn.name !== "string") continue;
    output.set(toolCall.id, {
      name: fn.name,
      args: parseToolCallArguments(fn.arguments)
    });
  }
}

function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sdkToolResultFeedback(
  toolCallId: string,
  fallbackToolName: string,
  resultText: string,
  toolCallById: Map<string, { name: string; args: Record<string, unknown> }>,
  tools: OpenAiToolSpec[] = []
): Record<string, unknown> {
  const original = toolCallById.get(toolCallId);
  const sdkMemory = sdkToolCallMemory.get(toolCallId);
  const name = original?.name || fallbackToolName || "unknown";
  const args = original?.args ?? {};
  const tool = toolSpecByName(tools, name);
  const sdkName = sdkMemory?.name ?? sdkCanonicalFromToolCallId(toolCallId) ?? sdkToolNameForOpenCodeTool(name, args, tool);
  const sdkArgs = sdkMemory?.args ?? openCodeArgsToSdkArgs(name, args, tool, sdkName);
  return {
    type: "tool_call",
    call_id: toolCallId || "unknown",
    name: sdkName,
    status: "completed",
    args: sdkArgs,
    result: openCodeToolResultToSdkResult(sdkMemory?.name ?? name, sdkMemory?.args ?? args, resultText, sdkName)
  };
}

function sdkCanonicalFromToolCallId(toolCallId: string): string | undefined {
  const match = /_(shell|write|read|edit|delete|grep|glob|ls|readlints|mcp|semsearch|todowrite)_\d+$/i.exec(toolCallId);
  if (!match) return undefined;
  const canonical = match[1].toLowerCase();
  return KNOWN_SDK_CANONICAL_TOOLS.has(canonical) ? canonical : undefined;
}

function toolSpecByName(tools: OpenAiToolSpec[], name: string): OpenAiToolSpec | undefined {
  const normalized = normalizeToolName(name);
  return tools.find((tool) => normalizeToolName(tool.name) === normalized);
}

function sdkToolNameForOpenCodeTool(name: string, args: Record<string, unknown> = {}, tool?: OpenAiToolSpec): string {
  const directCanonical = canonicalToolName(name);
  if (KNOWN_SDK_CANONICAL_TOOLS.has(directCanonical)) return directCanonical;
  if (explicitMcpTargetForClientToolName(name)) return "mcp";
  const inferred = inferSdkCanonicalFromClientTool(args, tool);
  if (inferred) return inferred;
  if (mcpTargetForClientToolName(name)) return "mcp";
  return name;
}

function explicitMcpTargetForClientToolName(name: string): { provider: string; toolName: string } | undefined {
  const trimmed = name.trim();
  return trimmed.startsWith("mcp__") ? mcpTargetForClientToolName(trimmed) : undefined;
}

function inferSdkCanonicalFromClientTool(args: Record<string, unknown>, tool?: OpenAiToolSpec): string | undefined {
  const operation = firstStringArg(args, ...operationPropertyCandidates());
  const normalizedOperation = normalizeToolName(operation || "");
  if (["write", "create", "overwrite"].includes(normalizedOperation)) return "write";
  if (["replace", "strreplace", "edit", "update"].includes(normalizedOperation)) return "edit";
  if (["read", "view", "open"].includes(normalizedOperation)) return "read";
  if (["delete", "remove"].includes(normalizedOperation)) return "delete";
  if (tool && schemaLooksCompatible("shell", tool) && firstStringArg(args, ...shellCommandCandidates())) return "shell";
  if (tool && schemaLooksCompatible("edit", tool) && firstStringArgAllowEmpty(args, ...oldTextCandidates()) !== undefined && firstStringArgAllowEmpty(args, ...newTextCandidates()) !== undefined) return "edit";
  if (tool && schemaLooksCompatible("write", tool) && firstStringArg(args, ...pathCandidates()) && firstStringArgAllowEmpty(args, ...fileContentCandidates()) !== undefined) return "write";
  if (tool && schemaLooksCompatible("glob", tool) && firstStringArg(args, ...globPatternCandidates())) return "glob";
  if (tool && schemaLooksCompatible("grep", tool) && firstStringArg(args, "pattern", "query", "search", "regex", "searchPattern", "search_pattern")) return "grep";
  if (tool && schemaLooksCompatible("ls", tool) && firstStringArg(args, ...pathCandidates(), "directory", "dir")) return "ls";
  return undefined;
}

function openCodeArgsToSdkArgs(toolName: string, args: Record<string, unknown>, tool?: OpenAiToolSpec, sdkName?: string): Record<string, unknown> {
  const canonical = sdkName && KNOWN_SDK_CANONICAL_TOOLS.has(sdkName) ? sdkName : sdkToolNameForOpenCodeTool(toolName, args, tool);
  const mcpTarget = canonical === "mcp" ? mcpTargetForClientToolName(toolName, { includeMapped: true }) : undefined;
  if (mcpTarget) {
    return {
      providerIdentifier: mcpTarget.provider,
      toolName: mcpTarget.toolName,
      args
    };
  }
  if (canonical === "shell") {
    const timeout = firstNumberNamedArg(args, ...timeoutCandidates());
    return compactRecord({
      command: firstStringArg(args, ...shellCommandCandidates()),
      workingDirectory: firstStringArg(args, ...shellWorkdirCandidates()),
      timeout: sdkTimeoutArgument(timeout, tool)
    });
  }
  if (canonical === "write") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates()),
      fileText: firstStringArg(args, ...fileContentCandidates(), ...newTextCandidates())
    });
  }
  if (canonical === "read") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
      offset: firstNumberArg(args, "offset", "start", "startLine", "start_line"),
      limit: firstNumberArg(args, "limit", "maxLines", "max_lines", "lineCount", "line_count")
    });
  }
  if (canonical === "delete") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir")
    });
  }
  if (canonical === "ls") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
      limit: firstNumberArg(args, "limit", "maxResults", "max_results")
    });
  }
  if (canonical === "edit") {
    return compactRecord({
      path: firstStringArg(args, ...pathCandidates(), "directory", "dir"),
      oldString: firstStringArgAllowEmpty(args, ...oldTextCandidates()),
      newString: firstStringArgAllowEmpty(args, ...newTextCandidates())
    });
  }
  if (canonical === "glob") {
    return compactRecord({
      targetDirectory: firstStringArg(args, ...globPathCandidates()),
      globPattern: firstStringArg(args, ...globPatternCandidates())
    });
  }
  if (canonical === "grep") {
    return compactRecord({
      pattern: firstStringArg(args, "pattern", "query", "search", "regex"),
      path: firstStringArg(args, "path", "directory", "cwd"),
      glob: firstStringArg(args, "glob", "include"),
      caseInsensitive: firstBooleanArg(args, "caseInsensitive", "case_insensitive", "ignoreCase", "ignore_case"),
      literal: firstBooleanArg(args, "literal", "fixedString", "fixed_string"),
      context: firstNumberArg(args, "context", "contextLines", "context_lines"),
      headLimit: firstNumberArg(args, "headLimit", "head_limit", "limit", "maxResults", "max_results")
    });
  }
  return args;
}

function openCodeToolResultToSdkResult(toolName: string, args: Record<string, unknown>, resultText: string, sdkName?: string): Record<string, unknown> {
  const parsed = parseToolResultPayload(resultText);
  const canonical = sdkName && KNOWN_SDK_CANONICAL_TOOLS.has(sdkName) ? sdkName : sdkToolNameForOpenCodeTool(toolName, args);
  if (canonical === "mcp") {
    return sdkToolResult(parsed, resultText, isRecord(parsed) ? parsed : { text: resultText });
  }
  if (canonical === "shell") {
    return sdkToolResult(parsed, resultText, {
      exitCode: numberFromParsed(parsed, ["exitCode", "exit_code", "code"]) ?? 0,
      signal: stringFromParsed(parsed, ["signal"]) ?? "",
      stdout: stringFromParsed(parsed, ["stdout", "output", "text"]) ?? resultText,
      stderr: stringFromParsed(parsed, ["stderr", "error"]) ?? "",
      executionTime: numberFromParsed(parsed, ["executionTime", "durationMs", "duration_ms"]) ?? 0
    });
  }
  if (canonical === "read") {
    const content = stringFromParsed(parsed, ["content", "text", "output"]) ?? resultText;
    return sdkToolResult(parsed, resultText, {
      content,
      totalLines: lineCount(content),
      fileSize: content.length
    });
  }
  if (canonical === "write") {
    const fileText = firstStringArg(args, ...fileContentCandidates(), ...newTextCandidates()) || "";
    return sdkToolResult(parsed, resultText, {
      path: firstStringArg(args, ...pathCandidates()) || "",
      linesCreated: lineCount(fileText),
      fileSize: fileText.length
    });
  }
  if (canonical === "edit") {
    return sdkToolResult(parsed, resultText, {
      diffString: stringFromParsed(parsed, ["diff", "diffString", "output"]) ?? resultText
    });
  }
  if (canonical === "glob") {
    const files = stringsFromParsed(parsed, ["files", "paths"]) ?? resultTextLines(resultText);
    return sdkToolResult(parsed, resultText, {
      files,
      totalFiles: files.length,
      clientTruncated: false,
      ripgrepTruncated: false
    });
  }
  return sdkToolResult(parsed, resultText, {
    text: resultText
  });
}

function parseToolResultPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isErrorToolResult(parsed: unknown, text: string): boolean {
  if (isRecord(parsed)) {
    if (parsed.isError === true || parsed.error !== undefined) return true;
    const exitCode = numberFromParsed(parsed, ["exitCode", "exit_code", "code"]);
    if (exitCode !== undefined && exitCode !== 0) return true;
  }
  return /^\s*(error|failed|exception)\b/i.test(text);
}

function sdkToolResult(parsed: unknown, resultText: string, value: Record<string, unknown>): Record<string, unknown> {
  if (isErrorToolResult(parsed, resultText)) {
    return { status: "error", error: { message: errorMessageFromToolResult(parsed, resultText) } };
  }
  return { status: "success", value };
}

function errorMessageFromToolResult(parsed: unknown, text: string): string {
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof parsed.message === "string") return parsed.message;
  }
  return text || "Tool failed";
}

function firstStringArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function firstNumberArg(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstNumberNamedArg(args: Record<string, unknown>, ...keys: string[]): { key: string; value: number } | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return { key, value };
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(args)) {
    if (normalizedKeys.has(normalizeToolName(key)) && typeof value === "number" && Number.isFinite(value)) {
      return { key, value };
    }
  }
  return undefined;
}

function sdkTimeoutArgument(argument: { key: string; value: number } | undefined, tool: OpenAiToolSpec | undefined): number | undefined {
  if (!argument) return undefined;
  const source = normalizeToolName(argument.key);
  if (["timeoutms", "timeoutmilliseconds", "milliseconds"].includes(source)) return argument.value;
  if (["timeoutseconds", "seconds"].includes(source)) return argument.value * 1000;
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const target = firstMatchingProperty(timeoutCandidates(), schema.properties, normalizedProperties) || argument.key;
  return toolPropertyPrefersSecondsTimeout(tool, target) ? argument.value * 1000 : argument.value;
}

function firstBooleanArg(args: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function stringFromParsed(value: unknown, keys: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function numberFromParsed(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function stringsFromParsed(value: unknown, keys: string[]): string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) return candidate;
  }
  return undefined;
}

function resultTextLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function imageFromUrl(url: string, metadata?: Record<string, unknown>): CursorImage {
  const dimension =
    typeof metadata?.width === "number" &&
    typeof metadata.height === "number" &&
    Number.isFinite(metadata.width) &&
    Number.isFinite(metadata.height)
      ? { width: Math.round(metadata.width), height: Math.round(metadata.height) }
      : undefined;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (dataUrl) {
    return { mimeType: dataUrl[1], data: dataUrl[2], ...(dimension ? { dimension } : {}) };
  }
  return { url, ...(dimension ? { dimension } : {}) };
}

function usageFromChars(model: string, promptChars: number, completionChars: number, actual?: CursorUsage) {
  // Cursor's cacheRead is an SDK-internal cache counter, not a reliable
  // representation of the prompt sent by this API request. Keep it out of the
  // OpenAI usage contract so OpenClaw cannot mistake cumulative cache tokens for
  // the current session context.
  const promptTokens = estimateTokens(promptChars);
  const completionTokens = actual?.outputTokens ?? estimateTokens(completionChars);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: 0,
      cache_write_tokens: 0,
      audio_tokens: 0
    },
    completion_tokens_details: {
      reasoning_tokens: actual?.reasoningTokens ?? 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0
    },
    cost: costFromTokens(model, promptTokens, completionTokens)
  };
}

function responseUsageFromChars(model: string, inputChars: number, outputChars: number, actual?: CursorUsage) {
  // See usageFromChars: expose the full request estimate, but not Cursor's
  // ambiguous/cumulative cache counters.
  const inputTokens = estimateTokens(inputChars);
  const outputTokens = actual?.outputTokens ?? estimateTokens(outputChars);
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: 0,
      cache_write_tokens: 0
    },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: actual?.reasoningTokens ?? 0 },
    total_tokens: inputTokens + outputTokens,
    cost: costFromTokens(model, inputTokens, outputTokens)
  };
}

function costFromTokens(model: string, inputTokens: number, outputTokens: number) {
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  const inputUsd = roundUsd((inputTokens / 1_000_000) * pricing.input);
  const outputUsd = roundUsd((outputTokens / 1_000_000) * pricing.output);
  return {
    currency: "USD",
    estimated: true,
    input_usd: inputUsd,
    output_usd: outputUsd,
    total_usd: roundUsd(inputUsd + outputUsd),
    pricing: {
      input_per_million_tokens_usd: pricing.input,
      output_per_million_tokens_usd: pricing.output,
      source: pricing.source
    }
  };
}

function pricingForModel(model: string): CursorModelPricing | null {
  return CURSOR_MODEL_PRICING[model.trim().toLowerCase()] ?? null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function serializedToolCallLength(toolCalls: OpenAiToolCall[]): number {
  return toolCalls.reduce((sum, toolCall) => sum + toolCall.function.name.length + toolCall.function.arguments.length, 0);
}

const KNOWN_SDK_CANONICAL_TOOLS = new Set(["shell", "write", "read", "edit", "delete", "grep", "glob", "ls", "readlints", "mcp", "semsearch", "todowrite"]);

function resolveToolSpec(emittedName: string, args: Record<string, unknown>, tools: OpenAiToolSpec[]): OpenAiToolSpec | undefined {
  const exact = tools.find((tool) => tool.name === emittedName);
  if (exact && (toolArgumentsSatisfySchema(args, exact) || nameMatchedToolCanAccept(emittedName, exact))) return exact;
  const normalized = normalizeToolName(emittedName);
  const match = tools.find((tool) => normalizeToolName(tool.name) === normalized);
  if (match && (toolArgumentsSatisfySchema(args, match) || nameMatchedToolCanAccept(emittedName, match))) return match;
  if (canonicalToolName(emittedName) === "mcp") {
    const specific = resolveSpecificMCPTool(args, tools);
    if (specific) return specific;
  }
  const candidates = toolNameAliases(normalized);
  const alias = tools.find((tool) => candidates.includes(normalizeToolName(tool.name)) && schemaLooksCompatible(emittedName, tool));
  if (alias) return alias;
  if (canonicalToolName(emittedName) === "ls") {
    const glob = tools.find((tool) => schemaLooksCompatible("glob", tool));
    if (glob) return glob;
  }
  const compatible = tools
    .map((tool) => ({ tool, score: schemaCompatibilityScore(emittedName, tool) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.tool;
  if (compatible) return compatible;
  if (canEmulateWithShell(emittedName)) {
    return tools.find((tool) => schemaLooksCompatible("shell", tool));
  }
  return undefined;
}

function nameMatchedToolCanAccept(emittedName: string, tool: OpenAiToolSpec): boolean {
  if (!isKnownSdkCanonical(canonicalToolName(emittedName))) return true;
  if (!toolParameterSchema(tool).properties.length) return true;
  return schemaLooksCompatible(emittedName, tool);
}

function isKnownSdkCanonical(value: string): boolean {
  return KNOWN_SDK_CANONICAL_TOOLS.has(value);
}

function normalizeToolName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalToolName(value: string): string {
  const normalized = normalizeToolName(value);
  if (["bash", "shellcommand", "runshellcommand", "runterminalcommand", "runterminalcmd", "terminal", "execute", "executecommand", "runcommand", "run"].includes(normalized)) {
    return "shell";
  }
  if (["writefile", "createfile", "strreplaceeditor"].includes(normalized)) return "write";
  if (["readfile", "openfile", "viewfile"].includes(normalized)) return "read";
  if (["editfile", "replacefile", "searchreplace"].includes(normalized)) return "edit";
  if (["deletefile", "removefile"].includes(normalized)) return "delete";
  if (["search", "searchfiles", "searchfilesystem", "ripgrep", "rg"].includes(normalized)) return "grep";
  if (isGlobLikeToolName(normalized)) return "glob";
  if (["list", "listfiles", "listdirectory", "listdir"].includes(normalized)) return "ls";
  if (["readlints", "diagnostics", "getdiagnostics"].includes(normalized)) return "readlints";
  if (["callmcptool"].includes(normalized)) return "mcp";
  if (["semanticsearch", "semsearch", "searchcode"].includes(normalized)) return "semsearch";
  if (["updatetodos", "updatetodostoolcall", "writetodos", "todowrite", "todowritetoolcall"].includes(normalized)) return "todowrite";
  return normalized;
}

function normalizeToolArguments(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  emittedName = "",
  wrapperDepth = 0,
  context?: ToolCallContext
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const emittedCanonical = canonicalToolName(emittedName);
  const selectedCanonical = canonicalToolName(tool?.name || "");
  const selectedTool = normalizeToolName(tool?.name || "");
  if (emittedCanonical === "mcp" && selectedCanonical === "mcp") {
    return normalizeMCPWrapperArguments(args, schema);
  }
  const argsToNormalize = emittedCanonical === "mcp"
    ? expandToolArguments(mcpPayloadArguments(args))
    : expandToolArguments(args);
  if (!schema.properties.length) return argsToNormalize;
  const wrapperObjectArguments = normalizeWrapperObjectArguments(argsToNormalize, tool, emittedName, schema, wrapperDepth, context);
  if (wrapperObjectArguments) {
    return wrapperObjectArguments;
  }
  if (selectedTool === "strreplaceeditor") {
    return strReplaceEditorArguments(argsToNormalize, emittedCanonical, tool);
  }
  const commandStyleFile = commandStyleFileArguments(argsToNormalize, emittedCanonical, tool, context);
  if (commandStyleFile) {
    return commandStyleFile;
  }
  const patchStyleFile = patchStyleFileArguments(argsToNormalize, emittedCanonical, tool, context);
  if (patchStyleFile) {
    return patchStyleFile;
  }
  if (emittedCanonical !== "shell" && selectedCanonical === "shell") {
    return shellFallbackArguments(argsToNormalize, emittedName, tool);
  }
  if (emittedCanonical === "ls" && selectedCanonical === "glob") {
    return listAsGlobArguments(argsToNormalize, tool, context);
  }
  if (emittedCanonical === "glob" && selectedCanonical === "glob") {
    return globArguments(argsToNormalize, tool, context);
  }

  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const output: Record<string, unknown> = {};
  const priorities = new Map<string, number>();
  for (const [key, value] of Object.entries(argsToNormalize)) {
    const mapped = mapToolArgument(key, schema.properties, normalizedProperties, tool?.name);
    if (!mapped) {
      if (schema.allowAdditionalProperties) output[key] = value;
      continue;
    }
    const previous = priorities.get(mapped.target) ?? -1;
    if (mapped.priority >= previous) {
      output[mapped.target] = normalizeToolArgumentValue(value, mapped.target, tool, context, key);
      priorities.set(mapped.target, mapped.priority);
    }
  }
  return sanitizeNormalizedToolArguments(applyRequiredToolDefaults(output, schema.required, tool, argsToNormalize), tool, argsToNormalize);
}

function schemaLooksCompatible(emittedName: string, tool: OpenAiToolSpec): boolean {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return false;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const has = (candidates: string[]) => Boolean(firstMatchingProperty(candidates, schema.properties, normalizedProperties));
  const canonical = canonicalToolName(emittedName);
  const wrapper = wrapperObjectArgumentProperty(tool, schema);
  if (wrapper) {
    if (canonical === "mcp" && (has(["toolName", "tool_name", "tool", "name"]) || normalizeToolName(tool.name).includes("mcp"))) {
      return true;
    }
    return schemaLooksCompatible(emittedName, { ...tool, parameters: wrapper.parameters });
  }
  if (normalizeToolName(tool.name) === "strreplaceeditor" && !["write", "read", "edit"].includes(canonical)) {
    return false;
  }
  if (commandStyleFileToolSupports(canonical, tool)) {
    return true;
  }
  if (patchStyleFileToolSupports(canonical, tool)) {
    return true;
  }
  const toolCanonical = canonicalToolName(tool.name);
  switch (canonical) {
    case "shell":
      return has(shellCommandCandidates());
    case "write":
      return has(pathCandidates()) && has(fileContentCandidates());
    case "read":
      return has(pathCandidates());
    case "delete":
      return toolCanonical === "delete" && has(pathCandidates());
    case "edit":
      return has(pathCandidates())
        && has(oldTextCandidates())
        && has(newTextCandidates());
    case "grep":
      return has(["pattern", "query", "regex", "search"]);
    case "glob":
      return has(globPatternCandidates({ includeQuery: false })) || (canonicalToolName(tool.name) === "glob" && has(["query"]));
    case "ls":
      return has([...pathCandidates(), "directory", "dir"]);
    case "readlints":
      return has(["paths", "files", "filePaths", "file_paths"]);
    case "mcp":
      return has(["toolName", "tool_name", "tool", "name"]);
    case "semsearch":
      return toolCanonical === "semsearch" && has(["query", "pattern", "search"]);
    case "todowrite":
      return has(["todos", "todoList", "todo_list", "items"]);
    default:
      return false;
  }
}

function schemaCompatibilityScore(emittedName: string, tool: OpenAiToolSpec): number {
  if (!schemaLooksCompatible(emittedName, tool)) return 0;
  const emittedCanonical = canonicalToolName(emittedName);
  const toolCanonical = canonicalToolName(tool.name);
  if (toolCanonical === emittedCanonical) return 100;
  if (toolNameAliases(normalizeToolName(emittedName)).includes(normalizeToolName(tool.name))) return 95;
  if (emittedCanonical === "write" && normalizeToolName(tool.name).includes("edit")) return 80;
  if (emittedCanonical === "ls" && toolCanonical === "read") return 20;
  return 50;
}

function canEmulateWithShell(emittedName: string): boolean {
  return ["write", "read", "edit", "delete", "grep", "glob", "ls", "semsearch"].includes(canonicalToolName(emittedName));
}

function shellFallbackArguments(
  args: Record<string, unknown>,
  emittedName: string,
  tool: OpenAiToolSpec | undefined
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const commandKey = firstMatchingProperty(shellCommandCandidates(), schema.properties, normalizedProperties);
  const command = shellFallbackCommand(args, emittedName);
  if (!commandKey || !command) return args;
  const output: Record<string, unknown> = { [commandKey]: command };
  const workdir = firstArg(args, shellExplicitWorkdirCandidates());
  const workdirKey = firstMatchingProperty(shellExplicitWorkdirCandidates(), schema.properties, normalizedProperties);
  if (workdirKey && shouldIncludeOptionalPath(workdir)) output[workdirKey] = workdir;
  const timeout = firstArg(args, timeoutCandidates());
  const timeoutKey = firstMatchingProperty(timeoutCandidates(), schema.properties, normalizedProperties);
  if (timeoutKey && timeout !== undefined) output[timeoutKey] = normalizeToolArgumentValue(timeout, timeoutKey, tool);
  const descriptionKey = firstMatchingProperty(["description"], schema.properties, normalizedProperties);
  if (descriptionKey) output[descriptionKey] = shellDescription(command);
  return sanitizeNormalizedToolArguments(applyRequiredToolDefaults(output, schema.required, tool, args), tool, args);
}

function shellFallbackCommand(args: Record<string, unknown>, emittedName: string): string | undefined {
  switch (canonicalToolName(emittedName)) {
    case "write": {
      const filePath = firstStringArg(args, ...pathCandidates());
      const content = firstStringArgAllowEmpty(args, ...fileContentCandidates());
      if (!filePath || content === undefined) return undefined;
      const delimiter = heredocDelimiter(content);
      return `mkdir -p "$(dirname ${shellQuote(filePath)})" && cat > ${shellQuote(filePath)} <<'${delimiter}'\n${content}\n${delimiter}`;
    }
    case "read": {
      const filePath = firstStringArg(args, ...pathCandidates());
      if (!filePath) return undefined;
      const offset = firstNumberArg(args, "offset", "start", "startLine", "start_line");
      const limit = firstNumberArg(args, "limit", "maxLines", "max_lines", "lineCount", "line_count");
      if (offset !== undefined && limit !== undefined && limit > 0) {
        const start = Math.max(1, Math.floor(offset));
        const end = start + Math.floor(limit) - 1;
        return `sed -n ${shellQuote(`${start},${end}p`)} ${shellQuote(filePath)}`;
      }
      return `cat ${shellQuote(filePath)}`;
    }
    case "edit": {
      const filePath = firstStringArg(args, ...pathCandidates());
      const oldString = firstStringArgAllowEmpty(args, ...oldTextCandidates());
      const newString = firstStringArgAllowEmpty(args, ...newTextCandidates());
      if (!filePath || !oldString || newString === undefined) return undefined;
      const replaceAll = firstBooleanArg(args, "replaceAll", "replace_all", "replaceAllOccurrences", "replace_all_occurrences") === true;
      return `python3 - <<'PY'\nfrom pathlib import Path\npath = Path(${JSON.stringify(filePath)})\nold = ${JSON.stringify(oldString)}\nnew = ${JSON.stringify(newString)}\ntext = path.read_text()\nif old not in text:\n    raise SystemExit(f"oldString not found in {path}")\npath.write_text(text.replace(old, new, ${replaceAll ? "-1" : "1"}))\nPY`;
    }
    case "delete": {
      const filePath = firstStringArg(args, ...pathCandidates());
      if (!filePath) return undefined;
      return `rm -rf ${shellQuote(filePath)}`;
    }
    case "grep": {
      const pattern = firstStringArg(args, "pattern", "query", "regex", "search", "searchPattern", "search_pattern");
      if (!pattern) return undefined;
      const targetPath = firstStringArg(args, ...pathCandidates(), "directory", "dir") || ".";
      const include = firstStringArg(args, "glob", "include", "includeGlob", "include_glob", "fileGlob", "file_glob", "includePattern", "include_pattern");
      return ["rg", "--line-number", "--color", "never", "--hidden", include ? `--glob ${shellQuote(include)}` : "", shellQuote(pattern), shellQuote(targetPath)]
        .filter(Boolean)
        .join(" ");
    }
    case "glob": {
      const { pattern, path } = normalizedGlobArguments(args);
      return `python3 - <<'PY'\nfrom pathlib import Path\nbase = Path(${JSON.stringify(path || ".")})\npattern = ${JSON.stringify(pattern || "**/*")}\nfor item in sorted(base.glob(pattern)):\n    print(item)\nPY`;
    }
    case "ls": {
      return `ls -la ${shellQuote(firstStringArg(args, ...pathCandidates(), "directory", "dir") || ".")}`;
    }
    case "semsearch": {
      const query = firstStringArg(args, "query", "pattern", "search");
      if (!query) return undefined;
      const directories = firstStringArrayArg(args, "targetDirectories", "target_directories", "directories", "paths");
      return ["rg", "--line-number", "--color", "never", "--hidden", shellQuote(query), ...(directories.length ? directories : ["."]).map(shellQuote)].join(" ");
    }
    default:
      return undefined;
  }
}

function pathCandidates(): string[] {
  return [
    "path",
    "file_path",
    "filePath",
    "filename",
    "file",
    "target",
    "targetPath",
    "target_path",
    "targetFile",
    "target_file",
    "absolutePath",
    "absolute_path",
    "relativePath",
    "relative_path"
  ];
}

function fileContentCandidates(): string[] {
  return [
    "fileText",
    "file_text",
    "content",
    "contents",
    "text",
    "body",
    "data",
    "value",
    "newContents",
    "new_contents",
    "fileContent",
    "file_content",
    "streamContent",
    "stream_content"
  ];
}

function oldTextCandidates(): string[] {
  return [
    "oldString",
    "old_string",
    "old_str",
    "oldText",
    "old_text",
    "oldContents",
    "old_contents",
    "old",
    "search",
    "searchString",
    "search_string",
    "find",
    "findText",
    "find_text"
  ];
}

function newTextCandidates(): string[] {
  return [
    "newString",
    "new_string",
    "new_str",
    "newText",
    "new_text",
    "newContents",
    "new_contents",
    "replacement",
    "replace",
    "replaceWith",
    "replace_with",
    "content"
  ];
}

function shellCommandCandidates(): string[] {
  return ["command", "cmd", "script", "input", "shellCommand", "shell_command", "commandLine", "command_line", "code"];
}

function shellWorkdirCandidates(): string[] {
  return [
    "workingDirectory",
    "working_directory",
    "workingDir",
    "working_dir",
    "workdir",
    "cwd",
    "directory",
    "dir",
    "path",
    "root",
    "rootDir",
    "root_dir",
    "projectRoot",
    "project_root"
  ];
}

function shellExplicitWorkdirCandidates(): string[] {
  return shellWorkdirCandidates().filter((candidate) => normalizeToolName(candidate) !== "path");
}

function timeoutCandidates(): string[] {
  return ["timeout", "timeoutMs", "timeout_ms", "timeoutMilliseconds", "timeout_milliseconds", "timeoutSeconds", "timeout_seconds", "seconds"];
}

function firstArg(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (args[key] !== undefined) return args[key];
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(args)) {
    if (normalizedKeys.has(normalizeToolName(key))) return value;
  }
  return undefined;
}

function firstStringArgAllowEmpty(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = firstArg(args, keys);
  return typeof value === "string" ? value : undefined;
}

function firstStringArrayArg(args: Record<string, unknown>, ...keys: string[]): string[] {
  const value = firstArg(args, keys);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return typeof value === "string" && value.trim() ? [value] : [];
}

function shouldIncludeOptionalPath(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.toLowerCase() !== "undefined" && trimmed.toLowerCase() !== "null";
}

function globPatternCandidates(options: { includeQuery?: boolean } = {}): string[] {
  return [
    "globPattern",
    "glob_pattern",
    "fileGlob",
    "file_glob",
    "filePattern",
    "file_pattern",
    "includePattern",
    "include_pattern",
    "pathPattern",
    "path_pattern",
    "pattern",
    "glob",
    ...(options.includeQuery === false ? [] : ["query"]),
    "include",
    "includeGlob",
    "include_glob"
  ];
}

function globPathCandidates(): string[] {
  return [
    "targetDirectory",
    "target_directory",
    "targeting",
    "directory",
    "dir",
    "cwd",
    "workdir",
    "workingDirectory",
    "working_directory",
    "path",
    "root",
    "rootDir",
    "root_dir",
    "basePath",
    "base_path",
    "searchPath",
    "search_path"
  ];
}

function normalizedGlobArguments(args: Record<string, unknown>, context?: ToolCallContext): { pattern?: string; path?: string } {
  let pattern = firstStringArg(args, ...globPatternCandidates());
  let targetPath = firstStringArg(args, ...globPathCandidates());
  if (targetPath) targetPath = absolutizeToolPath(targetPath, context);
  if (targetPath && looksLikeGlobPattern(targetPath)) {
    if (pattern && !looksLikeGlobPattern(pattern) && looksLikeGlobSearchRoot(pattern)) {
      const nextPattern = targetPath;
      targetPath = absolutizeToolPath(pattern, context);
      pattern = nextPattern;
    } else {
      const split = splitGlobTargetPath(targetPath);
      targetPath = split.path;
      pattern = combineGlobPatterns(split.pattern, pattern);
    }
  }
  return { pattern, path: targetPath };
}

function looksLikeGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value.trim());
}

function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.includes("/");
}

function looksLikeGlobSearchRoot(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if ([".", "./", "..", "../"].includes(trimmed)) return true;
  if (looksLikePath(trimmed) || trimmed.startsWith("~") || trimmed.startsWith("$")) return true;
  return !looksLikeGlobPattern(trimmed) && !/\.[^/.]+$/.test(trimmed);
}

function splitGlobTargetPath(value: string): { path?: string; pattern?: string } {
  const trimmed = value.trim();
  const firstGlob = trimmed.search(/[*?[\]{}]/);
  if (firstGlob < 0) return { path: trimmed };
  const slash = trimmed.lastIndexOf("/", firstGlob);
  const base = slash > 0 ? trimmed.slice(0, slash) : slash === 0 ? "/" : "";
  const pattern = trimmed.slice(slash + 1).replace(/^\/+/, "");
  return { path: base || undefined, pattern: pattern || undefined };
}

function combineGlobPatterns(targetPattern: string | undefined, pattern: string | undefined): string | undefined {
  const cleanTarget = targetPattern?.replace(/^\/+|\/+$/g, "");
  const cleanPattern = pattern?.replace(/^\/+/, "");
  if (!cleanTarget) return cleanPattern;
  if (!cleanPattern) return cleanTarget;
  if (cleanTarget === "**") return cleanPattern === "*" ? "**/*" : `**/${cleanPattern}`;
  if (cleanTarget === "*") return cleanPattern;
  if (cleanPattern === "*") return cleanTarget;
  return cleanPattern;
}

function heredocDelimiter(content: string): string {
  for (let index = 0; index <= 100; index += 1) {
    const delimiter = `API_FOR_CURSOR_EOF${index === 0 ? "" : `_${index}`}`;
    if (!content.includes(delimiter)) return delimiter;
  }
  return `API_FOR_CURSOR_EOF_${hashString(content)}`;
}

function listAsGlobArguments(args: Record<string, unknown>, tool: OpenAiToolSpec | undefined, context?: ToolCallContext): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const output: Record<string, unknown> = {};
  const patternKey = firstMatchingProperty(globPatternCandidates(), schema.properties, normalizedProperties);
  if (patternKey) output[patternKey] = Object.keys(args).length ? "*" : "**/*";
  const path = firstArg(args, globPathCandidates());
  const pathKey = firstMatchingProperty(globPathCandidates(), schema.properties, normalizedProperties);
  if (pathKey && shouldIncludeOptionalPath(path)) output[pathKey] = normalizeToolArgumentValue(path, pathKey, tool, context);
  else if (pathKey && schema.required.includes(pathKey)) output[pathKey] = ".";
  return Object.keys(output).length ? output : args;
}

function globArguments(args: Record<string, unknown>, tool: OpenAiToolSpec | undefined, context?: ToolCallContext): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const output: Record<string, unknown> = {};
  const { pattern, path } = normalizedGlobArguments(args, context);
  const patternKey = firstMatchingProperty(globPatternCandidates(), schema.properties, normalizedProperties);
  if (patternKey) output[patternKey] = pattern || "**/*";
  const pathKey = firstMatchingProperty(globPathCandidates(), schema.properties, normalizedProperties);
  if (pathKey && shouldIncludeOptionalPath(path)) output[pathKey] = normalizeToolArgumentValue(path, pathKey, tool, context);
  else if (pathKey && schema.required.includes(pathKey)) output[pathKey] = ".";
  return Object.keys(output).length ? output : args;
}

function strReplaceEditorArguments(
  args: Record<string, unknown>,
  emittedCanonical: string,
  tool: OpenAiToolSpec | undefined
): Record<string, unknown> {
  const schema = toolParameterSchema(tool);
  const properties = schema.properties.length ? schema.properties : ["command", "path", "file_text", "old_str", "new_str", "view_range"];
  const normalizedProperties = new Map(properties.map((property) => [normalizeToolName(property), property]));
  const output: Record<string, unknown> = {};
  const set = (candidates: string[], value: unknown) => {
    const key = firstMatchingProperty(candidates, properties, normalizedProperties);
    if (key && value !== undefined) output[key] = value;
  };
  const path = firstArg(args, [...pathCandidates(), "target_file", "targetFile"]);
  set(pathCandidates(), path);

  if (emittedCanonical === "read") {
    set(["command"], "view");
    const viewRange = viewRangeFromArgs(args);
    if (viewRange) set(["view_range", "viewRange", "range"], viewRange);
    return Object.keys(output).length ? output : args;
  }

  if (emittedCanonical === "edit") {
    const oldText = firstStringArgAllowEmpty(args, ...oldTextCandidates());
    const newText = firstStringArgAllowEmpty(args, ...newTextCandidates());
    if (oldText !== undefined && newText !== undefined) {
      set(["command"], "str_replace");
      set(["old_str", "oldString", "old_string", "old"], oldText);
      set(["new_str", "newString", "new_string", "replacement"], newText);
      return Object.keys(output).length ? output : args;
    }
  }

  const fileText = firstStringArgAllowEmpty(args, ...fileContentCandidates());
  if (fileText !== undefined) {
    set(["command"], "create");
    set(["file_text", "fileText", "content", "contents", "text"], fileText);
    return Object.keys(output).length ? output : args;
  }

  return Object.keys(output).length ? output : args;
}

function viewRangeFromArgs(args: Record<string, unknown>): number[] | undefined {
  const offset = firstNumberArg(args, "offset", "start", "startLine", "start_line");
  const limit = firstNumberArg(args, "limit", "maxLines", "max_lines", "lineCount", "line_count");
  if (offset === undefined && limit === undefined) return undefined;
  const start = Math.max(1, Math.trunc(offset ?? 1));
  if (limit === undefined || limit <= 0) return [start, -1];
  return [start, start + Math.trunc(limit) - 1];
}

function commandStyleFileArguments(
  args: Record<string, unknown>,
  emittedCanonical: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext
): Record<string, unknown> | undefined {
  if (!["write", "read", "edit", "delete"].includes(emittedCanonical)) return undefined;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return undefined;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const operationKey = firstMatchingProperty(operationPropertyCandidates(), schema.properties, normalizedProperties);
  const pathKey = firstMatchingProperty(pathCandidates(), schema.properties, normalizedProperties);
  const path = firstArg(args, [...pathCandidates(), "target_file", "targetFile"]);
  if (!operationKey || !pathKey || !shouldIncludeOptionalPath(path)) return undefined;

  const output: Record<string, unknown> = {
    [operationKey]: operationValue(tool, operationKey, emittedCanonical),
    [pathKey]: normalizeToolArgumentValue(path, pathKey, tool, context)
  };
  if (emittedCanonical === "write") {
    const content = firstStringArgAllowEmpty(args, ...fileContentCandidates());
    const contentKey = firstMatchingProperty(fileContentCandidates(), schema.properties, normalizedProperties);
    if (!contentKey || content === undefined) return undefined;
    output[contentKey] = content;
  } else if (emittedCanonical === "edit") {
    const oldText = firstStringArgAllowEmpty(args, ...oldTextCandidates());
    const newText = firstStringArgAllowEmpty(args, ...newTextCandidates());
    const oldKey = firstMatchingProperty(oldTextCandidates(), schema.properties, normalizedProperties);
    const newKey = firstMatchingProperty(newTextCandidates(), schema.properties, normalizedProperties);
    if (!oldKey || !newKey || oldText === undefined || newText === undefined) return undefined;
    output[oldKey] = oldText;
    output[newKey] = newText;
  } else if (emittedCanonical === "read") {
    copyOptionalArgument(output, schema.properties, normalizedProperties, args, ["offset", "start", "startLine", "start_line"]);
    copyOptionalArgument(output, schema.properties, normalizedProperties, args, ["limit", "maxLines", "max_lines", "lineCount", "line_count"]);
  }
  return output;
}

function copyOptionalArgument(
  output: Record<string, unknown>,
  properties: string[],
  normalizedProperties: Map<string, string>,
  args: Record<string, unknown>,
  candidates: string[]
) {
  const value = firstArg(args, candidates);
  const key = firstMatchingProperty(candidates, properties, normalizedProperties);
  if (key && value !== undefined) output[key] = value;
}

function commandStyleFileToolSupports(canonical: string, tool: OpenAiToolSpec): boolean {
  if (!["write", "read", "edit", "delete"].includes(canonical)) return false;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return false;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const has = (candidates: string[]) => Boolean(firstMatchingProperty(candidates, schema.properties, normalizedProperties));
  if (!has(operationPropertyCandidates()) || !has(pathCandidates())) return false;
  if (canonical === "write") return has(fileContentCandidates());
  if (canonical === "edit") {
    return has(oldTextCandidates()) && has(newTextCandidates());
  }
  return true;
}

function operationPropertyCandidates(): string[] {
  return ["command", "action", "operation", "op", "mode"];
}

function operationValue(tool: OpenAiToolSpec | undefined, property: string, canonical: string): string {
  const candidates: Record<string, string[]> = {
    write: ["write", "create", "overwrite", "replace"],
    read: ["read", "view", "open"],
    edit: ["replace", "str_replace", "edit", "update"],
    delete: ["delete", "remove"]
  };
  const allowed = stringEnumValues(tool, property);
  for (const candidate of candidates[canonical] ?? [canonical]) {
    const allowedMatch = allowed.find((value) => normalizeToolName(value) === normalizeToolName(candidate));
    if (allowedMatch) return allowedMatch;
  }
  return (candidates[canonical] ?? [canonical])[0];
}

function stringEnumValues(tool: OpenAiToolSpec | undefined, property: string): string[] {
  const propertySchema = toolPropertySchema(tool, property);
  if (!isRecord(propertySchema)) return [];
  return unionStringArrays(propertySchema.enum, propertySchema.const === undefined ? undefined : [propertySchema.const]);
}

function toolPropertySchema(tool: OpenAiToolSpec | undefined, property: string): unknown {
  return toolParameterSchema(tool).propertySchemas[property];
}

function toolArgumentsSatisfySchema(args: Record<string, unknown>, tool: OpenAiToolSpec): boolean {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return true;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  for (const required of schema.required) {
    const property = firstMatchingProperty([required], schema.properties, normalizedProperties) ?? required;
    if (!argumentValueSatisfiesSchema(args[property], schema.propertySchemas[property], true)) return false;
  }
  for (const [property, value] of Object.entries(args)) {
    const propertyName = firstMatchingProperty([property], schema.properties, normalizedProperties);
    if (!propertyName) continue;
    if (!argumentValueSatisfiesSchema(value, schema.propertySchemas[propertyName], false)) return false;
  }
  return true;
}

function argumentValueSatisfiesSchema(value: unknown, schema: unknown, required: boolean): boolean {
  if (value === undefined) return !required;
  const record = isRecord(schema) ? schema : undefined;
  if (value === null) return Boolean(record && schemaAllowsJsonType(record, "null"));
  if (!record) return true;
  const constValue = record.const;
  if (constValue !== undefined && value !== constValue) return false;
  if (Array.isArray(record.enum) && !record.enum.some((item) => item === value)) return false;
  const anyOf = composedToolSchemas(record.anyOf);
  if (anyOf.length && !anyOf.some((item) => argumentValueSatisfiesSchema(value, item, true))) return false;
  const oneOf = composedToolSchemas(record.oneOf);
  if (oneOf.length && !oneOf.some((item) => argumentValueSatisfiesSchema(value, item, true))) return false;
  const allOf = composedToolSchemas(record.allOf);
  if (allOf.length && !allOf.every((item) => argumentValueSatisfiesSchema(value, item, true))) return false;
  const types = schemaJsonTypes(record);
  if (types.length && !types.some((type) => jsonValueMatchesType(value, type))) return false;
  if (objectConstraintsApply(record, value, types) && !objectValueSatisfiesSchema(value, record)) return false;
  if (arrayConstraintsApply(record, value, types) && !arrayValueSatisfiesSchema(value, record)) return false;
  return true;
}

function objectConstraintsApply(schema: Record<string, unknown>, value: unknown, types: string[]): boolean {
  if (!isRecord(schema.properties) && !Array.isArray(schema.required) && schema.additionalProperties === undefined) return false;
  if (jsonValueMatchesType(value, "object")) return true;
  return !types.length || types.includes("object");
}

function objectValueSatisfiesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (!jsonValueMatchesType(value, "object")) return false;
  const recordValue = value as Record<string, unknown>;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  const normalizedProperties = new Map(propertyNames.map((property) => [normalizeToolName(property), property]));
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const requiredProperty of required) {
    const property = firstMatchingProperty([requiredProperty], propertyNames, normalizedProperties) ?? requiredProperty;
    if (!argumentValueSatisfiesSchema(recordValue[property], properties[property], true)) return false;
  }
  for (const [property, nestedValue] of Object.entries(recordValue)) {
    const propertyName = firstMatchingProperty([property], propertyNames, normalizedProperties);
    if (propertyName) {
      if (!argumentValueSatisfiesSchema(nestedValue, properties[propertyName], false)) return false;
      continue;
    }
    if (schema.additionalProperties === false) return false;
    if (isRecord(schema.additionalProperties) && !argumentValueSatisfiesSchema(nestedValue, schema.additionalProperties, false)) return false;
  }
  return true;
}

function arrayConstraintsApply(schema: Record<string, unknown>, value: unknown, types: string[]): boolean {
  if (schema.items === undefined && !Array.isArray(schema.prefixItems) && schema.minItems === undefined && schema.maxItems === undefined) return false;
  if (Array.isArray(value)) return true;
  return !types.length || types.includes("array");
}

function arrayValueSatisfiesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (!Array.isArray(value)) return false;
  const minItems = typeof schema.minItems === "number" && Number.isFinite(schema.minItems) ? schema.minItems : undefined;
  const maxItems = typeof schema.maxItems === "number" && Number.isFinite(schema.maxItems) ? schema.maxItems : undefined;
  if (minItems !== undefined && value.length < minItems) return false;
  if (maxItems !== undefined && value.length > maxItems) return false;
  const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  for (let index = 0; index < prefixItems.length && index < value.length; index += 1) {
    if (!argumentValueSatisfiesSchema(value[index], prefixItems[index], true)) return false;
  }
  if (schema.items === false && value.length > prefixItems.length) return false;
  if (isRecord(schema.items)) {
    for (let index = prefixItems.length; index < value.length; index += 1) {
      if (!argumentValueSatisfiesSchema(value[index], schema.items, true)) return false;
    }
  }
  return true;
}

function schemaJsonTypes(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
}

function schemaAllowsJsonType(schema: Record<string, unknown>, type: string): boolean {
  const types = schemaJsonTypes(schema);
  return !types.length || types.includes(type);
}

function jsonValueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value) && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function toolRequiredArgumentSummary(tool: OpenAiToolSpec): string {
  const schema = toolParameterSchema(tool);
  if (!schema.required.length) return "none";
  return schema.required.flatMap((property) => {
    const canonicalProperty = schema.properties.find((item) => normalizeToolName(item) === normalizeToolName(property)) ?? property;
    return requiredArgumentSummaryForSchema(canonicalProperty, schema.propertySchemas[canonicalProperty]);
  }).join(", ");
}

function requiredArgumentSummaryForSchema(prefix: string, schema: unknown): string[] {
  if (!isRecord(schema)) return [`${prefix}:unknown`];
  const nestedProperties = isRecord(schema.properties) ? schema.properties : {};
  const nestedNames = Object.keys(nestedProperties);
  const nestedRequired = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  if (nestedNames.length && nestedRequired.length) {
    const normalizedProperties = new Map(nestedNames.map((property) => [normalizeToolName(property), property]));
    return nestedRequired.flatMap((property) => {
      const canonicalProperty = firstMatchingProperty([property], nestedNames, normalizedProperties) ?? property;
      return requiredArgumentSummaryForSchema(`${prefix}.${canonicalProperty}`, nestedProperties[canonicalProperty]);
    });
  }
  if (isRecord(schema.items)) {
    const itemSummaries = requiredArgumentSummaryForSchema(`${prefix}[]`, schema.items);
    if (itemSummaries.some((item) => item !== `${prefix}[]:unknown`)) return itemSummaries;
  }
  return [`${prefix}:${schemaTypeLabel(schema)}`];
}

function toolSchemaPropertySummary(tool: OpenAiToolSpec): string {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return "none";
  return schema.properties.map((property) => `${property}:${schemaTypeLabel(schema.propertySchemas[property])}`).join(", ");
}

function schemaTypeLabel(schema: unknown): string {
  if (!isRecord(schema)) return "unknown";
  const constValue = typeof schema.const === "string" ? `=${schema.const}` : "";
  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === "string") : [];
  if (enumValues.length) return `enum(${enumValues.join("|")})`;
  const types = schemaJsonTypes(schema);
  return `${types.join("|") || "any"}${constValue}`;
}

function safeJsonForPrompt(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "null";
    return json.length > 700 ? `${json.slice(0, 700)}...` : json;
  } catch {
    return "[unserializable]";
  }
}

function normalizeToolArgumentValue(
  value: unknown,
  targetProperty: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext,
  sourceProperty?: string
): unknown {
  if (typeof value === "number" && Number.isFinite(value) && toolPropertyPrefersSecondsTimeout(tool, targetProperty)) {
    return normalizeTimeoutForSecondsTool(value, sourceProperty);
  }
  if (typeof value !== "string") return value;
  if (!toolPropertyPrefersAbsolutePath(tool, targetProperty)) return value;
  return absolutizeToolPath(value, context);
}

function normalizeTimeoutForSecondsTool(value: number, sourceProperty?: string): number {
  const source = normalizeToolName(sourceProperty || "");
  if (["timeoutseconds", "seconds"].includes(source)) return value;
  if (["timeoutms", "timeoutmilliseconds", "milliseconds"].includes(source)) return Math.max(1, Math.ceil(value / 1000));
  return value >= 1000 ? Math.max(1, Math.ceil(value / 1000)) : value;
}

function toolPropertyPrefersSecondsTimeout(tool: OpenAiToolSpec | undefined, property: string): boolean {
  const normalizedProperty = normalizeToolName(property);
  if (!["timeout", "timeoutseconds", "seconds"].includes(normalizedProperty)) return false;
  if (["timeoutseconds", "seconds"].includes(normalizedProperty)) return true;
  const schema = toolPropertySchema(tool, property);
  const description = isRecord(schema) && typeof schema.description === "string" ? schema.description.toLowerCase() : "";
  return /\bseconds?\b/.test(description) && !/\bmilliseconds?\b|\bms\b/.test(description);
}

function toolPropertyPrefersAbsolutePath(tool: OpenAiToolSpec | undefined, property: string): boolean {
  const schema = toolPropertySchema(tool, property);
  const description = isRecord(schema) && typeof schema.description === "string" ? schema.description.toLowerCase() : "";
  if (description.includes("absolute path")) return true;
  const normalizedProperty = normalizeToolName(property);
  const canonical = canonicalToolName(tool?.name || "");
  return ["read", "write", "edit", "delete"].includes(canonical) && ["filepath", "absolutepath"].includes(normalizedProperty);
}

function absolutizeToolPath(value: string, context?: ToolCallContext): string {
  const trimmed = value.trim();
  if (!trimmed || /^(?:[a-z][a-z0-9+.-]*:|\$)/i.test(trimmed)) return trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const home = homeDirectoryFromContext(context);
    if (!home) return trimmed;
    return normalizePosixPath(trimmed === "~" ? home : `${home}/${trimmed.slice(2)}`);
  }
  if (trimmed.startsWith("/")) return normalizePosixPath(trimmed);
  const base = sanitizeContextPath(context?.workingDirectory);
  if (!base || !base.startsWith("/")) return trimmed;
  return normalizePosixPath(`${base.replace(/\/+$/, "")}/${trimmed}`);
}

function homeDirectoryFromContext(context?: ToolCallContext): string | undefined {
  const base = sanitizeContextPath(context?.workingDirectory);
  if (!base?.startsWith("/")) return undefined;
  return /^\/Users\/[^/]+/.exec(base)?.[0] ?? /^\/home\/[^/]+/.exec(base)?.[0];
}

function normalizePosixPath(value: string): string {
  if (!value.startsWith("/")) return value.replace(/\/{2,}/g, "/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function patchStyleFileArguments(
  args: Record<string, unknown>,
  emittedCanonical: string,
  tool: OpenAiToolSpec | undefined,
  context?: ToolCallContext
): Record<string, unknown> | undefined {
  if (!["write", "edit", "delete"].includes(emittedCanonical)) return undefined;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return undefined;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const patchKey = patchPropertyKey(tool, schema.properties, normalizedProperties);
  if (!patchKey) return undefined;
  const path = firstStringArg(args, ...pathCandidates(), "target_file", "targetFile");

  let patch: string | undefined;
  if (emittedCanonical === "write") {
    if (!path) return undefined;
    const content = firstStringArgAllowEmpty(args, ...fileContentCandidates());
    if (content === undefined) return undefined;
    patch = addFilePatch(path, content);
  } else if (emittedCanonical === "edit") {
    const patchContent = firstStringArgAllowEmpty(args, "patchContent", "patch_content", "patch", "diff", "unifiedDiff", "unified_diff");
    if (patchContent !== undefined) {
      patch = patchContent;
    } else {
      if (!path) return undefined;
      const oldText = firstStringArgAllowEmpty(args, ...oldTextCandidates());
      const newText = firstStringArgAllowEmpty(args, ...newTextCandidates());
      if (oldText === undefined || newText === undefined) return undefined;
      patch = updateFilePatch(path, oldText, newText);
    }
  } else {
    if (!path) return undefined;
    patch = deleteFilePatch(path);
  }

  const output: Record<string, unknown> = { [patchKey]: patch };
  const pathKey = firstMatchingProperty(pathCandidates(), schema.properties, normalizedProperties);
  if (path && pathKey) {
    output[pathKey] = normalizeToolArgumentValue(path, pathKey, tool, context);
  } else if (pathKey && schema.required.includes(pathKey)) {
    return undefined;
  }
  return output;
}

function patchStyleFileToolSupports(canonical: string, tool: OpenAiToolSpec): boolean {
  if (!["write", "edit", "delete"].includes(canonical)) return false;
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return false;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  return Boolean(patchPropertyKey(tool, schema.properties, normalizedProperties));
}

function patchPropertyKey(
  tool: OpenAiToolSpec | undefined,
  properties: string[],
  normalizedProperties: Map<string, string>
): string | undefined {
  const direct = firstMatchingProperty(["patch", "diff", "unifiedDiff", "unified_diff"], properties, normalizedProperties);
  if (direct) return direct;
  const normalizedTool = normalizeToolName(tool?.name || "");
  if (!normalizedTool.includes("patch")) return undefined;
  return firstMatchingProperty(["input", "content", "text"], properties, normalizedProperties);
}

function addFilePatch(path: string, content: string): string {
  return [
    "*** Begin Patch",
    `*** Add File: ${path}`,
    ...patchLines(content, "+"),
    "*** End Patch"
  ].join("\n");
}

function updateFilePatch(path: string, oldText: string, newText: string): string {
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    ...patchLines(oldText, "-"),
    ...patchLines(newText, "+"),
    "*** End Patch"
  ].join("\n");
}

function deleteFilePatch(path: string): string {
  return [
    "*** Begin Patch",
    `*** Delete File: ${path}`,
    "*** End Patch"
  ].join("\n");
}

function patchLines(text: string, prefix: "+" | "-"): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [`${prefix}`];
  if (lines[lines.length - 1] === "") lines.pop();
  return (lines.length ? lines : [""]).map((line) => `${prefix}${line}`);
}

function resolveSpecificMCPTool(args: Record<string, unknown>, tools: OpenAiToolSpec[]): OpenAiToolSpec | undefined {
  const normalizedCandidates = new Set(mcpToolNameCandidates(args).map(normalizeToolName));
  if (!normalizedCandidates.size) return undefined;
  return tools.find((tool) => {
    const normalizedTool = normalizeToolName(tool.name);
    if (normalizedCandidates.has(normalizedTool)) return true;
    return Array.from(normalizedCandidates).some((candidate) => normalizedTool.endsWith(candidate));
  });
}

function mcpToolNameCandidates(args: Record<string, unknown>): string[] {
  const provider = firstStringArg(args, "providerIdentifier", "provider_identifier", "provider", "server", "serverName", "server_name");
  const toolName = firstStringArg(args, "toolName", "tool_name", "tool", "name");
  const candidates: string[] = [];
  if (toolName) candidates.push(toolName);
  if (toolName) {
    for (const providerName of mcpProviderNameVariants(provider)) {
      candidates.push(
        `${providerName}__${toolName}`,
        `${providerName}_${toolName}`,
        `mcp__${providerName}__${toolName}`,
        `mcp_${providerName}_${toolName}`
      );
    }
  }
  return candidates;
}

function mcpProviderNameVariants(provider: string | undefined): string[] {
  if (!provider?.trim()) return [];
  const variants: string[] = [];
  const append = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !variants.includes(trimmed)) variants.push(trimmed);
  };
  append(provider);
  for (const separator of [":", "/", "\\", "."]) {
    append(provider.split(separator).filter(Boolean).pop());
  }
  for (const prefix of ["mcp__", "mcp_", "mcp-", "mcp:"]) {
    if (provider.toLowerCase().startsWith(prefix)) append(provider.slice(prefix.length));
  }
  return variants;
}

function normalizeMCPWrapperArguments(
  args: Record<string, unknown>,
  schema: ToolParameterSchemaShape
): Record<string, unknown> {
  if (!schema.properties.length) return args;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const output: Record<string, unknown> = {};
  const serverKey = firstMatchingProperty(["serverName", "server", "provider", "providerIdentifier", "provider_identifier"], schema.properties, normalizedProperties);
  const toolKey = firstMatchingProperty(["toolName", "tool", "name", "tool_name"], schema.properties, normalizedProperties);
  const argsKey = firstMatchingProperty(["arguments", "args", "input", "params", "parameters"], schema.properties, normalizedProperties);
  const serverName = firstStringArg(args, "providerIdentifier", "provider_identifier", "provider", "server", "serverName", "server_name");
  const toolName = firstStringArg(args, "toolName", "tool_name", "tool", "name");
  const payload = mcpPayloadArguments(args);
  if (serverKey && serverName) output[serverKey] = serverName;
  if (toolKey && toolName) output[toolKey] = toolName;
  if (argsKey) output[argsKey] = payload;
  return Object.keys(output).length ? output : args;
}

function mcpPayloadArguments(args: Record<string, unknown>): Record<string, unknown> {
  return recordArgumentValue(firstArg(args, mcpPayloadCandidates())) ?? {};
}

function mcpPayloadCandidates(): string[] {
  return ["args", "arguments", "input", "params", "parameters", "payload", "data"];
}

function normalizeWrapperObjectArguments(
  args: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  emittedName: string,
  schema: ToolParameterSchemaShape,
  wrapperDepth: number,
  context?: ToolCallContext
): Record<string, unknown> | undefined {
  if (!tool || wrapperDepth > 1) return undefined;
  const wrapper = wrapperObjectArgumentProperty(tool, schema);
  if (!wrapper) return undefined;
  const nested = normalizeToolArguments(
    args,
    { name: tool.name, description: tool.description, parameters: wrapper.parameters },
    canonicalToolName(emittedName) === "mcp" && canonicalToolName(tool.name) !== "mcp" ? tool.name : emittedName,
    wrapperDepth + 1,
    context
  );
  return { [wrapper.key]: nested };
}

function wrapperObjectArgumentProperty(
  tool: OpenAiToolSpec | undefined,
  schema = toolParameterSchema(tool)
): { key: string; parameters: unknown } | undefined {
  if (!tool || !schema.properties.length) return undefined;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  for (const candidate of wrapperObjectPropertyCandidates()) {
    const key = firstMatchingProperty([candidate], schema.properties, normalizedProperties);
    if (!key) continue;
    const parameters = schema.propertySchemas[key];
    if (toolParameterSchemaFromValue(parameters).properties.length > 0) {
      return { key, parameters };
    }
  }
  return undefined;
}

function wrapperObjectPropertyCandidates(): string[] {
  return ["input", "args", "arguments", "params", "parameters", "payload", "data"];
}

function toolParameterSchema(tool: OpenAiToolSpec | undefined): ToolParameterSchemaShape {
  return toolParameterSchemaFromValue(tool?.parameters);
}

function toolParameterSchemaFromValue(value: unknown, depth = 0, root: unknown = value, seenRefs: Set<string> = new Set()): ToolParameterSchemaShape {
  if (depth > 5) return emptyToolParameterSchema();
  const parameters = canonicalToolSchemaRecord(value, root, depth, seenRefs);
  if (!parameters) return emptyToolParameterSchema();

  const direct = directToolParameterSchema(parameters, root, depth, seenRefs);
  const allOf = composedToolSchemas(parameters.allOf)
    .map((schema) => toolParameterSchemaFromValue(schema, depth + 1, root, seenRefs));
  const variants = [
    ...composedToolSchemas(parameters.anyOf),
    ...composedToolSchemas(parameters.oneOf)
  ].map((schema) => toolParameterSchemaFromValue(schema, depth + 1, root, seenRefs));

  return mergeToolParameterSchemas(
    [
      direct,
      mergeToolParameterSchemas(allOf, "union"),
      mergeToolParameterSchemas(variants, "intersection")
    ],
    "union"
  );
}

function emptyToolParameterSchema(): ToolParameterSchemaShape {
  return {
    properties: [],
    required: [],
    allowAdditionalProperties: false,
    propertySchemas: {}
  };
}

function canonicalToolSchemaRecord(value: unknown, root: unknown, depth = 0, seenRefs: Set<string> = new Set()): Record<string, unknown> | undefined {
  if (depth > 5) return undefined;
  const dereferenced = dereferenceToolSchema(value, root, depth, seenRefs);
  if (!isRecord(dereferenced)) return undefined;
  if (!isRecord(dereferenced.properties)) {
    if (isRecord(dereferenced.schema)) return canonicalToolSchemaRecord(dereferenced.schema, root, depth + 1, seenRefs);
    if (isRecord(dereferenced.json_schema)) return canonicalToolSchemaRecord(dereferenced.json_schema, root, depth + 1, seenRefs);
  }
  return dereferenced;
}

function directToolParameterSchema(parameters: Record<string, unknown>, root: unknown, depth: number, seenRefs: Set<string>): ToolParameterSchemaShape {
  const properties = isRecord(parameters.properties) ? parameters.properties : undefined;
  const required = Array.isArray(parameters.required) ? parameters.required.filter((item): item is string => typeof item === "string") : [];
  const propertySchemas = properties
    ? Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, dereferenceToolSchema(schema, root, depth + 1, seenRefs)]))
    : {};
  return {
    properties: properties ? Object.keys(properties) : [],
    required,
    allowAdditionalProperties: parameters.additionalProperties === true || isRecord(parameters.additionalProperties),
    propertySchemas
  };
}

function composedToolSchemas(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dereferenceToolSchema(value: unknown, root: unknown, depth = 0, seenRefs: Set<string> = new Set()): unknown {
  if (depth > 5 || !isRecord(value) || typeof value.$ref !== "string") return value;
  const ref = value.$ref.trim();
  if (!ref || seenRefs.has(ref)) return value;
  const target = localSchemaReference(root, ref);
  if (target === undefined || target === value) return value;
  return dereferenceToolSchema(target, root, depth + 1, new Set([...seenRefs, ref]));
}

function localSchemaReference(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  const direct = jsonPointerTarget(root, ref);
  if (direct !== undefined) return direct;
  if (!isRecord(root)) return undefined;
  return jsonPointerTarget(root.schema, ref) ?? jsonPointerTarget(root.json_schema, ref);
}

function jsonPointerTarget(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) return undefined;
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/").map(jsonPointerToken)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function jsonPointerToken(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function mergeToolParameterSchemas(shapes: ToolParameterSchemaShape[], requiredMode: "union" | "intersection"): ToolParameterSchemaShape {
  const useful = shapes.filter((shape) => shape.properties.length || shape.required.length || shape.allowAdditionalProperties);
  if (!useful.length) return emptyToolParameterSchema();
  const propertySchemas: Record<string, unknown> = {};
  const properties: string[] = [];
  for (const shape of useful) {
    for (const property of shape.properties) {
      if (!properties.includes(property)) properties.push(property);
      propertySchemas[property] = propertySchemas[property] === undefined
        ? shape.propertySchemas[property]
        : mergePropertySchemas(propertySchemas[property], shape.propertySchemas[property]);
    }
  }
  const required = requiredMode === "intersection"
    ? intersectRequiredProperties(useful.map((shape) => shape.required))
    : Array.from(new Set(useful.flatMap((shape) => shape.required)));
  return {
    properties,
    required,
    allowAdditionalProperties: useful.some((shape) => shape.allowAdditionalProperties),
    propertySchemas
  };
}

function mergePropertySchemas(left: unknown, right: unknown): unknown {
  if (!isRecord(left) || !isRecord(right)) return left ?? right;
  const merged: Record<string, unknown> = { ...right, ...left };
  const enumValues = unionStringArrays(
    left.enum,
    right.enum,
    left.const === undefined ? undefined : [left.const],
    right.const === undefined ? undefined : [right.const]
  );
  if (enumValues.length) {
    merged.enum = enumValues;
    if (enumValues.length > 1) delete merged.const;
  }
  if (merged.description === undefined && typeof right.description === "string") merged.description = right.description;
  return merged;
}

function unionStringArrays(...values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && !output.includes(item)) output.push(item);
    }
  }
  return output;
}

function intersectRequiredProperties(requiredSets: string[][]): string[] {
  const nonEmpty = requiredSets.filter((required) => required.length > 0);
  if (!nonEmpty.length) return [];
  return nonEmpty[0].filter((property) => nonEmpty.every((required) => required.includes(property)));
}

function applyRequiredToolDefaults(
  output: Record<string, unknown>,
  required: string[],
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>
): Record<string, unknown> {
  if (!required.length) return output;
  const normalizedTool = normalizeToolName(tool?.name || "");
  const schema = toolParameterSchema(tool);
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const next = { ...output };
  if (isShellLikeTool(tool, originalArgs)) {
    const workdirKey = firstMatchingProperty(shellExplicitWorkdirCandidates(), schema.properties, normalizedProperties);
    if (workdirKey && required.includes(workdirKey) && !shouldIncludeOptionalPath(next[workdirKey])) {
      next[workdirKey] = ".";
    }
    const timeoutKey = firstMatchingProperty(timeoutCandidates(), schema.properties, normalizedProperties);
    if (timeoutKey && required.includes(timeoutKey) && next[timeoutKey] === undefined) {
      next[timeoutKey] = normalizeToolArgumentValue(120_000, timeoutKey, tool);
    }
    if (required.includes("description") && typeof next.description !== "string") {
      const command = commandLikeValue(next, tool) ?? firstStringArg(originalArgs, ...shellCommandCandidates());
      next.description = shellDescription(command);
    }
    const commandKey = commandLikeProperty(tool) ?? "command";
    if (required.includes(commandKey) && typeof next[commandKey] !== "string") {
      next[commandKey] = firstStringArg(originalArgs, ...shellCommandCandidates()) || "";
    }
  } else if (isGlobLikeToolName(normalizedTool)) {
    const requiredProperties = new Map(required.map((property) => [normalizeToolName(property), property]));
    const patternKey = firstMatchingProperty(globPatternCandidates(), required, requiredProperties);
    if (patternKey && typeof next[patternKey] !== "string") {
      next[patternKey] = firstStringArg(originalArgs, ...globPatternCandidates()) || "*";
    }
    const pathKey = firstMatchingProperty(globPathCandidates(), schema.properties, normalizedProperties);
    if (pathKey && required.includes(pathKey) && !shouldIncludeOptionalPath(next[pathKey])) {
      next[pathKey] = ".";
    }
  }
  return next;
}

function sanitizeNormalizedToolArguments(
  output: Record<string, unknown>,
  tool: OpenAiToolSpec | undefined,
  originalArgs: Record<string, unknown>
): Record<string, unknown> {
  if (!isShellLikeTool(tool, originalArgs)) return output;
  const next = { ...output };
  const schema = toolParameterSchema(tool);
  const required = new Set(schema.required);
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  const seen = new Set<string>();
  for (const candidate of shellExplicitWorkdirCandidates()) {
    const key = firstMatchingProperty([candidate], schema.properties, normalizedProperties) ?? candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isSyntheticSdkWorkingDirectory(next[key])) continue;
    if (required.has(key)) next[key] = ".";
    else delete next[key];
  }
  const commandKey = commandLikeProperty(tool) ?? "command";
  const command = typeof next[commandKey] === "string" ? next[commandKey] : firstStringArg(originalArgs, ...shellCommandCandidates());
  if (typeof command === "string" && shouldBackgroundShellCommand(command)) {
    next[commandKey] = backgroundShellCommand(command);
    if (typeof next.description === "string") {
      next.description = `Starts background process: ${next.description}`;
    }
  }
  return next;
}

function isShellLikeTool(tool: OpenAiToolSpec | undefined, originalArgs: Record<string, unknown>): boolean {
  const normalizedTool = normalizeToolName(tool?.name || "");
  if (["bash", "shell", "terminal"].includes(normalizedTool) || canonicalToolName(tool?.name || "") === "shell") return true;
  return Boolean(commandLikeProperty(tool) && firstStringArg(originalArgs, ...shellCommandCandidates()));
}

function commandLikeProperty(tool: OpenAiToolSpec | undefined): string | undefined {
  const schema = toolParameterSchema(tool);
  if (!schema.properties.length) return undefined;
  const normalizedProperties = new Map(schema.properties.map((property) => [normalizeToolName(property), property]));
  return firstMatchingProperty(shellCommandCandidates(), schema.properties, normalizedProperties);
}

function commandLikeValue(output: Record<string, unknown>, tool: OpenAiToolSpec | undefined): unknown {
  const commandKey = commandLikeProperty(tool);
  return commandKey ? output[commandKey] : output.command;
}

function isSyntheticSdkWorkingDirectory(value: unknown): boolean {
  return typeof value === "string" && ["", ".", "/workspace", "workspace"].includes(value.trim());
}

function shellDescription(command: unknown): string {
  if (typeof command !== "string" || !command.trim()) return "Runs shell command";
  const first = command.trim().split(/\s+/).slice(0, 5).join(" ");
  return `Runs ${first}`;
}

function shouldBackgroundShellCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text || isAlreadyBackgroundedShellCommand(text)) return false;
  if (/\bpython(?:3(?:\.\d+)?)?\s+-m\s+http\.server\b/.test(text)) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|preview)\b/.test(text)) return true;
  if (/\b(?:npx|bunx)\s+(?:vite|next|nuxt|astro|webpack-dev-server)\b/.test(text)) return true;
  if (/\b(?:vite|next|nuxt|astro|webpack-dev-server)\b/.test(text) && /\b(?:--host|--port|localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(text)) {
    return true;
  }
  return /\b(?:uvicorn|gunicorn|flask\s+run|php\s+-s)\b/.test(text);
}

function isAlreadyBackgroundedShellCommand(command: string): boolean {
  return /(^|[\s;&|])(?:nohup|setsid|tmux|screen)\b/.test(command) || /(^|[^&])&\s*(?:$|[;|])/.test(command) || /\bdisown\b|\$!/.test(command);
}

function backgroundShellCommand(command: string): string {
  const logPath = `/tmp/opencode-background-${hashString(command)}.log`;
  return `nohup sh -lc ${shellQuote(command)} > ${shellQuote(logPath)} 2>&1 & echo "Started background process pid=$! log=${logPath}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function expandToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const normalized = normalizeToolName(key);
    const nested = recordArgumentValue(value);
    if (nested && ["arguments", "args", "input", "parameters", "params"].includes(normalized)) {
      Object.assign(output, expandToolArguments(nested));
      continue;
    }
    if (nested && normalized === "targeting") {
      Object.assign(output, expandToolArguments(nested));
      continue;
    }
    output[key] = value;
  }
  return output;
}

function recordArgumentValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapToolArgument(
  key: string,
  properties: string[],
  normalizedProperties: Map<string, string>,
  toolName: string | undefined
): { target: string; priority: number } | null {
  const exact = properties.includes(key) ? key : normalizedProperties.get(normalizeToolName(key));
  if (exact) return { target: exact, priority: 100 };
  return aliasToolArgument(key, properties, normalizedProperties, toolName);
}

function aliasToolArgument(
  key: string,
  properties: string[],
  normalizedProperties: Map<string, string>,
  toolName: string | undefined
): { target: string; priority: number } | null {
  const normalized = normalizeToolName(key);
  const rules = [...toolSpecificArgumentAliases(normalizeToolName(toolName || ""), normalized), ...commonArgumentAliases(normalized)];
  for (const rule of rules) {
    const target = firstMatchingProperty(rule.candidates, properties, normalizedProperties);
    if (target) return { target, priority: rule.priority };
  }
  return null;
}

function firstMatchingProperty(
  candidates: string[],
  properties: string[],
  normalizedProperties: Map<string, string>
): string | undefined {
  for (const candidate of candidates) {
    if (properties.includes(candidate)) return candidate;
    const normalized = normalizedProperties.get(normalizeToolName(candidate));
    if (normalized) return normalized;
  }
  return undefined;
}

function commonArgumentAliases(normalized: string): Array<{ candidates: string[]; priority: number }> {
  const aliases: Record<string, Array<{ candidates: string[]; priority: number }>> = {
    absolutepath: [{ candidates: pathCandidates(), priority: 80 }],
    commandline: [{ candidates: shellCommandCandidates(), priority: 80 }],
    contents: [{ candidates: [...fileContentCandidates(), "newString"], priority: 70 }],
    command: [{ candidates: shellCommandCandidates(), priority: 90 }],
    shellcommand: [{ candidates: shellCommandCandidates(), priority: 95 }],
    code: [{ candidates: shellCommandCandidates(), priority: 60 }],
    cwd: [{ candidates: shellWorkdirCandidates(), priority: 45 }],
    directory: [{ candidates: [...shellWorkdirCandidates(), ...globPathCandidates()], priority: 45 }],
    filetext: [{ candidates: [...fileContentCandidates(), "newString"], priority: 95 }],
    filepath: [{ candidates: pathCandidates(), priority: 90 }],
    filename: [{ candidates: pathCandidates(), priority: 75 }],
    fileglob: [{ candidates: globPatternCandidates(), priority: 90 }],
    filepattern: [{ candidates: globPatternCandidates(), priority: 90 }],
    glob: [{ candidates: globPatternCandidates(), priority: 85 }],
    globpattern: [{ candidates: globPatternCandidates(), priority: 95 }],
    includepattern: [{ candidates: globPatternCandidates(), priority: 80 }],
    include: [{ candidates: globPatternCandidates(), priority: 70 }],
    literal: [{ candidates: ["literal", "fixedString", "fixed_string"], priority: 90 }],
    newcontents: [{ candidates: [...newTextCandidates(), ...fileContentCandidates()], priority: 85 }],
    newstring: [{ candidates: newTextCandidates(), priority: 95 }],
    newtext: [{ candidates: [...newTextCandidates(), "text"], priority: 85 }],
    oldcontents: [{ candidates: [...oldTextCandidates(), "text"], priority: 80 }],
    oldstring: [{ candidates: oldTextCandidates(), priority: 95 }],
    oldtext: [{ candidates: [...oldTextCandidates(), "text"], priority: 85 }],
    pattern: [{ candidates: ["pattern", "query", "regex", "search"], priority: 80 }],
    query: [{ candidates: ["query", "pattern", "search", "prompt"], priority: 80 }],
    regex: [{ candidates: ["pattern", "regex", "query"], priority: 75 }],
    replacement: [{ candidates: newTextCandidates(), priority: 85 }],
    replacewith: [{ candidates: newTextCandidates(), priority: 90 }],
    script: [{ candidates: shellCommandCandidates(), priority: 75 }],
    search: [{ candidates: ["pattern", "query", "oldString", "search"], priority: 70 }],
    searchstring: [{ candidates: ["pattern", "query", "oldString", "search"], priority: 80 }],
    searchpath: [{ candidates: globPathCandidates(), priority: 80 }],
    targetdirectory: [{ candidates: globPathCandidates(), priority: 55 }],
    target: [{ candidates: pathCandidates(), priority: 80 }],
    targetpath: [{ candidates: pathCandidates(), priority: 90 }],
    targetfile: [{ candidates: pathCandidates(), priority: 90 }],
    targeting: [{ candidates: ["path", "directory", "cwd", "pattern", "filePath"], priority: 45 }],
    timeout: [{ candidates: timeoutCandidates(), priority: 90 }],
    timeoutms: [{ candidates: timeoutCandidates(), priority: 95 }],
    timeoutmilliseconds: [{ candidates: timeoutCandidates(), priority: 95 }],
    timeoutseconds: [{ candidates: timeoutCandidates(), priority: 95 }],
    seconds: [{ candidates: timeoutCandidates(), priority: 80 }],
    url: [{ candidates: ["url", "uri", "href"], priority: 90 }]
  };
  if (normalized === "workingdirectory" || normalized === "workingdir") return [{ candidates: shellWorkdirCandidates(), priority: 90 }];
  if (normalized === "cmd") return [{ candidates: shellCommandCandidates(), priority: 95 }];
  if (normalized === "path") return [{ candidates: ["filePath", "path", "directory", "cwd", "pattern"], priority: 75 }];
  if (normalized === "prompt") return [{ candidates: ["prompt", "description", "instructions", "query"], priority: 80 }];
  if (normalized === "tasks") return [{ candidates: ["todos", "tasks", "items"], priority: 75 }];
  if (normalized === "todo" || normalized === "items") return [{ candidates: ["todos", "items", "tasks"], priority: 70 }];
  return aliases[normalized] ?? [];
}

function toolSpecificArgumentAliases(tool: string, normalized: string): Array<{ candidates: string[]; priority: number }> {
  if (isGlobLikeToolName(tool)) {
    if (["globpattern", "fileglob", "filepattern", "includepattern", "glob", "include", "pattern", "query"].includes(normalized)) {
      return [{ candidates: globPatternCandidates(), priority: 98 }];
    }
    if (["targeting", "targetdirectory", "searchpath", "basepath", "root", "rootdir", "cwd", "directory", "path"].includes(normalized)) {
      return [{ candidates: globPathCandidates(), priority: 40 }];
    }
  }
  if (["grep", "search", "searchfiles"].includes(tool)) {
    if (["query", "search", "searchstring", "regex", "pattern"].includes(normalized)) {
      return [{ candidates: ["pattern", "query", "regex", "search"], priority: 95 }];
    }
    if (["globpattern", "glob", "include"].includes(normalized)) {
      return [{ candidates: ["include", "glob", "files", "pattern"], priority: 75 }];
    }
    if (["caseinsensitive", "ignorecase"].includes(normalized)) {
      return [{ candidates: ["ignoreCase", "ignore_case", "caseInsensitive", "case_insensitive"], priority: 95 }];
    }
    if (["literal", "fixedstring"].includes(normalized)) {
      return [{ candidates: ["literal", "fixedString", "fixed_string"], priority: 95 }];
    }
    if (["headlimit", "limit", "maxresults", "maxresult"].includes(normalized)) {
      return [{ candidates: ["limit", "headLimit", "head_limit", "maxResults", "max_results"], priority: 90 }];
    }
    if (["context", "contextlines"].includes(normalized)) {
      return [{ candidates: ["context", "contextLines", "context_lines"], priority: 90 }];
    }
    if (["contextbefore", "beforecontext"].includes(normalized)) {
      return [{ candidates: ["contextBefore", "context_before", "beforeContext", "before_context"], priority: 90 }];
    }
    if (["contextafter", "aftercontext"].includes(normalized)) {
      return [{ candidates: ["contextAfter", "context_after", "afterContext", "after_context"], priority: 90 }];
    }
  }
  if (["read", "readfile", "openfile"].includes(tool)) {
    if (["targeting", "target", "targetpath", "targetfile", "filepath", "absolutepath", "relativepath", "path", "file"].includes(normalized)) {
      return [{ candidates: pathCandidates(), priority: 95 }];
    }
  }
  if (["write", "writefile", "createfile"].includes(tool)) {
    if (["targeting", "target", "targetpath", "targetfile", "filepath", "absolutepath", "relativepath", "path", "file"].includes(normalized)) {
      return [{ candidates: pathCandidates(), priority: 95 }];
    }
    if (["newcontents", "contents", "content", "text", "body", "data", "value"].includes(normalized)) {
      return [{ candidates: fileContentCandidates(), priority: 95 }];
    }
  }
  if (["edit", "editfile", "replacefile", "searchreplace"].includes(tool)) {
    if (["targeting", "target", "targetpath", "targetfile", "filepath", "absolutepath", "relativepath", "path", "file"].includes(normalized)) {
      return [{ candidates: pathCandidates(), priority: 95 }];
    }
    if (["oldstring", "oldtext", "oldcontents", "search", "searchstring", "find", "findtext"].includes(normalized)) {
      return [{ candidates: oldTextCandidates(), priority: 95 }];
    }
    if (["newstring", "newtext", "newcontents", "replacement", "replace", "replacewith", "content"].includes(normalized)) {
      return [{ candidates: newTextCandidates(), priority: 95 }];
    }
  }
  if (["bash", "shell", "terminal", "runterminalcmd"].includes(tool)) {
    if (["cmd", "commandline", "command", "script", "shellcommand", "code"].includes(normalized)) {
      return [{ candidates: shellCommandCandidates(), priority: 95 }];
    }
    if (["workingdirectory", "workingdir", "cwd", "directory", "dir", "path", "workdir", "projectroot"].includes(normalized)) {
      return [{ candidates: shellWorkdirCandidates(), priority: 95 }];
    }
    if (["timeout", "timeoutms", "timeoutmilliseconds", "timeoutseconds", "seconds"].includes(normalized)) {
      return [{ candidates: timeoutCandidates(), priority: 95 }];
    }
  }
  if (["webfetch", "fetch", "web"].includes(tool)) {
    if (["url", "uri", "href"].includes(normalized)) return [{ candidates: ["url", "uri", "href"], priority: 95 }];
    if (["prompt", "query", "instructions"].includes(normalized)) {
      return [{ candidates: ["prompt", "query", "instructions"], priority: 90 }];
    }
  }
  if (["todowrite", "todo"].includes(tool) && ["todos", "tasks", "items"].includes(normalized)) {
    return [{ candidates: ["todos", "tasks", "items"], priority: 95 }];
  }
  if (tool === "task") {
    if (["prompt", "instructions", "query"].includes(normalized)) {
      return [{ candidates: ["prompt", "description", "instructions"], priority: 90 }];
    }
    if (["subagenttype", "agent", "agenttype"].includes(normalized)) {
      return [{ candidates: ["subagent_type", "subagentType", "agent"], priority: 90 }];
    }
  }
  return [];
}

function toolNameAliases(normalized: string): string[] {
  const aliases: Record<string, string[]> = {
    createfile: ["write"],
    editfile: ["edit"],
    fileglob: ["glob", "find"],
    filesearch: ["glob", "grep", "find"],
    find: ["glob"],
    findfile: ["glob"],
    findfiles: ["glob", "find"],
    openfile: ["read"],
    readfile: ["read"],
    replacefile: ["edit"],
    runterminalcmd: ["bash", "shell"],
    shellcommand: ["bash", "shell"],
    shell: ["bash"],
    searchfiles: ["grep", "glob"],
    searchreplace: ["edit"],
    terminal: ["bash", "shell"],
    ls: ["list"],
    list: ["ls"],
    mcp: ["callmcptool"],
    writefile: ["write"]
  };
  return aliases[normalized] ?? [];
}

function isGlobLikeToolName(normalized: string): boolean {
  return ["glob", "fileglob", "filesearch", "find", "findfile", "findfiles", "globfiles"].includes(normalized);
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

function includeStreamUsage(record: Record<string, unknown>): boolean {
  return isRecord(record.stream_options) && record.stream_options.include_usage === true;
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(`${name} must be an object`, 400, "invalid_request_error", name);
  return value;
}

function expectArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(`${name} must be an array`, 400, "invalid_request_error", name);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
