import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const state = vi.hoisted(() => {
  process.env.CURSOR_SDK_BRIDGE_PENDING_LEASE_MS = "200";
  process.env.CURSOR_SDK_BRIDGE_RUN_CLEANUP_TIMEOUT_MS = "50";
  return { directory: "" };
});
state.directory = mkdtempSync(path.join(tmpdir(), "cursor2response-runtime-tests-"));
process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = state.directory;
const { Agent, runLocalAgentBody, cancelAgentRequest, openAgentRequestLifecycle, runtimeSnapshot } = await import("./server.mjs");

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(state.directory, { recursive: true, force: true }));

function inputFor() {
  const identity = crypto.randomUUID();
  return {
    apiKey: `secret-${identity}`, model: "grok-4.6", workingDirectory: state.directory,
    sessionKey: identity, trajectorySessionId: `session-${identity}`, requestId: `request-${identity}`,
    prompt: "private prompt", incrementalPrompt: "private prompt", hasIncrementalPrompt: false,
    fullReplay: true, clientTools: [{ name: "read", parameters: { type: "object" } }],
    resumeToolResults: [], supersedePendingRun: false, supersededToolCallIds: [],
    agentContext: { bootstrapFingerprint: "bootstrap", transcriptItemHashes: ["user"], transcriptItemOffsets: [0], transcriptEndOffset: 14 }
  };
}

async function waitingRun(input = inputFor(), options = {}) {
  let callbackResult;
  const cancel = vi.fn(options.cancel ?? (async () => {}));
  const close = vi.fn();
  const agent = {
    agentId: `agent-${crypto.randomUUID()}`, close,
    send: vi.fn(async (_prompt, sendOptions) => {
      const result = sendOptions.local.customTools.read.execute({ path: "private-path" }, { toolCallId: "reused-sdk-call" });
      return {
        id: `run-${crypto.randomUUID()}`, cancel,
        async *stream() {
          callbackResult = await result;
          yield { type: "assistant", message: { content: [{ type: "text", text: "completed" }] } };
        },
        wait: async () => ({ status: "finished", result: "" })
      };
    })
  };
  vi.spyOn(Agent, "create").mockResolvedValue(agent);
  const output = await runLocalAgentBody(input);
  const callId = output.toolCalls[0].callId;
  return {
    input, agent, output, callId, cancel, close,
    callbackResult: () => callbackResult,
    ownership: { ...input, pendingToolCallIds: [callId] },
    continuation: { ...input, requestId: `result-${crypto.randomUUID()}`, resumeToolResults: [{ callId, output: "private result", isError: false }], agentContext: undefined }
  };
}

function cancellation() {
  return Object.assign(new Error("caller stopped"), { status: 499, code: "cursor_sdk_cancelled" });
}

describe("Bridge runtime ownership", () => {
  it("exposes live pending metadata without business payloads or credentials", async () => {
    const fixture = await waitingRun();
    const snapshot = runtimeSnapshot();
    expect(snapshot.runs.find((run) => run.executionId === fixture.output.executionID)).toMatchObject({
      phase: "waiting_tools", pendingToolCount: 1, pendingToolCallIds: [fixture.callId],
      subscriber: { attached: false }, leaseRemainingMs: expect.any(Number), waitingSince: expect.any(String)
    });
    const serialized = JSON.stringify(snapshot);
    for (const secret of [fixture.input.apiKey, "private prompt", "private-path", "private result"]) expect(serialized).not.toContain(secret);
    await cancelAgentRequest(fixture.input.requestId, cancellation(), fixture.ownership);
  });

  it("cancels the previous pending run before a new continuation has admission", async () => {
    const fixture = await waitingRun();
    const error = cancellation();
    expect(await cancelAgentRequest(fixture.continuation.requestId, error, fixture.ownership)).toBe(true);
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    await expect(runLocalAgentBody(fixture.continuation)).rejects.toBe(error);
    expect(runtimeSnapshot().runs.some((run) => run.executionId === fixture.output.executionID)).toBe(false);
  });

  it("does not accept an incomplete or duplicate cancellation identity", async () => {
    const fixture = await waitingRun();
    for (const ids of [[], ["wrong"], [fixture.callId, fixture.callId]]) {
      expect(await cancelAgentRequest(crypto.randomUUID(), cancellation(), { ...fixture.ownership, pendingToolCallIds: ids })).toBe(false);
    }
    expect(fixture.cancel).not.toHaveBeenCalled();
    await expect(runLocalAgentBody(fixture.continuation)).resolves.toMatchObject({ text: "completed" });
    expect(fixture.callbackResult()).toBe("private result");
  });

  it("honors explicit cancellation after the matching HTTP transport has disconnected", async () => {
    const fixture = await waitingRun();
    const response = new EventEmitter();
    const lifecycle = openAgentRequestLifecycle(fixture.input.requestId, new EventEmitter(), response);
    try {
      response.emit("close");
      expect(lifecycle.signal.reason).toMatchObject({ code: "cursor_sdk_subscriber_disconnected" });
      expect(await cancelAgentRequest(fixture.input.requestId, cancellation(), fixture.ownership)).toBe(true);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.close).toHaveBeenCalledOnce();
    } finally {
      lifecycle.close();
    }
  });

  it("preserves the valid owner's cancellation authority after rejecting a tool result", async () => {
    const fixture = await waitingRun();
    await expect(runLocalAgentBody({
      ...fixture.continuation,
      resumeToolResults: [{ callId: "unmatched-call", output: "invalid result", isError: false }]
    })).rejects.toMatchObject({ code: "cursor_sdk_tool_result_batch_mismatch" });
    expect(runtimeSnapshot().runs.find((run) => run.executionId === fixture.output.executionID))
      .toMatchObject({ requestId: fixture.input.requestId, subscriber: { attached: false } });
    expect(await cancelAgentRequest(fixture.input.requestId, cancellation(), fixture.ownership)).toBe(true);
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a replacement subscriber authoritative after it detaches", async () => {
    const fixture = await waitingRun();
    const reattached = await runLocalAgentBody({ ...fixture.input, requestId: "new-subscriber" });
    expect(reattached.toolCalls[0].callId).toBe(fixture.callId);
    expect(fixture.agent.send).toHaveBeenCalledOnce();
    expect(await cancelAgentRequest(fixture.input.requestId, cancellation(), fixture.ownership)).toBe(false);
    expect(fixture.cancel).not.toHaveBeenCalled();
    await expect(runLocalAgentBody(fixture.continuation)).resolves.toMatchObject({ text: "completed" });
  });

  it("serializes cancellation before results without settling the wrong callback", async () => {
    const fixture = await waitingRun();
    const error = cancellation();
    const cancelled = cancelAgentRequest("unadmitted-cancellation", error, fixture.ownership);
    const result = runLocalAgentBody(fixture.continuation);
    const outcomes = await Promise.allSettled([cancelled, result]);
    expect(outcomes).toMatchObject([{ status: "fulfilled", value: true }, { status: "rejected", reason: error }]);
    expect(fixture.callbackResult()).not.toBe("private result");
  });

  it("does not cancel a result that was accepted before the late cancellation", async () => {
    const fixture = await waitingRun();
    const result = runLocalAgentBody(fixture.continuation);
    const cancelled = cancelAgentRequest("late-unadmitted-cancellation", cancellation(), fixture.ownership);
    await expect(result).resolves.toMatchObject({ text: "completed" });
    expect(await cancelled).toBe(false);
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("keeps late cancellation and tool results away from a new generation", async () => {
    const first = await waitingRun();
    await cancelAgentRequest(first.input.requestId, cancellation(), first.ownership);
    const next = await waitingRun({ ...first.input, requestId: "new-generation", agentContext: undefined });
    expect(next.callId).not.toBe(first.callId);
    expect(await cancelAgentRequest("late-previous-generation", cancellation(), first.ownership)).toBe(false);
    await expect(runLocalAgentBody(first.continuation)).rejects.toMatchObject({ code: "cursor_sdk_cancelled" });
    expect(next.cancel).not.toHaveBeenCalled();
    await expect(runLocalAgentBody(next.continuation)).resolves.toMatchObject({ text: "completed" });
  });

  it("reclaims an unattended pending lease and rejects a late result explicitly", async () => {
    const fixture = await waitingRun();
    await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    await expect(runLocalAgentBody(fixture.continuation)).rejects.toMatchObject({ status: 409, code: "cursor_sdk_pending_lease_expired" });
    expect(runtimeSnapshot().recentTerminations).toContainEqual(expect.objectContaining({ executionId: fixture.output.executionID, reason: "lease_expired" }));
  });

  it("renews a validated reconnect and preserves a long tool within its lease", async () => {
    const fixture = await waitingRun();
    await new Promise((resolve) => setTimeout(resolve, 110));
    await runLocalAgentBody({ ...fixture.input, requestId: "lease-renewal" });
    await new Promise((resolve) => setTimeout(resolve, 110));
    await expect(runLocalAgentBody(fixture.continuation)).resolves.toMatchObject({ text: "completed" });
    expect(fixture.cancel).not.toHaveBeenCalled();
  });

  it("releases actor ownership when SDK cancellation does not settle", async () => {
    const fixture = await waitingRun(inputFor(), { cancel: () => new Promise(() => {}) });
    await expect(cancelAgentRequest(fixture.input.requestId, cancellation(), fixture.ownership)).resolves.toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(runtimeSnapshot().runs.some((run) => run.executionId === fixture.output.executionID)).toBe(false);
    expect(runtimeSnapshot().counters.cleanupFailures).toBeGreaterThan(0);
  });
});
