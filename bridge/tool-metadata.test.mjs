import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectCursorSdkOutput, createCursorSdkCompletion } from "../core/cursor-sdk.ts";
import { prepareChatRequest, prepareResponsesRequest } from "../core/openai.ts";
import { anthropicToChatBody } from "../sidecar/anthropic.ts";

const previousDirectory = process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR;
const directory = mkdtempSync(path.join(tmpdir(), "cursor2response-tool-metadata-tests-"));
process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
const { Agent, localAgentSendOptions, runLocalAgentBody } = await import("./server.mjs");

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (previousDirectory === undefined) delete process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR;
  else process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

const outputSchema = {
  type: "object",
  properties: { count: { type: "integer" } },
  required: ["count"],
  additionalProperties: false
};
const annotations = {
  title: "Inspect files",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

function prepareTool(tool) {
  return prepareResponsesRequest({
    model: "grok-4.6",
    input: "Inspect the workspace.",
    tools: [{ type: "function", name: "inspect", parameters: { type: "object" }, ...tool }]
  }, { id: "grok-4.6" });
}

function sdkTool(tool) {
  return localAgentSendOptions({ model: "grok-4.6", clientTools: [tool] }).local.customTools.inspect;
}

describe("SDK tool metadata", () => {
  it.each([
    { output_schema: outputSchema, annotations },
    { outputSchema, annotations },
    { function: { name: "inspect", parameters: { type: "object" }, output_schema: outputSchema, annotations } },
    { function: { name: "inspect", parameters: { type: "object" }, outputSchema, annotations } }
  ])("preserves explicit metadata from Responses through the Bridge wire and SDK tool definition %#", async (definition) => {
    const prepared = prepareTool(definition);
    let forwardedTool;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" },
      {
        now: () => new Date("2026-09-05T00:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          forwardedTool = sdkTool(body.tools[0]);
          return Response.json({ text: "done", toolCalls: [], status: "completed" });
        }
      },
      "metadata-test-key",
      {
        prompt: prepared.prompt,
        model: prepared.cursorModel,
        sessionKey: crypto.randomUUID(),
        clientTools: prepared.tools,
        agentContext: prepared.agentContext
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "done" });
    expect(forwardedTool).toMatchObject({ outputSchema, annotations });
    expect(prepared.responseMetadata.tools[0]).toMatchObject({ output_schema: outputSchema, annotations });
  });

  it("does not infer schema or safety hints and ignores unknown annotations", () => {
    const absent = sdkTool(prepareTool({ description: "Read files safely and idempotently" }).tools[0]);
    expect(absent).not.toHaveProperty("outputSchema");
    expect(absent).not.toHaveProperty("annotations");
    const partial = sdkTool(prepareTool({ annotations: { destructiveHint: false, permission: "allow" } }).tools[0]);
    expect(partial.annotations).toEqual({ destructiveHint: false });
    expect(sdkTool(prepareTool({ annotations: {} }).tools[0]).annotations).toEqual({});
  });

  it.each([
    { output_schema: null },
    { output_schema: [] },
    { output_schema: true },
    { outputSchema: "object" },
    { annotations: null },
    { annotations: [] },
    { annotations: false },
    { annotations: { title: false } },
    { annotations: { readOnlyHint: "true" } },
    { annotations: { destructiveHint: 0 } },
    { annotations: { idempotentHint: null } },
    { annotations: { openWorldHint: {} } }
  ])("rejects invalid public metadata with HTTP 400 %#", (definition) => {
    expect(() => prepareTool(definition)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_request_error" }));
  });

  it.each([
    { outputSchema: null },
    { outputSchema: [] },
    { annotations: null },
    { annotations: [] },
    { annotations: { title: 5 } },
    { annotations: { readOnlyHint: "false" } },
    { annotations: { destructiveHint: null } },
    { annotations: { idempotentHint: 0 } },
    { annotations: { openWorldHint: [] } }
  ])("rejects invalid metadata at the SDK boundary with HTTP 400 %#", (definition) => {
    expect(() => sdkTool({ name: "inspect", ...definition }))
      .toThrowError(expect.objectContaining({ status: 400, code: "invalid_request" }));
  });

  it("keeps external execution and accepts an unmatched output schema without modifying the result", async () => {
    const prepared = prepareTool({ output_schema: outputSchema, annotations });
    let settledResult;
    const agent = {
      agentId: `metadata-agent-${crypto.randomUUID()}`,
      close: vi.fn(),
      send: vi.fn(async (_prompt, options) => {
        const result = options.local.customTools.inspect.execute({}, { toolCallId: "sdk-inspect" });
        return {
          id: `metadata-run-${crypto.randomUUID()}`,
          cancel: vi.fn(),
          async *stream() {
            settledResult = await result;
            yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
          },
          wait: async () => ({ status: "finished", result: "" })
        };
      })
    };
    vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const identity = crypto.randomUUID();
    const input = {
      apiKey: "metadata-test-key", model: "grok-4.6", workingDirectory: directory,
      sessionKey: identity, requestId: `request-${identity}`,
      prompt: prepared.prompt.text, incrementalPrompt: prepared.prompt.text,
      hasIncrementalPrompt: false, fullReplay: true,
      clientTools: prepared.tools, resumeToolResults: [],
      supersedePendingRun: false, supersededToolCallIds: []
    };
    const pending = await runLocalAgentBody(input);
    expect(pending.toolCalls).toMatchObject([{ name: "inspect", arguments: {} }]);
    expect(settledResult).toBeUndefined();

    await expect(runLocalAgentBody({
      ...input,
      requestId: `result-${identity}`,
      resumeToolResults: [{ callId: pending.toolCalls[0].callId, output: "plain text from the harness", isError: false }]
    })).resolves.toMatchObject({ text: "done" });
    expect(settledResult).toBe("plain text from the harness");
    expect(agent.send).toHaveBeenCalledOnce();
  });

  it("preserves explicitly supplied Messages metadata through the shared preparation path", () => {
    const body = anthropicToChatBody({
      model: "grok-4.6", messages: [{ role: "user", content: "Inspect files" }],
      tools: [{ name: "inspect", input_schema: { type: "object" }, output_schema: outputSchema, annotations }]
    });
    const prepared = prepareChatRequest(body, { id: "grok-4.6" });
    expect(sdkTool(prepared.tools[0])).toMatchObject({ outputSchema, annotations });
  });
});
