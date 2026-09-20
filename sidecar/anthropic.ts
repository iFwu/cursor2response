/**
 * Anthropic Messages API <-> OpenAI/Cursor adapter (sidecar-local, pure translation).
 *
 * Lets Claude Code (CLI) use Cursor's Composer via ANTHROPIC_BASE_URL: we convert an
 * Anthropic `/v1/messages` request into the OpenAI-shaped body that `core/openai.ts`
 * `prepareChatRequest` already understands, run it through the existing Cursor SDK path,
 * then translate the resulting `CursorTextEvent` stream back into an Anthropic `Message`
 * (non-stream) or Anthropic SSE events (stream).
 *
 * See docs/specs/protocol-support.md for the current maintenance contract.
 */
import type { CursorTextEvent } from "../core/cursor.ts";
import type { CursorToolCall } from "../core/types.ts";
import { toOpenAiToolCalls, type OpenAiToolSpec, type ToolCallContext } from "../core/openai.ts";

const PRIMARY_MODEL = "auto";

type Block = Record<string, unknown>;
type Msg = { role?: string; content?: unknown };

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Preserve the requested Cursor catalog id, including Agent CLI bracket parameters.
 * Callers can set ANTHROPIC_MODEL to an exact id returned by `/v1/models`. */
export function mapModel(model: unknown): string {
  const requested = typeof model === "string" && model.trim() ? model.trim() : PRIMARY_MODEL;
  const match = /^([^\[]+?)\[([^\]]+)\]$/.exec(requested);
  if (!match) return requested;

  const params = match[2].split(",").map((entry) => {
    const trimmed = entry.trim();
    return !trimmed.includes("=") && /^\d+(?:\.\d+)?[km]$/i.test(trimmed)
      ? `context=${trimmed.toLowerCase()}`
      : trimmed;
  });
  return `${match[1].trim()}[${params.join(",")}]`;
}

/** Claude Code keeps the wire model at its base id and advertises extended
 * context through `anthropic-beta`, e.g. `context-1m-2025-08-07`. */
export function contextFromAnthropicBeta(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /(?:^|,)\s*context-(\d+(?:\.\d+)?[km])(?:-|,|$)/i.exec(value);
  return match?.[1]?.toLowerCase();
}

/** Estimate tokens from a character count (count_tokens / usage are non-exact by design). */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/** Anthropic error envelope. */
export function anthropicError(message: string, type = "api_error"): { type: "error"; error: { type: string; message: string } } {
  return { type: "error", error: { type, message } };
}

/** Flatten an Anthropic `tool_result.content` (string OR array of blocks) to plain text. */
export function flattenToolResultContent(content: unknown, isError = false): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!isRecord(b)) return typeof b === "string" ? b : "";
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") return "[image]";
        return typeof b.text === "string" ? b.text : JSON.stringify(b);
      })
      .filter(Boolean)
      .join("\n");
  } else {
    text = content == null ? "" : String(content);
  }
  return isError ? `[tool error] ${text}` : text;
}

/** Anthropic `tool_choice` -> OpenAI `tool_choice` (undefined = omit). */
export function mapToolChoice(tc: unknown): unknown {
  if (!isRecord(tc)) return undefined;
  switch (tc.type) {
    case "auto":
      return undefined;
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof tc.name === "string" ? { type: "function", function: { name: tc.name } } : undefined;
    default:
      return undefined;
  }
}

function imagePartFromBlock(block: Block): Record<string, unknown> | null {
  const source = isRecord(block.source) ? block.source : null;
  if (source && source.type === "base64" && typeof source.data === "string") {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${source.data}` } };
  }
  // url / file sources are best-effort: surface as text so we never crash.
  if (source && source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/** Convert an Anthropic Messages request body into the OpenAI-shaped body that
 * `prepareChatRequest` consumes. May expand one Anthropic message into several OpenAI
 * messages (tool_result blocks become separate `tool` messages). */
export function anthropicToChatBody(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {};
  const out: Record<string, unknown> = { model: mapModel(record.model), stream: record.stream === true };
  const messages: Array<Record<string, unknown>> = [];

  // system: string or array of text blocks (ignore cache_control / unknown keys).
  const system = record.system;
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  for (const raw of asArray<Msg>(record.messages)) {
    const role = raw?.role === "assistant" ? "assistant" : raw?.role === "system" ? "system" : "user";
    const content = raw?.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    const blocks = asArray<Block>(content);
    if (role === "system") {
      const text = blocks
        .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    if (role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (!isRecord(b)) continue;
        if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: typeof b.id === "string" ? b.id : `toolu_${toolCalls.length}`,
            type: "function",
            function: { name: typeof b.name === "string" ? b.name : "", arguments: JSON.stringify(b.input ?? {}) }
          });
        }
      }
      const assistant: Record<string, unknown> = { role: "assistant", content: parts.length ? parts : null };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }

    // user: tool_result blocks -> separate `tool` messages; text/image -> a user message.
    const userParts: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      if (!isRecord(b)) continue;
      if (b.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          content: flattenToolResultContent(b.content, b.is_error === true)
        });
      } else if (b.type === "text" && typeof b.text === "string") {
        userParts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const img = imagePartFromBlock(b);
        if (img) userParts.push(img);
        else userParts.push({ type: "text", text: "[unsupported image source]" });
      }
    }
    if (userParts.length) messages.push({ role: "user", content: userParts });
  }

  out.messages = messages;

  const tools = asArray<Block>(record.tools)
    .filter(isRecord)
    .map((t) => ({
      type: "function",
      function: {
        name: typeof t.name === "string" ? t.name : "",
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        parameters: t.input_schema ?? { type: "object", properties: {} },
        ...(t.output_schema !== undefined ? { output_schema: t.output_schema } : {}),
        ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
        ...(t.annotations !== undefined ? { annotations: t.annotations } : {})
      }
    }));
  if (tools.length) out.tools = tools;
  const toolChoice = mapToolChoice(record.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  const outputConfig = isRecord(record.output_config) ? record.output_config : {};
  const effort = [outputConfig.effort, record.reasoning_effort]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof effort === "string") out.reasoning_effort = effort.trim();

  for (const key of ["service_tier", "fast", "cursor_params", "cursor_fast", "cursor_context", "cursor_router_mode", "optimize_for"]) {
    if (record[key] !== undefined) out[key] = record[key];
  }

  return out;
}

function toolUseBlock(toolCall: CursorToolCall): Record<string, unknown> {
  return {
    type: "tool_use",
    id: toolCall.callId || `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
    name: toolCall.name,
    input: isRecord(toolCall.arguments) ? toolCall.arguments : {}
  };
}

export function mapAnthropicToolCall(input: {
  toolCall: CursorToolCall;
  tools: OpenAiToolSpec[];
  responseId: string;
  index: number;
  context?: ToolCallContext;
}): CursorToolCall | undefined {
  const mapped = toOpenAiToolCalls({
    toolCalls: [input.toolCall],
    tools: input.tools,
    responseId: input.responseId,
    startIndex: input.index,
    context: input.context
  })[0];
  if (!mapped) return undefined;
  let args: unknown = {};
  try {
    args = JSON.parse(mapped.function.arguments);
  } catch {
    args = {};
  }
  return {
    callId: mapped.id,
    name: mapped.function.name,
    arguments: isRecord(args) ? args : {}
  };
}

/** Build a non-stream Anthropic `Message` object. */
export function anthropicMessage(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: CursorToolCall[];
  tools?: OpenAiToolSpec[];
  toolContext?: ToolCallContext;
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  let emittedToolCalls = 0;
  for (const [index, toolCall] of opts.toolCalls.entries()) {
    const mapped = opts.tools?.length
      ? mapAnthropicToolCall({ toolCall, tools: opts.tools, responseId: opts.id, index, context: opts.toolContext })
      : toolCall;
    if (!mapped) continue;
    content.push(toolUseBlock(mapped));
    emittedToolCalls += 1;
  }
  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    model: opts.model,
    content,
    stop_reason: emittedToolCalls ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens }
  };
}

/** Translate a `CursorTextEvent` stream into the ordered Anthropic SSE event objects.
 * The caller serializes each as `event: <event>\ndata: <JSON.stringify(data)>\n\n`. */
export async function* anthropicSseEvents(opts: {
  id: string;
  model: string;
  inputTokens: number;
  stream: AsyncIterable<CursorTextEvent>;
  tools?: OpenAiToolSpec[];
  toolContext?: ToolCallContext;
}): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: opts.id,
        type: "message",
        role: "assistant",
        model: opts.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: opts.inputTokens, output_tokens: 1 }
      }
    }
  };

  let textIndex = -1; // index of the open text block, or -1
  let nextIndex = 0;
  let outputChars = 0;
  let sawTool = false;
  let toolCallIndex = 0;

  for await (const event of opts.stream) {
    if (event.type === "text" && event.text) {
      if (textIndex === -1) {
        textIndex = nextIndex++;
        yield { event: "content_block_start", data: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } } };
      }
      outputChars += event.text.length;
      yield { event: "content_block_delta", data: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: event.text } } };
    } else if (event.type === "tool_call" && event.toolCall) {
      const mapped = opts.tools?.length
        ? mapAnthropicToolCall({
            toolCall: event.toolCall,
            tools: opts.tools,
            responseId: opts.id,
            index: toolCallIndex,
            context: opts.toolContext
          })
        : event.toolCall;
      toolCallIndex += 1;
      if (!mapped) continue;
      if (textIndex !== -1) {
        yield { event: "content_block_stop", data: { type: "content_block_stop", index: textIndex } };
        textIndex = -1;
      }
      const idx = nextIndex++;
      const block = toolUseBlock(mapped);
      const input = block.input as Record<string, unknown>;
      yield { event: "content_block_start", data: { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } } };
      yield { event: "content_block_delta", data: { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } };
      yield { event: "content_block_stop", data: { type: "content_block_stop", index: idx } };
      sawTool = true;
    } else if (event.type === "done") {
      break;
    }
  }

  if (textIndex !== -1) {
    yield { event: "content_block_stop", data: { type: "content_block_stop", index: textIndex } };
  }
  yield {
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: sawTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: estimateTokens(outputChars) } }
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}
