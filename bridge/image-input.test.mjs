import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
const state = vi.hoisted(() => {
  const directory = `/tmp/cursor2response-images-${process.pid}-${Date.now()}`;
  process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
  return { directory };
});
import { Agent, acknowledgePendingAgentOutput, normalizeResumeToolResults, runLocalAgentBody } from "./server.mjs";
import { collectCursorSdkOutput, createCursorSdkCompletion } from "../core/cursor-sdk.ts";
import { prepareResponsesRequest, responseToolContinuation } from "../core/openai.ts";

const image = (data) => ({ type: "input_image", image_url: `data:image/png;base64,${data}` });
const user = (data) => ({ role: "user", content: [{ type: "input_text", text: "Inspect" }, image(data)] });
const sdkImage = (data) => ({ mimeType: "image/png", data });
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(state.directory, { recursive: true, force: true }));

function harness(send) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = { agentId: crypto.randomUUID(), close: vi.fn(), send: vi.fn(send ?? (async () => ({
    id: crypto.randomUUID(), cancel: vi.fn(),
    async *stream() { yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } }; },
    wait: async () => ({ status: "finished", result: "" })
  }))) };
  const create = vi.spyOn(Agent, "create").mockResolvedValue(agent);
  const requests = [];
  const sessionKey = crypto.randomUUID();
  async function request(body, overrides = {}) {
    const prepared = prepareResponsesRequest(body, { id: "grok-4.6" });
    const continuation = responseToolContinuation(body);
    const completion = await createCursorSdkCompletion({ CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" }, {
      now: () => new Date(), randomUUID: () => crypto.randomUUID(),
      fetch: async (_url, init) => {
        const wire = JSON.parse(init.body);
        requests.push(wire);
        const output = await runLocalAgentBody({
          ...wire, model: wire.model, workingDirectory: state.directory,
          clientTools: prepared.tools ?? [],
          resumeToolResults: normalizeResumeToolResults(wire.resumeToolResults, {}),
          hasIncrementalPrompt: Boolean(wire.incrementalPrompt), fullReplay: !wire.incrementalPrompt,
          supersededToolCallIds: wire.supersededToolCallIds ?? []
        });
        acknowledgePendingAgentOutput(output);
        return Response.json(output);
      }
    }, "synthetic-test-key", {
      prompt: prepared.prompt, agentContext: prepared.agentContext, sessionKey,
      model: { id: "grok-4.6" }, clientTools: prepared.tools,
      resumeToolResults: continuation.results, ...overrides
    });
    return collectCursorSdkOutput(completion.stream);
  }
  return { agent, create, requests, request };
}

describe("Responses image delivery", () => {
  it("carries actual image bytes through Bridge, slices accepted history, and replaces same-count edited history", async () => {
    const h = harness();
    const first = { input: [user("AQID")] };
    await h.request(first);
    expect(h.agent.send.mock.calls[0][0]).toEqual({ text: h.requests[0].prompt, images: [sdkImage("AQID")] });
    expect(h.requests[0].prompt).not.toContain("AQID");
    const second = { input: [...first.input, { role: "assistant", content: "done" }, user("BAUG")] };
    await h.request(second);
    expect(h.agent.send.mock.calls[1][0]).toEqual({ text: "INPUT:\nUSER: Inspect\n[image]", images: [sdkImage("BAUG")] });
    expect(h.create).toHaveBeenCalledOnce();
    const edited = { input: [user("BwgJ"), ...second.input.slice(1), { role: "assistant", content: "done" }, { role: "user", content: "continue" }] };
    await h.request(edited);
    expect(h.requests[2].agentContext.transcriptItemHashes[0]).not.toBe(h.requests[0].agentContext.transcriptItemHashes[0]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.agent.send.mock.calls[2][0].images).toEqual([sdkImage("BwgJ"), sdkImage("BAUG")]);
  });

  it("hashes historical tool-result image content and replays a same-count edit", async () => {
    const h = harness();
    const body = (data) => ({ input: [
      { role: "user", content: "Inspect the result" },
      { type: "function_call", call_id: "historical-image", name: "inspect", arguments: "{}" },
      { type: "function_call_output", call_id: "historical-image", output: [image(data)] }
    ] });
    await h.request(body("AQID"), { resumeToolResults: [] });
    await h.request(body("BAUG"), { resumeToolResults: [] });
    expect(h.requests[1].agentContext.transcriptItemHashes[2]).not.toBe(h.requests[0].agentContext.transcriptItemHashes[2]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.agent.send.mock.calls[1][0].images).toEqual([sdkImage("BAUG")]);
  });

  it.each([
    { data: "", mimeType: "image/png" },
    { data: "AQID====", mimeType: "image/png" },
    { data: "not base64!", mimeType: "image/png" },
    { data: "AQID", mimeType: "text/html" }
  ])("rejects invalid image tool results before SDK callback admission: %j", (invalid) => {
    expect(() => normalizeResumeToolResults([{ callId: "image-tool", output: "", images: [invalid] }], {}))
      .toThrow(expect.objectContaining({ status: 400, code: "invalid_request_error" }));
  });

  it.each([false, true])("delivers image tool results once through the owned callback (isError=%s)", async (isError) => {
    let callback;
    let deliver;
    const h = harness(async (_message, options) => {
      const gate = new Promise((resolve) => { deliver = resolve; });
      return {
        id: crypto.randomUUID(), cancel: vi.fn(),
        async *stream() {
          const tools = options.local.customTools;
          callback = tools.inspect.execute({}, { toolCallId: "image-tool" });
          callback.then(deliver);
          await gate;
          yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
        },
        wait: async () => ({ status: "finished", result: "" })
      };
    });
    const body = {
      tools: [{ type: "function", name: "inspect", parameters: { type: "object", properties: {} } }],
      input: [{ role: "user", content: "Use inspect" }]
    };
    const output = await h.request(body);
    const callId = output.toolCalls[0].callId;
    await h.request({ ...body, input: [...body.input,
      { type: "custom_tool_call", call_id: callId, name: "inspect", input: "" },
      { type: "custom_tool_call_output", call_id: callId, is_error: isError, output: [
        { type: "input_text", text: "screenshot" }, image("AQID")
      ] }
    ] });
    expect(await callback).toEqual({ content: [
      { type: "text", text: "screenshot\n[image]" }, { type: "image", data: "AQID", mimeType: "image/png" }
    ], ...(isError ? { isError: true } : {}) });
    expect(h.agent.send).toHaveBeenCalledOnce();
  });

  it.each(["https://example.com/image.png", "http://127.0.0.1/private", "file:///etc/passwd"])("rejects remote or local image URLs without fetching: %s", async (url) => {
    const h = harness();
    await expect(h.request({ input: [{ role: "user", content: [{ type: "input_image", image_url: url }] }] }))
      .rejects.toMatchObject({ status: 400, code: "unsupported_parameter" });
    expect(h.requests).toHaveLength(0);
    expect(h.agent.send).not.toHaveBeenCalled();
  });
});
