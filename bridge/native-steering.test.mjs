import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const state = vi.hoisted(() => {
  const directory = `/tmp/cursor2response-native-steering-${process.pid}-${Date.now()}`;
  process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
  return { directory };
});
import {
  Agent, agentCacheKey, attachPendingAgentRun, consumePendingAgentRun, createPendingAgentRun,
  failPendingAgentRun, isRetryableSDKRunError, parkPendingToolCall, runLocalAgentBody
} from "./server.mjs";
import { isTransientCursorSdkError } from "../core/cursor-sdk.ts";
import { prepareResponsesRequest, prepareResponsesFollowUpPrompt, responseToolContinuation } from "../core/openai.ts";

const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.finish();
    fixture.acks.forEach((ack) => ack.resolve("revert_to_followup"));
    await failPendingAgentRun(fixture.pending, new Error("test cleanup"), { cancelRun: true });
  }
  vi.restoreAllMocks();
});
afterAll(() => rmSync(state.directory, { recursive: true, force: true }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function withContext(input, items) {
  const prefix = "INPUT:\n";
  const transcript = items.join("\n");
  const prompt = prefix + transcript;
  let offset = prefix.length;
  return {
    ...input, prompt,
    agentContext: {
      bootstrapFingerprint: "bootstrap", transcriptItemHashes: items,
      transcriptItemOffsets: items.map((item) => { const start = offset; offset += item.length + 1; return start; }),
      transcriptItemImageCounts: items.map(() => 0), transcriptEndOffset: prompt.length, promptTextChars: prompt.length
    }
  };
}

async function fixture(options = {}) {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let input = withContext({
    apiKey: "test-key", model: "grok-4.6", workingDirectory: state.directory,
    sessionKey: crypto.randomUUID(), requestId: crypto.randomUUID(),
    incrementalPrompt: "USER: New turn", hasIncrementalPrompt: true, fullReplay: false,
    clientTools: [], resumeToolResults: [], supersedePendingRun: false, supersededToolCallIds: []
  }, ["USER: Initial"]);
  if (options.body) input = responsesInput(input, options.body);
  const gate = deferred();
  const acks = [];
  const run = {
    id: `run-${crypto.randomUUID()}`,
    steer: vi.fn(() => { const ack = deferred(); acks.push(ack); return ack.promise; }),
    cancel: vi.fn(async () => gate.resolve()),
    async *stream() {
      await gate.promise;
      yield { type: "assistant", message: { content: [{ type: "text", text: "Finished" }] } };
    },
    wait: async () => ({ status: "finished", result: "" })
  };
  if (options.withoutNative) delete run.steer;
  const agent = {
    agentId: crypto.randomUUID(), close: vi.fn(),
    send: vi.fn(async () => ({
      id: "followup-run", cancel: vi.fn(),
      async *stream() { yield { type: "assistant", message: { content: [{ type: "text", text: "Followup" }] } }; },
      wait: async () => ({ status: "finished", result: "" })
    }))
  };
  const pending = createPendingAgentRun(agentCacheKey(input), { agent }, input.requestId, input.sessionKey, input.agentContext);
  pending.model = input.model;
  pending.toolBatchDiscoveryMs = 1;
  pending.toolBatchGraceMs = 1;
  await attachPendingAgentRun(pending, run);
  pending.completionPromise = consumePendingAgentRun(pending, run);
  pending.completionPromise.catch(() => undefined);
  const result = { input, run, agent, pending, acks, finish: () => gate.resolve() };
  fixtures.push(result);
  return result;
}

function responsesInput(base, body) {
  const prepared = prepareResponsesRequest(body, { id: "grok-4.6" });
  const continuation = responseToolContinuation(body);
  const followUp = prepareResponsesFollowUpPrompt(body, { id: "grok-4.6" }, continuation.followUpInput);
  return {
    ...base, ...continuation, requestId: crypto.randomUUID(),
    prompt: prepared.prompt.text, incrementalPrompt: followUp?.text ?? "", hasIncrementalPrompt: !!followUp,
    images: prepared.prompt.images, incrementalImages: followUp?.images,
    resumeToolResults: continuation.results,
    agentContext: {
      bootstrapFingerprint: prepared.agentContext.bootstrap,
      transcriptItemHashes: prepared.agentContext.transcriptItems.map((item) => JSON.stringify(item.value)),
      transcriptItemOffsets: prepared.agentContext.transcriptItems.map((item) => item.offset),
      transcriptItemImageCounts: prepared.agentContext.transcriptItems.map((item) => item.imageCount),
      transcriptEndOffset: prepared.agentContext.transcriptEndOffset,
      promptTextChars: prepared.prompt.text.length
    }
  };
}

function responsesSteeringBody(toolLocation = "top-level") {
  const body = {
    model: "cursor-grok", instructions: `STABLE_INSTRUCTIONS_${"x".repeat(10000)}`,
    tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    input: [
      { role: "user", content: "ORIGINAL_TASK" },
      { type: "function_call", call_id: "call_previous", name: "read", arguments: '{"path":"/tmp/a"}' },
      { type: "function_call_output", call_id: "call_previous", output: "PREVIOUS_RESULT" }
    ]
  };
  if (toolLocation === "additional_tools") {
    body.input.unshift({ type: "additional_tools", tools: body.tools });
    delete body.tools;
  }
  return body;
}

function turn(f, text = "USER: New turn") {
  return withContext({ ...f.input, requestId: crypto.randomUUID(), incrementalPrompt: text }, ["USER: Initial", text]);
}

describe("native SDK steering", () => {
  it.each(["top-level", "additional_tools"])("sends only new explicit steering items before and after ACK with %s tools", async (toolLocation) => {
    const body = responsesSteeringBody(toolLocation);
    const f = await fixture({ body });
    const firstBody = { ...body, input: [...body.input, { role: "user", content: "STEER_ONE" }] };
    const firstInput = responsesInput(f.input, firstBody);
    const first = runLocalAgentBody(firstInput).catch((error) => error);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    expect(f.run.steer).toHaveBeenLastCalledWith("INPUT:\nUSER: STEER_ONE");
    const secondInput = responsesInput(f.input, { ...body, input: [...firstBody.input, { role: "user", content: "STEER_TWO" }] });
    const second = runLocalAgentBody(secondInput).catch((error) => error);
    await expect(first).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    const queuedRetry = runLocalAgentBody({ ...secondInput, requestId: crypto.randomUUID() }).catch((error) => error);
    await expect(second).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledTimes(2));
    expect(f.run.steer).toHaveBeenLastCalledWith("INPUT:\nUSER: STEER_TWO");
    f.acks[1].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.actor.inbox).toHaveLength(0));
    const acknowledgedRetry = runLocalAgentBody({ ...secondInput, requestId: crypto.randomUUID() });
    await expect(queuedRetry).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    f.finish();
    await expect(acknowledgedRetry).resolves.toMatchObject({ text: "Finished" });
    expect(f.run.steer).toHaveBeenCalledTimes(2);
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("delivers cumulative image steering once through the followup send instead of text-only steer", async () => {
    const body = responsesSteeringBody();
    const f = await fixture({ body });
    const imageUser = (text, data) => ({ role: "user", content: [
      { type: "input_text", text }, { type: "input_image", image_url: `data:image/png;base64,${data}` }
    ] });
    const firstBody = { ...body, input: [...body.input, imageUser("STEER_ONE", "AQID")] };
    const first = runLocalAgentBody(responsesInput(f.input, firstBody)).catch((error) => error);
    await vi.waitFor(() => expect(f.pending.actor.inbox).toHaveLength(1));
    const secondInput = responsesInput(f.input, { ...body, input: [...firstBody.input, imageUser("STEER_TWO", "BAUG")] });
    const second = runLocalAgentBody(secondInput);
    await expect(first).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    expect(f.run.steer).not.toHaveBeenCalled();
    f.finish();
    await expect(second).resolves.toMatchObject({ text: "Followup" });
    expect(f.agent.send).toHaveBeenCalledOnce();
    const message = f.agent.send.mock.calls[0][0];
    expect(message.images).toEqual([{ mimeType: "image/png", data: "AQID" }, { mimeType: "image/png", data: "BAUG" }]);
    expect(message.text.match(/STEER_ONE/g)).toHaveLength(1);
    expect(message.text.match(/STEER_TWO/g)).toHaveLength(1);
    expect(message.text).not.toContain("STABLE_INSTRUCTIONS_");
    expect(message.text).not.toContain("base64");
  });

  it("annotates the owned callback with one new suffix and retains an aborted-turn marker", async () => {
    const body = responsesSteeringBody();
    const f = await fixture({ body });
    const callback = parkPendingToolCall(f.pending, { callId: "current-tool", toolCall: { type: "read", args: { path: "/tmp/b" } } });
    const batch = await runLocalAgentBody({ ...f.input, resumeToolResults: [] });
    const callId = batch.toolCalls[0].callId;
    const input = responsesInput(f.input, {
      ...body, max_output_tokens: 4096,
      input: [...body.input,
        { type: "function_call", call_id: callId, name: "read", arguments: '{"path":"/tmp/b"}' },
        { type: "function_call_output", call_id: callId, output: "CURRENT_CALLBACK_RESULT" },
        { role: "developer", content: "<turn_aborted>" },
        { role: "user", content: "STEER_ONE" }
      ]
    });
    const request = runLocalAgentBody(input);
    const delivered = JSON.stringify(await callback);
    expect(delivered.split("CURRENT_CALLBACK_RESULT")).toHaveLength(2);
    expect(delivered.split("<turn_aborted>")).toHaveLength(2);
    expect(delivered.split("STEER_ONE")).toHaveLength(2);
    expect(delivered).toContain("Keep the answer within about 4096 output tokens.");
    expect(delivered).not.toContain("STABLE_INSTRUCTIONS_");
    expect(delivered).not.toContain("PREVIOUS_RESULT");
    expect(f.run.steer).not.toHaveBeenCalled();
    f.finish();
    await expect(request).resolves.toMatchObject({ text: "Finished" });
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("attaches tool-result and steering images to the same owned callback in order", async () => {
    const body = responsesSteeringBody();
    const f = await fixture({ body });
    const callback = parkPendingToolCall(f.pending, { callId: "current-image-tool", toolCall: { type: "read", args: { path: "/tmp/image" } } });
    const batch = await runLocalAgentBody({ ...f.input, resumeToolResults: [] });
    const callId = batch.toolCalls[0].callId;
    const request = runLocalAgentBody(responsesInput(f.input, { ...body, input: [...body.input,
      { type: "function_call", call_id: callId, name: "read", arguments: '{"path":"/tmp/image"}' },
      { type: "function_call_output", call_id: callId, output: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] },
      { role: "user", content: [{ type: "input_text", text: "Compare" }, { type: "input_image", image_url: "data:image/png;base64,BAUG" }] }
    ] }));
    const delivered = await callback;
    expect(delivered.content.filter((part) => part.type === "image")).toEqual([
      { type: "image", mimeType: "image/png", data: "AQID" },
      { type: "image", mimeType: "image/png", data: "BAUG" }
    ]);
    expect(delivered.content[0].text.match(/Compare/g)).toHaveLength(1);
    expect(delivered.content[0].text).not.toContain("AQID");
    expect(f.run.steer).not.toHaveBeenCalled();
    f.finish();
    await expect(request).resolves.toMatchObject({ text: "Finished" });
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it.each(["top-level", "additional_tools"])("full-replays changed Responses instructions with %s tools on a replacement Agent", async (toolLocation) => {
    const body = responsesSteeringBody(toolLocation);
    const f = await fixture({ body });
    const replacement = { ...f.agent, agentId: crypto.randomUUID(), close: vi.fn(), send: vi.fn(f.agent.send.getMockImplementation()) };
    vi.spyOn(Agent, "create").mockResolvedValue(replacement);
    const input = responsesInput(f.input, {
      ...body, instructions: "REPLACEMENT_INSTRUCTIONS",
      input: [...body.input, { role: "user", content: "STEER_ONE" }]
    });
    await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "Followup" });
    expect(f.agent.close).toHaveBeenCalledOnce();
    expect(f.run.steer).not.toHaveBeenCalled();
    expect(replacement.send).toHaveBeenCalledOnce();
    const prompt = replacement.send.mock.calls[0][0];
    expect(prompt).toContain("INSTRUCTIONS:\nREPLACEMENT_INSTRUCTIONS");
    expect(prompt).toContain("ORIGINAL_TASK");
    expect(prompt).toContain("PREVIOUS_RESULT");
    expect(prompt).toContain("STEER_ONE");
    expect(prompt).not.toContain("STABLE_INSTRUCTIONS_");
  });

  it("delivers on the active Run and advances context only after ACK", async () => {
    const f = await fixture();
    const request = runLocalAgentBody(turn(f));
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    expect(f.pending.authoritativeTranscriptItemHashes).toEqual(["USER: Initial"]);
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.authoritativeTranscriptItemHashes).toEqual(["USER: Initial", "USER: New turn"]));
    f.finish();
    await expect(request).resolves.toMatchObject({ text: "Finished", runID: f.run.id });
    expect(f.agent.send).not.toHaveBeenCalled();
    expect(f.pending.actor.inbox).toHaveLength(0);
  });

  it("records only new user inputs as native steering acceptance", async () => {
    const f = await fixture();
    const oldInput = { source: "user", content: "Initial", contentSha256: "a".repeat(64), contentChars: 7, itemIndex: 0 };
    const newInput = { source: "user", content: "New turn", contentSha256: "b".repeat(64), contentChars: 8, itemIndex: 1 };
    f.pending.trajectoryInputs = [oldInput];
    const request = runLocalAgentBody({ ...turn(f), trajectoryInputs: [oldInput, newInput] });
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.actor.inbox).toHaveLength(0));
    const accepted = console.info.mock.calls.flatMap(([line]) => {
      try { const record = JSON.parse(line); return record.event === "trajectory_input_accepted" && record.acceptedBy === "run_steer" ? [record] : []; }
      catch { return []; }
    });
    expect(accepted.map((record) => record.contentSha256)).toEqual([newInput.contentSha256]);
    f.finish();
    await expect(request).resolves.toMatchObject({ text: "Finished" });
  });

  it("waits for the SDK outcome before terminal fallback and sends a revert once", async () => {
    const f = await fixture();
    const request = runLocalAgentBody(turn(f));
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    f.finish();
    await f.pending.completionPromise;
    expect(f.agent.send).not.toHaveBeenCalled();
    f.acks[0].resolve("revert_to_followup");
    await expect(request).resolves.toMatchObject({ text: "Followup" });
    expect(f.agent.send).toHaveBeenCalledExactlyOnceWith("INPUT:\nUSER: New turn", expect.any(Object));
  });

  it.each(["latest", "earlier"])("preserves ordered turns on a %s content retry without reinjection", async (retryKind) => {
    const f = await fixture();
    const first = runLocalAgentBody(turn(f)).catch((error) => error);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    const secondInput = withContext({ ...turn(f), requestId: crypto.randomUUID() }, ["USER: Initial", "USER: New turn", "USER: Second turn"]);
    const second = runLocalAgentBody(secondInput).catch((error) => error);
    await expect(first).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    const retry = runLocalAgentBody({ ...(retryKind === "latest" ? secondInput : turn(f)), requestId: crypto.randomUUID() });
    await expect(second).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledTimes(2));
    expect(f.run.steer.mock.calls.map(([prompt]) => prompt)).toEqual(["INPUT:\nUSER: New turn", "INPUT:\nUSER: Second turn"]);
    f.acks[1].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.actor.inbox).toHaveLength(0));
    f.finish();
    await expect(retry).resolves.toMatchObject({ text: "Finished" });
    expect(f.pending.authoritativeTranscriptItemHashes).toEqual(secondInput.agentContext.transcriptItemHashes);
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("allows cancellation while ACK is pending and ignores a late delivery", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const request = runLocalAgentBody(turn(f), undefined, controller.signal).catch((error) => error);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    const cancelled = Object.assign(new Error("stopped"), { code: "cursor_sdk_cancelled", status: 499 });
    controller.abort(cancelled);
    await expect(request).resolves.toBe(cancelled);
    await vi.waitFor(() => expect(f.run.cancel).toHaveBeenCalledOnce());
    f.acks[0].resolve("complete_delivered");
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.pending.authoritativeTranscriptItemHashes).toEqual(["USER: Initial"]);
    expect(f.pending.actor.activeRun).toBeNull();
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("reattaches an acknowledged turn before terminal output without a second steer", async () => {
    const f = await fixture();
    const input = turn(f);
    const first = runLocalAgentBody(input).catch((error) => error);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.actor.inbox).toHaveLength(0));
    const retry = runLocalAgentBody({ ...input, requestId: crypto.randomUUID() });
    await expect(first).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    f.finish();
    await expect(retry).resolves.toMatchObject({ text: "Finished" });
    expect(f.run.steer).toHaveBeenCalledOnce();
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("keeps a second turn after a published tool batch ordered behind an in-flight steer", async () => {
    const f = await fixture();
    const first = runLocalAgentBody(turn(f));
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    const callback = parkPendingToolCall(f.pending, { callId: "tool-id", toolCall: { type: "read", args: {} } });
    const output = await first;
    const toolHash = f.pending.transcriptItemHashes.at(-1);
    const secondInput = withContext({
      ...turn(f, "USER: Second turn"), supersedePendingRun: true,
      supersededToolCallIds: [output.toolCalls[0].callId]
    }, ["USER: Initial", "USER: New turn", toolHash, "USER: Second turn"]);
    const second = runLocalAgentBody(secondInput);
    expect(await callback).toMatchObject({ isError: true });
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledTimes(2));
    expect(f.pending.authoritativeTranscriptItemHashes).toEqual(["USER: Initial", "USER: New turn"]);
    f.acks[1].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.actor.inbox).toHaveLength(0));
    expect(f.pending.authoritativeTranscriptItemHashes).toEqual(secondInput.agentContext.transcriptItemHashes);
    f.finish();
    await expect(second).resolves.toMatchObject({ text: "Finished" });
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("settles tool callbacks during an in-flight ACK without adding an annotation", async () => {
    const f = await fixture();
    const input = turn(f);
    const request = runLocalAgentBody(input);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    const callback = parkPendingToolCall(f.pending, { callId: "tool-id", toolCall: { type: "read", args: {} } });
    const output = await request;
    const resultInput = withContext({ ...input, requestId: crypto.randomUUID(), resumeToolResults: [{ callId: output.toolCalls[0].callId, output: "tool result", isError: false }] }, ["USER: Initial", "USER: New turn", "TOOL CALL", "TOOL RESULT"]);
    const continuation = runLocalAgentBody(resultInput);
    await expect(callback).resolves.toBe("tool result");
    f.acks[0].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.authoritativeTranscriptItemHashes).toEqual(resultInput.agentContext.transcriptItemHashes));
    f.finish();
    await expect(continuation).resolves.toMatchObject({ text: "Finished" });
    expect(f.agent.send).not.toHaveBeenCalled();
  });

  it("keeps the callback annotation path when a batch is already parked", async () => {
    const f = await fixture();
    const callback = parkPendingToolCall(f.pending, { callId: "tool-id", toolCall: { type: "read", args: {} } });
    const first = await runLocalAgentBody(f.input);
    const input = withContext({ ...turn(f), supersedePendingRun: true, supersededToolCallIds: [first.toolCalls[0].callId] }, [...f.pending.transcriptItemHashes, "USER: New turn"]);
    const request = runLocalAgentBody(input);
    expect(await callback).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("<user_interjection>") }] });
    expect(f.run.steer).not.toHaveBeenCalled();
    f.finish();
    await expect(request).resolves.toMatchObject({ text: "Finished" });
  });

  it("discards a deferred checkpoint after revert is delivered by a later callback", async () => {
    const f = await fixture();
    const input = turn(f);
    const first = runLocalAgentBody(input);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    const callback = parkPendingToolCall(f.pending, { callId: "first-tool", toolCall: { type: "read", args: {} } });
    const batch = await first;
    const resultInput = withContext({ ...input, requestId: crypto.randomUUID(), resumeToolResults: [{ callId: batch.toolCalls[0].callId, output: "first result" }] }, ["USER: Initial", "USER: New turn", "FIRST CALL", "FIRST RESULT"]);
    const continuation = runLocalAgentBody(resultInput);
    await callback;
    f.acks[0].resolve("revert_to_followup");
    await vi.waitFor(() => expect(f.pending.actor.inbox[0].state).toBe("queued"));
    const nextCallback = parkPendingToolCall(f.pending, { callId: "second-tool", toolCall: { type: "read", args: {} } });
    const nextBatch = await continuation;
    const nextResultInput = withContext({ ...resultInput, requestId: crypto.randomUUID(), resumeToolResults: [{ callId: nextBatch.toolCalls[0].callId, output: "second result" }] }, [...resultInput.agentContext.transcriptItemHashes, "SECOND CALL", "SECOND RESULT"]);
    const completedTools = runLocalAgentBody(nextResultInput).catch((error) => error);
    expect(await nextCallback).toContain("<user_interjection>");
    const nextInput = withContext({ ...input, requestId: crypto.randomUUID() }, [...nextResultInput.agentContext.transcriptItemHashes, "USER: Next turn"]);
    const nextTurn = runLocalAgentBody(nextInput);
    await expect(completedTools).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledTimes(2));
    f.acks[1].resolve("complete_delivered");
    await vi.waitFor(() => expect(f.pending.authoritativeTranscriptItemHashes).toEqual(nextInput.agentContext.transcriptItemHashes));
    f.finish();
    await expect(nextTurn).resolves.toMatchObject({ text: "Finished" });
  });

  it.each(["reject", "unknown"])("fails visibly on %s ACK failures without replaying", async (failure) => {
    const f = await fixture();
    const request = runLocalAgentBody(turn(f)).catch((error) => error);
    await vi.waitFor(() => expect(f.run.steer).toHaveBeenCalledOnce());
    if (failure === "reject") f.acks[0].reject(new Error("connection reset"));
    else f.acks[0].resolve("unknown-outcome");
    const error = await request;
    expect(error).toMatchObject({ code: "cursor_sdk_steer_failed" });
    expect(isRetryableSDKRunError(error)).toBe(false);
    expect(isTransientCursorSdkError(error)).toBe(false);
    expect(f.agent.send).not.toHaveBeenCalled();
    expect(f.run.cancel).toHaveBeenCalledOnce();
  });
});
