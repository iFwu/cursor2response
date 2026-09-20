import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const state = vi.hoisted(() => {
  const previous = process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR;
  const directory = `/tmp/cursor2response-system-prompt-test-${process.pid}-${Date.now()}`;
  process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
  return { previous, directory };
});

import { Agent, agentCacheKey, localAgentCreateOptions, runLocalAgentBody } from "./server.mjs";
import { prepareResponsesRequest } from "../core/openai.ts";
import { collectCursorSdkOutput, createCursorSdkCompletion, isTransientCursorSdkError } from "../core/cursor-sdk.ts";

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (state.previous === undefined) delete process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR;
  else process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = state.previous;
  rmSync(state.directory, { recursive: true, force: true });
});

function inputFor(systemPrompt) {
  return {
    apiKey: "cursor-test-key",
    model: "model-a",
    workingDirectory: "/tmp/system-prompt-project",
    sessionKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    prompt: "FULL TRANSCRIPT",
    incrementalPrompt: "latest user turn",
    hasIncrementalPrompt: true,
    fullReplay: false,
    clientTools: [],
    resumeToolResults: [],
    supersedePendingRun: false,
    supersededToolCallIds: [],
    systemPrompt
  };
}

function finishedAgent() {
  const agentId = crypto.randomUUID();
  return {
    agentId,
    close: vi.fn(),
    send: vi.fn(async () => ({
      id: `run-${agentId}`,
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    }))
  };
}

function statePath(input) {
  return path.join(state.directory, `${agentCacheKey(input)}.json`);
}

function seedCleanState(input, systemPrompt) {
  mkdirSync(state.directory, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(input), JSON.stringify({
    version: 3,
    cacheKey: agentCacheKey(input),
    sdkAgentId: "persisted-system-prompt-agent",
    model: input.model,
    updatedAt: Date.now(),
    dirty: false,
    systemPromptFingerprint: systemPrompt === undefined
      ? null
      : createHash("sha256").update(systemPrompt).digest("hex"),
    bootstrapFingerprint: null,
    transcriptItemHashes: null,
    provisionalTranscriptItemHashes: null
  }), { mode: 0o600 });
}

async function bridgeBody(systemPrompt) {
  const prepared = prepareResponsesRequest({
    input: "hello",
    instructions: "Keep existing instructions",
    ...(systemPrompt === undefined ? {} : { system_prompt: systemPrompt })
  }, { id: "model-a" });
  let body;
  const completion = await createCursorSdkCompletion(
    { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" },
    {
      now: () => new Date(),
      randomUUID: () => crypto.randomUUID(),
      fetch: async (_url, init) => {
        body = JSON.parse(String(init.body));
        return Response.json({ text: "done", toolCalls: [], status: "finished" });
      }
    },
    "cursor-test-key",
    {
      prompt: prepared.prompt,
      systemPrompt: prepared.systemPrompt,
      agentContext: prepared.agentContext,
      model: prepared.cursorModel,
      sessionKey: "system-prompt-wire"
    }
  );
  await collectCursorSdkOutput(completion.stream);
  return { body, prepared };
}

describe("native SDK system prompt", () => {
  it("returns a non-retryable capability error for the SDK account gate", async () => {
    const agent = finishedAgent();
    agent.send.mockResolvedValue({
      id: "unsupported-prompt-run", cancel: vi.fn(),
      async *stream() {},
      wait: async () => ({ status: "error", error: { message: "[invalid_argument] unknown option '--system-prompt'", code: "invalid_argument" } })
    });
    vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const error = await runLocalAgentBody(inputFor("custom prompt")).catch((value) => value);
    expect(error).toMatchObject({ status: 400, code: "cursor_sdk_system_prompt_unavailable" });
    expect(isTransientCursorSdkError(error)).toBe(false);
    expect(agent.send).toHaveBeenCalledOnce();
  });
  it.each([true, null, "", " \n ", 42, {}, []])("rejects invalid public system_prompt %j", (systemPrompt) => {
    expect(() => prepareResponsesRequest({ input: "hello", system_prompt: systemPrompt }, undefined))
      .toThrow(expect.objectContaining({ status: 400, code: "invalid_request_error", param: "system_prompt" }));
    expect(() => localAgentCreateOptions(inputFor(systemPrompt)))
      .toThrow(expect.objectContaining({ status: 400, code: "invalid_request" }));
  });

  it("forwards the exact native prompt independently of instructions and transcript offsets", async () => {
    const nativePrompt = "  Explicit native system prompt\n";
    const { body, prepared } = await bridgeBody(nativePrompt);
    const baseline = await bridgeBody(undefined);
    const changed = await bridgeBody("Changed native prompt");
    expect(body.systemPrompt).toBe(nativePrompt);
    expect(body.prompt).toBe(baseline.body.prompt);
    expect(body.prompt).toContain("INSTRUCTIONS:\nKeep existing instructions");
    expect(body.prompt).not.toContain(nativePrompt);
    expect(prepared.responseMetadata).not.toHaveProperty("system_prompt");
    expect(body.agentContext.transcriptItemOffsets).toEqual(baseline.body.agentContext.transcriptItemOffsets);
    expect(new Set([
      body.agentContext.bootstrapFingerprint,
      baseline.body.agentContext.bootstrapFingerprint,
      changed.body.agentContext.bootstrapFingerprint
    ]).size).toBe(3);
    expect(body.sessionKey).toBe(baseline.body.sessionKey);
    expect(body.sessionKey).toBe(changed.body.sessionKey);
  });

  it("treats false as the SDK default without changing instructions or Agent identity", async () => {
    const disabled = await bridgeBody(false);
    const baseline = await bridgeBody(undefined);
    expect(disabled.prepared.systemPrompt).toBeUndefined();
    expect(disabled.body).not.toHaveProperty("systemPrompt");
    expect(disabled.body.prompt).toBe(baseline.body.prompt);
    expect(disabled.body.prompt).toContain("INSTRUCTIONS:\nKeep existing instructions");
    expect(disabled.body.agentContext).toEqual(baseline.body.agentContext);
    expect(disabled.body.sessionKey).toBe(baseline.body.sessionKey);
    expect(localAgentCreateOptions(inputFor(disabled.prepared.systemPrompt))).not.toHaveProperty("systemPrompt");
  });

  it("rejects native system prompts when no SDK Bridge is configured", async () => {
    const fetch = vi.fn();
    await expect(createCursorSdkCompletion({}, { fetch }, "cursor-test-key", {
      prompt: { text: "hello" }, systemPrompt: "native prompt"
    })).rejects.toMatchObject({ status: 500, code: "cursor_sdk_bridge_missing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the configured SDK workspace without changing client path identity", () => {
    const input = inputFor(undefined);
    const identity = agentCacheKey(input);
    vi.stubEnv("CURSOR_SDK_WORKING_DIRECTORY", "/workspace");
    try {
      expect(localAgentCreateOptions(input).local.cwd).toBe("/workspace");
      expect(input.workingDirectory).toBe("/tmp/system-prompt-project");
      expect(agentCacheKey(input)).toBe(identity);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reuses a matching Agent and replaces it when native prompt changes or is omitted", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const agents = [finishedAgent(), finishedAgent(), finishedAgent()];
    const create = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(agents[0]).mockResolvedValueOnce(agents[1]).mockResolvedValueOnce(agents[2]);
    const resume = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const input = inputFor("first native prompt");
    await runLocalAgentBody(input);
    await runLocalAgentBody({ ...input, requestId: crypto.randomUUID() });
    expect(create).toHaveBeenCalledTimes(1);
    expect(agents[0].send).toHaveBeenCalledTimes(2);
    await runLocalAgentBody({ ...input, requestId: crypto.randomUUID(), systemPrompt: "second native prompt" });
    expect(agents[0].close).toHaveBeenCalledOnce();
    await runLocalAgentBody({ ...input, requestId: crypto.randomUUID(), systemPrompt: undefined });
    expect(agents[1].close).toHaveBeenCalledOnce();
    expect(create.mock.calls.map(([options]) => options.systemPrompt))
      .toEqual(["first native prompt", "second native prompt", undefined]);
    expect(resume).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(statePath(input), "utf8"))).toMatchObject({
      dirty: false, systemPromptFingerprint: null
    });
  });

  it("passes the native prompt again when resuming a matching clean Agent", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const input = inputFor("persisted native prompt");
    seedCleanState(input, input.systemPrompt);
    const create = vi.spyOn(Agent, "create").mockRejectedValue(new Error("must not create"));
    const resume = vi.spyOn(Agent, "resume").mockResolvedValue(finishedAgent());
    await runLocalAgentBody(input);
    expect(create).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledWith("persisted-system-prompt-agent", expect.objectContaining({
      systemPrompt: input.systemPrompt
    }));
    const persisted = readFileSync(statePath(input), "utf8");
    expect(persisted).not.toContain(input.systemPrompt);
    expect(JSON.parse(persisted)).toMatchObject({
      dirty: false,
      systemPromptFingerprint: createHash("sha256").update(input.systemPrompt).digest("hex")
    });
  });

  it("settles an exposed tool batch before replacing an active Agent's native prompt", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      ...inputFor("active native prompt"),
      clientTools: [{ name: "read", parameters: { type: "object", properties: {} } }]
    };
    let callback;
    const cancel = vi.fn();
    const oldAgent = finishedAgent();
    oldAgent.send.mockImplementation(async (_prompt, options) => ({
      id: "run-native-prompt-pending",
      async *stream() {
        callback = options.local.customTools.read.execute({}, { toolCallId: "read-native-prompt" });
        await callback;
        yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel
    }));
    const replacement = finishedAgent();
    const create = vi.spyOn(Agent, "create").mockResolvedValueOnce(oldAgent).mockResolvedValueOnce(replacement);
    const exposed = await runLocalAgentBody(input);
    const changed = { ...input, requestId: crypto.randomUUID(), systemPrompt: undefined };
    await expect(runLocalAgentBody(changed)).rejects.toMatchObject({
      status: 409, code: "cursor_sdk_tool_result_pending"
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    const results = [{ callId: exposed.toolCalls[0].callId, output: "contents" }];
    await expect(runLocalAgentBody({ ...changed, resumeToolResults: results, internalToolCorrection: true }))
      .rejects.toMatchObject({ status: 409, code: "cursor_sdk_agent_context_conflict" });
    await runLocalAgentBody({ ...changed, requestId: crypto.randomUUID(), resumeToolResults: results });
    await expect(callback).resolves.toBe("contents");
    expect(cancel).toHaveBeenCalledOnce();
    expect(oldAgent.close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("systemPrompt");
  });

  it.each([undefined, "new native prompt"])("replaces persisted Agents when native prompt becomes %j", async (systemPrompt) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const input = inputFor(systemPrompt);
    seedCleanState(input, "previous native prompt");
    const resume = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const create = vi.spyOn(Agent, "create").mockResolvedValue(finishedAgent());
    await runLocalAgentBody(input);
    expect(resume).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "agent" }));
    expect(create.mock.calls[0][0].systemPrompt).toBe(systemPrompt);
  });
});
