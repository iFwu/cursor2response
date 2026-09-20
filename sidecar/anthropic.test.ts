import { describe, expect, test } from "vitest";
import {
  anthropicError,
  anthropicMessage,
  anthropicSseEvents,
  anthropicToChatBody,
  contextFromAnthropicBeta,
  estimateTokens,
  flattenToolResultContent,
  mapModel,
  mapToolChoice
} from "./anthropic.ts";
import type { CursorTextEvent } from "../core/cursor.ts";

describe("mapModel", () => {
  test("preserves live Cursor catalog ids and parameterized model syntax", () => {
    expect(mapModel("claude-opus-4-8[context=1m,effort=high]"))
      .toBe("claude-opus-4-8[context=1m,effort=high]");
    expect(mapModel("claude-opus-5[1m]")).toBe("claude-opus-5[context=1m]");
    expect(mapModel("claude-opus-5[300K,effort=max]"))
      .toBe("claude-opus-5[context=300k,effort=max]");
    expect(mapModel("auto-smart[mode=balanced]")).toBe("auto-smart[mode=balanced]");
    expect(mapModel(undefined)).toBe("auto");
  });

  test("maps Claude Code context beta headers to Cursor context values", () => {
    expect(contextFromAnthropicBeta("claude-code-20250219,context-1m-2025-08-07,effort-2025-11-24"))
      .toBe("1m");
    expect(contextFromAnthropicBeta("context-300K-preview")).toBe("300k");
    expect(contextFromAnthropicBeta("claude-code-20250219")).toBeUndefined();
  });
});

describe("estimateTokens / anthropicError", () => {
  test("estimateTokens ~ chars/4, min 1", () => {
    expect(estimateTokens(0)).toBe(1);
    expect(estimateTokens(40)).toBe(10);
  });
  test("anthropicError envelope", () => {
    expect(anthropicError("nope", "authentication_error")).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "nope" }
    });
  });
});

describe("flattenToolResultContent", () => {
  test("string passthrough", () => {
    expect(flattenToolResultContent("hello")).toBe("hello");
  });
  test("array of text blocks joined; is_error prefixed", () => {
    const out = flattenToolResultContent([{ type: "text", text: "line1" }, { type: "text", text: "line2" }], true);
    expect(out).toBe("[tool error] line1\nline2");
  });
});

describe("mapToolChoice", () => {
  test("translates the variants", () => {
    expect(mapToolChoice({ type: "auto" })).toBeUndefined();
    expect(mapToolChoice({ type: "any" })).toBe("required");
    expect(mapToolChoice({ type: "none" })).toBe("none");
    expect(mapToolChoice({ type: "tool", name: "read" })).toEqual({ type: "function", function: { name: "read" } });
  });
});

describe("anthropicToChatBody", () => {
  test("forwards model and effort into the Cursor selection layer", () => {
    const body = anthropicToChatBody({
      model: "claude-opus-4-8",
      output_config: { effort: "high" },
      service_tier: "priority",
      messages: []
    });
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.reasoning_effort).toBe("high");
    expect(body.service_tier).toBe("priority");
  });

  test("system string -> leading system message", () => {
    const body = anthropicToChatBody({ system: "be terse", messages: [{ role: "user", content: "hi" }] });
    expect((body.messages as any[])[0]).toEqual({ role: "system", content: "be terse" });
    expect((body.messages as any[])[1]).toEqual({ role: "user", content: "hi" });
  });

  test("system array (cache_control ignored) -> joined text", () => {
    const body = anthropicToChatBody({ system: [{ type: "text", text: "A", cache_control: { type: "ephemeral" } }, { type: "text", text: "B" }], messages: [] });
    expect((body.messages as any[])[0]).toEqual({ role: "system", content: "A\nB" });
  });

  test("preserves Claude Code mid-conversation system messages", () => {
    const body = anthropicToChatBody({
      messages: [
        { role: "user", content: [{ type: "text", text: "你是什么模型？" }] },
        { role: "system", content: [{ type: "text", text: "Dynamic skill metadata" }] }
      ]
    });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "你是什么模型？" }] },
      { role: "system", content: "Dynamic skill metadata" }
    ]);
  });

  test("user text + base64 image -> image_url data URL", () => {
    const body = anthropicToChatBody({
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] }]
    });
    const userMsg = (body.messages as any[]).find((m) => m.role === "user");
    expect(userMsg.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }
    ]);
  });

  test("assistant tool_use -> OpenAI tool_calls (id verbatim, args JSON)", () => {
    const body = anthropicToChatBody({
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_abc", name: "read", input: { path: "x" } }] }]
    });
    const asst = (body.messages as any[]).find((m) => m.role === "assistant");
    expect(asst.content).toBeNull();
    expect(asst.tool_calls).toEqual([{ id: "toolu_abc", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "x" }) } }]);
  });

  test("user tool_result (array content + is_error) -> tool message", () => {
    const body = anthropicToChatBody({
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_abc", is_error: true, content: [{ type: "text", text: "boom" }] }] }]
    });
    const toolMsg = (body.messages as any[]).find((m) => m.role === "tool");
    expect(toolMsg).toEqual({ role: "tool", tool_call_id: "toolu_abc", content: "[tool error] boom" });
  });

  test("tools -> OpenAI function with parameters from input_schema; tool_choice mapped", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const body = anthropicToChatBody({
      messages: [],
      tools: [{ name: "read", description: "Read a file", input_schema: schema }],
      tool_choice: { type: "any" }
    });
    expect(body.tools).toEqual([{ type: "function", function: { name: "read", description: "Read a file", parameters: schema } }]);
    expect(body.tool_choice).toBe("required");
  });
});

describe("anthropicMessage", () => {
  test("text only", () => {
    const msg = anthropicMessage({ id: "msg_1", model: "claude-x", text: "hello", toolCalls: [], inputTokens: 5, outputTokens: 2 });
    expect(msg).toMatchObject({
      id: "msg_1", type: "message", role: "assistant", model: "claude-x",
      content: [{ type: "text", text: "hello" }], stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 }
    });
  });
  test("with tool call -> tool_use block + stop_reason tool_use; empty text omits text block", () => {
    const msg = anthropicMessage({ id: "msg_2", model: "m", text: "", toolCalls: [{ name: "read", arguments: { path: "x" } }], inputTokens: 1, outputTokens: 1 });
    expect((msg.content as any[]).length).toBe(1);
    expect((msg.content as any[])[0]).toMatchObject({ type: "tool_use", name: "read", input: { path: "x" } });
    expect((msg.content as any[])[0].id).toMatch(/^toolu_/);
    expect(msg.stop_reason).toBe("tool_use");
  });

  test("maps SDK shell calls back to Claude Code's Bash tool", () => {
    const msg = anthropicMessage({
      id: "msg_3",
      model: "m",
      text: "",
      toolCalls: [{ name: "shell", arguments: { command: "rg --files" } }],
      tools: [{
        name: "Bash",
        description: "Execute a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"]
        }
      }],
      inputTokens: 1,
      outputTokens: 1
    });

    expect((msg.content as any[])[0]).toMatchObject({
      type: "tool_use",
      name: "Bash",
      input: { command: "rg --files" }
    });
    expect(msg.stop_reason).toBe("tool_use");
  });
});

async function* events(...evts: CursorTextEvent[]): AsyncGenerator<CursorTextEvent> {
  for (const e of evts) yield e;
}
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("anthropicSseEvents", () => {
  test("text-only stream -> ordered events with correct shapes", async () => {
    const out = await collect(anthropicSseEvents({
      id: "msg_1", model: "m", inputTokens: 3,
      stream: events({ type: "text", text: "Hi" }, { type: "text", text: "!" }, { type: "done", finalText: "Hi!", toolCalls: [] })
    }));
    expect(out.map((e) => e.event)).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"
    ]);
    const firstDelta = out[2].data as any;
    expect(firstDelta).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } });
    expect((out[5].data as any).delta.stop_reason).toBe("end_turn");
  });

  test("text + tool_call -> text stops, tool block at index 1, stop_reason tool_use", async () => {
    const out = await collect(anthropicSseEvents({
      id: "msg_2", model: "m", inputTokens: 1,
      stream: events(
        { type: "text", text: "ok" },
        { type: "tool_call", toolCall: { callId: "call_sdk_dddddddddddddddddddddddddddddddd_read", name: "read", arguments: { path: "x" } } },
        { type: "done", finalText: "ok", toolCalls: [] }
      )
    }));
    const types = out.map((e) => e.event);
    // text block 0 opened+delta+stopped, then tool block 1 start/delta/stop, then message_delta/stop
    expect(types).toEqual([
      "message_start", "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"
    ]);
    const toolStart = out[4].data as any;
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toMatchObject({
      type: "tool_use",
      id: "call_sdk_dddddddddddddddddddddddddddddddd_read",
      name: "read",
      input: {}
    });
    const toolDelta = out[5].data as any;
    expect(toolDelta.delta).toEqual({ type: "input_json_delta", partial_json: JSON.stringify({ path: "x" }) });
    expect((out[7].data as any).delta.stop_reason).toBe("tool_use");
  });
});
