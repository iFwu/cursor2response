import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agentStateTestContext = vi.hoisted(() => {
  const previousDirectory = process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR;
  const directory = `/tmp/cursor2response-bridge-state-test-${process.pid}-${Date.now()}`;
  process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = directory;
  return { directory, previousDirectory };
});
const fsPromiseTestHooks = vi.hoisted(() => ({
  failAgentStateWrites: false,
  agentStateDirectory: ""
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: (filePath, ...args) => {
      if (
        fsPromiseTestHooks.failAgentStateWrites
        && fsPromiseTestHooks.agentStateDirectory
        && String(filePath).startsWith(`${fsPromiseTestHooks.agentStateDirectory}/`)
        && String(filePath).endsWith(".tmp")
      ) {
        return Promise.reject(new Error("injected agent state write failure"));
      }
      return actual.open(filePath, ...args);
    }
  };
});
import {
  ABORTED_TOOL_RESULT_MESSAGE,
  Agent,
  agentCacheKey,
  acknowledgePendingAgentOutput,
  attachPendingAgentSubscriber,
  attachPendingAgentRun,
  bindPendingAgentRunAbort,
  bridgePrompt,
  clientForwardingMcpServerSource,
  clientMcpToolDefinitions,
  composerToolCallFromText,
  configureCursorSdkNetwork,
  consumePendingAgentRun,
  cancelAgentRequest,
  createPendingAgentRun as createBridgePendingAgentRun,
  detachPendingAgentSubscriber,
  failPendingAgentRun,
  handleCursorSdkDelta,
  localAgentCreateOptions,
  localAgentSendOptions,
  isAuthenticationSDKError,
  isForwardableSDKToolCall,
  isRetryableSDKRunError,
  normalizeModel,
  normalizeSdkEvent,
  normalizeSdkUsage,
  normalizeResumeToolResults,
  openAgentRequestLifecycle,
  normalizeSDKToolCall,
  openAiError,
  parseBridgePromptFields,
  parseTrajectoryInputs,
  parkPendingToolCall,
  recordPendingToolCallStatus,
  requirePendingAgentRunForToolResults,
  resolvePendingToolResults,
  runLocalAgentBody,
  runLocalAgentUnlocked,
  sdkRunFailureSummary,
  statusFromError,
  summarizeToolTraceValue,
  takePendingNarration,
  traceChunkRecords,
  traceSdkPayload,
  toolArgsTraceChunkRecords,
  truncateTraceText,
  toolCallFromDelta,
  validateClientMcpToolCall,
  waitForPendingAgentEvent
} from "./server.mjs";

const bridgeScriptPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
fsPromiseTestHooks.agentStateDirectory = agentStateTestContext.directory;

function createPendingAgentRun(...args) {
  const pending = createBridgePendingAgentRun(...args);
  pending.toolBatchDiscoveryMs = 1;
  pending.toolBatchGraceMs = 1;
  return pending;
}

function persistedAgentStatePath(input) {
  return path.join(agentStateTestContext.directory, `${agentCacheKey(input)}.json`);
}

function seedPersistedAgentState(input, overrides = {}) {
  mkdirSync(agentStateTestContext.directory, { recursive: true, mode: 0o700 });
  writeFileSync(persistedAgentStatePath(input), JSON.stringify({
    version: 1,
    cacheKey: agentCacheKey(input),
    sdkAgentId: "agent-persisted",
    model: input.model,
    updatedAt: Date.now(),
    dirty: false,
    ...overrides
  }), { mode: 0o600 });
}

function finishedAgent(agentId, text = "done") {
  return {
    agentId,
    close: vi.fn(),
    send: vi.fn(async () => ({
      id: `run-${agentId}`,
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    }))
  };
}

function localAgentInput(identity, overrides = {}) {
  return {
    apiKey: `cursor-test-key-${identity}`,
    model: "model-a",
    workingDirectory: `/tmp/cursor2response-${identity}`,
    sessionKey: `session-${identity}`,
    requestId: `request-${identity}`,
    prompt: "FULL TRANSCRIPT",
    incrementalPrompt: "FULL TRANSCRIPT",
    hasIncrementalPrompt: false,
    fullReplay: true,
    clientTools: [],
    resumeToolResults: [],
    supersedePendingRun: false,
    supersededToolCallIds: [],
    ...overrides
  };
}

function jsonLogRecords(spy, event) {
  return spy.mock.calls.flatMap(([message]) => {
    try {
      const record = JSON.parse(message);
      return record?.event === event ? [record] : [];
    } catch {
      return [];
    }
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify(Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, JSON.parse(stableJson(value[key]))])
  ));
}

function transcriptHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function messageItem(role, text) {
  return {
    value: { type: "message", role, text, imageCount: 0 },
    prompt: `${role.toUpperCase()}: ${text}`
  };
}

function agentContextPrompt(bootstrap, items, suffix = "") {
  const header = `${bootstrap}\nINPUT:\n`;
  const itemOffsets = [];
  let prompt = header;
  for (const [index, item] of items.entries()) {
    if (index > 0) prompt += "\n";
    itemOffsets.push(prompt.length);
    prompt += item.prompt;
  }
  const transcriptEndOffset = prompt.length;
  prompt += suffix;
  return {
    prompt,
    agentContext: {
      bootstrapFingerprint: createHash("sha256").update(header).digest("hex"),
      transcriptItemHashes: items.map((item) => transcriptHash(item.value)),
      transcriptItemOffsets: itemOffsets,
      transcriptItemImageCounts: items.map(() => 0),
      transcriptEndOffset,
      promptTextChars: prompt.length
    }
  };
}

afterAll(() => {
  rmSync(agentStateTestContext.directory, { recursive: true, force: true });
  if (agentStateTestContext.previousDirectory === undefined) {
    delete process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR;
  } else {
    process.env.CURSOR_SDK_BRIDGE_AGENT_STATE_DIR = agentStateTestContext.previousDirectory;
  }
});

describe("Cursor SDK local-agent bridge", () => {
  it("recomputes trace metadata without rejecting a real tool result", () => {
    const output = { result: "ok", nested: [1, true] };
    const content = JSON.stringify(output);
    expect(normalizeResumeToolResults([{
      callId: "call-read",
      output,
      isError: false,
      contentSha256: "invalid",
      contentChars: 1
    }], {
      requestId: "run-tool-result",
      ingressRequestId: "resp-tool-result",
      sessionKey: "sdk-session",
      trajectorySessionId: "trajectory-session"
    })).toEqual([expect.objectContaining({
      callId: "call-read",
      output,
      content,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      contentChars: content.length,
      source: "tool_result"
    })]);
  });

  it("treats malformed trajectory input metadata as observation-only", () => {
    const content = "keep the request running";
    expect(parseTrajectoryInputs([{
      source: "user",
      content,
      contentSha256: "invalid",
      contentChars: 1,
      contextCheckpointHash: "invalid"
    }], {
      requestId: "request-current",
      ingressRequestId: "response-current",
      sessionKey: "sdk-session-current",
      trajectorySessionId: "trajectory-session-current"
    })).toEqual([expect.objectContaining({
      source: "user",
      content,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      contentChars: content.length,
      contextCheckpointHash: undefined,
      trajectoryRequestId: "request-current",
      trajectoryIngressRequestId: "response-current",
      trajectorySdkSessionKey: "sdk-session-current",
      trajectorySessionId: "trajectory-session-current"
    })]);
    expect(parseTrajectoryInputs({ source: "user" })).toEqual([]);
  });

  it("accepts prompt-free tool-result resumes without marking them as full replays", () => {
    expect(parseBridgePromptFields({}, [{ callId: "call-read", output: "contents" }])).toEqual({
      prompt: "",
      incrementalPrompt: "",
      promptAlreadyPrepared: true,
      hasIncrementalPrompt: false,
      fullReplay: false
    });
    expect(() => parseBridgePromptFields({}, [])).toThrowError(expect.objectContaining({
      status: 400,
      code: "invalid_request"
    }));
  });

  it("accepts full and incremental prompts for a superseding Responses turn", () => {
    expect(parseBridgePromptFields({
      prompt: "full transcript",
      incrementalPrompt: "new user turn",
      promptAlreadyPrepared: true,
      supersedePendingRun: true
    }, [{ callId: "call-aborted", output: "aborted" }])).toEqual({
      prompt: "full transcript",
      incrementalPrompt: "new user turn",
      promptAlreadyPrepared: true,
      hasIncrementalPrompt: true,
      fullReplay: false
    });
  });

  it("reuses a model Agent after another model and sends the exact missing transcript suffix", async () => {
    const sessionKey = `context-prefix-${crypto.randomUUID()}`;
    const bootstrap = "STABLE RESPONSES INSTRUCTIONS";
    const userOne = messageItem("user", "one");
    const assistantA = messageItem("assistant", "answer-a");
    const userTwo = messageItem("user", "two");
    const assistantB = messageItem("assistant", "answer-b");
    const userThree = messageItem("user", "three");
    const first = agentContextPrompt(bootstrap, [userOne]);
    const switched = agentContextPrompt(bootstrap, [userOne, assistantA, userTwo]);
    const returned = agentContextPrompt(bootstrap, [userOne, assistantA, userTwo, assistantB, userThree]);
    const run = (id, text) => ({
      id,
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    });
    const agentA = {
      agentId: "agent-context-a",
      close: vi.fn(),
      send: vi.fn()
        .mockResolvedValueOnce(run("run-context-a-1", "answer-a"))
        .mockResolvedValueOnce(run("run-context-a-2", "answer-a-2"))
    };
    const agentB = {
      agentId: "agent-context-b",
      close: vi.fn(),
      send: vi.fn().mockResolvedValueOnce(run("run-context-b-1", "answer-b"))
    };
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(agentA)
      .mockResolvedValueOnce(agentB);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const baseInput = {
      apiKey: "cursor-test-key",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };

    try {
      await runLocalAgentBody({
        ...baseInput,
        model: "model-a",
        requestId: "context-a-1",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true
      });
      await runLocalAgentBody({
        ...baseInput,
        model: "model-b",
        requestId: "context-b-1",
        ...switched,
        incrementalPrompt: switched.prompt,
        hasIncrementalPrompt: true,
        fullReplay: false
      });
      await runLocalAgentBody({
        ...baseInput,
        model: "model-a",
        requestId: "context-a-2",
        ...returned,
        incrementalPrompt: `${bootstrap}\nINPUT:\nUSER: three`,
        hasIncrementalPrompt: true,
        fullReplay: false
      });

      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(agentA.send).toHaveBeenNthCalledWith(
        2,
        "INPUT:\nUSER: two\nASSISTANT: answer-b\nUSER: three",
        expect.objectContaining({ idempotencyKey: "context-a-2" })
      );
      expect(agentA.close).not.toHaveBeenCalled();
      expect(jsonLogRecords(log, "trajectory_agent_transition")).toEqual([
        expect.objectContaining({ toAgentId: agentA.agentId, transitionKind: "created" }),
        expect.objectContaining({
          fromAgentId: agentA.agentId,
          toAgentId: agentB.agentId,
          transitionKind: "replaced"
        }),
        expect.objectContaining({
          fromAgentId: agentB.agentId,
          toAgentId: agentA.agentId,
          transitionKind: "replaced"
        })
      ]);
    } finally {
      log.mockRestore();
      createAgent.mockRestore();
      agentA.close();
      agentB.close();
    }
  });

  it("creates a fresh Agent when the authoritative transcript omits acknowledged provisional output", async () => {
    const sessionKey = `context-aborted-terminal-${crypto.randomUUID()}`;
    const bootstrap = "STABLE TOOL RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "inspect");
    const first = agentContextPrompt(bootstrap, [user]);
    const agent = {
      agentId: "agent-context-aborted-terminal",
      close: vi.fn(),
      send: vi.fn()
        .mockImplementationOnce(async (_prompt, options) => {
          const result = options.local.customTools.update_plan.execute(
            { plan: [{ step: "inspect", status: "in_progress" }] },
            { toolCallId: "sdk-call-update-plan" }
          );
          return {
            id: "run-context-aborted-terminal",
            async *stream() {
              yield {
                type: "tool_call",
                call_id: "sdk-call-update-plan",
                name: "update_plan",
                status: "running",
                args: { plan: [{ step: "inspect", status: "in_progress" }] }
              };
              await result;
              yield { type: "assistant", message: { content: [{ type: "text", text: "late answer" }] } };
            },
            wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
            cancel: vi.fn()
          };
        })
    };
    const replayAgent = finishedAgent("agent-context-aborted-terminal-replay", "replayed");
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce(replayAgent);
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [{ name: "update_plan", parameters: { type: "object" } }]
    };

    try {
      const toolOutput = await runLocalAgentBody({
        ...baseInput,
        requestId: "context-aborted-terminal-call",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true,
        resumeToolResults: [],
        supersedePendingRun: false,
        supersededToolCallIds: []
      });
      const callId = toolOutput.toolCalls[0].callId;
      const toolCall = {
        value: {
          type: "tool_call",
          callId,
          name: "update_plan",
          arguments: { plan: [{ step: "inspect", status: "in_progress" }] }
        },
        prompt: "ASSISTANT TOOL_CALLS: update_plan"
      };
      const toolResult = {
        value: {
          type: "tool_output",
          callId,
          output: "updated",
          imageCount: 0,
          isError: false
        },
        prompt: "TOOL RESULT: updated"
      };
      const interjection = messageItem("user", "stop testing");
      const shapeAContext = agentContextPrompt(bootstrap, [user, toolCall, toolResult, interjection]);

      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-aborted-terminal-shape-a",
        ...shapeAContext,
        incrementalPrompt: interjection.prompt,
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{ callId, output: "updated", isError: false }],
        supersedePendingRun: true,
        supersedingTurnAborted: false,
        supersededToolCallIds: [callId]
      })).resolves.toMatchObject({ text: "late answer" });

      const marker = messageItem("developer", "<turn_aborted>");
      const nextUser = messageItem("user", "continue");
      const nextContext = agentContextPrompt(
        bootstrap,
        [user, toolCall, toolResult, interjection, marker, nextUser]
      );
      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-aborted-terminal-continue",
        ...nextContext,
        incrementalPrompt: `${marker.prompt}\n${nextUser.prompt}`,
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{ callId, output: "updated", isError: false }],
        supersedePendingRun: true,
        supersedingTurnAborted: false,
        supersededToolCallIds: [callId]
      })).resolves.toMatchObject({ text: "replayed" });

      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(agent.close).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledOnce();
      expect(replayAgent.send).toHaveBeenCalledWith(
        expect.stringMatching(/^STABLE TOOL RESPONSES INSTRUCTIONS\nINPUT:\n[\s\S]+\n\n\[cursor2response recovery\]/),
        expect.objectContaining({ idempotencyKey: "context-aborted-terminal-continue" })
      );
    } finally {
      createAgent.mockRestore();
      agent.close();
      replayAgent.close();
    }
  });

  it.each([
    ["bootstrap change", true],
    ["transcript edit", false]
  ])("creates a fresh Agent after %s", async (_name, changeBootstrap) => {
    const sessionKey = `context-divergence-${crypto.randomUUID()}`;
    const firstUser = messageItem("user", "original");
    const firstAssistant = messageItem("assistant", "first answer");
    const nextUser = messageItem("user", "continue");
    const first = agentContextPrompt("BOOTSTRAP V1", [firstUser]);
    const changed = agentContextPrompt(
      changeBootstrap ? "BOOTSTRAP V2" : "BOOTSTRAP V1",
      [changeBootstrap ? firstUser : messageItem("user", "edited"), firstAssistant, nextUser]
    );
    const oldAgent = finishedAgent(`agent-old-${crypto.randomUUID()}`, "first answer");
    const newAgent = finishedAgent(`agent-new-${crypto.randomUUID()}`, "replacement answer");
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(oldAgent)
      .mockResolvedValueOnce(newAgent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };

    try {
      await runLocalAgentBody({
        ...baseInput,
        requestId: "context-original",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true
      });
      await runLocalAgentBody({
        ...baseInput,
        requestId: "context-changed",
        ...changed,
        incrementalPrompt: "BOOTSTRAP V1\nINPUT:\nUSER: continue",
        hasIncrementalPrompt: true,
        fullReplay: false
      });

      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(oldAgent.close).toHaveBeenCalledOnce();
      expect(newAgent.send.mock.calls[0][0]).toMatch(new RegExp(`^${changed.prompt}`));
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .filter((record) => record?.event === "sdk_prompt_selected")
        .at(-1);
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: changeBootstrap ? "agent_bootstrap_mismatch" : "agent_transcript_diverged"
      });
      const replay = jsonLogRecords(info, "trajectory_replay").at(-1);
      if (changeBootstrap) {
        expect(replay).toMatchObject({ replayCause: "agent_bootstrap_mismatch" });
        expect(replay.divergedItemIndex).toBeUndefined();
      } else {
        expect(replay).toMatchObject({
          replayCause: "agent_transcript_diverged",
          divergenceKind: "item_mismatch",
          divergedItemIndex: 0,
          knownTranscriptItemCount: expect.any(Number),
          clientTranscriptItemCount: 3,
          divergedItemPreview: "USER: edited",
          knownItemPreview: "USER: original",
          divergedCharOffset: "USER: ".length
        });
      }
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      oldAgent.close();
      newAgent.close();
    }
  });

  it("does not start another Agent run for an unchanged completed transcript", async () => {
    const sessionKey = `context-equal-${crypto.randomUUID()}`;
    const bootstrap = "STABLE RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "one");
    const first = agentContextPrompt(bootstrap, [user]);
    const agent = finishedAgent("agent-context-equal", "answer");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };

    try {
      const firstOutput = await runLocalAgentBody({
        ...baseInput,
        requestId: "context-equal-first",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true
      }, undefined, undefined, undefined, { deferTerminalAck: true });
      expect(JSON.parse(readFileSync(persistedAgentStatePath(baseInput), "utf8"))).toMatchObject({
        dirty: true
      });
      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-equal-reattach",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true
      })).resolves.toEqual(firstOutput);
      expect(JSON.parse(readFileSync(persistedAgentStatePath(baseInput), "utf8"))).toMatchObject({
        version: 3,
        dirty: false,
        bootstrapFingerprint: first.agentContext.bootstrapFingerprint,
        transcriptItemHashes: first.agentContext.transcriptItemHashes,
        provisionalTranscriptItemHashes: [
          ...first.agentContext.transcriptItemHashes,
          transcriptHash(messageItem("assistant", "answer").value)
        ]
      });
      const repeated = agentContextPrompt(bootstrap, [user, messageItem("assistant", "answer")]);

      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-equal-repeat",
        ...repeated,
        incrementalPrompt: "STALE HEURISTIC PROMPT",
        hasIncrementalPrompt: true,
        fullReplay: false
      })).rejects.toMatchObject({
        status: 409,
        code: "cursor_sdk_transcript_not_extended"
      });
      expect(createAgent).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledOnce();
      expect(agent.close).not.toHaveBeenCalled();
    } finally {
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("advances the Agent transcript checkpoint across a forwarded tool round trip", async () => {
    const sessionKey = `context-tool-${crypto.randomUUID()}`;
    const bootstrap = "STABLE TOOL RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "inspect");
    const first = agentContextPrompt(bootstrap, [user]);
    const nextRun = (id, text) => ({
      id,
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    });
    const agent = {
      agentId: "agent-context-tool",
      close: vi.fn(),
      send: vi.fn()
        .mockImplementationOnce(async (_prompt, options) => {
          const result = options.local.customTools.read.execute(
            { path: "README.md" },
            { toolCallId: "sdk-call-read" }
          );
          return {
            id: "run-context-tool-1",
            async *stream() {
              yield { type: "assistant", message: { content: [{ type: "text", text: "checking" }] } };
              yield {
                type: "tool_call",
                call_id: "sdk-call-read",
                name: "read",
                status: "running",
                args: { path: "README.md" }
              };
              await result;
              yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
            },
            wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
            cancel: vi.fn()
          };
        })
        .mockResolvedValueOnce(nextRun("run-context-tool-2", "continued"))
    };
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [{
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };

    try {
      const toolOutput = await runLocalAgentBody({
        ...baseInput,
        requestId: "context-tool-call",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true,
        resumeToolResults: []
      });
      const callId = toolOutput.toolCalls[0].callId;
      const toolCall = {
        value: {
          type: "tool_call",
          callId,
          name: "read",
          arguments: { path: "README.md" }
        },
        prompt: "ASSISTANT TOOL_CALLS: read README.md"
      };
      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-tool-accepted-input-retry",
        ...first,
        incrementalPrompt: "STALE HEURISTIC PROMPT",
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: []
      })).resolves.toEqual(toolOutput);
      const narration = messageItem("assistant", "checking");
      const latchedContext = agentContextPrompt(bootstrap, [user, narration, toolCall]);
      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-tool-latched-retry",
        ...latchedContext,
        incrementalPrompt: "STALE HEURISTIC PROMPT",
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: []
      })).resolves.toEqual(toolOutput);
      const toolResult = {
        value: {
          type: "tool_output",
          callId,
          output: "contents",
          imageCount: 0,
          isError: false
        },
        prompt: "TOOL RESULT: contents"
      };
      const resultContext = agentContextPrompt(bootstrap, [user, toolCall, narration, toolResult]);

      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-tool-result",
        ...resultContext,
        incrementalPrompt: resultContext.prompt,
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{ callId, output: "contents", isError: false }]
      })).resolves.toMatchObject({ text: "done" });
      const matched = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_tool_results_matched");
      expect(matched).toMatchObject({
        requestId: "context-tool-result",
        pendingRequestId: "context-tool-call",
        agentId: "agent-context-tool",
        runId: "run-context-tool-1"
      });

      const assistant = messageItem("assistant", "done");
      const nextUser = messageItem("user", "next");
      const nextContext = agentContextPrompt(bootstrap, [user, toolCall, narration, toolResult, assistant, nextUser]);
      await runLocalAgentBody({
        ...baseInput,
        requestId: "context-tool-next",
        ...nextContext,
        incrementalPrompt: "STALE HEURISTIC PROMPT",
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: []
      });

      expect(createAgent).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenNthCalledWith(
        2,
        "INPUT:\nUSER: next",
        expect.objectContaining({ idempotencyKey: "context-tool-next" })
      );
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it.each([
    ["context-aware", true],
    ["legacy", false]
  ])("returns an internally rejected tool batch to the same %s run", async (_name, contextAware) => {
    const sessionKey = `context-tool-correction-${crypto.randomUUID()}`;
    const bootstrap = "STABLE TOOL RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "inspect");
    const original = agentContextPrompt(bootstrap, [user]);
    let correctedResult;
    const agent = {
      agentId: "agent-context-tool-correction",
      close: vi.fn(),
      send: vi.fn(async (_prompt, options) => {
        const result = options.local.customTools.read.execute(
          { limit: 100 },
          { toolCallId: "sdk-call-rejected" }
        );
        return {
          id: "run-context-tool-correction",
          async *stream() {
            yield { type: "assistant", message: { content: [{ type: "text", text: "checking" }] } };
            yield {
              type: "tool_call",
              call_id: "sdk-call-rejected",
              name: "read",
              status: "running",
              args: { limit: 100 }
            };
            correctedResult = await result;
            yield { type: "assistant", message: { content: [{ type: "text", text: "corrected" }] } };
          },
          wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
          cancel: vi.fn()
        };
      })
    };
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(agent)
      .mockRejectedValueOnce(new Error("must not create a replacement Agent"));
    const contextInput = contextAware
      ? { ...original, incrementalPrompt: original.prompt }
      : { prompt: "inspect", incrementalPrompt: "inspect" };
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [{
        name: "read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      }],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      ...contextInput,
      hasIncrementalPrompt: false,
      fullReplay: true
    };

    try {
      const rejected = await runLocalAgentBody({
        ...input,
        requestId: "context-tool-correction-first",
        resumeToolResults: []
      });
      await expect(runLocalAgentBody({
        ...input,
        requestId: "context-tool-correction-result",
        resumeToolResults: [{
          callId: rejected.toolCalls[0].callId,
          output: "The call did not satisfy the current schema.",
          isError: true
        }],
        internalToolCorrection: true
      })).resolves.toMatchObject({ text: "corrected", status: "finished" });

      expect(correctedResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "The call did not satisfy the current schema." }]
      });
      expect(createAgent).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledOnce();
      expect(agent.close).not.toHaveBeenCalled();
      if (contextAware) {
        expect(JSON.parse(readFileSync(persistedAgentStatePath(input), "utf8"))).toMatchObject({
          version: 3,
          dirty: false,
          transcriptItemHashes: original.agentContext.transcriptItemHashes,
          provisionalTranscriptItemHashes: [
            ...original.agentContext.transcriptItemHashes,
            transcriptHash(messageItem("assistant", "checking").value),
            transcriptHash(messageItem("assistant", "corrected").value)
          ]
        });
      }
    } finally {
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("creates a fresh Agent for a context-aware empty-turn recovery", async () => {
    const sessionKey = `context-empty-recovery-${crypto.randomUUID()}`;
    const current = agentContextPrompt("STABLE RESPONSES INSTRUCTIONS", [messageItem("user", "answer")]);
    const emptyAgent = finishedAgent("agent-context-empty", "");
    const recoveredAgent = finishedAgent("agent-context-recovered", "recovered");
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(emptyAgent)
      .mockResolvedValueOnce(recoveredAgent);
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      ...current,
      incrementalPrompt: current.prompt,
      hasIncrementalPrompt: false,
      fullReplay: true
    };

    try {
      await expect(runLocalAgentBody({ ...input, requestId: "context-empty-first" }))
        .resolves.toMatchObject({ text: "" });
      await expect(runLocalAgentBody({
        ...input,
        requestId: "context-empty-retry",
        fullReplayCause: "empty_turn_recovery"
      })).resolves.toMatchObject({ text: "recovered" });

      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(emptyAgent.close).toHaveBeenCalledOnce();
      expect(recoveredAgent.send).toHaveBeenCalledWith(
        current.prompt,
        expect.objectContaining({ idempotencyKey: "context-empty-retry" })
      );
    } finally {
      createAgent.mockRestore();
      emptyAgent.close();
      recoveredAgent.close();
    }
  });

  it("does not resume persisted state for an empty-turn recovery", async () => {
    const sessionKey = `context-persisted-empty-recovery-${crypto.randomUUID()}`;
    const current = agentContextPrompt("STABLE RESPONSES INSTRUCTIONS", [messageItem("user", "answer")]);
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      requestId: "context-persisted-empty-retry",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      ...current,
      incrementalPrompt: current.prompt,
      hasIncrementalPrompt: false,
      fullReplay: true,
      fullReplayCause: "empty_turn_recovery"
    };
    seedPersistedAgentState(input, {
      version: 3,
      sdkAgentId: "agent-context-persisted-empty",
      bootstrapFingerprint: current.agentContext.bootstrapFingerprint,
      transcriptItemHashes: current.agentContext.transcriptItemHashes,
      provisionalTranscriptItemHashes: current.agentContext.transcriptItemHashes
    });
    const agent = finishedAgent("agent-context-persisted-empty-replacement", "recovered");
    const resumeAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "recovered" });
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(createAgent).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledWith(
        current.prompt,
        expect.objectContaining({ idempotencyKey: input.requestId })
      );
    } finally {
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("keeps an anonymous callback public ID stable through a context-aware result", async () => {
    const sessionKey = `context-anonymous-tool-${crypto.randomUUID()}`;
    const bootstrap = "STABLE TOOL RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "inspect");
    const first = agentContextPrompt(bootstrap, [user]);
    const agent = {
      agentId: "agent-context-anonymous-tool",
      close: vi.fn(),
      send: vi.fn(async (_prompt, options) => {
        const result = options.local.customTools.read.execute({ path: "README.md" }, {});
        return {
          id: "run-context-anonymous-tool",
          async *stream() {
            await result;
            yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
          },
          wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
          cancel: vi.fn()
        };
      })
    };
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [{ name: "read", parameters: { type: "object" } }],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };

    try {
      const toolOutput = await runLocalAgentBody({
        ...baseInput,
        requestId: "context-anonymous-call",
        ...first,
        incrementalPrompt: first.prompt,
        hasIncrementalPrompt: false,
        fullReplay: true,
        resumeToolResults: []
      });
      const callId = toolOutput.toolCalls[0].callId;
      expect(callId).toMatch(/^call_sdk_[a-f0-9]{32}_read$/);
      const toolCall = {
        value: { type: "tool_call", callId, name: "read", arguments: { path: "README.md" } },
        prompt: "ASSISTANT TOOL_CALLS: read README.md"
      };
      const toolResult = {
        value: { type: "tool_output", callId, output: "contents", imageCount: 0, isError: false },
        prompt: "TOOL RESULT: contents"
      };
      const continuation = agentContextPrompt(bootstrap, [user, toolCall, toolResult]);
      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "context-anonymous-result",
        ...continuation,
        incrementalPrompt: continuation.prompt,
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{ callId, output: "contents", isError: false }]
      })).resolves.toMatchObject({ text: "done" });

      expect(createAgent).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledOnce();
    } finally {
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("annotates a context-aware aborted turn on the active Run", async () => {
    const sessionKey = `context-interrupt-steer-${crypto.randomUUID()}`;
    const bootstrap = "STABLE TOOL RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "inspect");
    const original = agentContextPrompt(bootstrap, [user]);
    let settledResult;
    const agent = {
      agentId: "agent-context-interrupt-steer",
      close: vi.fn(),
      send: vi.fn()
    };
    const createAgent = vi.spyOn(Agent, "create").mockRejectedValue(new Error("must not create"));
    const inputBase = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      supersedePendingRun: true,
      supersedingTurnAborted: true
    };
    const pending = createPendingAgentRun(
      agentCacheKey(inputBase),
      { agent },
      "context-interrupt-original",
      sessionKey,
      original.agentContext
    );
    pending.model = inputBase.model;
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-interrupt",
      toolCall: { type: "exec", args: { command: "old command" } }
    });
    const exposed = await waitForPendingAgentEvent(pending);
    const callId = exposed.toolCalls[0].callId;
    const oldRun = {
      id: "run-context-interrupted",
      async *stream() {
        settledResult = await result;
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn().mockResolvedValue(undefined)
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);
    const toolCall = {
      value: { type: "tool_call", callId, name: "exec", arguments: { command: "old command" } },
      prompt: "ASSISTANT TOOL_CALLS: exec old command"
    };
    const toolResult = {
      value: { type: "tool_output", callId, output: "stopped", imageCount: 0, isError: false },
      prompt: "TOOL RESULT: stopped"
    };
    const aborted = messageItem("assistant", "Reply operation aborted by user.");
    const marker = messageItem("developer", "<turn_aborted>");
    const nextUser = messageItem("user", "Change direction");
    const current = agentContextPrompt(bootstrap, [user, toolCall, toolResult, aborted, marker, nextUser]);
    const followUp = [aborted.prompt, marker.prompt, nextUser.prompt].join("\n");

    try {
      const outputPromise = runLocalAgentBody({
        ...inputBase,
        requestId: "context-interrupt-follow-up",
        ...current,
        incrementalPrompt: followUp,
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{ callId, output: "stopped", isError: false }],
        supersededToolCallIds: [callId]
      });
      await expect(outputPromise).resolves.toMatchObject({ status: "finished" });

      expect(settledResult).toContain("stopped");
      expect(settledResult).toContain(`<user_interjection>\nINPUT:\n${followUp}\n</user_interjection>`);
      expect(oldRun.cancel).not.toHaveBeenCalled();
      expect(agent.close).not.toHaveBeenCalled();
      expect(agent.send).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    } finally {
      createAgent.mockRestore();
      agent.close();
    }
  });

  it.each(["active", "cached", "snapshot unavailable", "journal failure"])("retains the accepted continuation snapshot for %s divergence", async (mode) => {
    const sessionKey = `context-snapshot-${crypto.randomUUID()}`;
    const user = messageItem("user", "inspect");
    const original = agentContextPrompt("STABLE BOOTSTRAP", [user]);
    let firstCallback;
    let secondCallback;
    const oldRun = {
      id: "run-snapshot-old",
      cancel: vi.fn(),
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" })
    };
    const oldAgent = {
      agentId: "agent-snapshot-old",
      close: vi.fn(),
      send: vi.fn(async (_prompt, options) => {
        firstCallback = options.local.customTools.read.execute({ path: "one" }, { toolCallId: "sdk-one" });
        return {
          ...oldRun,
          async *stream() {
            await firstCallback;
            secondCallback = options.local.customTools.read.execute({ path: "two" }, { toolCallId: "sdk-two" });
            await secondCallback;
            yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
          }
        };
      })
    };
    const newAgent = finishedAgent("agent-snapshot-new", "replacement answer");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValueOnce(oldAgent).mockResolvedValueOnce(newAgent);
    const info = vi.spyOn(console, "info").mockImplementation((message) => {
      if (mode === "journal failure" && ["trajectory_context_replacement", "trajectory_observation_error"].includes(JSON.parse(message).event)) {
        throw new Error("injected journal failure");
      }
    });
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [{ name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
      resumeToolResults: [],
      hasIncrementalPrompt: true,
      fullReplay: false,
      incrementalPrompt: "STALE HEURISTIC PROMPT"
    };
    const callItem = (callId, path) => ({
      value: { type: "tool_call", callId, name: "read", arguments: { path } },
      prompt: `ASSISTANT TOOL_CALLS: read ${path}`
    });
    const resultItem = (callId, output) => ({
      value: { type: "tool_output", callId, output, imageCount: 0, isError: false },
      prompt: `TOOL RESULT: ${output}`
    });
    const prefix = "x".repeat(400);
    try {
      const first = await runLocalAgentBody({ ...baseInput, ...original, requestId: "snapshot-initial" });
      const firstId = first.toolCalls[0].callId;
      const acceptedItems = [user, callItem(firstId, "one"), resultItem(firstId, `${prefix}original`)];
      const continuation = agentContextPrompt("STABLE BOOTSTRAP", acceptedItems);
      if (mode === "snapshot unavailable") continuation.agentContext.promptTextChars += 1;
      const second = await runLocalAgentBody({
        ...baseInput, ...continuation, requestId: "snapshot-continuation",
        resumeToolResults: [{ callId: firstId, output: `${prefix}original`, isError: false }]
      });
      await expect(firstCallback).resolves.toBe(`${prefix}original`);
      expect(createAgent).toHaveBeenCalledOnce();
      expect(oldRun.cancel).not.toHaveBeenCalled();
      expect(jsonLogRecords(info, "trajectory_context_replacement")).toHaveLength(0);
      const secondId = second.toolCalls[0].callId;
      const completeItems = [...acceptedItems, callItem(secondId, "two"), resultItem(secondId, "second result")];
      if (mode === "cached") {
        await runLocalAgentBody({
          ...baseInput, ...agentContextPrompt("STABLE BOOTSTRAP", completeItems), requestId: "snapshot-terminal",
          resumeToolResults: [{ callId: secondId, output: "second result", isError: false }]
        });
        completeItems.push(messageItem("assistant", "done"), messageItem("user", "next"));
      }
      completeItems[2] = resultItem(firstId, `${prefix}edited`);
      const changed = agentContextPrompt("STABLE BOOTSTRAP", completeItems);
      await expect(runLocalAgentBody({
        ...baseInput, ...changed, requestId: "snapshot-replacement",
        resumeToolResults: mode === "cached" ? [] : [{ callId: secondId, output: "second result", isError: false }]
      })).resolves.toMatchObject({ text: "replacement answer" });
      await expect(secondCallback).resolves.toBe("second result");
      expect(oldAgent.close).toHaveBeenCalledOnce();
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(newAgent.send.mock.calls[0][0]).toContain(changed.prompt);
      const replay = jsonLogRecords(info, "trajectory_replay").at(-1);
      expect(replay).toMatchObject({
        replayCause: "agent_transcript_diverged",
        divergedItemIndex: 2,
        knownItemHash: continuation.agentContext.transcriptItemHashes[2],
        clientItemHash: changed.agentContext.transcriptItemHashes[2]
      });
      if (mode === "snapshot unavailable") {
        expect(replay.knownItemPreview).toBeUndefined();
        expect(replay.knownRequestId).toBeUndefined();
      } else {
        expect(replay).toMatchObject({
          knownRequestId: mode === "cached" ? "snapshot-terminal" : "snapshot-continuation",
          divergedCharOffset: "TOOL RESULT: ".length + prefix.length
        });
        expect(replay.knownItemPreview).toContain("original");
        expect(replay.divergedItemPreview).toContain("edited");
        expect(replay.knownItemPreview.length).toBeLessThanOrEqual(200);
        expect(replay.divergedItemPreview.length).toBeLessThanOrEqual(200);
      }
      expect(oldRun.cancel).toHaveBeenCalledTimes(mode === "cached" ? 0 : 1);
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      oldAgent.close();
      newAgent.close();
    }
  });

  it.each(["bootstrap", "transcript", "truncated", "observation failure"])("settles an exposed tool result before replacing a pending Agent: %s", async (change) => {
    const sessionKey = `context-pending-divergence-${crypto.randomUUID()}`;
    const user = messageItem("user", "inspect");
    const original = agentContextPrompt("BOOTSTRAP V1", [user]);
    const inputBase = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };
    const oldAgent = { agentId: "agent-pending-old", close: vi.fn() };
    const pending = createPendingAgentRun(
      agentCacheKey(inputBase),
      { agent: oldAgent },
      "context-pending-original",
      sessionKey,
      original.agentContext
    );
    pending.model = inputBase.model;
    pending.actor.agentEntry.contextSnapshot = {
      requestId: "context-pending-original",
      prompt: original.prompt,
      hashes: original.agentContext.transcriptItemHashes,
      offsets: original.agentContext.transcriptItemOffsets,
      endOffset: original.agentContext.transcriptEndOffset
    };
    const callback = parkPendingToolCall(pending, {
      callId: "sdk-call-read",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    pending.readyBatch = new Set(pending.parked.keys());
    const oldRun = { id: "run-pending-old", cancel: vi.fn() };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = Promise.resolve({ usage: null });
    const exposed = await waitForPendingAgentEvent(pending);
    const callId = exposed.toolCalls[0].callId;
    const toolCall = {
      value: {
        type: "tool_call",
        callId,
        name: "read",
        arguments: { path: "README.md" }
      },
      prompt: "ASSISTANT TOOL_CALLS: read README.md"
    };
    const toolResult = {
      value: {
        type: "tool_output",
        callId,
        output: "contents",
        imageCount: 0,
        isError: false
      },
      prompt: "TOOL RESULT: contents"
    };
    const changed = agentContextPrompt(
      change === "bootstrap" ? "BOOTSTRAP V2" : "BOOTSTRAP V1",
      change === "truncated" ? [] : [change === "bootstrap" ? user : messageItem("user", "edited"), toolCall, toolResult]
    );
    if (change === "observation failure") {
      Object.defineProperty(pending.actor.agentEntry.contextSnapshot, "offsets", {
        get() { throw new Error("injected observation failure"); }
      });
    }
    const newAgent = finishedAgent("agent-pending-new", "replacement answer");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(newAgent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await runLocalAgentBody({
        ...inputBase,
        requestId: "context-pending-replacement",
        ...changed,
        incrementalPrompt: "STALE HEURISTIC PROMPT",
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{ callId, output: "contents", isError: false }]
      });

      await expect(callback).resolves.toBe("contents");
      expect(oldRun.cancel).toHaveBeenCalledOnce();
      expect(oldAgent.close).toHaveBeenCalledOnce();
      expect(createAgent).toHaveBeenCalledOnce();
      expect(newAgent.send.mock.calls[0][0]).toMatch(new RegExp(`^${changed.prompt}`));
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: change === "bootstrap" ? "agent_bootstrap_mismatch" : "agent_transcript_diverged"
      });
      const replacement = jsonLogRecords(info, "trajectory_context_replacement").at(-1);
      expect(replacement).toMatchObject({
        requestId: "context-pending-replacement",
        agentId: oldAgent.agentId,
        runId: oldRun.id,
        resumeToolResultsCount: 1,
        supersedePendingRun: false
      });
      const replacementCall = info.mock.calls.findIndex(([message]) => JSON.parse(message).event === "trajectory_context_replacement");
      expect(info.mock.invocationCallOrder[replacementCall]).toBeLessThan(oldRun.cancel.mock.invocationCallOrder[0]);
      if (change === "transcript") {
        const detail = {
          divergenceKind: "item_mismatch",
          divergedItemIndex: 0,
          knownTranscriptItemCount: 1,
          clientTranscriptItemCount: 3,
          knownItemHash: original.agentContext.transcriptItemHashes[0],
          clientItemHash: changed.agentContext.transcriptItemHashes[0],
          knownRequestId: "context-pending-original",
          knownItemPreview: "USER: inspect",
          divergedItemPreview: "USER: edited"
        };
        expect(replacement).toMatchObject(detail);
        expect(jsonLogRecords(info, "trajectory_replay").at(-1)).toMatchObject(detail);
      } else if (change === "truncated") {
        expect(replacement).toMatchObject({
          divergenceKind: "client_history_truncated",
          divergedItemIndex: 0,
          knownTranscriptItemCount: 1,
          clientTranscriptItemCount: 0
        });
        expect(replacement.knownItemPreview).toBeUndefined();
      } else if (change === "observation failure") {
        expect(jsonLogRecords(info, "trajectory_observation_error")).toContainEqual(expect.objectContaining({
          scope: "context_divergence"
        }));
      }
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      oldAgent.close();
      newAgent.close();
    }
  });

  it("replaces an active Agent when provisional output diverges from a new turn", async () => {
    const sessionKey = `context-active-provisional-divergence-${crypto.randomUUID()}`;
    const bootstrap = "STABLE RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "inspect");
    const original = agentContextPrompt(bootstrap, [user]);
    const oldAgent = { agentId: "agent-active-provisional-old", close: vi.fn() };
    const inputBase = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };
    const pending = createPendingAgentRun(
      agentCacheKey(inputBase),
      { agent: oldAgent },
      "context-active-provisional-original",
      sessionKey,
      original.agentContext
    );
    pending.model = inputBase.model;
    pending.transcriptItemHashes.push(transcriptHash(messageItem("assistant", "partial").value));
    const oldRun = { id: "run-active-provisional-old", cancel: vi.fn() };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = Promise.resolve({ usage: null });

    const marker = messageItem("developer", "<turn_aborted>");
    const nextUser = messageItem("user", "continue");
    const current = agentContextPrompt(bootstrap, [user, marker, nextUser]);
    const newAgent = finishedAgent("agent-active-provisional-new", "replacement answer");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(newAgent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody({
        ...inputBase,
        requestId: "context-active-provisional-replacement",
        ...current,
        incrementalPrompt: `${marker.prompt}\n${nextUser.prompt}`,
        hasIncrementalPrompt: true,
        fullReplay: false
      })).resolves.toMatchObject({ text: "replacement answer" });

      expect(oldRun.cancel).toHaveBeenCalledOnce();
      expect(oldAgent.close).toHaveBeenCalledOnce();
      expect(createAgent).toHaveBeenCalledOnce();
      expect(newAgent.send.mock.calls[0][0]).toMatch(new RegExp(`^${current.prompt}`));
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: "agent_provisional_transcript_diverged"
      });
      expect(jsonLogRecords(info, "trajectory_replay").at(-1)).toMatchObject({
        divergenceKind: "item_mismatch",
        divergedItemIndex: 1,
        knownTranscriptItemCount: 2,
        clientTranscriptItemCount: 3,
        knownItemHash: transcriptHash(messageItem("assistant", "partial").value),
        clientItemHash: transcriptHash(marker.value)
      });
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      oldAgent.close();
      newAgent.close();
    }
  });

  it("resumes persisted context state and renders the missing transcript suffix", async () => {
    const sessionKey = `context-persisted-${crypto.randomUUID()}`;
    const bootstrap = "STABLE PERSISTED RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "one");
    const assistant = messageItem("assistant", "answer");
    const nextUser = messageItem("user", "two");
    const current = agentContextPrompt(bootstrap, [user, assistant, nextUser]);
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      requestId: "context-persisted-next",
      ...current,
      incrementalPrompt: "STALE HEURISTIC PROMPT",
      hasIncrementalPrompt: false,
      fullReplay: true,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };
    seedPersistedAgentState(input, {
      version: 3,
      sdkAgentId: "agent-context-persisted",
      bootstrapFingerprint: current.agentContext.bootstrapFingerprint,
      transcriptItemHashes: current.agentContext.transcriptItemHashes.slice(0, 1),
      provisionalTranscriptItemHashes: current.agentContext.transcriptItemHashes.slice(0, 2)
    });
    const agent = finishedAgent("agent-context-persisted", "next answer");
    const resumeAgent = vi.spyOn(Agent, "resume").mockResolvedValue(agent);
    const createAgent = vi.spyOn(Agent, "create").mockRejectedValue(new Error("must not create"));

    try {
      await runLocalAgentBody(input);

      expect(resumeAgent).toHaveBeenCalledWith("agent-context-persisted", localAgentCreateOptions(input));
      expect(agent.send).toHaveBeenCalledWith(
        "INPUT:\nUSER: two",
        expect.objectContaining({ idempotencyKey: input.requestId })
      );
      expect(JSON.parse(readFileSync(persistedAgentStatePath(input), "utf8"))).toMatchObject({
        version: 3,
        dirty: false,
        bootstrapFingerprint: current.agentContext.bootstrapFingerprint,
        transcriptItemHashes: current.agentContext.transcriptItemHashes,
        provisionalTranscriptItemHashes: [
          ...current.agentContext.transcriptItemHashes,
          transcriptHash(messageItem("assistant", "next answer").value)
        ]
      });
    } finally {
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("creates a fresh Agent when persisted provisional output diverges", async () => {
    const bootstrap = "STABLE PERSISTED RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "one");
    const marker = messageItem("developer", "<turn_aborted>");
    const nextUser = messageItem("user", "continue");
    const current = agentContextPrompt(bootstrap, [user, marker, nextUser]);
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey: `context-persisted-aborted-${crypto.randomUUID()}`,
      requestId: "context-persisted-aborted-next",
      ...current,
      incrementalPrompt: "STALE HEURISTIC PROMPT",
      hasIncrementalPrompt: true,
      fullReplay: false,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };
    seedPersistedAgentState(input, {
      version: 3,
      sdkAgentId: "agent-context-persisted-aborted",
      bootstrapFingerprint: current.agentContext.bootstrapFingerprint,
      transcriptItemHashes: current.agentContext.transcriptItemHashes.slice(0, 1),
      provisionalTranscriptItemHashes: [
        current.agentContext.transcriptItemHashes[0],
        transcriptHash(messageItem("assistant", "late answer").value)
      ]
    });
    const agent = finishedAgent("agent-context-persisted-aborted-replacement", "continued");
    const resumeAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "continued" });

      expect(resumeAgent).not.toHaveBeenCalled();
      expect(createAgent).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledWith(
        expect.stringMatching(/^STABLE PERSISTED RESPONSES INSTRUCTIONS\nINPUT:\n[\s\S]+\n\n\[cursor2response recovery\]/),
        expect.objectContaining({ idempotencyKey: input.requestId })
      );
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: "agent_provisional_transcript_diverged"
      });
    } finally {
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it.each([false, true])(
    "does not resume persisted state for an equal authoritative transcript (provisional extended: %s)",
    async (provisionalExtended) => {
      const sessionKey = `context-persisted-equal-${crypto.randomUUID()}`;
      const current = agentContextPrompt("STABLE RESPONSES INSTRUCTIONS", [
        messageItem("user", "one"),
        messageItem("assistant", "answer")
      ]);
      const input = {
        apiKey: "cursor-test-key",
        model: "model-a",
        workingDirectory: "/tmp/project",
        sessionKey,
        requestId: "context-persisted-equal",
        ...current,
        incrementalPrompt: "STALE HEURISTIC PROMPT",
        hasIncrementalPrompt: true,
        fullReplay: false,
        clientTools: [],
        resumeToolResults: [],
        supersedePendingRun: false,
        supersededToolCallIds: []
      };
      seedPersistedAgentState(input, {
        version: 3,
        sdkAgentId: "agent-context-persisted-equal",
        bootstrapFingerprint: current.agentContext.bootstrapFingerprint,
        transcriptItemHashes: current.agentContext.transcriptItemHashes,
        provisionalTranscriptItemHashes: provisionalExtended
          ? [
              ...current.agentContext.transcriptItemHashes,
              transcriptHash(messageItem("assistant", "late answer").value)
            ]
          : current.agentContext.transcriptItemHashes
      });
      const resumeAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
      const createAgent = vi.spyOn(Agent, "create").mockRejectedValue(new Error("must not create"));

      try {
        await expect(runLocalAgentBody(input)).rejects.toMatchObject({
          status: 409,
          code: "cursor_sdk_transcript_not_extended"
        });
        expect(resumeAgent).not.toHaveBeenCalled();
        expect(createAgent).not.toHaveBeenCalled();
      } finally {
        resumeAgent.mockRestore();
        createAgent.mockRestore();
      }
    }
  );

  it.each([1, 2])("does not resume persisted state v%s for a context-aware request", async (version) => {
    const sessionKey = `context-legacy-${crypto.randomUUID()}`;
    const current = agentContextPrompt("STABLE RESPONSES INSTRUCTIONS", [messageItem("user", "one")]);
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey,
      requestId: "context-legacy-next",
      ...current,
      incrementalPrompt: "USER: one",
      hasIncrementalPrompt: true,
      fullReplay: false,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: []
    };
    seedPersistedAgentState(input, version === 1
      ? {}
      : {
          version,
          bootstrapFingerprint: current.agentContext.bootstrapFingerprint,
          transcriptItemHashes: current.agentContext.transcriptItemHashes
        });
    const agent = finishedAgent("agent-context-legacy-replacement", "answer");
    const resumeAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await runLocalAgentBody(input);

      expect(resumeAgent).not.toHaveBeenCalled();
      expect(createAgent).toHaveBeenCalledOnce();
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: "agent_context_missing"
      });
    } finally {
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it.each([
    [1, {}],
    [2, { version: 2, bootstrapFingerprint: null, transcriptItemHashes: null }],
    [3, {
      version: 3,
      bootstrapFingerprint: null,
      transcriptItemHashes: null,
      provisionalTranscriptItemHashes: null
    }]
  ])("resumes a clean persisted v%s Agent for a legacy caller", async (version, stateOverrides) => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `persisted-resume-v${version}-${crypto.randomUUID()}`,
      requestId: "request-persisted-resume",
      prompt: "full transcript",
      incrementalPrompt: "latest user turn",
      hasIncrementalPrompt: true,
      clientTools: [],
      resumeToolResults: [{ callId: "stale-call", output: "aborted" }],
      supersedePendingRun: true,
      supersededToolCallIds: ["stale-call"],
      fullReplay: false
    };
    seedPersistedAgentState(input, stateOverrides);
    const agent = finishedAgent("agent-resumed", "resumed answer");
    agent.send.mockImplementationOnce(async (prompt) => {
      expect(JSON.parse(readFileSync(persistedAgentStatePath(input), "utf8"))).toMatchObject({
        sdkAgentId: "agent-resumed",
        model: input.model,
        dirty: true
      });
      return {
        id: "run-agent-resumed",
        async *stream() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "resumed answer" }] } };
        },
        wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
        cancel: vi.fn()
      };
    });
    const resumeAgent = vi.spyOn(Agent, "resume").mockResolvedValue(agent);
    const createAgent = vi.spyOn(Agent, "create").mockRejectedValue(new Error("must not create"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "resumed answer" });

      expect(resumeAgent).toHaveBeenCalledWith("agent-persisted", localAgentCreateOptions(input));
      expect(createAgent).not.toHaveBeenCalled();
      expect(agent.send).toHaveBeenCalledWith(
        "latest user turn",
        expect.objectContaining({ idempotencyKey: input.requestId })
      );
      expect(JSON.parse(readFileSync(persistedAgentStatePath(input), "utf8"))).toMatchObject({
        version: 3,
        sdkAgentId: "agent-resumed",
        model: input.model,
        dirty: false,
        bootstrapFingerprint: null,
        transcriptItemHashes: null,
        provisionalTranscriptItemHashes: null
      });
      expect(statSync(agentStateTestContext.directory).mode & 0o777).toBe(0o700);
      expect(statSync(persistedAgentStatePath(input)).mode & 0o777).toBe(0o600);
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        agentCacheHit: false,
        agentResumed: true,
        sentPromptChars: "latest user turn".length,
        promptSource: "resumed-incremental",
        recoverySuffixApplied: false
      });
    } finally {
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it.each([
    ["missing state", null, false, "agent_state_missing"],
    ["dirty state", { dirty: true }, false, "agent_state_dirty"],
    ["model-mismatched state", { model: "composer-2.5" }, false, "agent_model_mismatch"],
    ["resume failure", {}, true, "agent_resume_failed"]
  ])("creates a recovery Agent with a suffix for %s", async (_name, stateOverrides, shouldResume, replayCause) => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `created-recovery-${crypto.randomUUID()}`,
      requestId: "request-created-recovery",
      prompt: "full transcript",
      incrementalPrompt: "latest user turn",
      hasIncrementalPrompt: true,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };
    if (stateOverrides !== null) seedPersistedAgentState(input, stateOverrides);
    const agent = finishedAgent(`agent-created-${crypto.randomUUID()}`, "created answer");
    const resumeAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("resume unavailable"));
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "created answer" });

      expect(resumeAgent).toHaveBeenCalledTimes(shouldResume ? 1 : 0);
      expect(createAgent).toHaveBeenCalledOnce();
      const sentPrompt = agent.send.mock.calls[0][0];
      expect(sentPrompt).toMatch(/^full transcript\n\n\[cursor2response recovery\]/);
      expect(sentPrompt).toContain("Continue from the latest user message");
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        agentCacheHit: false,
        agentResumed: false,
        sentPromptChars: sentPrompt.length,
        promptSource: "created-full",
        replayCause,
        recoverySuffixApplied: true
      });
    } finally {
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("preserves dirty replay attribution without an incremental prompt", async () => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `dirty-full-replay-${crypto.randomUUID()}`,
      requestId: "request-dirty-full-replay",
      prompt: "full transcript",
      incrementalPrompt: "full transcript",
      hasIncrementalPrompt: false,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };
    seedPersistedAgentState(input, { dirty: true });
    const agent = finishedAgent("agent-dirty-full-replay");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "done" });
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: "agent_state_dirty"
      });
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("does not append the recovery suffix to a first-ever full prompt", async () => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `first-turn-${crypto.randomUUID()}`,
      requestId: "request-first-turn",
      prompt: "first full prompt",
      incrementalPrompt: "first full prompt",
      hasIncrementalPrompt: false,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: true
    };
    const agent = finishedAgent("agent-first-turn");
    const resumeAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "done" });
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(agent.send).toHaveBeenCalledWith(
        "first full prompt",
        expect.objectContaining({ idempotencyKey: input.requestId })
      );
      expect(info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected")).toMatchObject({
          promptSource: "created-full",
          replayCause: "first_turn"
        });
    } finally {
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("leaves a failed run dirty and non-resumable", async () => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `failed-run-${crypto.randomUUID()}`,
      requestId: "request-failed-run",
      prompt: "full transcript",
      incrementalPrompt: "latest user turn",
      hasIncrementalPrompt: true,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const failure = new Error("SDK send failed");
    const agent = {
      agentId: "agent-failed-run",
      close: vi.fn(),
      send: vi.fn().mockRejectedValue(failure)
    };
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);

    try {
      await expect(runLocalAgentBody(input)).rejects.toBe(failure);
      expect(JSON.parse(readFileSync(persistedAgentStatePath(input), "utf8"))).toMatchObject({
        sdkAgentId: "agent-failed-run",
        model: input.model,
        dirty: true
      });
      expect(agent.close).toHaveBeenCalledOnce();
    } finally {
      createAgent.mockRestore();
    }
  });

  it("invalidates stale clean state when dirty persistence fails", async () => {
    const input = {
      apiKey: "cursor-test-key",
      model: "model-a",
      workingDirectory: "/tmp/project",
      sessionKey: `failed-state-write-${crypto.randomUUID()}`,
      requestId: "request-failed-state-write",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const previousContext = agentContextPrompt("STABLE BOOTSTRAP", [messageItem("user", "one")]);
    const currentContext = agentContextPrompt("STABLE BOOTSTRAP", [
      messageItem("user", "one"),
      messageItem("user", "two")
    ]);
    seedPersistedAgentState(input, {
      version: 3,
      bootstrapFingerprint: previousContext.agentContext.bootstrapFingerprint,
      transcriptItemHashes: previousContext.agentContext.transcriptItemHashes,
      provisionalTranscriptItemHashes: previousContext.agentContext.transcriptItemHashes
    });
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent: { agentId: "agent-failed-state-write", close: vi.fn() } },
      input.requestId,
      input.sessionKey
    );
    pending.model = input.model;
    const failure = new Error("SDK run failed");
    fsPromiseTestHooks.failAgentStateWrites = true;
    try {
      await failPendingAgentRun(pending, failure);
    } finally {
      fsPromiseTestHooks.failAgentStateWrites = false;
    }

    expect(() => statSync(persistedAgentStatePath(input))).toThrow();

    const resumedAgent = vi.spyOn(Agent, "resume").mockRejectedValue(new Error("must not resume"));
    const replacement = finishedAgent("agent-after-failed-state-write");
    const createdAgent = vi.spyOn(Agent, "create").mockResolvedValue(replacement);
    try {
      await runLocalAgentBody({
        ...input,
        requestId: "request-after-failed-state-write",
        ...currentContext,
        incrementalPrompt: "USER: two",
        hasIncrementalPrompt: true
      });
      expect(resumedAgent).not.toHaveBeenCalled();
      expect(createdAgent).toHaveBeenCalledOnce();
    } finally {
      resumedAgent.mockRestore();
      createdAgent.mockRestore();
      replacement.close();
    }
  });

  it("does not let a failed run's late completion overwrite replacement state", async () => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `late-completion-${crypto.randomUUID()}`,
      requestId: "request-late-completion",
      prompt: "full transcript",
      incrementalPrompt: "latest user turn",
      hasIncrementalPrompt: true,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const agent = { agentId: "agent-old", close: vi.fn() };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      input.requestId,
      input.sessionKey
    );
    pending.model = input.model;
    let markStreamStarted;
    const streamStarted = new Promise((resolve) => {
      markStreamStarted = resolve;
    });
    let releaseStream;
    const streamRelease = new Promise((resolve) => {
      releaseStream = resolve;
    });
    const run = {
      id: "run-old",
      async *stream() {
        markStreamStarted();
        await streamRelease;
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "old result" }),
      cancel: vi.fn()
    };
    seedPersistedAgentState(input, { sdkAgentId: agent.agentId, dirty: true });
    const completion = consumePendingAgentRun(pending, run);
    await streamStarted;

    await failPendingAgentRun(pending, new Error("request cancelled"));
    seedPersistedAgentState(input, { sdkAgentId: "agent-replacement", dirty: true });
    releaseStream();
    await completion;

    expect(JSON.parse(readFileSync(persistedAgentStatePath(input), "utf8"))).toMatchObject({
      sdkAgentId: "agent-replacement",
      dirty: true
    });
  });

  it("keeps the cached agent when a supersede candidate has no pending owner", async () => {
    const run = (id, text) => ({
      id,
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    });
    const firstAgent = {
      agentId: "agent-completed-history",
      close: vi.fn(),
      send: vi.fn()
        .mockResolvedValueOnce(run("run-completed-history", "Earlier final"))
        .mockResolvedValueOnce(run("run-incremental-follow-up", "New final"))
    };
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(firstAgent);
    const sessionKey = `completed-history-${crypto.randomUUID()}`;
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey,
      requestId: "request-completed-history",
      prompt: "Earlier full transcript",
      incrementalPrompt: "",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };

    try {
      await expect(runLocalAgentBody(baseInput)).resolves.toMatchObject({ text: "Earlier final" });
      await expect(runLocalAgentBody({
        ...baseInput,
        requestId: "request-new-user",
        prompt: "Completed transcript followed by a new user turn",
        incrementalPrompt: "ASSISTANT: Earlier final\nUSER: New turn",
        resumeToolResults: [{ callId: "call-already-completed", output: "done" }],
        supersedePendingRun: true,
        supersededToolCallIds: ["call-already-completed"]
      })).resolves.toMatchObject({ text: "New final" });

      expect(firstAgent.close).not.toHaveBeenCalled();
      expect(createAgent).toHaveBeenCalledOnce();
      expect(firstAgent.send).toHaveBeenNthCalledWith(
        2,
        "ASSISTANT: Earlier final\nUSER: New turn",
        expect.objectContaining({ idempotencyKey: "request-new-user" })
      );
    } finally {
      createAgent.mockRestore();
      firstAgent.close();
    }
  });

  it("annotates a shape-A steer on the final result while preserving supplied siblings", async () => {
    const order = [];
    const oldUsage = {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: 13
    };
    const agent = {
      agentId: "agent-two-phase",
      close: vi.fn(),
      send: vi.fn()
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `two-phase-${crypto.randomUUID()}`,
      requestId: "request-two-phase",
      prompt: "full transcript",
      incrementalPrompt: "New user turn",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    const suppliedToolResult = parkPendingToolCall(pending, {
      callId: "sdk-call-supplied",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const missingToolResult = parkPendingToolCall(pending, {
      callId: "sdk-call-missing",
      toolCall: { type: "read", args: { path: "TODO.md" } }
    });
    const toolEvent = await waitForPendingAgentEvent(pending);
    input.supersededToolCallIds = toolEvent.toolCalls.map((call) => call.callId);
    input.resumeToolResults = [{ callId: toolEvent.toolCalls[0].callId, output: "README contents" }];
    const oldRun = {
      id: "run-initial",
      async *stream() {
        const [supplied, missing] = await Promise.all([suppliedToolResult, missingToolResult]);
        order.push(`supplied:${supplied}`);
        order.push(`missing:${missing.isError}:${missing.content[0].text}`);
        yield { type: "usage", usage: oldUsage };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Old turn complete" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    const output = await runLocalAgentBody(input);

    expect(output).toMatchObject({
      text: "Old turn complete",
      status: "finished",
      usage: oldUsage
    });
    expect(order[0]).toBe("supplied:README contents");
    expect(order[1]).toContain(`missing:true:${ABORTED_TOOL_RESULT_MESSAGE}`);
    expect(order[1]).toContain("<user_interjection>\nNew user turn\n</user_interjection>");
    expect(order.join("\n").match(/<user_interjection>/g)).toHaveLength(1);
    expect(agent.send).not.toHaveBeenCalled();
  });

  it("recovers a dead client turn by annotating the actual batch", async () => {
    let settledResult;
    const agent = {
      agentId: "agent-dead-turn",
      close: vi.fn(),
      send: vi.fn()
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `dead-turn-${crypto.randomUUID()}`,
      requestId: "request-dead-turn",
      prompt: "full transcript with new user turn",
      incrementalPrompt: "USER: Recover this turn",
      hasIncrementalPrompt: true,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    pending.model = input.model;
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-dead-turn",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    await waitForPendingAgentEvent(pending);
    const oldRun = {
      id: "run-dead-turn",
      async *stream() {
        settledResult = await result;
        yield { type: "assistant", message: { content: [{ type: "text", text: "Recovered in place" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    await expect(runLocalAgentBody(input)).resolves.toMatchObject({
      text: "Recovered in place",
      status: "finished"
    });
    expect(settledResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining(
        "<user_interjection>\nUSER: Recover this turn\n</user_interjection>"
      ) }]
    });
    expect(oldRun.cancel).not.toHaveBeenCalled();
    expect(agent.send).not.toHaveBeenCalled();
    expect(agent.close).not.toHaveBeenCalled();
  });

  it("settles the pending run before a full replay with no incremental prompt", async () => {
    let settledResult;
    const oldAgent = {
      agentId: "agent-full-replay-old",
      close: vi.fn(),
      send: vi.fn()
    };
    const newAgent = finishedAgent("agent-full-replay-new", "Replayed answer");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(newAgent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `full-replay-fallback-${crypto.randomUUID()}`,
      requestId: "request-full-replay-fallback",
      prompt: "complete transcript",
      incrementalPrompt: "complete transcript",
      hasIncrementalPrompt: false,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: true
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent: oldAgent },
      "request-initial",
      input.sessionKey
    );
    pending.model = input.model;
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-full-replay",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    await waitForPendingAgentEvent(pending);
    const oldRun = {
      id: "run-full-replay-old",
      async *stream() {
        settledResult = await result;
      },
      wait: vi.fn().mockResolvedValue({ status: "cancelled", result: "" }),
      cancel: vi.fn().mockResolvedValue(undefined)
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "Replayed answer" });
      expect(settledResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: ABORTED_TOOL_RESULT_MESSAGE }]
      });
      expect(oldRun.cancel).toHaveBeenCalledOnce();
      expect(oldAgent.close).toHaveBeenCalledOnce();
      expect(newAgent.send).toHaveBeenCalledWith(
        "complete transcript",
        expect.objectContaining({ idempotencyKey: input.requestId })
      );
      const selection = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_prompt_selected");
      expect(selection).toMatchObject({
        promptSource: "created-full",
        replayCause: "missing_incremental_prompt"
      });
      const settled = warn.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_pending_run_settled_for_full_replay");
      expect(settled).toMatchObject({
        requestId: "request-full-replay-fallback",
        pendingRequestId: "request-initial",
        agentId: "agent-full-replay-old",
        runId: "run-full-replay-old"
      });
    } finally {
      warn.mockRestore();
      info.mockRestore();
      createAgent.mockRestore();
      newAgent.close();
    }
  });

  it("settles and annotates an aborted turn on the active Run", async () => {
    let settledResult;
    const agent = {
      agentId: "agent-interrupt-steer",
      close: vi.fn(),
      send: vi.fn()
    };
    const createAgent = vi.spyOn(Agent, "create").mockRejectedValue(new Error("must not create"));
    const bootstrap = "STABLE RESPONSES INSTRUCTIONS";
    const user = messageItem("user", "Inspect the service");
    const original = agentContextPrompt(bootstrap, [user]);
    const marker = messageItem("developer", "<turn_aborted>");
    const nextUser = messageItem("user", "Change direction");
    const current = agentContextPrompt(bootstrap, [user, marker, nextUser]);
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `interrupt-steer-${crypto.randomUUID()}`,
      requestId: "request-interrupt-steer",
      ...current,
      incrementalPrompt: `${marker.prompt}\n${nextUser.prompt}`,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersedingTurnAborted: true,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey,
      original.agentContext
    );
    pending.model = input.model;
    pending.transcriptItemHashes.push(transcriptHash(messageItem("assistant", "partial").value));
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-interrupted",
      toolCall: { type: "exec", args: { command: "old command" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    input.supersededToolCallIds = [event.toolCalls[0].callId];
    const oldRun = {
      id: "run-interrupted",
      async *stream() {
        settledResult = await result;
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn().mockResolvedValue(undefined)
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ status: "finished" });

      expect(settledResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining(ABORTED_TOOL_RESULT_MESSAGE) }]
      });
      expect(settledResult.content[0].text).toContain(
        `<user_interjection>\nINPUT:\n${input.incrementalPrompt}\n</user_interjection>`
      );
      expect(oldRun.cancel).not.toHaveBeenCalled();
      expect(agent.send).not.toHaveBeenCalled();
      expect(agent.close).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
    } finally {
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("accepts successive shape-A steers and annotates each actual batch once", async () => {
    const oldUsage = {
      inputTokens: 11,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: 13,
      reasoningTokens: 1
    };
    const agent = {
      agentId: "agent-drain-tool",
      close: vi.fn(),
      send: vi.fn()
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `drain-tool-${crypto.randomUUID()}`,
      requestId: "request-drain-tool",
      prompt: "full transcript",
      incrementalPrompt: "New user turn",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    const firstResult = parkPendingToolCall(pending, {
      callId: "sdk-call-first",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const firstEvent = await waitForPendingAgentEvent(pending);
    input.supersededToolCallIds = [firstEvent.toolCalls[0].callId];
    input.resumeToolResults = [{ callId: firstEvent.toolCalls[0].callId, output: "aborted" }];
    let settledFirst;
    let settledSecond;
    const oldRun = {
      id: "run-initial",
      async *stream() {
        settledFirst = await firstResult;
        const secondResult = parkPendingToolCall(pending, {
          callId: "sdk-call-second",
          toolCall: { type: "read", args: { path: "TODO.md" } }
        });
        settledSecond = await secondResult;
        yield { type: "usage", usage: oldUsage };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Steered terminal" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    const secondBatch = await runLocalAgentBody(input);

    expect(secondBatch).toMatchObject({
      status: "tool_call",
      toolCalls: [{ name: "read", arguments: { path: "TODO.md" } }]
    });
    expect(secondBatch.text).toBe("");
    expect(agent.send).not.toHaveBeenCalled();

    const finalOutput = await runLocalAgentBody({
      ...input,
      requestId: "request-newer-turn",
      incrementalPrompt: "A newer user turn",
      resumeToolResults: [],
      supersedePendingRun: true,
      supersededToolCallIds: [secondBatch.toolCalls[0].callId]
    });
    expect(agent.send).not.toHaveBeenCalled();
    expect(settledFirst).toContain("<user_interjection>\nNew user turn\n</user_interjection>");
    expect(settledSecond).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining(
        "<user_interjection>\nA newer user turn\n</user_interjection>"
      ) }]
    });
    expect(`${settledFirst}\n${settledSecond.content[0].text}`.match(/<user_interjection>/g)).toHaveLength(2);
    expect(finalOutput).toMatchObject({ text: "Steered terminal", usage: oldUsage });
  });

  it("annotates the actual synthetic batch when a shape-A steer names a stale batch", async () => {
    let settledCurrentResult;
    const agent = {
      agentId: "agent-mismatch",
      close: vi.fn(),
      send: vi.fn(async () => ({
        id: "run-follow-up",
        async *stream() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "Follow-up complete" }] } };
        },
        wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
        cancel: vi.fn()
      }))
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `mismatch-${crypto.randomUUID()}`,
      requestId: "request-mismatch",
      prompt: "full transcript",
      incrementalPrompt: "New user turn",
      clientTools: [],
      resumeToolResults: [{ callId: "call-from-another-run", output: "stale output" }],
      supersedePendingRun: true,
      supersededToolCallIds: ["call-from-another-run"],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-current",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    await waitForPendingAgentEvent(pending);
    const oldRun = {
      id: "run-initial",
      async *stream() {
        settledCurrentResult = await result;
        yield { type: "assistant", message: { content: [{ type: "text", text: "Old turn complete" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({
        text: "Old turn complete",
        status: "finished"
      });
      expect(settledCurrentResult).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining(ABORTED_TOOL_RESULT_MESSAGE) }]
      });
      expect(settledCurrentResult.content[0].text).toContain(
        "<user_interjection>\nNew user turn\n</user_interjection>"
      );
      expect(settledCurrentResult).not.toEqual("stale output");
      expect(agent.send).not.toHaveBeenCalled();
      const recovery = warn.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .find((record) => record?.event === "sdk_superseding_turn_recovered_mismatched_pending");
      expect(recovery).toMatchObject({
        declaredCallIds: ["call-from-another-run"],
        suppliedResultCallIds: ["call-from-another-run"]
      });
      expect(recovery.pendingCallIds).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects an empty declared superseding batch without settling the current batch", async () => {
    const agent = {
      agentId: "agent-empty-declared",
      close: vi.fn(),
      send: vi.fn()
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `empty-declared-${crypto.randomUUID()}`,
      requestId: "request-empty-declared",
      prompt: "full transcript",
      incrementalPrompt: "New user turn",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-current",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const resultHandled = result.catch(() => undefined);
    await waitForPendingAgentEvent(pending);

    let observedError;
    try {
      await runLocalAgentBody(input);
    } catch (error) {
      observedError = error;
    }
    try {
      expect(observedError).toMatchObject({
        status: 409,
        code: "cursor_sdk_superseding_turn_mismatch"
      });
      expect(agent.send).not.toHaveBeenCalled();
      expect(pending.emitted.size).toBe(1);
    } finally {
      const cleanup = new Error("test cleanup");
      await failPendingAgentRun(pending, cleanup);
      await resultHandled;
    }
  });

  it("delivers queued shape-A turns with one merged send when the run ends before a barrier", async () => {
    const agent = {
      agentId: "agent-no-emitted",
      close: vi.fn(),
      send: vi.fn(async () => ({
        id: "run-follow-up",
        async *stream() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "Follow-up complete" }] } };
        },
        wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
        cancel: vi.fn()
      }))
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `no-emitted-${crypto.randomUUID()}`,
      requestId: "request-no-emitted",
      prompt: "full transcript",
      incrementalPrompt: "New user turn",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersededToolCallIds: ["call-stale"],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    pending.model = input.model;
    const oldRun = {
      id: "run-initial",
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "Old terminal" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    await expect(runLocalAgentBody(input)).resolves.toMatchObject({
      text: "Follow-up complete",
      status: "finished"
    });
    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent.send).toHaveBeenCalledWith(
      "New user turn",
      expect.objectContaining({ idempotencyKey: input.requestId })
    );
    expect(oldRun.cancel).not.toHaveBeenCalled();
  });

  it("installs a terminal fallback run before admitting another send", async () => {
    const firstInput = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `terminal-handoff-${crypto.randomUUID()}`,
      requestId: "request-first-terminal-steer",
      prompt: "full transcript",
      incrementalPrompt: "USER: First steer",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersedingTurnAborted: false,
      supersededToolCallIds: ["call-stale"],
      fullReplay: false
    };
    const secondInput = {
      ...firstInput,
      requestId: "request-second-terminal-steer",
      incrementalPrompt: "USER: Second steer"
    };
    let releaseOldRun;
    const oldRunGate = new Promise((resolve) => {
      releaseOldRun = resolve;
    });
    let releaseFirstSend;
    const firstSendGate = new Promise((resolve) => {
      releaseFirstSend = resolve;
    });
    let markFirstSendStarted;
    const firstSendStarted = new Promise((resolve) => {
      markFirstSendStarted = resolve;
    });
    let sendCount = 0;
    const finishedRun = (id, text) => ({
      id,
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    });
    const agent = {
      agentId: "agent-terminal-handoff",
      close: vi.fn(),
      send: vi.fn(async () => {
        sendCount += 1;
        if (sendCount === 1) {
          markFirstSendStarted();
          await firstSendGate;
          return finishedRun("run-first-follow-up", "First follow-up complete");
        }
        return finishedRun("run-second-follow-up", "Second follow-up complete");
      })
    };
    const pending = createPendingAgentRun(
      agentCacheKey(firstInput),
      { agent },
      "request-initial",
      firstInput.sessionKey
    );
    pending.model = firstInput.model;
    const oldRun = {
      id: "run-initial",
      async *stream() {
        await oldRunGate;
        yield { type: "assistant", message: { content: [{ type: "text", text: "Old terminal" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    const requestSignal = new AbortController().signal;
    let admitConcurrentRequest = false;
    let second;
    const signal = {
      get aborted() { return requestSignal.aborted; },
      get reason() { return requestSignal.reason; },
      addEventListener: (...args) => requestSignal.addEventListener(...args),
      removeEventListener: (...args) => requestSignal.removeEventListener(...args),
      throwIfAborted() {
        requestSignal.throwIfAborted();
        if (!admitConcurrentRequest) return;
        admitConcurrentRequest = false;
        second = runLocalAgentBody(secondInput);
      }
    };
    const first = runLocalAgentBody(firstInput, undefined, signal);
    const firstOutcome = first.catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    admitConcurrentRequest = true;
    releaseOldRun();
    await firstSendStarted;
    await new Promise((resolve) => setImmediate(resolve));

    expect(second).toBeDefined();
    expect(agent.send).toHaveBeenCalledOnce();
    releaseFirstSend();

    await expect(firstOutcome).resolves.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    await expect(second).resolves.toMatchObject({
      text: "Second follow-up complete",
      status: "finished"
    });
    expect(agent.send).toHaveBeenCalledTimes(2);
    expect(agent.send.mock.calls.map(([prompt]) => prompt)).toEqual([
      "USER: First steer",
      "USER: Second steer"
    ]);
  });

  it("holds ordered inbox turns without a subscriber and deduplicates a content retry", async () => {
    let releaseOldRun;
    const oldRunGate = new Promise((resolve) => {
      releaseOldRun = resolve;
    });
    const agent = {
      agentId: "agent-held-inbox",
      close: vi.fn(),
      send: vi.fn(async () => ({
        id: "run-held-follow-up",
        async *stream() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "Merged follow-up" }] } };
        },
        wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
        cancel: vi.fn()
      }))
    };
    const baseInput = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `held-inbox-${crypto.randomUUID()}`,
      requestId: "request-first-steer",
      prompt: "full transcript",
      incrementalPrompt: "USER: First steer",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersedingTurnAborted: false,
      supersededToolCallIds: ["call-stale"],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(baseInput),
      { agent },
      "request-initial",
      baseInput.sessionKey
    );
    pending.model = baseInput.model;
    const oldRun = {
      id: "run-held-old",
      async *stream() {
        await oldRunGate;
        yield { type: "assistant", message: { content: [{ type: "text", text: "Old terminal" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);

    const first = runLocalAgentBody(baseInput);
    await new Promise((resolve) => setImmediate(resolve));
    const secondInput = {
      ...baseInput,
      requestId: "request-second-steer",
      incrementalPrompt: "USER: Second steer"
    };
    const second = runLocalAgentBody(secondInput);
    await expect(first).rejects.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    await new Promise((resolve) => setImmediate(resolve));
    const detacher = attachPendingAgentSubscriber(pending, { requestId: "detacher" });
    detachPendingAgentSubscriber(detacher);
    releaseOldRun();
    await expect(second).rejects.toMatchObject({ code: "cursor_sdk_subscriber_replaced" });
    await pending.completionPromise;

    await expect(runLocalAgentBody({
      ...secondInput,
      requestId: "request-second-steer-retry"
    })).resolves.toMatchObject({ text: "Merged follow-up" });

    expect(agent.send).toHaveBeenCalledOnce();
    expect(agent.send).toHaveBeenCalledWith(
      "USER: First steer\n\nUSER: Second steer",
      expect.objectContaining({ idempotencyKey: "request-second-steer-retry" })
    );
    expect(oldRun.cancel).not.toHaveBeenCalled();
  });

  it.each([
    [
      "duplicate declared tool calls",
      (callId) => [callId, callId],
      (callId) => [{ callId, output: "aborted" }],
      "cursor_sdk_superseding_turn_mismatch"
    ],
    [
      "a supplied result for an unknown tool call",
      (callId) => [callId],
      () => [{ callId: "call-from-another-run", output: "wrong result" }],
      "cursor_sdk_tool_result_batch_mismatch"
    ],
    [
      "duplicate supplied tool results",
      (callId) => [callId],
      (callId) => [
        { callId, output: "first result" },
        { callId, output: "second result" }
      ],
      "cursor_sdk_tool_result_batch_mismatch"
    ]
  ])("rejects %s", async (_name, declaredCallIds, suppliedResults, expectedCode) => {
    const agent = {
      agentId: "agent-extra-call",
      close: vi.fn(),
      send: vi.fn(async () => ({
        id: "run-follow-up",
        async *stream() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "unexpected" }] } };
        },
        wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
        cancel: vi.fn()
      }))
    };
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: `extra-call-${crypto.randomUUID()}`,
      requestId: "request-extra-call",
      prompt: "full transcript",
      incrementalPrompt: "New user turn",
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: true,
      supersededToolCallIds: [],
      fullReplay: false
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent },
      "request-initial",
      input.sessionKey
    );
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-current",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    const currentCallId = event.toolCalls[0].callId;
    input.supersededToolCallIds = declaredCallIds(currentCallId);
    input.resumeToolResults = suppliedResults(currentCallId);
    const oldRun = {
      id: "run-initial",
      async *stream() {
        await result;
        yield { type: "assistant", message: { content: [{ type: "text", text: "old" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
      cancel: vi.fn()
    };
    await attachPendingAgentRun(pending, oldRun);
    pending.completionPromise = consumePendingAgentRun(pending, oldRun);
    pending.completionPromise.catch(() => undefined);

    await expect(runLocalAgentBody(input)).rejects.toMatchObject({
      status: 409,
      code: expectedCode
    });
    expect(agent.send).not.toHaveBeenCalled();

    const cleanup = new Error("test cleanup");
    await failPendingAgentRun(pending, cleanup);
    await expect(result).rejects.toBe(cleanup);
  });

  it("rejects tool results when their pending SDK run no longer exists", () => {
    expect(() => requirePendingAgentRunForToolResults(undefined, [
      { callId: "call-missing", output: "done" }
    ])).toThrowError(expect.objectContaining({
      status: 409,
      code: "cursor_sdk_tool_result_unmatched"
    }));
    expect(() => requirePendingAgentRunForToolResults(undefined, [])).not.toThrow();
  });

  it("routes resumed SDK text events to the current request sink", async () => {
    let releaseResume;
    const resume = new Promise((resolve) => {
      releaseResume = resolve;
    });
    let markInitialTextReceived;
    const initialTextReceived = new Promise((resolve) => {
      markInitialTextReceived = resolve;
    });
    const run = {
      id: "run-stream-resume",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "before tool" }] }
        };
        markInitialTextReceived();
        await resume;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "after tool 1" }] }
        };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "after tool 2" }] }
        };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" })
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-initial",
      "session-test"
    );
    const initialSink = vi.fn();
    const resumedSink = vi.fn();
    const initialSubscriber = attachPendingAgentSubscriber(pending, { eventSink: initialSink });

    const completion = consumePendingAgentRun(pending, run);
    await initialTextReceived;
    const resumedSubscriber = attachPendingAgentSubscriber(pending, { eventSink: resumedSink });
    releaseResume();
    await completion;

    expect(initialSink).toHaveBeenCalledTimes(1);
    expect(initialSink).toHaveBeenCalledWith(expect.objectContaining({ type: "text", text: "before tool" }));
    expect(resumedSink.mock.calls).toEqual([
      [expect.objectContaining({ type: "text", text: "after tool 1" })],
      [expect.objectContaining({ type: "text", text: "after tool 2" })]
    ]);
    detachPendingAgentSubscriber(initialSubscriber);
    detachPendingAgentSubscriber(resumedSubscriber);
    await waitForPendingAgentEvent(pending);
  });

  it("emits one reasoning item boundary per SDK thinking segment", async () => {
    const run = {
      id: "run-reasoning-segments",
      async *stream() {
        yield { type: "thinking", text: "Inspecting " };
        yield { type: "thinking", text: "the code" };
        yield { type: "thinking", text: "", thinking_duration_ms: 120 };
        yield { type: "assistant", message: { content: [{ type: "text", text: "First answer." }] } };
        yield { type: "thinking", text: "Checking again" };
        yield { type: "assistant", message: { content: [{ type: "text", text: " Final answer." }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" })
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-reasoning-segments" } },
      "request-reasoning-segments",
      "session-reasoning-segments"
    );
    pending.emitReasoning = true;
    const eventSink = vi.fn();
    const subscriber = attachPendingAgentSubscriber(pending, { eventSink });

    await consumePendingAgentRun(pending, run);

    expect(eventSink.mock.calls).toEqual([
      [{ type: "reasoning", text: "Inspecting ", done: false }],
      [{ type: "reasoning", text: "the code", done: false }],
      [{ type: "reasoning", text: "", done: true, thinkingDurationMs: 120 }],
      [expect.objectContaining({ type: "text", text: "First answer." })],
      [{ type: "reasoning", text: "Checking again", done: false }],
      [{ type: "reasoning", text: "", done: true }],
      [expect.objectContaining({ type: "text", text: " Final answer." })]
    ]);
    detachPendingAgentSubscriber(subscriber);
  });

  it("does not expose SDK thinking when reasoning projection is disabled", async () => {
    const run = {
      id: "run-reasoning-disabled",
      async *stream() {
        yield { type: "thinking", text: "Private trace" };
        yield { type: "thinking", text: "", thinking_duration_ms: 20 };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Answer" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" })
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-reasoning-disabled" } },
      "request-reasoning-disabled",
      "session-reasoning-disabled"
    );
    const eventSink = vi.fn();
    const subscriber = attachPendingAgentSubscriber(pending, { eventSink });

    await consumePendingAgentRun(pending, run);

    expect(eventSink).toHaveBeenCalledOnce();
    expect(eventSink).toHaveBeenCalledWith(expect.objectContaining({ type: "text", text: "Answer" }));
    detachPendingAgentSubscriber(subscriber);
  });

  it("treats every SDK stream event as request progress", async () => {
    const progressSink = vi.fn();
    const run = {
      id: "run-progress",
      async *stream() {
        yield { type: "thinking", text: "working" };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "still working" }] }
        };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "done" })
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-progress" } },
      "request-progress",
      "session-progress"
    );
    const subscriber = attachPendingAgentSubscriber(pending, { progressSink });

    await consumePendingAgentRun(pending, run);

    expect(progressSink).toHaveBeenCalledTimes(2);
    detachPendingAgentSubscriber(subscriber);
  });

  it("fails closed when the SDK emits an unknown semantic event", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const eventSink = vi.fn();
    const run = {
      id: "run-semantic-unknown",
      async *stream() {
        yield {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "must not escape" },
              { type: "future_semantic_block", value: "unknown" }
            ]
          }
        };
      },
      wait: vi.fn(),
      cancel
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-semantic-unknown", close: vi.fn() } },
      "request-semantic-unknown",
      "session-semantic-unknown"
    );
    pending.run = run;
    attachPendingAgentSubscriber(pending, { eventSink });

    await expect(consumePendingAgentRun(pending, run)).rejects.toMatchObject({
      status: 502,
      code: "sdk_semantic_unknown"
    });

    expect(eventSink).not.toHaveBeenCalled();
    expect(run.wait).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when terminal SDK status disagrees with Run.wait", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const run = {
      id: "run-terminal-mismatch",
      async *stream() {
        yield { type: "status", status: "FINISHED" };
      },
      wait: vi.fn().mockResolvedValue({ status: "cancelled", result: "" }),
      cancel
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-terminal-mismatch", close: vi.fn() } },
      "request-terminal-mismatch",
      "session-terminal-mismatch"
    );
    pending.run = run;

    await expect(consumePendingAgentRun(pending, run)).rejects.toMatchObject({
      status: 502,
      code: "sdk_semantic_unknown"
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Run.wait returns malformed usage", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const run = {
      id: "run-invalid-result-usage",
      async *stream() {},
      wait: vi.fn().mockResolvedValue({
        status: "finished",
        result: "done",
        usage: { inputTokens: 1 }
      }),
      cancel
    };
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-invalid-result-usage", close: vi.fn() } },
      "request-invalid-result-usage",
      "session-invalid-result-usage"
    );
    pending.run = run;

    await expect(consumePendingAgentRun(pending, run)).rejects.toMatchObject({
      status: 502,
      code: "sdk_semantic_unknown"
    });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("coalesces the interleaved tool-call timing observed from the live SDK", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 500;
      pending.toolBatchGraceMs = 1000;
      const results = [];

      const park = (index) => {
        const callId = `sdk-call-${index}`;
        recordPendingToolCallStatus(pending, callId, "running");
        results.push(parkPendingToolCall(pending, {
          callId,
          toolCall: { type: "read", args: { path: `file-${index}.txt` } }
        }));
      };

      park(1);
      await vi.advanceTimersByTimeAsync(2);
      park(2);
      await vi.advanceTimersByTimeAsync(91);
      park(3);
      await vi.advanceTimersByTimeAsync(765);
      park(4);
      park(5);

      expect(pending.readyBatch).toBeNull();
      const eventPromise = waitForPendingAgentEvent(pending);
      await vi.advanceTimersByTimeAsync(999);
      expect(pending.readyBatch).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      const event = await eventPromise;
      expect(event.toolCalls).toHaveLength(5);
      resolvePendingToolResults(pending, event.toolCalls.map((toolCall, index) => ({
        callId: toolCall.callId,
        output: `result-${index + 1}`
      })));
      await expect(Promise.all(results)).resolves.toEqual([
        "result-1",
        "result-2",
        "result-3",
        "result-4",
        "result-5"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a single SDK callback after the discovery window", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 500;
      pending.toolBatchGraceMs = 1000;
      recordPendingToolCallStatus(pending, "sdk-call-1", "running");
      const result = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });
      const eventPromise = waitForPendingAgentEvent(pending);

      await vi.advanceTimersByTimeAsync(499);
      expect(pending.readyBatch).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      const event = await eventPromise;
      expect(event.toolCalls).toHaveLength(1);
      resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
      await expect(result).resolves.toBe("readme");
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches to the multi-call quiet window when a second callback arrives", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 500;
      pending.toolBatchGraceMs = 1000;
      const results = [];
      const park = (index) => {
        const callId = `sdk-call-${index}`;
        recordPendingToolCallStatus(pending, callId, "running");
        results.push(parkPendingToolCall(pending, {
          callId,
          toolCall: { type: "read", args: { path: `file-${index}.txt` } }
        }));
      };

      park(1);
      await vi.advanceTimersByTimeAsync(365);
      park(2);
      const eventPromise = waitForPendingAgentEvent(pending);
      await vi.advanceTimersByTimeAsync(999);
      expect(pending.readyBatch).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      const event = await eventPromise;
      expect(event.toolCalls).toHaveLength(2);
      resolvePendingToolResults(pending, event.toolCalls.map((toolCall) => ({
        callId: toolCall.callId,
        output: toolCall.name
      })));
      await expect(Promise.all(results)).resolves.toEqual(["read", "read"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("emits all expected concurrent SDK callbacks as one batch (trace failure: %s)", async (traceFailure) => {
    const info = vi.spyOn(console, "info").mockImplementation((message) => {
      const record = JSON.parse(message);
      if (traceFailure && record.event === "trajectory_output_content_chunk" && record.outputType === "commentary") {
        throw new Error("injected commentary trace write failure");
      }
    });
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.segmentText = "I will inspect both files.";
      pending.expected.add("sdk-call-1");
      pending.expected.add("sdk-call-2");

      const firstResult = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });
      const secondResult = parkPendingToolCall(pending, {
        callId: "sdk-call-2",
        toolCall: { type: "read", args: { path: "package.json" } }
      });
      expect(pending.batchTimer).not.toBeNull();
      expect(pending.readyBatch).toBeNull();

      const event = await waitForPendingAgentEvent(pending);
      expect(event).toMatchObject({
        text: "I will inspect both files.",
        outputType: "commentary",
        toolCalls: [
          { name: "read", arguments: { path: "README.md" } },
          { name: "read", arguments: { path: "package.json" } }
        ]
      });
      if (traceFailure) {
        expect(event.outputID).toBeUndefined();
        expect(jsonLogRecords(info, "trajectory_observation_error")).toContainEqual(expect.objectContaining({
          scope: "output_recording",
          errorCode: "trace_output_record_failed"
        }));
      } else {
        expect(event.outputID).toMatch(/^output_[a-f0-9]{32}$/);
      }
      const firstCallId = event.toolCalls[0].callId;
      const secondCallId = event.toolCalls[1].callId;
      expect(firstCallId).toMatch(/^call_sdk_[a-f0-9]{32}_read$/);
      expect(firstCallId.length).toBeLessThanOrEqual(64);
      expect(secondCallId).not.toBe(firstCallId);
      resolvePendingToolResults(pending, [
        { callId: secondCallId, output: "package" },
        { callId: firstCallId, output: "readme" }
      ]);
      await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(["readme", "package"]);
    } finally {
      info.mockRestore();
    }
  });

  it("replaces the active subscriber and re-delivers its unacknowledged tool batch", async () => {
    const cancel = vi.fn();
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    pending.run = { id: "run-subscriber-replacement", cancel };
    pending.expected.add("sdk-call-1");
    const firstWaiter = waitForPendingAgentEvent(pending);
    const firstOutcome = firstWaiter.catch((error) => error);
    const replacementWaiter = waitForPendingAgentEvent(pending);

    await expect(firstOutcome).resolves.toMatchObject({
      status: 499,
      code: "cursor_sdk_subscriber_replaced"
    });

    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    expect(pending.batchTimer).not.toBeNull();
    const event = await replacementWaiter;
    expect(event).toMatchObject({
      toolCalls: [{ name: "read" }]
    });
    await expect(waitForPendingAgentEvent(pending)).resolves.toEqual(event);
    expect(cancel).not.toHaveBeenCalled();
    resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
    await expect(result).resolves.toBe("readme");
  });

  it("re-delivers terminal output until the subscriber acknowledges it", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-terminal-redelivery" } },
      "request-terminal-redelivery",
      "session-terminal-redelivery"
    );
    const run = {
      id: "run-terminal-redelivery",
      async *stream() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "terminal answer" }] } };
      },
      wait: vi.fn().mockResolvedValue({ status: "finished", result: "" })
    };
    await attachPendingAgentRun(pending, run);
    await consumePendingAgentRun(pending, run);

    const first = await waitForPendingAgentEvent(pending);
    const reconnected = await waitForPendingAgentEvent(pending);

    expect(reconnected).toEqual(first);
    expect(acknowledgePendingAgentOutput(reconnected)).toBe(true);
    expect(acknowledgePendingAgentOutput(first)).toBe(false);
  });

  it("keeps anonymous parked callbacks distinct", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    pending.toolBatchGraceMs = 0;
    const firstResult = parkPendingToolCall(pending, {
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const secondResult = parkPendingToolCall(pending, {
      toolCall: { type: "read", args: { path: "package.json" } }
    });

    expect(pending.parked).toHaveLength(2);
    await waitForPendingAgentEvent(pending);
    resolvePendingToolResults(pending, [{ output: "readme" }]);
    await waitForPendingAgentEvent(pending);
    resolvePendingToolResults(pending, [{ output: "package" }]);
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(["readme", "package"]);
  });

  it("rejects result batches that do not match the emitted callback count", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    expect(() => resolvePendingToolResults(pending, [{ output: "early" }])).toThrowError(
      expect.objectContaining({ code: "cursor_sdk_tool_result_unmatched" })
    );

    pending.expected.add("sdk-call-1");
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    expect(() => resolvePendingToolResults(pending, [
      { output: "first" },
      { output: "extra" }
    ])).toThrowError(expect.objectContaining({ code: "cursor_sdk_tool_result_batch_mismatch" }));

    resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
    await expect(result).resolves.toBe("readme");
  });

  it("routes an emitted result batch by external call ID instead of result order", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    const firstResult = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const secondResult = parkPendingToolCall(pending, {
      callId: "sdk-call-2",
      toolCall: { type: "read", args: { path: "package.json" } }
    });
    const entries = [...pending.parked.entries()];
    pending.emitted = new Set(entries.map(([key]) => key));

    expect(() => resolvePendingToolResults(pending, [
      { callId: entries[0][1].externalCallId, output: "readme" }
    ])).toThrowError(expect.objectContaining({ code: "cursor_sdk_tool_result_batch_mismatch" }));
    expect(pending.emitted).toHaveLength(2);
    expect(pending.parked).toHaveLength(2);

    resolvePendingToolResults(pending, [
      { callId: entries[1][1].externalCallId, output: "package" },
      { callId: entries[0][1].externalCallId, output: "readme" }
    ]);

    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(["readme", "package"]);
  });

  it("ignores unknown and replayed result IDs when the emitted batch is complete", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    pending.expected.add("sdk-call-1");
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    const callId = event.toolCalls[0].callId;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      resolvePendingToolResults(pending, [
        { callId: "call_sdk_ffffffffffffffffffffffffffffffff_unknown", output: "ignored" },
        { callId, output: "readme" },
        { callId, output: "replayed" }
      ]);
      await expect(result).resolves.toBe("readme");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map(([record]) => JSON.parse(record).reason)).toEqual(["unknown", "replayed"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("emits a partial batch after the quiet window and keeps late callbacks for the next batch", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 300;
      pending.toolBatchGraceMs = 300;
      pending.expected.add("sdk-call-1");
      pending.expected.add("sdk-call-2");
      pending.expected.add("sdk-call-3");
      const firstResult = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });
      await vi.advanceTimersByTimeAsync(200);
      const secondResult = parkPendingToolCall(pending, {
        callId: "sdk-call-2",
        toolCall: { type: "read", args: { path: "package.json" } }
      });
      const firstBatchPromise = waitForPendingAgentEvent(pending);

      await vi.advanceTimersByTimeAsync(299);
      expect(pending.emitted).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      const firstBatch = await firstBatchPromise;
      expect(firstBatch.toolCalls).toHaveLength(2);
      resolvePendingToolResults(pending, firstBatch.toolCalls.map((toolCall) => ({
        callId: toolCall.callId,
        output: toolCall.name
      })));
      await expect(Promise.all([firstResult, secondResult])).resolves.toEqual(["read", "read"]);

      const thirdResult = parkPendingToolCall(pending, {
        callId: "sdk-call-3",
        toolCall: { type: "read", args: { path: "TODO.md" } }
      });
      const secondBatchPromise = waitForPendingAgentEvent(pending);
      await vi.advanceTimersByTimeAsync(300);
      const secondBatch = await secondBatchPromise;
      expect(secondBatch.toolCalls).toMatchObject([{ name: "read", arguments: { path: "TODO.md" } }]);
      resolvePendingToolResults(pending, [{ callId: secondBatch.toolCalls[0].callId, output: "todo" }]);
      await expect(thirdResult).resolves.toBe("todo");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces callbacks accumulated across an active batch boundary", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 10;
      pending.toolBatchGraceMs = 10;

      recordPendingToolCallStatus(pending, "sdk-call-1", "running");
      const firstResult = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });
      const firstBatchPromise = waitForPendingAgentEvent(pending);
      await vi.advanceTimersByTimeAsync(10);
      const firstBatch = await firstBatchPromise;
      expect(firstBatch.toolCalls).toHaveLength(1);

      recordPendingToolCallStatus(pending, "sdk-call-2", "running");
      const secondResult = parkPendingToolCall(pending, {
        callId: "sdk-call-2",
        toolCall: { type: "read", args: { path: "package.json" } }
      });

      resolvePendingToolResults(pending, [{
        callId: firstBatch.toolCalls[0].callId,
        output: "readme"
      }]);
      await expect(firstResult).resolves.toBe("readme");
      expect(pending.readyBatch).toBeNull();
      expect(pending.batchTimer).not.toBeNull();

      const secondBatchPromise = waitForPendingAgentEvent(pending);
      await vi.advanceTimersByTimeAsync(5);
      recordPendingToolCallStatus(pending, "sdk-call-3", "running");
      const thirdResult = parkPendingToolCall(pending, {
        callId: "sdk-call-3",
        toolCall: { type: "read", args: { path: "TODO.md" } }
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(pending.readyBatch).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      const secondBatch = await secondBatchPromise;
      expect(secondBatch.toolCalls).toMatchObject([
        { arguments: { path: "package.json" } },
        { arguments: { path: "TODO.md" } }
      ]);
      resolvePendingToolResults(pending, secondBatch.toolCalls.map((toolCall) => ({
        callId: toolCall.callId,
        output: toolCall.name
      })));
      await expect(Promise.all([secondResult, thirdResult])).resolves.toEqual(["read", "read"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not postpone a parked call for duplicate running events", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 30;
      pending.toolBatchGraceMs = 30;

      recordPendingToolCallStatus(pending, "sdk-call-1", "running");
      const result = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });
      const eventPromise = waitForPendingAgentEvent(pending);

      await vi.advanceTimersByTimeAsync(20);
      recordPendingToolCallStatus(pending, "sdk-call-1", "running");
      await vi.advanceTimersByTimeAsync(9);
      expect(pending.readyBatch).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      const event = await eventPromise;
      expect(event.toolCalls).toHaveLength(1);
      resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
      await expect(result).resolves.toBe("readme");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the grace fallback when stream_running never identifies the callback", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 300;
      pending.toolBatchGraceMs = 300;
      const result = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });
      const eventPromise = waitForPendingAgentEvent(pending);

      await vi.advanceTimersByTimeAsync(300);
      const event = await eventPromise;
      expect(event.toolCalls).toMatchObject([{ name: "read" }]);
      resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
      await expect(result).resolves.toBe("readme");
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes the grace-window batch before a late callback can join it", async () => {
    vi.useFakeTimers();
    try {
      const pending = createPendingAgentRun(
        `test-${crypto.randomUUID()}`,
        { agent: { agentId: "agent-test" } },
        "request-test",
        "session-test"
      );
      pending.toolBatchDiscoveryMs = 300;
      pending.toolBatchGraceMs = 300;
      pending.expected.add("sdk-call-1");
      pending.expected.add("sdk-call-2");
      const firstResult = parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      });

      await vi.advanceTimersByTimeAsync(300);
      expect(pending.readyBatch).toHaveLength(1);
      const secondResult = parkPendingToolCall(pending, {
        callId: "sdk-call-2",
        toolCall: { type: "read", args: { path: "package.json" } }
      });
      const firstBatch = await waitForPendingAgentEvent(pending);
      expect(firstBatch.toolCalls).toHaveLength(1);
      resolvePendingToolResults(pending, [{ callId: firstBatch.toolCalls[0].callId, output: "readme" }]);
      await expect(firstResult).resolves.toBe("readme");

      const secondBatchPromise = waitForPendingAgentEvent(pending);
      await vi.advanceTimersByTimeAsync(300);
      const secondBatch = await secondBatchPromise;
      expect(secondBatch.toolCalls).toMatchObject([{ arguments: { path: "package.json" } }]);
      resolvePendingToolResults(pending, [{ callId: secondBatch.toolCalls[0].callId, output: "package" }]);
      await expect(secondResult).resolves.toBe("package");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a settled result for an identical SDK replay and rejects mismatched args", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    recordPendingToolCallStatus(pending, "sdk-call-1", "running");
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
    await expect(result).resolves.toBe("readme");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      recordPendingToolCallStatus(pending, "sdk-call-1", "running");
      expect(pending.expected).toHaveLength(0);
      await expect(parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      })).resolves.toBe("readme");

      await expect(parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "package.json" } }
      })).rejects.toMatchObject({ code: "cursor_sdk_tool_call_duplicate" });
      const duplicates = warn.mock.calls
        .map(([record]) => JSON.parse(record))
        .filter((record) => record.event === "sdk_tool_call_duplicate");
      expect(duplicates).toMatchObject([
        { action: "reuse_settled_result", argsMatch: true },
        { action: "reject_mismatched_duplicate", argsMatch: false }
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("reuses a parked callback when the SDK replays the same call", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    const first = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const replay = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    expect(replay).toBe(first);

    const event = await waitForPendingAgentEvent(pending);
    resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
    await expect(Promise.all([first, replay])).resolves.toEqual(["readme", "readme"]);
  });

  it("reuses every settled result after a split two-plus-one batch", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    recordPendingToolCallStatus(pending, "sdk-call-3", "running");
    const firstResults = [
      parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      }),
      parkPendingToolCall(pending, {
        callId: "sdk-call-2",
        toolCall: { type: "read", args: { path: "package.json" } }
      })
    ];
    const firstBatch = await waitForPendingAgentEvent(pending);
    expect(firstBatch.toolCalls).toHaveLength(2);

    const lateResult = parkPendingToolCall(pending, {
      callId: "sdk-call-3",
      toolCall: { type: "read", args: { path: "TODO.md" } }
    });
    resolvePendingToolResults(pending, firstBatch.toolCalls.map((call, index) => ({
      callId: call.callId,
      output: [`README contents`, `package contents`][index]
    })));
    const secondBatch = await waitForPendingAgentEvent(pending);
    expect(secondBatch.toolCalls).toHaveLength(1);
    resolvePendingToolResults(pending, [{ callId: secondBatch.toolCalls[0].callId, output: "TODO contents" }]);
    await expect(Promise.all([...firstResults, lateResult])).resolves.toEqual([
      "README contents",
      "package contents",
      "TODO contents"
    ]);

    const replays = [
      parkPendingToolCall(pending, {
        callId: "sdk-call-1",
        toolCall: { type: "read", args: { path: "README.md" } }
      }),
      parkPendingToolCall(pending, {
        callId: "sdk-call-2",
        toolCall: { type: "read", args: { path: "package.json" } }
      }),
      parkPendingToolCall(pending, {
        callId: "sdk-call-3",
        toolCall: { type: "read", args: { path: "TODO.md" } }
      })
    ];
    await expect(Promise.all(replays)).resolves.toEqual([
      "README contents",
      "package contents",
      "TODO contents"
    ]);
  });

  it("reuses a settled SDK error result during callback replay", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-error",
      toolCall: { type: "read", args: { path: "missing.txt" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    resolvePendingToolResults(pending, [{
      callId: event.toolCalls[0].callId,
      output: { message: "missing" },
      isError: true
    }]);
    const expected = { content: [{ type: "text", text: '{"message":"missing"}' }], isError: true };
    await expect(result).resolves.toEqual(expected);
    await expect(parkPendingToolCall(pending, {
      callId: "sdk-call-error",
      toolCall: { type: "read", args: { path: "missing.txt" } }
    })).resolves.toEqual(expected);
  });

  it("rejects callback replay after a terminal pending-run error", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test", close: vi.fn() } },
      "request-test",
      "session-test"
    );
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-terminal",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    resolvePendingToolResults(pending, [{ callId: event.toolCalls[0].callId, output: "readme" }]);
    await expect(result).resolves.toBe("readme");

    const terminalError = new Error("run failed");
    await failPendingAgentRun(pending, terminalError);
    await expect(parkPendingToolCall(pending, {
      callId: "sdk-call-terminal",
      toolCall: { type: "read", args: { path: "README.md" } }
    })).rejects.toBe(terminalError);
  });

  it("reuses a supersede synthetic abort result during callback replay", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test" } },
      "request-test",
      "session-test"
    );
    const result = parkPendingToolCall(pending, {
      callId: "sdk-call-aborted",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const event = await waitForPendingAgentEvent(pending);
    const abort = {
      callId: event.toolCalls[0].callId,
      output: ABORTED_TOOL_RESULT_MESSAGE,
      isError: true
    };
    resolvePendingToolResults(pending, [abort]);
    const expected = {
      content: [{ type: "text", text: ABORTED_TOOL_RESULT_MESSAGE }],
      isError: true
    };
    await expect(result).resolves.toEqual(expected);
    await expect(parkPendingToolCall(pending, {
      callId: "sdk-call-aborted",
      toolCall: { type: "read", args: { path: "README.md" } }
    })).resolves.toEqual(expected);
  });

  it("rejects every parked callback when the SDK run fails", async () => {
    const pending = createPendingAgentRun(
      `test-${crypto.randomUUID()}`,
      { agent: { agentId: "agent-test", close() {} } },
      "request-test",
      "session-test"
    );
    const firstResult = parkPendingToolCall(pending, {
      callId: "sdk-call-1",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const secondResult = parkPendingToolCall(pending, {
      callId: "sdk-call-2",
      toolCall: { type: "read", args: { path: "package.json" } }
    });
    const settled = Promise.allSettled([firstResult, secondResult]);
    const failure = new Error("run failed");
    pending.carriedUsage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2
    };

    expect(pending.batchTimer).not.toBeNull();

    failPendingAgentRun(pending, failure);

    await expect(settled).resolves.toEqual([
      expect.objectContaining({ status: "rejected", reason: failure }),
      expect.objectContaining({ status: "rejected", reason: failure })
    ]);
    expect(pending.parked).toHaveLength(0);
    expect(pending.emitted).toHaveLength(0);
    expect(pending.batchTimer).toBeNull();
    expect(pending.carriedUsage).toBeNull();
    await expect(waitForPendingAgentEvent(pending)).rejects.toBe(failure);
  });

  it("keeps a replacement pending run active after the previous run fails late", async () => {
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: "replacement-session",
      clientTools: [{
        name: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }]
    };
    const cacheKey = agentCacheKey(input);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const closePrevious = vi.fn();
    const previous = createPendingAgentRun(
      cacheKey,
      { agent: { agentId: "agent-previous", close: closePrevious } },
      "request-previous",
      input.sessionKey
    );
    previous.run = { id: "run-previous", cancel };
    const previousSendOptions = localAgentSendOptions(input, { pending: previous });
    const parkedResult = parkPendingToolCall(previous, {
      callId: "sdk-call-previous",
      toolCall: { type: "read", args: { path: "README.md" } }
    });
    const replacementError = new Error("run replaced by full transcript replay");
    void parkedResult.catch(() => undefined);

    await failPendingAgentRun(previous, replacementError, { cancelRun: true });

    await expect(parkedResult).rejects.toBe(replacementError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(closePrevious).toHaveBeenCalledOnce();

    const replacement = createPendingAgentRun(
      cacheKey,
      { agent: { agentId: "agent-replacement", close: vi.fn() } },
      "request-replacement",
      input.sessionKey
    );
    failPendingAgentRun(previous, new Error("late failure from previous run"));

    await expect(previousSendOptions.local.customTools.read.execute(
      { path: "STALE.md" },
      { toolCallId: "sdk-call-stale" }
    )).rejects.toThrow("No pending outer client session");
    expect(replacement.parked).toHaveLength(0);

    const sendOptions = localAgentSendOptions(input, { pending: replacement });
    const replacementResult = sendOptions.local.customTools.read.execute(
      { path: "TOOLS.md" },
      { toolCallId: "sdk-call-replacement" }
    );
    void replacementResult.catch(() => undefined);
    expect(replacement.parked).toHaveLength(1);

    const cleanupError = new Error("test cleanup");
    failPendingAgentRun(replacement, cleanupError);
    await expect(replacementResult).rejects.toBe(cleanupError);
  });

  it("cancels a late SDK run after its pending request was already aborted", async () => {
    const close = vi.fn();
    const pending = createPendingAgentRun(
      agentCacheKey({
        apiKey: "cursor-test-key",
        model: "grok-4.6",
        workingDirectory: "/tmp/project",
        sessionKey: "session-aborted"
      }),
      { agent: { agentId: "agent-aborted", close } },
      "request-aborted",
      "session-aborted"
    );
    const cancellation = new Error("request deadline reached");

    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: "session-aborted",
      requestId: "request-aborted"
    };
    const lifecycle = openAgentRequestLifecycle(input.requestId);
    const unbindAbort = bindPendingAgentRunAbort(pending, lifecycle.signal);
    expect(await cancelAgentRequest(input.requestId, cancellation)).toBe(true);
    expect(await cancelAgentRequest(input.requestId, cancellation)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(close).not.toHaveBeenCalled();

    const cancel = vi.fn().mockResolvedValue(undefined);
    await expect(attachPendingAgentRun(pending, { id: "run-late", cancel })).rejects.toBe(cancellation);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    unbindAbort();
    lifecycle.close();
  });

  it("creates a fresh Agent with the authoritative full prompt after subscriber abort", async () => {
    let releaseCancelledRun;
    const cancelledRunGate = new Promise((resolve) => {
      releaseCancelledRun = resolve;
    });
    const cancel = vi.fn(async () => releaseCancelledRun());
    const agent = {
      agentId: "agent-stop-resume",
      close: vi.fn(),
      send: vi.fn()
        .mockResolvedValueOnce({
          id: "run-before-stop",
          async *stream() {
            yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
            await cancelledRunGate;
          },
          wait: vi.fn().mockResolvedValue({ status: "cancelled", result: "" }),
          cancel
        })
    };
    const replacementAgent = finishedAgent("agent-stop-resume-replacement", "resumed");
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce(replacementAgent);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const controller = new AbortController();
    const sessionKey = `stop-resume-${crypto.randomUUID()}`;
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey,
      requestId: "request-before-stop",
      prompt: "full transcript",
      incrementalPrompt: "full transcript",
      hasIncrementalPrompt: false,
      clientTools: [],
      resumeToolResults: [],
      supersedePendingRun: false,
      supersededToolCallIds: [],
      fullReplay: true
    };
    const cancellation = new Error("client stopped the turn");

    try {
      const stopped = runLocalAgentBody(input, undefined, controller.signal);
      await vi.waitFor(() => expect(agent.send).toHaveBeenCalledOnce());
      controller.abort(cancellation);
      await expect(stopped).rejects.toBe(cancellation);

      await expect(runLocalAgentBody({
        ...input,
        requestId: "request-after-stop",
        prompt: "full transcript with follow-up",
        incrementalPrompt: "USER: Continue from here",
        hasIncrementalPrompt: true,
        fullReplay: false
      })).resolves.toMatchObject({ text: "resumed", status: "finished" });

      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(agent.close).toHaveBeenCalledOnce();
      expect(agent.send).toHaveBeenCalledOnce();
      expect(replacementAgent.send).toHaveBeenCalledWith(
        expect.stringMatching(/^full transcript with follow-up\n\n\[cursor2response recovery\]/),
        expect.objectContaining({ idempotencyKey: "request-after-stop" })
      );
      const selections = info.mock.calls
        .map(([message]) => {
          try { return JSON.parse(message); } catch { return null; }
        })
        .filter((record) => record?.event === "sdk_prompt_selected");
      expect(selections.at(-1)).toMatchObject({
        promptSource: "created-full",
        replayCause: "agent_state_dirty"
      });
    } finally {
      info.mockRestore();
      createAgent.mockRestore();
      agent.close();
      replacementAgent.close();
    }
  });

  it("fails compacted runs and cancels an already attached SDK run once", async () => {
    const close = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const pending = createPendingAgentRun(
      agentCacheKey({
        apiKey: "cursor-test-key",
        model: "grok-4.6",
        workingDirectory: "/tmp/project",
        sessionKey: "session-compact-attached"
      }),
      { agent: { agentId: "agent-compact-attached", close } },
      "request-compact-attached",
      "session-compact-attached"
    );
    pending.model = "grok-4.6";
    await attachPendingAgentRun(pending, { id: "run-compact-attached", cancel });

    await handleCursorSdkDelta(pending, { update: { type: "summary-started" } });
    await handleCursorSdkDelta(pending, { update: { type: "summary", summary: "compacted context" } });
    await handleCursorSdkDelta(pending, { update: { type: "summary-completed" } });
    await handleCursorSdkDelta(pending, { update: { type: "summary-started" } });

    expect(pending.terminalError).toMatchObject({
      status: 413,
      code: "cursor_sdk_context_compacted",
      contextRetrySafe: true
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(waitForPendingAgentEvent(pending)).rejects.toBe(pending.terminalError);
  });

  it("preserves compact failure when summary-started arrives before run attachment", async () => {
    const close = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const pending = createPendingAgentRun(
      agentCacheKey({
        apiKey: "cursor-test-key",
        model: "grok-4.6",
        workingDirectory: "/tmp/project",
        sessionKey: "session-compact-before-attach"
      }),
      { agent: { agentId: "agent-compact-before-attach", close } },
      "request-compact-before-attach",
      "session-compact-before-attach"
    );
    pending.model = "grok-4.6";

    await handleCursorSdkDelta(pending, { update: { type: "summary-started" } });
    const compactError = pending.terminalError;
    await handleCursorSdkDelta(pending, { update: { type: "summary-completed" } });

    await expect(attachPendingAgentRun(pending, {
      id: "run-compact-before-attach",
      cancel
    })).rejects.toBe(compactError);
    expect(compactError).toMatchObject({
      status: 413,
      code: "cursor_sdk_context_compacted",
      contextRetrySafe: false
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "dispose"])("does not authorize context retry when %s fails", async (phase) => {
    const failure = () => Promise.reject(new Error("cleanup failure"));
    const agent = { agentId: `agent-cleanup-${phase}`, close: vi.fn(),
      [Symbol.asyncDispose]: phase === "dispose" ? failure : vi.fn().mockResolvedValue(undefined) };
    const pending = createPendingAgentRun(agentCacheKey({ apiKey: "key", model: "grok-4.6",
      workingDirectory: "/tmp/project", sessionKey: `cleanup-${phase}` }), { agent },
      `request-cleanup-${phase}`, `cleanup-${phase}`);
    pending.model = "grok-4.6";
    await attachPendingAgentRun(pending, { id: `run-cleanup-${phase}`,
      cancel: phase === "cancel" ? failure : vi.fn().mockResolvedValue(undefined) });
    await handleCursorSdkDelta(pending, { update: { type: "summary-started" } });
    await pending.terminalError.contextRecoveryBarrier;
    expect(openAiError(pending.terminalError).error).toMatchObject({ code: "cursor_sdk_context_compacted", contextRetrySafe: false });
  });

  it("passes a per-send SDK delta callback only when one is provided", () => {
    const input = {
      model: "grok-4.6",
      clientTools: []
    };
    const onDelta = vi.fn();

    expect(localAgentSendOptions(input)).not.toHaveProperty("onDelta");
    expect(localAgentSendOptions(input, { onDelta }).onDelta).toBe(onDelta);
  });

  it("refreshes the idle deadline on progress without extending the hard deadline", async () => {
    vi.useFakeTimers();
    const requestId = `request-deadline-${crypto.randomUUID()}`;
    const lifecycle = openAgentRequestLifecycle(requestId, undefined, undefined, {
      idleTimeoutMs: 100,
      maxTimeoutMs: 250
    });
    try {
      await vi.advanceTimersByTimeAsync(90);
      lifecycle.touch();
      await vi.advanceTimersByTimeAsync(90);
      lifecycle.touch();
      await vi.advanceTimersByTimeAsync(69);
      expect(lifecycle.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      expect(lifecycle.signal.aborted).toBe(true);
      expect(lifecycle.signal.reason).toMatchObject({
        status: 504,
        code: "cursor_sdk_timeout"
      });
    } finally {
      lifecycle.close();
      vi.useRealTimers();
    }
  });

  it("aborts a request that produces no SDK progress before the idle deadline", async () => {
    vi.useFakeTimers();
    const requestId = `request-idle-${crypto.randomUUID()}`;
    const lifecycle = openAgentRequestLifecycle(requestId, undefined, undefined, {
      idleTimeoutMs: 100,
      maxTimeoutMs: 250
    });
    try {
      await vi.advanceTimersByTimeAsync(100);

      expect(lifecycle.signal.aborted).toBe(true);
      expect(lifecycle.signal.reason).toMatchObject({
        status: 504,
        code: "cursor_sdk_idle_timeout"
      });
    } finally {
      lifecycle.close();
      vi.useRealTimers();
    }
  });

  it("does not cancel another request that shares the same agent session", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const input = {
      apiKey: "cursor-test-key",
      model: "grok-4.6",
      workingDirectory: "/tmp/project",
      sessionKey: "shared-session",
      requestId: "request-a"
    };
    const pending = createPendingAgentRun(
      agentCacheKey(input),
      { agent: { agentId: "agent-shared", close } },
      input.requestId,
      input.sessionKey
    );
    pending.run = { id: "run-a", cancel };
    const lifecycleA = openAgentRequestLifecycle(input.requestId);
    const unbindAbort = bindPendingAgentRunAbort(pending, lifecycleA.signal);

    expect(await cancelAgentRequest("request-b", new Error("cancel B"))).toBe(false);
    expect(pending.terminalError).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    const lifecycleB = openAgentRequestLifecycle("request-b");
    expect(lifecycleB.signal.aborted).toBe(true);
    lifecycleB.close();

    const cleanupError = new Error("test cleanup");
    await failPendingAgentRun(pending, cleanupError, { cancelRun: true });
    unbindAbort();
    lifecycleA.close();
  });

  it("takes one pending narration segment without clearing the full transcript", () => {
    const pending = {
      segmentText: "Before this tool.",
      fullText: "Earlier. Before this tool."
    };
    expect(takePendingNarration(pending)).toBe("Before this tool.");
    expect(pending.segmentText).toBe("");
    expect(pending.fullText).toBe("Earlier. Before this tool.");
  });

  it("keeps short trace input intact and preserves both ends when truncating", () => {
    expect(truncateTraceText("short", 10)).toBe("short");
    const text = `${"head ".repeat(20)}MIDDLE${" tail".repeat(20)}`;
    const truncated = truncateTraceText(text, 80);
    expect(truncated.length).toBeLessThanOrEqual(80);
    expect(truncated).toContain("trace truncated");
    expect(truncated).toContain("head head");
    expect(truncated).toContain("tail tail");
    expect(truncated).toContain("chars omitted");
  });

  it("chunks complete trace input into journal-safe, hash-addressed records", () => {
    const text = `${"中文和\\\"\n".repeat(2_000)}tail 🧪`;
    const records = traceChunkRecords({
      requestId: "run-trace",
      sessionKey: "session-trace-long",
      reason: "error",
      field: "prompt",
      text
    }, 6 * 1024);

    expect(records.length).toBeGreaterThan(1);
    expect(records.map((record) => record.content).join("")).toBe(text);
    expect(new Set(records.map((record) => record.sha256)).size).toBe(1);
    expect(records.map((record) => record.chunkIndex)).toEqual(records.map((_, index) => index));
    expect(records.every((record) => record.chunkCount === records.length)).toBe(true);
    expect(records.every((record) => record.totalChars === text.length)).toBe(true);
    expect(records.every((record) => Buffer.byteLength(JSON.stringify(record)) < 48 * 1024)).toBe(true);
  });

  it("preserves semantic output identity on chunk records", () => {
    const records = traceChunkRecords({
      event: "sdk_trace_output_chunk",
      requestId: "request-output",
      sessionKey: "session-output-long",
      reason: "final",
      field: "output",
      agentId: "agent-output",
      runId: "run-output",
      text: "final answer"
    });

    expect(records).toEqual([
      expect.objectContaining({
        event: "sdk_trace_output_chunk",
        requestId: "request-output",
        sessionKey: "session-output-long",
        agentId: "agent-output",
        runId: "run-output",
        field: "output",
        content: "final answer"
      })
    ]);
  });

  it("summarizes and chunks complete tool arguments without losing newline distinctions", () => {
    const args = {
      path: "/tmp/example.py",
      content: `line 1\nline 2 with literal \\n\n${"中文\n".repeat(3_000)}`
    };
    const summary = summarizeToolTraceValue(args);
    const records = toolArgsTraceChunkRecords({
      requestId: "run-tool-trace",
      sessionKey: "session-tool-trace-long",
      phase: "custom_callback",
      runId: "cursor-run",
      callId: "call-1",
      toolName: "write",
      summary
    }, 6 * 1024);

    expect(summary.realNewlines).toBe(3_002);
    expect(summary.literalBackslashN).toBe(1);
    expect(records.length).toBeGreaterThan(1);
    expect(records.map((record) => record.content).join("")).toBe(summary.text);
    expect(records.every((record) => record.event === "sdk_trace_tool_args_chunk")).toBe(true);
    expect(records.every((record) => record.phase === "custom_callback")).toBe(true);
    expect(records.every((record) => record.callId === "call-1")).toBe(true);
    expect(records.every((record) => record.sha256 === summary.sha256)).toBe(true);
    expect(records.every((record) => Buffer.byteLength(JSON.stringify(record)) < 48 * 1024)).toBe(true);
  });

  it("uses stable key ordering for tool argument fingerprints", () => {
    const first = summarizeToolTraceValue({ path: "README.md", line: 1 });
    const reordered = summarizeToolTraceValue({ line: 1, path: "README.md" });
    expect(reordered.text).not.toBe(first.text);
    expect(reordered.sha256).toBe(first.sha256);
  });

  it("traces assistant, thinking, and tool input without tool results", () => {
    expect(traceSdkPayload({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I will inspect the repo first." },
          { type: "tool_use", id: "call-1", name: "read", input: { path: "README.md" } }
        ]
      }
    })).toEqual({
      type: "assistant",
      content: [
        { type: "text", text: "I will inspect the repo first." },
        { type: "tool_use", id: "call-1", name: "read", input: { path: "README.md" } }
      ]
    });
    expect(traceSdkPayload({
      type: "thinking",
      text: "planning",
      thinking_duration_ms: 120
    })).toEqual({ type: "thinking", text: "planning", thinkingDurationMs: 120 });
    expect(traceSdkPayload({
      type: "tool_call",
      call_id: "call-1",
      name: "read",
      status: "completed",
      args: { path: "README.md" },
      result: "do not log this"
    })).toEqual({
      type: "tool_call",
      callId: "call-1",
      name: "read",
      status: "completed",
      args: { path: "README.md" }
    });
  });

  it("normalizes every documented SDK message category", () => {
    expect(normalizeSdkEvent({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "answer" },
          { type: "tool_use", id: "call-1", name: "read", input: { path: "README.md" } }
        ]
      }
    })).toEqual([
      { kind: "text", sdkType: "assistant", text: "answer" },
      {
        kind: "diagnostic",
        sdkType: "assistant",
        name: "assistant_tool_use",
        block: { id: "call-1", name: "read", input: { path: "README.md" } }
      }
    ]);
    for (const status of ["running", "completed", "error"]) {
      expect(normalizeSdkEvent({
        type: "tool_call",
        call_id: "call-1",
        name: "mcp",
        status,
        args: { toolName: "read", args: { path: "README.md" } }
      })).toEqual([{
        kind: "tool_call",
        sdkType: "tool_call",
        callId: "call-1",
        sdkName: "mcp",
        toolName: "read",
        status,
        args: { path: "README.md" }
      }]);
    }
    expect(normalizeSdkEvent({
      type: "thinking",
      text: "planning",
      thinking_duration_ms: 120
    })).toEqual([{
      kind: "reasoning",
      sdkType: "thinking",
      text: "planning",
      thinkingDurationMs: 120
    }]);
    expect(normalizeSdkEvent({
      type: "usage",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        totalTokens: 15
      }
    })).toEqual([{
      kind: "usage",
      sdkType: "usage",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        totalTokens: 15
      }
    }]);
    expect(normalizeSdkEvent({ type: "status", status: "RUNNING" })).toEqual([{
      kind: "progress",
      sdkType: "status",
      status: "RUNNING"
    }]);
    expect(normalizeSdkEvent({ type: "status", status: "FINISHED" })).toEqual([{
      kind: "terminal-impacting",
      sdkType: "status",
      status: "FINISHED"
    }]);

    for (const event of [
      { type: "system", subtype: "init" },
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "request", request_id: "request-1" },
      { type: "task", status: "running", text: "task" }
    ]) {
      expect(normalizeSdkEvent(event)).toEqual([expect.objectContaining({
        kind: "diagnostic",
        sdkType: event.type
      })]);
    }
  });

  it("classifies invalid semantic SDK shapes without partial normalization", () => {
    const invalidEvents = [
      { type: "future_event" },
      { type: "assistant", message: { content: [{ type: "future_block" }] } },
      { type: "tool_call", call_id: "call-1", name: "read", status: "paused" },
      {
        type: "usage",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: -1,
          cacheWriteTokens: 0,
          totalTokens: 2
        }
      },
      { type: "status", status: "PAUSED" },
      { type: "thinking", text: "bad duration", thinking_duration_ms: -1 }
    ];

    for (const event of invalidEvents) {
      const normalized = normalizeSdkEvent(event);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toMatchObject({ kind: "semantic-unknown" });
    }
  });

  it("preserves SDK cache usage counters", () => {
    expect(normalizeSdkUsage({
      inputTokens: 12000,
      outputTokens: 80,
      cacheReadTokens: 10000,
      cacheWriteTokens: 1500,
      totalTokens: 12080,
      reasoningTokens: 20
    })).toEqual({
      inputTokens: 12000,
      outputTokens: 80,
      cacheReadTokens: 10000,
      cacheWriteTokens: 1500,
      totalTokens: 12080,
      reasoningTokens: 20
    });
    expect(normalizeSdkUsage({ inputTokens: 1 })).toBeNull();
    expect(normalizeSdkUsage({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      reasoningTokens: -1
    })).toBeNull();
  });

  it("recovers structured client calls from Composer marker text", () => {
    expect(composerToolCallFromText([
      "<|tool_calls_begin|><|tool_call_begin|>",
      "Bash",
      "<|tool_sep|>command",
      'powershell -NoProfile -Command "Get-Location"',
      "<|tool_call_end|><|tool_calls_end|>"
    ].join("\n"))).toEqual({
      type: "Bash",
      args: { command: 'powershell -NoProfile -Command "Get-Location"' }
    });
  });

  it("allows healthy independent Agent acquisitions in one executor group to overlap", async () => {
    const identity = `executor-concurrent-${crypto.randomUUID()}`;
    let releaseFirstAgent;
    const firstAgentGate = new Promise((resolve) => {
      releaseFirstAgent = resolve;
    });
    const firstAgent = finishedAgent("agent-concurrent-first", "first");
    const secondAgent = finishedAgent("agent-concurrent-second", "second");
    const createAgent = vi.spyOn(Agent, "create").mockImplementation(async (options) => {
      if (options.model.id === "model-first") {
        await firstAgentGate;
        return firstAgent;
      }
      if (options.model.id === "model-second") return secondAgent;
      throw new Error(`unexpected Agent.create for ${options.model.id}`);
    });
    const first = runLocalAgentBody(localAgentInput(identity, { model: "model-first" }));

    try {
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
      const second = runLocalAgentBody(localAgentInput(identity, {
        model: "model-second",
        sessionKey: `session-${identity}-second`,
        requestId: `request-${identity}-second`
      }));
      await expect(second).resolves.toMatchObject({ text: "second" });
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(firstAgent.send).not.toHaveBeenCalled();

      releaseFirstAgent();
      await expect(first).resolves.toMatchObject({ text: "first" });
    } finally {
      releaseFirstAgent();
      createAgent.mockRestore();
      firstAgent.close();
      secondAgent.close();
    }
  });

  it("reuses an idle Agent across credential refresh intervals without full replay", async () => {
    const identity = `executor-native-refresh-idle-${crypto.randomUUID()}`;
    let now = 1_800_000_000_000;
    const cachedAgent = {
      ...finishedAgent("agent-native-refresh-idle", "continued"),
      [Symbol.asyncDispose]: vi.fn()
    };
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(cachedAgent);
    const resumeAgent = vi.spyOn(Agent, "resume");
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const input = localAgentInput(identity);

    try {
      await expect(runLocalAgentBody(input)).resolves.toMatchObject({ text: "continued" });
      now += 4 * 60 * 60 * 1000;
      await expect(runLocalAgentBody({
        ...input,
        requestId: `${input.requestId}-follow-up`,
        prompt: "FULL TRANSCRIPT\nUSER: continue",
        incrementalPrompt: "USER: continue",
        hasIncrementalPrompt: true,
        fullReplay: false
      })).resolves.toMatchObject({ text: "continued" });

      expect(createAgent).toHaveBeenCalledOnce();
      expect(resumeAgent).not.toHaveBeenCalled();
      expect(cachedAgent.send).toHaveBeenCalledTimes(2);
      expect(cachedAgent.send).toHaveBeenLastCalledWith("USER: continue", expect.objectContaining({
        idempotencyKey: `${input.requestId}-follow-up`
      }));
      expect(cachedAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      expect(cachedAgent.close).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      dateNow.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      cachedAgent.close();
    }
  });

  it("allows tool continuation and a parallel session across a credential refresh boundary within the lease", async () => {
    const identity = `executor-native-refresh-active-${crypto.randomUUID()}`;
    let now = 1_800_000_000_000;
    let toolResult;
    const activeAgent = {
      agentId: "agent-native-refresh-active",
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
      send: vi.fn(async (_prompt, options) => {
        const result = options.local.customTools.read.execute(
          { path: "README.md" },
          { toolCallId: "sdk-call-native-refresh-active" }
        );
        return {
          id: "run-native-refresh-active",
          async *stream() {
            yield {
              type: "tool_call",
              call_id: "sdk-call-native-refresh-active",
              name: "read",
              status: "running",
              args: { path: "README.md" }
            };
            toolResult = await result;
            yield { type: "assistant", message: { content: [{ type: "text", text: "continued" }] } };
          },
          wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
          cancel: vi.fn()
        };
      })
    };
    const parallelAgent = finishedAgent("agent-native-refresh-parallel", "parallel");
    const createAgent = vi.spyOn(Agent, "create")
      .mockResolvedValueOnce(activeAgent)
      .mockResolvedValueOnce(parallelAgent);
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const activeInput = localAgentInput(identity, {
      model: "model-active",
      clientTools: [{ name: "read", parameters: { type: "object" } }]
    });

    try {
      const toolOutput = await runLocalAgentBody(activeInput);
      now += 63 * 60 * 1000;
      await expect(runLocalAgentBody(localAgentInput(identity, {
        model: "model-parallel",
        sessionKey: `${activeInput.sessionKey}-parallel`,
        requestId: `${activeInput.requestId}-parallel`
      }))).resolves.toMatchObject({ text: "parallel" });

      expect(activeAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      await expect(runLocalAgentBody({
        ...activeInput,
        requestId: `${activeInput.requestId}-result`,
        prompt: "FULL TRANSCRIPT\nTOOL RESULT: contents",
        incrementalPrompt: "TOOL RESULT: contents",
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{
          callId: toolOutput.toolCalls[0].callId,
          output: "contents",
          isError: false
        }]
      })).resolves.toMatchObject({ text: "continued" });

      expect(toolResult).toBe("contents");
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(activeAgent.send).toHaveBeenCalledOnce();
      expect(parallelAgent.send).toHaveBeenCalledOnce();
      expect(activeAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      expect(activeAgent.close).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      dateNow.mockRestore();
      createAgent.mockRestore();
      activeAgent.close();
      parallelAgent.close();
    }
  });

  it("keeps a pending session independent from another session authentication failure and new admission", async () => {
    const identity = `executor-auth-isolation-${crypto.randomUUID()}`;
    let activeToolResult;
    const activeAgent = {
      agentId: "agent-auth-isolation-active",
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(async (_prompt, options) => {
        const result = options.local.customTools.read.execute(
          { path: "README.md" },
          { toolCallId: "sdk-call-auth-isolation-active" }
        );
        return {
          id: "run-auth-isolation-active",
          async *stream() {
            yield {
              type: "tool_call",
              call_id: "sdk-call-auth-isolation-active",
              name: "read",
              status: "running",
              args: { path: "README.md" }
            };
            activeToolResult = await result;
            yield { type: "assistant", message: { content: [{ type: "text", text: "active done" }] } };
          },
          wait: vi.fn().mockResolvedValue({ status: "finished", result: "" }),
          cancel: vi.fn()
        };
      })
    };
    const authAgent = {
      agentId: "agent-auth-isolation-failed",
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(async () => ({
        id: "run-auth-isolation-failed",
        async *stream() {
          yield { type: "status", status: "ERROR" };
        },
        wait: vi.fn().mockResolvedValue({
          status: "error",
          error: { message: "[unknown] Invalid User API Key", code: "cursor_sdk_error" }
        }),
        cancel: vi.fn().mockResolvedValue(undefined)
      }))
    };
    const parallelAgent = finishedAgent("agent-auth-isolation-parallel", "parallel");
    const agentsByModel = new Map([
      ["model-active", activeAgent],
      ["model-auth", authAgent],
      ["model-parallel", parallelAgent]
    ]);
    const createAgent = vi.spyOn(Agent, "create").mockImplementation(async (options) => {
      const agent = agentsByModel.get(options.model.id);
      if (!agent) throw new Error(`unexpected Agent.create for ${options.model.id}`);
      return agent;
    });
    const resumeAgent = vi.spyOn(Agent, "resume");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const activeInput = localAgentInput(identity, {
      model: "model-active",
      clientTools: [{ name: "read", parameters: { type: "object" } }]
    });
    const authInput = localAgentInput(identity, {
      model: "model-auth",
      sessionKey: `${activeInput.sessionKey}-auth`,
      requestId: `${activeInput.requestId}-auth`
    });

    try {
      const toolOutput = await runLocalAgentBody(activeInput);
      const error = await runLocalAgentUnlocked(authInput).catch((failure) => failure);
      expect(error).toMatchObject({ message: "[unknown] Invalid User API Key" });
      expect(statusFromError(error)).toBe(401);
      expect(authAgent[Symbol.asyncDispose]).toHaveBeenCalledOnce();
      expect(authAgent.send).toHaveBeenCalledOnce();

      await expect(runLocalAgentUnlocked(localAgentInput(identity, {
        model: "model-parallel",
        sessionKey: `${activeInput.sessionKey}-parallel`,
        requestId: `${activeInput.requestId}-parallel`
      }))).resolves.toMatchObject({ text: "parallel" });
      expect(activeToolResult).toBeUndefined();
      expect(activeAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      expect(activeAgent.close).not.toHaveBeenCalled();

      await expect(runLocalAgentBody({
        ...activeInput,
        requestId: `${activeInput.requestId}-result`,
        prompt: "FULL TRANSCRIPT\nTOOL RESULT: contents",
        incrementalPrompt: "TOOL RESULT: contents",
        hasIncrementalPrompt: true,
        fullReplay: false,
        resumeToolResults: [{
          callId: toolOutput.toolCalls[0].callId,
          output: "contents",
          isError: false
        }]
      })).resolves.toMatchObject({ text: "active done" });
      expect(activeToolResult).toBe("contents");
      expect(activeAgent.send).toHaveBeenCalledOnce();
      expect(activeAgent[Symbol.asyncDispose]).not.toHaveBeenCalled();
      expect(activeAgent.close).not.toHaveBeenCalled();
      expect(createAgent).toHaveBeenCalledTimes(3);
      expect(resumeAgent).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
      activeAgent.close();
      parallelAgent.close();
    }
  });

  it.each(["send", "semantic run"])("awaits failed-Agent disposal and returns %s authentication failure without replay", async (failureSource) => {
    const identity = `executor-auth-terminal-${crypto.randomUUID()}`;
    let releaseDisposal;
    const disposalGate = new Promise((resolve) => {
      releaseDisposal = resolve;
    });
    const authAgent = {
      agentId: "agent-auth-terminal-failed",
      close: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(() => disposalGate),
      send: vi.fn(async () => {
        if (failureSource === "send") {
          throw Object.assign(new Error("Missing or invalid authorization"), {
            name: "AuthenticationError",
            status: 401,
            isRetryable: false
          });
        }
        return {
          id: "run-auth-terminal-failed",
          async *stream() {
            yield { type: "status", status: "ERROR" };
          },
          wait: vi.fn().mockResolvedValue({
            status: "error",
            error: { message: "Missing or invalid authorization", code: "unauthorized" }
          }),
          cancel: vi.fn().mockResolvedValue(undefined)
        };
      })
    };
    const resumeAgent = vi.spyOn(Agent, "resume").mockResolvedValue(authAgent);
    const createAgent = vi.spyOn(Agent, "create").mockRejectedValue(new Error("Unexpected authentication replay"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = localAgentInput(identity, {
      prompt: "FULL TRANSCRIPT\nUSER: continue",
      incrementalPrompt: "USER: continue",
      hasIncrementalPrompt: true,
      fullReplay: false
    });
    seedPersistedAgentState(input, { sdkAgentId: authAgent.agentId });

    try {
      let settled = false;
      const failure = runLocalAgentUnlocked(input).then(
        (output) => {
          settled = true;
          return output;
        },
        (error) => {
          settled = true;
          return error;
        }
      );
      await vi.waitFor(() => expect(authAgent[Symbol.asyncDispose]).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(resumeAgent).toHaveBeenCalledOnce();
      expect(createAgent).not.toHaveBeenCalled();
      releaseDisposal();
      const error = await failure;
      expect(error).toMatchObject({ message: "Missing or invalid authorization" });
      expect(statusFromError(error)).toBe(401);
      expect(resumeAgent).toHaveBeenCalledOnce();
      expect(createAgent).not.toHaveBeenCalled();
      expect(authAgent.send).toHaveBeenCalledOnce();
      expect(authAgent.send).toHaveBeenCalledWith("USER: continue", expect.objectContaining({
        idempotencyKey: input.requestId
      }));
      expect(authAgent.close).not.toHaveBeenCalled();
    } finally {
      releaseDisposal();
      warn.mockRestore();
      info.mockRestore();
      resumeAgent.mockRestore();
      createAgent.mockRestore();
    }
  });

  it("classifies retryable Cursor SDK upstream capacity errors", () => {
    expect(isRetryableSDKRunError(new Error("Server at capacity"))).toBe(true);
    expect(isRetryableSDKRunError({ cause: { isRetryable: true } })).toBe(true);
    expect(isRetryableSDKRunError({ rawMessage: "temporarily unavailable" })).toBe(true);
    expect(isRetryableSDKRunError(new TypeError("The socket connection was closed unexpectedly."))).toBe(true);
    expect(isRetryableSDKRunError({ cause: { code: "UND_ERR_SOCKET" } })).toBe(true);
    expect(isRetryableSDKRunError({ status: 429 })).toBe(true);
    expect(isRetryableSDKRunError(new Error("Missing or invalid authorization"))).toBe(false);
    expect(isRetryableSDKRunError({ status: 401, message: "Unauthorized" })).toBe(false);
  });

  it("recognizes SDK authentication failures that must terminate without transparent retry", () => {
    expect(isAuthenticationSDKError(new Error("Authentication error If you are logged in, try logging out and back in."))).toBe(true);
    expect(isAuthenticationSDKError(new Error("[unknown] Invalid User API Key"))).toBe(true);
    expect(isAuthenticationSDKError({ status: 401, code: "unauthorized" })).toBe(true);
    expect(isAuthenticationSDKError(new Error("Server at capacity"))).toBe(false);
  });

  it("treats opaque SDK error results as retryable but preserves explicit auth failures", () => {
    expect(sdkRunFailureSummary({ status: "error" })).toMatchObject({
      message: "",
      retryable: true
    });
    expect(sdkRunFailureSummary({ status: "error", error: { message: "Server at capacity", code: "unavailable" } })).toMatchObject({
      message: "Server at capacity",
      code: "unavailable",
      retryable: true
    });
    expect(sdkRunFailureSummary({ status: "error", error: { message: "Missing or invalid authorization", code: "unauthorized" } })).toMatchObject({
      message: "Missing or invalid authorization",
      code: "unauthorized",
      retryable: false
    });
  });

  it("surfaces Cursor SDK authentication failures as unauthorized API errors", () => {
    const error = Object.assign(new Error("Error"), {
      name: "AuthenticationError",
      code: "internal",
      status: "401",
      endpoint: "GET /v1/models"
    });

    expect(statusFromError(error)).toBe(401);
    expect(openAiError(error)).toEqual({
      error: {
        message: "Missing or invalid authorization",
        type: "invalid_request_error",
        code: "unauthorized",
        status: 401
      }
    });

    const semanticError = Object.assign(new Error("[unknown] Invalid User API Key"), {
      code: "cursor_sdk_error",
      status: 502
    });
    expect(statusFromError(semanticError)).toBe(401);
  });

  it("keeps public Composer aliases distinct before SDK model selection", () => {
    expect(normalizeModel("composer-2.5")).toBe("composer-2.5");
    expect(normalizeModel("composer-2.5-fast")).toBe("composer-2.5-fast");
    expect(normalizeModel("cursorapi/composer-2.5-fast")).toBe("composer-2.5-fast");
    expect(normalizeModel("composer-latest")).toBe("composer-2.5");
    expect(normalizeModel("auto")).toBe("auto");
    expect(normalizeModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeModel("cursor/claude-opus-4-8[context=1m,effort=high,fast=false]"))
      .toBe("claude-opus-4-8[context=1m,effort=high,fast=false]");
  });

  it("does not cancel SDK glob calls on directory-only partial arguments", () => {
    const partial = normalizeSDKToolCall({
      type: "glob",
      args: { targetDirectory: "." }
    });

    expect(partial).toEqual({
      name: "glob",
      arguments: { targetDirectory: "." }
    });
    expect(isForwardableSDKToolCall(partial)).toBe(false);
  });

  it("allows SDK glob calls once a real pattern is present", () => {
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { globPattern: "**/*.tsx", targetDirectory: "." } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { glob_pattern: "*.tsx", targeting: "src" } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { targeting: "/tmp/project/src/**/*.tsx" } })).toBe(true);
  });

  it("ignores partial SDK tool calls even when their partial arguments look forwardable", () => {
    const update = {
      type: "partial-tool-call",
      toolCall: {
        type: "shell",
        args: { command: "cat > package.json <<'EOF'\n{\"scripts\"" }
      }
    };

    expect(toolCallFromDelta(update)).toBe(null);
  });

  it("extracts SDK tool-call starts for early bridge-side cancellation", () => {
    const update = {
      type: "tool-call-started",
      toolCall: {
        type: "shell",
        args: { command: "printf OK" }
      }
    };

    const normalized = normalizeSDKToolCall(toolCallFromDelta(update));

    expect(normalized).toEqual({
      name: "shell",
      arguments: { command: "printf OK" }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("requires both provider and tool names for SDK MCP forwarding", () => {
    expect(isForwardableSDKToolCall({ name: "mcp", arguments: { providerIdentifier: "client" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "mcp", arguments: { providerIdentifier: "client", toolName: "glob" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "glob", arguments: { globPattern: "**/*" } })).toBe(true);
  });

  it("requires complete non-file SDK builtin tool arguments before forwarding", () => {
    expect(isForwardableSDKToolCall({ name: "readLints", arguments: { cwd: "." } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "readLints", arguments: { paths: [] } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "readLints", arguments: { paths: ["src/App.tsx"] } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "readLints", arguments: { filePath: "src/App.tsx" } })).toBe(true);

    expect(isForwardableSDKToolCall({ name: "semSearch", arguments: { targetDirectories: ["src"] } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "semSearch", arguments: { query: "submit button" } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "semSearch", arguments: { search_query: "submit button", targetDirectories: ["src"] } })).toBe(true);

    expect(isForwardableSDKToolCall({ name: "todowrite", arguments: { status: "in_progress" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "todowrite", arguments: { todos: [] } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "todowrite", arguments: { taskList: [{ content: "Build app" }] } })).toBe(true);

    expect(isForwardableSDKToolCall({ name: "task", arguments: { description: "Inspect app" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "task", arguments: { description: "Inspect app", prompt: "Find the entrypoint" } })).toBe(true);

    expect(isForwardableSDKToolCall({ name: "createPlan", arguments: { status: "in_progress" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "createPlan", arguments: { plan: "Build and verify the app" } })).toBe(true);
    expect(isForwardableSDKToolCall({ name: "createPlan", arguments: { todos: [{ content: "Build app" }] } })).toBe(true);

    expect(isForwardableSDKToolCall({ name: "generateImage", arguments: { filePath: "out.png" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "generateImage", arguments: { description: "A blue cube" } })).toBe(true);

    expect(isForwardableSDKToolCall({ name: "recordScreen", arguments: { path: "recording.mov" } })).toBe(false);
    expect(isForwardableSDKToolCall({ name: "recordScreen", arguments: { mode: "START_RECORDING" } })).toBe(true);
  });

  it("normalizes local client MCP forwarding tools back to SDK tool names", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "client_shell",
        args: {
          command: "npm test",
          timeout: 120000
        }
      }
    });

    expect(normalized).toEqual({
      name: "shell",
      arguments: {
        command: "npm test",
        timeout: 120000
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes the Codex shell_command forwarding tool", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "shell_command",
        args: {
          command: "rg --files",
          workdir: "C:\\project"
        }
      }
    });

    expect(normalized).toEqual({
      name: "shell",
      arguments: {
        command: "rg --files",
        workdir: "C:\\project"
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes direct forwarding MCP tool events back to SDK tool names", () => {
    const normalized = normalizeSDKToolCall({
      type: "client_shell",
      args: {
        command: "npm test",
        timeout: 120000
      }
    });

    expect(normalized).toEqual({
      name: "shell",
      arguments: {
        command: "npm test",
        timeout: 120000
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes SDK task and plan forwarding tools back to SDK tool names", () => {
    const task = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "client_task",
        args: {
          description: "Inspect app",
          prompt: "Find the entrypoint",
          subagentType: { kind: "agent", name: "explore" }
        }
      }
    });

    expect(task).toEqual({
      name: "task",
      arguments: {
        description: "Inspect app",
        prompt: "Find the entrypoint",
        subagentType: { kind: "agent", name: "explore" }
      }
    });
    expect(isForwardableSDKToolCall(task)).toBe(true);

    const plan = normalizeSDKToolCall({
      type: "client_create_plan",
      args: {
        plan: "Build the app",
        todos: [{ content: "Create files", status: "pending" }]
      }
    });

    expect(plan).toEqual({
      name: "createPlan",
      arguments: {
        plan: "Build the app",
        todos: [{ content: "Create files", status: "pending" }]
      }
    });
    expect(isForwardableSDKToolCall(plan)).toBe(true);
  });

  it("normalizes SDK image and screen forwarding tools back to SDK tool names", () => {
    const image = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "client_generate_image",
        args: {
          description: "A blue cube",
          filePath: "assets/cube.png"
        }
      }
    });

    expect(image).toEqual({
      name: "generateImage",
      arguments: {
        description: "A blue cube",
        filePath: "assets/cube.png"
      }
    });
    expect(isForwardableSDKToolCall(image)).toBe(true);

    const screen = normalizeSDKToolCall({
      type: "client_record_screen",
      args: {
        mode: "START_RECORDING"
      }
    });

    expect(screen).toEqual({
      name: "recordScreen",
      arguments: {
        mode: "START_RECORDING"
      }
    });
    expect(isForwardableSDKToolCall(screen)).toBe(true);
  });

  it("normalizes SDK tool calls that use OpenAI-style argument keys", () => {
    const normalized = normalizeSDKToolCall({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });

    expect(normalized).toEqual({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes local client MCP forwarding tools with alternate payload keys", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "client_glob",
        arguments: JSON.stringify({
          targetDirectory: "src",
          globPattern: "**/*.tsx"
        })
      }
    });

    expect(normalized).toEqual({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("normalizes local client MCP forwarding tools with direct payload fields", () => {
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "client_glob",
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });

    expect(normalized).toEqual({
      name: "glob",
      arguments: {
        targetDirectory: "src",
        globPattern: "**/*.tsx"
      }
    });
    expect(isForwardableSDKToolCall(normalized)).toBe(true);
  });

  it("keeps dynamic harness MCP tools as client MCP calls", () => {
    const clientTools = [
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ];
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    }, clientTools);

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized, clientTools)).toBe(true);
  });

  it("keeps dynamic harness MCP tools with direct payload fields as client MCP calls", () => {
    const clientTools = [
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ];
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        file_path: "marker.txt",
        contents: "ok"
      }
    }, clientTools);

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized, clientTools)).toBe(true);
  });

  it("keeps provider-style harness tools on the local client MCP server", () => {
    const clientTools = [
      {
        name: "mcp__filesystem__write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ];
    const normalized = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "client",
        toolName: "mcp__filesystem__write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    }, clientTools);

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "mcp__filesystem__write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized, clientTools)).toBe(true);
  });

  it("normalizes direct dynamic harness MCP tool events to SDK MCP calls", () => {
    const clientTools = [
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ];
    const normalized = normalizeSDKToolCall({
      type: "probe_write_file",
      args: {
        file_path: "marker.txt",
        contents: "ok"
      }
    }, clientTools);

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "probe_write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized, clientTools)).toBe(true);
  });

  it("preserves direct Codex Code Mode exec custom-tool calls", () => {
    const clientTools = [{
      name: "exec",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false
      }
    }];
    const normalized = normalizeSDKToolCall({
      type: "exec",
      args: {
        code: 'const r = await tools.shell_command({"command":"Get-ChildItem -Name"}); text(r);'
      }
    }, clientTools);

    expect(normalized).toEqual({
      name: "exec",
      arguments: {
        code: 'const r = await tools.shell_command({"command":"Get-ChildItem -Name"}); text(r);'
      }
    });
    expect(isForwardableSDKToolCall(normalized, clientTools)).toBe(true);
  });

  it("normalizes direct provider-style harness MCP tool events to exact client MCP calls", () => {
    const clientTools = [
      {
        name: "mcp__filesystem__write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ];
    const normalized = normalizeSDKToolCall({
      type: "mcp__filesystem__write_file",
      args: {
        file_path: "marker.txt",
        contents: "ok"
      }
    }, clientTools);

    expect(normalized).toEqual({
      name: "mcp",
      arguments: {
        providerIdentifier: "client",
        toolName: "mcp__filesystem__write_file",
        args: {
          file_path: "marker.txt",
          contents: "ok"
        }
      }
    });
    expect(isForwardableSDKToolCall(normalized, clientTools)).toBe(true);
  });

  it("does not forward SDK tool calls that were not exposed by the harness", () => {
    expect(isForwardableSDKToolCall({
      name: "unexpected_tool",
      arguments: { path: "marker.txt", content: "ok" }
    })).toBe(false);
    expect(isForwardableSDKToolCall({
      name: "mcp",
      arguments: {
        providerIdentifier: "github",
        toolName: "create_issue",
        args: { title: "Bug", body: "Details" }
      }
    })).toBe(false);
  });

  it("waits for complete direct dynamic harness tool arguments before forwarding", () => {
    const clientTools = [
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
            contents: { type: "string", minLength: 1 }
          },
          required: ["file_path", "contents"]
        }
      }
    ];

    const partial = normalizeSDKToolCall({
      type: "probe_write_file",
      args: { file_path: "marker.txt" }
    }, clientTools);
    const invalid = normalizeSDKToolCall({
      type: "probe_write_file",
      args: { file_path: "marker.txt", contents: "" }
    }, clientTools);
    const complete = normalizeSDKToolCall({
      type: "probe_write_file",
      args: { file_path: "marker.txt", contents: "ok" }
    }, clientTools);

    expect(isForwardableSDKToolCall(partial, clientTools)).toBe(false);
    expect(isForwardableSDKToolCall(invalid, clientTools)).toBe(false);
    expect(isForwardableSDKToolCall(complete, clientTools)).toBe(true);
  });

  it("waits for complete provider-style MCP tool arguments before forwarding", () => {
    const clientTools = [
      {
        name: "mcp__github__create_issue",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            body: { type: "string", minLength: 1 }
          },
          required: ["title", "body"]
        }
      }
    ];

    const partial = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "github",
        toolName: "create_issue",
        args: { title: "Bug" }
      }
    }, clientTools);
    const complete = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "github",
        toolName: "create_issue",
        args: { title: "Bug", body: "Details" }
      }
    }, clientTools);

    expect(isForwardableSDKToolCall(partial, clientTools)).toBe(false);
    expect(isForwardableSDKToolCall(complete, clientTools)).toBe(true);
  });

  it("accepts provider-style SDK MCP calls through generic wrapper tools", () => {
    const clientTools = [
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            serverName: { type: "string" },
            toolName: { type: "string" },
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                mode: { type: "string", enum: ["create", "overwrite"] },
                filePath: { type: "string" },
                content: { type: "string" },
                description: { type: "string" }
              },
              required: ["mode", "filePath", "content", "description"]
            }
          },
          required: ["serverName", "toolName", "input"]
        }
      }
    ];

    const partial = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "filesystem",
        toolName: "write_file",
        args: { file_path: "src/App.tsx" }
      }
    }, clientTools);
    const complete = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "filesystem",
        toolName: "write_file",
        args: {
          file_path: "src/App.tsx",
          contents: "export default function App() { return null }"
        }
      }
    }, clientTools);

    expect(isForwardableSDKToolCall(partial, clientTools)).toBe(false);
    expect(isForwardableSDKToolCall(complete, clientTools)).toBe(true);
  });

  it("requires exact nested wrapper schemas for unknown provider-style SDK MCP tools", () => {
    const clientTools = [
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            serverName: { type: "string" },
            toolName: { type: "string" },
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string", minLength: 1 },
                body: { type: "string", minLength: 1 }
              },
              required: ["title", "body"]
            }
          },
          required: ["serverName", "toolName", "input"]
        }
      }
    ];

    const partial = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "github",
        toolName: "create_issue",
        args: { title: "Bug" }
      }
    }, clientTools);
    const complete = normalizeSDKToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "github",
        toolName: "create_issue",
        args: { title: "Bug", body: "Details" }
      }
    }, clientTools);

    expect(isForwardableSDKToolCall(partial, clientTools)).toBe(false);
    expect(isForwardableSDKToolCall(complete, clientTools)).toBe(true);
  });

  it("exposes dynamic client tool schemas through the forwarding MCP server", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "probe_write_file",
        description: "Writes a marker through the harness MCP server.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);

    expect(tools.some((tool) => tool.name === "client_shell")).toBe(true);
    expect(tools.some((tool) => tool.name === "client_task")).toBe(true);
    expect(tools.find((tool) => tool.name === "probe_write_file")).toMatchObject({
      description: "Writes a marker through the harness MCP server.",
      inputSchema: {
        additionalProperties: false,
        required: ["file_path", "contents"]
      }
    });
    expect(tools.map((tool) => tool.name).indexOf("probe_write_file")).toBeLessThan(
      tools.map((tool) => tool.name).indexOf("client_shell")
    );
  });

  it("unwraps common dynamic client tool schema wrappers", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "wrapped_write_file",
        parameters: {
          json_schema: {
            name: "wrapped_write_file",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              },
              required: ["path", "content"]
            }
          }
        }
      }
    ]);

    expect(tools.find((tool) => tool.name === "wrapped_write_file")).toMatchObject({
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"]
      }
    });
    expect(validateClientMcpToolCall(tools, "wrapped_write_file", { path: "marker.txt" })).toBe("Missing required argument for wrapped_write_file: content");
    expect(validateClientMcpToolCall(tools, "wrapped_write_file", { path: "marker.txt", content: "ok" })).toBe(null);
  });

  it("rejects unknown or incomplete client MCP forwarding calls internally", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "probe_write_file",
        parameters: {
          type: "object",
          properties: {
            file_path: { type: "string" },
            contents: { type: "string" }
          },
          required: ["file_path", "contents"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "missing_tool", {})).toContain("Unknown client MCP forwarding tool");
    expect(validateClientMcpToolCall(tools, "probe_write_file", { file_path: "marker.txt" })).toBe("Missing required argument for probe_write_file: contents");
    expect(validateClientMcpToolCall(tools, "probe_write_file", { file_path: "marker.txt", contents: "" })).toBe(null);
  });

  it("validates dynamic client MCP schemas with local references", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "ref_write_file",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: { $ref: "#/$defs/fileTarget" },
            metadata: { $ref: "#/definitions/metadata" },
            format: { anyOf: [{ $ref: "#/$defs/format" }, { type: "null" }] }
          },
          required: ["target", "metadata"],
          $defs: {
            fileTarget: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                mode: { type: "string", enum: ["create", "overwrite"] }
              },
              required: ["path", "mode"]
            },
            format: { type: "string", enum: ["text", "markdown"] }
          },
          definitions: {
            metadata: {
              type: "object",
              additionalProperties: false,
              properties: {
                tags: { type: "array", items: { type: "string" }, minItems: 1 }
              },
              required: ["tags"]
            }
          }
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx" },
      metadata: { tags: ["ui"] }
    })).toBe("Missing required argument for ref_write_file.target: mode");
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "append" },
      metadata: { tags: ["ui"] }
    })).toContain("expected one of");
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "create" },
      metadata: { tags: [42] }
    })).toBe("Invalid value for ref_write_file.metadata.tags[0]: expected string");
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "create" },
      metadata: { tags: ["ui"] },
      format: null
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "ref_write_file", {
      target: { path: "src/App.tsx", mode: "create" },
      metadata: { tags: ["ui"] },
      format: "markdown"
    })).toBe(null);
  });

  it("validates dynamic client MCP scalar constraints", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "constrained_search",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 2, maxLength: 12, pattern: "^[A-Za-z0-9_]+$" },
            limit: { type: "integer", minimum: 1, maximum: 50, multipleOf: 5 }
          },
          required: ["query", "limit"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "", limit: 5 })).toBe("Invalid value for constrained_search.query: expected at least 2 character(s)");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo app", limit: 5 })).toContain("expected to match pattern");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app_name", limit: 5 })).toBe("Invalid value for constrained_search.query: expected at most 12 character(s)");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 0 })).toBe("Invalid value for constrained_search.limit: expected >= 1");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 55 })).toBe("Invalid value for constrained_search.limit: expected <= 50");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 7 })).toBe("Invalid value for constrained_search.limit: expected a multiple of 5");
    expect(validateClientMcpToolCall(tools, "constrained_search", { query: "todo_app", limit: 10 })).toBe(null);
  });

  it("validates dynamic client MCP array membership constraints", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "run_steps",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            steps: {
              type: "array",
              items: { type: "string" },
              uniqueItems: true,
              contains: { const: "build" },
              minContains: 1,
              maxContains: 1
            },
            labels: {
              type: "array",
              items: { type: "string" },
              contains: { type: "string", pattern: "^release:" },
              minContains: 0,
              maxContains: 1
            }
          },
          required: ["steps"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "run_steps", {
      steps: ["install", "build", "test"],
      labels: ["release:stable", "ui"]
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "run_steps", {
      steps: ["build", "build"]
    })).toBe("Invalid value for run_steps.steps: expected unique items");
    expect(validateClientMcpToolCall(tools, "run_steps", {
      steps: ["install", "test"]
    })).toBe("Invalid value for run_steps.steps: expected at least 1 matching item");
    expect(validateClientMcpToolCall(tools, "run_steps", {
      steps: ["build", "package", "build"]
    })).toBe("Invalid value for run_steps.steps: expected unique items");
    expect(validateClientMcpToolCall(tools, "run_steps", {
      steps: ["build"],
      labels: ["release:stable", "release:beta"]
    })).toBe("Invalid value for run_steps.labels: expected at most 1 matching item");
  });

  it("validates dynamic client MCP tuple array schemas", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "run_pipeline",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: [
                { const: "install" },
                { const: "build" }
              ],
              additionalItems: false
            }
          },
          required: ["steps"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "run_pipeline", {
      steps: ["install", "build"]
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "run_pipeline", {
      steps: ["install", "test"]
    })).toBe("Invalid value for run_pipeline.steps[1]: expected constant \"build\"");
    expect(validateClientMcpToolCall(tools, "run_pipeline", {
      steps: ["install", "build", "test"]
    })).toBe("Unexpected array item for run_pipeline.steps: 2");
  });

  it("validates dynamic client MCP unevaluated object properties", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "configure_deploy",
        parameters: {
          type: "object",
          allOf: [
            {
              properties: {
                command: { type: "string" }
              },
              required: ["command"]
            },
            {
              properties: {
                metadata: {
                  type: "object",
                  properties: {
                    owner: { type: "string" }
                  },
                  required: ["owner"],
                  unevaluatedProperties: false
                }
              },
              required: ["metadata"]
            }
          ],
          unevaluatedProperties: false
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "configure_deploy", {
      command: "npm run build",
      metadata: { owner: "web" }
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "configure_deploy", {
      command: "npm run build",
      metadata: { owner: "web", extra: true }
    })).toBe("Unexpected argument for configure_deploy.metadata: extra");
    expect(validateClientMcpToolCall(tools, "configure_deploy", {
      command: "npm run build",
      metadata: { owner: "web" },
      debug: true
    })).toBe("Unexpected argument for configure_deploy: debug");
  });

  it("treats additionalProperties schemas as evaluated for unevaluated object properties", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "configure_env",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" }
          },
          required: ["command"],
          additionalProperties: { type: "string", minLength: 1 },
          unevaluatedProperties: false
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "configure_env", {
      command: "npm run build",
      NODE_ENV: "production"
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "configure_env", {
      command: "npm run build",
      NODE_ENV: ""
    })).toBe("Invalid value for configure_env.NODE_ENV: expected at least 1 character(s)");
    expect(validateClientMcpToolCall(tools, "configure_env", {
      command: "npm run build",
      DEBUG: true
    })).toBe("Invalid value for configure_env.DEBUG: expected string");
  });

  it("treats dependentSchemas as evaluated for unevaluated object properties", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "run_command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" }
          },
          required: ["command"],
          dependentSchemas: {
            command: {
              properties: {
                cwd: { type: "string" }
              },
              required: ["cwd"]
            }
          },
          unevaluatedProperties: false
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "run_command", {
      command: "npm run build",
      cwd: "."
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "run_command", {
      command: "npm run build"
    })).toBe("Missing required argument for run_command: cwd");
    expect(validateClientMcpToolCall(tools, "run_command", {
      command: "npm run build",
      cwd: ".",
      debug: true
    })).toBe("Unexpected argument for run_command: debug");
  });

  it("treats contains matches as evaluated for unevaluated array items", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "run_pipeline",
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              prefixItems: [{ const: "install" }],
              contains: { const: "build" },
              minContains: 1,
              unevaluatedItems: false
            }
          },
          required: ["steps"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "run_pipeline", {
      steps: ["install", "build"]
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "run_pipeline", {
      steps: ["install", "build", "test"]
    })).toBe("Unexpected array item for run_pipeline.steps: 2");
  });

  it("validates dynamic client MCP oneOf schemas exactly", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "deploy_target",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: {
              oneOf: [
                {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"]
                },
                {
                  type: "object",
                  properties: { path: { type: "string" }, mode: { const: "preview" } },
                  required: ["path", "mode"]
                }
              ]
            }
          },
          required: ["target"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "deploy_target", {
      target: { path: "dist" }
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "deploy_target", {
      target: { path: "dist", mode: "preview" }
    })).toBe("Invalid value for deploy_target.target: matched more than one allowed schema");
    expect(validateClientMcpToolCall(tools, "deploy_target", {
      target: { mode: "preview" }
    })).toBe("Invalid value for deploy_target.target: did not match any allowed schema");
  });

  it("validates dynamic client MCP conditional schemas", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "send_notice",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            channel: { type: "string", enum: ["email", "slack"] },
            message: { type: "string" },
            email: { type: "string", minLength: 3 },
            channelId: { type: "string", pattern: "^C[A-Z0-9]+$" }
          },
          required: ["channel", "message"],
          if: {
            properties: { channel: { const: "email" } },
            required: ["channel"]
          },
          then: {
            required: ["email"]
          },
          else: {
            required: ["channelId"]
          }
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "email",
      message: "Build passed",
      email: "dev@example.com"
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "slack",
      message: "Build passed",
      channelId: "C123"
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "email",
      message: "Build passed"
    })).toBe("Missing required argument for send_notice: email");
    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "slack",
      message: "Build passed"
    })).toBe("Missing required argument for send_notice: channelId");
  });

  it("validates dynamic client MCP branch-specific conditional schemas", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "send_notice",
        parameters: {
          type: "object",
          unevaluatedProperties: false,
          properties: {
            channel: { type: "string", enum: ["email", "slack"] },
            message: { type: "string" }
          },
          required: ["channel", "message"],
          if: {
            properties: { channel: { const: "email" } },
            required: ["channel"]
          },
          then: {
            properties: { email: { type: "string", minLength: 3 } },
            required: ["email"]
          },
          else: {
            properties: { channelId: { type: "string", pattern: "^C[A-Z0-9]+$" } },
            required: ["channelId"]
          }
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "email",
      message: "Build passed",
      email: "dev@example.com"
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "slack",
      message: "Build passed",
      channelId: "C123"
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "slack",
      message: "Build passed",
      channelId: "C123",
      email: "dev@example.com"
    })).toBe("Unexpected argument for send_notice: email");
    expect(validateClientMcpToolCall(tools, "send_notice", {
      channel: "email",
      message: "Build passed",
      email: "dev@example.com",
      channelId: "C123"
    })).toBe("Unexpected argument for send_notice: channelId");
  });

  it("validates dynamic client MCP pattern properties", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "run_with_env",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: { type: "string" },
            env: {
              type: "object",
              additionalProperties: false,
              patternProperties: {
                "^VITE_[A-Z0-9_]+$": { type: "string", minLength: 1 }
              }
            }
          },
          required: ["command", "env"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "run_with_env", {
      command: "npm run build",
      env: { VITE_API_URL: "https://example.com" }
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "run_with_env", {
      command: "npm run build",
      env: { API_URL: "https://example.com" }
    })).toBe("Unexpected argument for run_with_env.env: API_URL");
    expect(validateClientMcpToolCall(tools, "run_with_env", {
      command: "npm run build",
      env: { VITE_API_URL: "" }
    })).toBe("Invalid value for run_with_env.env.VITE_API_URL: expected at least 1 character(s)");
  });

  it("validates dynamic client MCP object key constraints", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "configure_env",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            settings: {
              type: "object",
              minProperties: 1,
              maxProperties: 2,
              propertyNames: { type: "string", pattern: "^APP_[A-Z0-9_]+$" },
              patternProperties: {
                "^APP_SECRET$": false
              },
              additionalProperties: { type: "string", minLength: 1 },
              dependentRequired: {
                APP_TOKEN: ["APP_URL"]
              }
            }
          },
          required: ["settings"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: { APP_URL: "https://example.com", APP_TOKEN: "secret" }
    })).toBe(null);
    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: {}
    })).toBe("Invalid value for configure_env.settings: expected at least 1 property");
    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: { APP_URL: "https://example.com", APP_TOKEN: "secret", APP_MODE: "prod" }
    })).toBe("Invalid value for configure_env.settings: expected at most 2 properties");
    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: { API_URL: "https://example.com" }
    })).toContain("configure_env.settings property name API_URL");
    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: { APP_TOKEN: "secret" }
    })).toBe("Missing dependent argument for configure_env.settings: APP_URL");
    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: { APP_SECRET: "secret" }
    })).toBe("Invalid value for configure_env.settings.APP_SECRET: schema disallows value");
    expect(validateClientMcpToolCall(tools, "configure_env", {
      settings: { APP_URL: "" }
    })).toBe("Invalid value for configure_env.settings.APP_URL: expected at least 1 character(s)");
  });

  it("validates nested dynamic client MCP schemas before accepting forwarding calls", () => {
    const tools = clientMcpToolDefinitions([
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            serverName: { type: "string" },
            toolName: { type: "string" },
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                filePath: { type: "string" },
                content: { type: "string" },
                mode: { type: "string", enum: ["create", "overwrite"] },
                metadata: {
                  type: "object",
                  properties: {
                    tags: { type: "array", items: { type: "string" }, minItems: 1 }
                  },
                  required: ["tags"],
                  additionalProperties: false
                },
                format: { anyOf: [{ type: "string", enum: ["text", "markdown"] }, { type: "null" }] }
              },
              required: ["filePath", "content", "mode", "metadata"]
            }
          },
          required: ["serverName", "toolName", "input"]
        }
      }
    ]);

    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create" }
    })).toBe("Missing required argument for call_mcp_tool.input: metadata");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "append", metadata: { tags: ["ui"] } }
    })).toContain("expected one of");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create", metadata: { tags: [42] } }
    })).toBe("Invalid value for call_mcp_tool.input.metadata.tags[0]: expected string");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create", metadata: { tags: ["ui"] }, extra: true }
    })).toBe("Unexpected argument for call_mcp_tool.input: extra");
    expect(validateClientMcpToolCall(tools, "call_mcp_tool", {
      serverName: "filesystem",
      toolName: "write_file",
      input: { filePath: "src/App.tsx", content: "ok", mode: "create", metadata: { tags: ["ui"] }, format: null }
    })).toBe(null);
  });

  it("bundles nested schema validation into the generated MCP forwarding server", () => {
    const source = clientForwardingMcpServerSource([
      {
        name: "call_mcp_tool",
        parameters: {
          type: "object",
          properties: {
            serverName: { type: "string" },
            input: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["create"] }
              },
              required: ["mode"]
            }
          },
          required: ["serverName", "input"]
        }
      }
    ]);
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "call_mcp_tool",
        arguments: {
          serverName: "filesystem",
          input: { mode: "append" }
        }
      }
    };

    const result = spawnSync(process.execPath, ["-e", source], {
      input: `${JSON.stringify(message)}\n`,
      encoding: "utf8",
      timeout: 1000
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout.trim());
    expect(response.error.message).toContain("expected one of");
  });

  it("bundles referenced schema validation into the generated MCP forwarding server", () => {
    const source = clientForwardingMcpServerSource([
      {
        name: "ref_write_file",
        parameters: {
          type: "object",
          properties: {
            target: { $ref: "#/$defs/fileTarget" }
          },
          required: ["target"],
          $defs: {
            fileTarget: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["create"] }
              },
              required: ["mode"]
            }
          }
        }
      }
    ]);
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ref_write_file",
        arguments: {
          target: { mode: "append" }
        }
      }
    };

    const result = spawnSync(process.execPath, ["-e", source], {
      input: `${JSON.stringify(message)}\n`,
      encoding: "utf8",
      timeout: 1000
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout.trim());
    expect(response.error.message).toContain("expected one of");
  });

  it("does not fake a forwarded MCP result when the bridge callback is unavailable", () => {
    const source = clientForwardingMcpServerSource([]);
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "client_shell",
        arguments: {
          command: "printf SHOULD_NOT_RUN"
        }
      }
    };

    const result = spawnSync(process.execPath, ["-e", source], {
      input: `${JSON.stringify(message)}\n`,
      encoding: "utf8",
      timeout: 3000,
      env: {
        ...process.env,
        CURSOR_SDK_BRIDGE_CALLBACK_URL: "http://127.0.0.1:1/client-tool-call",
        CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY: "cache-key"
      }
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout.trim());
    expect(response.error.message).toContain("Outer client callback unavailable");
  });

  it("posts forwarded MCP tool calls to the bridge callback before returning success", async () => {
    let observedRequest;
    const callbackServer = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(body)
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, accepted: true }));
      });
    });

    await new Promise((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
    const address = callbackServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const child = spawn(process.execPath, [bridgeScriptPath, "--client-mcp-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CURSOR_SDK_BRIDGE_CALLBACK_URL: `http://127.0.0.1:${port}/client-tool-call`,
        CURSOR_SDK_BRIDGE_CALLBACK_TOKEN: "bridge-token",
        CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY: "cache-key",
        CURSOR_SDK_BRIDGE_CLIENT_TOOLS_JSON: JSON.stringify(clientMcpToolDefinitions([]))
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "client_shell",
        arguments: {
          command: "printf CALLBACK_OK"
        }
      }
    };
    child.stdin.end(`${JSON.stringify(message)}\n`);

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("generated MCP server did not exit"));
      }, 3000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    callbackServer.close();

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const response = JSON.parse(stdout.trim());
    expect(response.result.content[0].text).toBe("FORWARDED_TO_OUTER_CLIENT");
    expect(observedRequest).toEqual({
      url: "/client-tool-call",
      authorization: "Bearer bridge-token",
      body: {
        cacheKey: "cache-key",
        toolName: "client_shell",
        arguments: {
          command: "printf CALLBACK_OK"
        }
      }
    });
  });

  it("keeps exact custom harness MCP tools available in the subcommand server", async () => {
    let observedRequest;
    const callbackServer = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        observedRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(body)
        };
        setTimeout(() => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true, accepted: true }));
        }, 50);
      });
    });

    await new Promise((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
    const address = callbackServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const tools = clientMcpToolDefinitions([
      {
        name: "mcp__github__create_issue",
        description: "Create a GitHub issue through the outer harness MCP server.",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            body: { type: "string" }
          },
          required: ["owner", "repo", "title", "body"],
          additionalProperties: false
        }
      }
    ]);
    const child = spawn(process.execPath, [bridgeScriptPath, "--client-mcp-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CURSOR_SDK_BRIDGE_CALLBACK_URL: `http://127.0.0.1:${port}/client-tool-call`,
        CURSOR_SDK_BRIDGE_CALLBACK_TOKEN: "bridge-token",
        CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY: "cache-key",
        CURSOR_SDK_BRIDGE_CLIENT_TOOLS_JSON: JSON.stringify(tools)
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const listMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    };
    const callMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "mcp__github__create_issue",
        arguments: {
          owner: "octo",
          repo: "hello",
          title: "Smoke",
          body: "OK"
        }
      }
    };
    child.stdin.end(`${JSON.stringify(listMessage)}\n${JSON.stringify(callMessage)}\n`);

    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("custom MCP forwarding server did not exit"));
      }, 3000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    callbackServer.close();

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const responses = stdout.trim().split(/\n+/).map((line) => JSON.parse(line));
    const listResponse = responses.find((response) => response.id === 1);
    const callResponse = responses.find((response) => response.id === 2);
    expect(listResponse.result.tools.some((tool) => tool.name === "mcp__github__create_issue")).toBe(true);
    expect(callResponse.result.content[0].text).toBe("FORWARDED_TO_OUTER_CLIENT");
    expect(observedRequest).toEqual({
      url: "/client-tool-call",
      authorization: "Bearer bridge-token",
      body: {
        cacheKey: "cache-key",
        toolName: "mcp__github__create_issue",
        arguments: {
          owner: "octo",
          repo: "hello",
          title: "Smoke",
          body: "OK"
        }
      }
    });
  });

  it("tells the SDK to forward compatible client tools through MCP", () => {
    const prompt = bridgePrompt("USER: create a file", [
      { name: "bash" },
      { name: "write" }
    ]);

    expect(prompt).toContain("outer client tools are: bash, write");
    expect(prompt).toContain("Use SDK mcp with providerIdentifier \"client\" for every local operation");
    expect(prompt).toContain("client_shell");
    expect(prompt).toContain("Prefer exact client tools and dedicated client MCP tools");
    expect(prompt).toContain("TOOL RESULT records are present");
    expect(prompt).toContain("emit exactly one client MCP forwarding tool call and no prose");
  });

  it("uses SDK-compatible local options that do not wedge local runs", () => {
    const input = {
      apiKey: "test-key",
      model: "composer-2.5",
      workingDirectory: "/tmp/project",
      clientTools: []
    };

    const createOptions = localAgentCreateOptions(input);
    const sendOptions = localAgentSendOptions(input);

    expect(createOptions.local).toEqual({
      cwd: "/tmp/project",
      settingSources: []
    });
    expect(createOptions.mode).toBe("agent");
    expect(createOptions).not.toHaveProperty("mcpServers");
    expect(createOptions.local).not.toHaveProperty("sandboxOptions");
    expect(sendOptions.model).toEqual({ id: "composer-2.5" });
    expect(sendOptions.mode).toBe("agent");
    expect(sendOptions).not.toHaveProperty("mcpServers");
    expect(sendOptions).not.toHaveProperty("local");
    expect(localAgentSendOptions(input, { force: true }).local).toEqual({ force: true });
  });

  it("configures the optional SDK HTTP/1.1 proxy fallback", () => {
    const cursor = { configure: vi.fn() };

    expect(configureCursorSdkNetwork(cursor, {})).toBeUndefined();
    expect(cursor.configure).not.toHaveBeenCalled();

    expect(configureCursorSdkNetwork(cursor, { CURSOR_SDK_USE_HTTP1_FOR_AGENT: "yes" })).toBe(true);
    expect(cursor.configure).toHaveBeenLastCalledWith({ local: { useHttp1ForAgent: true } });

    expect(configureCursorSdkNetwork(cursor, { CURSOR_SDK_USE_HTTP1_FOR_AGENT: "0" })).toBe(false);
    expect(cursor.configure).toHaveBeenLastCalledWith({ local: { useHttp1ForAgent: false } });
    expect(() => configureCursorSdkNetwork(cursor, {
      CURSOR_SDK_USE_HTTP1_FOR_AGENT: "sometimes"
    })).toThrow(/CURSOR_SDK_USE_HTTP1_FOR_AGENT must be one of/);
  });

  it("restricts agent creation to the MCP tool family so built-in tools cannot bypass client tools", () => {
    const input = {
      apiKey: "test-key",
      model: "composer-2.5",
      workingDirectory: "/tmp/project",
      clientTools: []
    };

    expect(localAgentCreateOptions(input).tools).toEqual(["mcp"]);
  });

  it("maps legacy fast aliases and Agent CLI bracket parameters to SDK params", () => {
    const input = {
      apiKey: "test-key",
      model: "composer-2.5-fast",
      workingDirectory: "/tmp/project",
      clientTools: []
    };

    expect(localAgentCreateOptions(input).model).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }]
    });
    expect(localAgentSendOptions({
      ...input,
      model: "auto-smart[mode=intelligence]"
    }).model).toEqual({
      id: "auto-smart",
      params: [{ id: "optimize_for", value: "intelligence" }]
    });
    expect(localAgentSendOptions({
      ...input,
      model: "claude-opus-4-8[context=1m,reasoning_effort=high,fast=false]"
    }).model).toEqual({
      id: "claude-opus-4-8",
      params: [
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" }
      ]
    });
    expect(localAgentSendOptions({
      ...input,
      model: "claude-opus-5[1m]"
    }).model).toEqual({
      id: "claude-opus-5",
      params: [{ id: "context", value: "1m" }]
    });
  });

  it("records accepted trajectory input and final output around one attached execution", async () => {
    const identity = `trajectory-${crypto.randomUUID()}`;
    const agent = finishedAgent(`agent-${identity}`, "trajectory final");
    const createAgent = vi.spyOn(Agent, "create").mockResolvedValue(agent);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const content = "inspect this session";
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const input = localAgentInput(identity, {
      ingressRequestId: `resp-${identity}`,
      trajectorySessionId: `session-trajectory-${identity}`,
      trajectoryInputs: [{
        source: "user",
        content,
        contentSha256,
        contentChars: content.length,
        itemIndex: 0
      }]
    });

    try {
      const output = await runLocalAgentBody(input);
      const started = jsonLogRecords(log, "trajectory_execution_started");
      const attached = jsonLogRecords(log, "trajectory_execution_attached");
      const accepted = jsonLogRecords(log, "trajectory_input_accepted");
      const inputChunks = jsonLogRecords(log, "trajectory_input_content_chunk");
      const outputChunks = jsonLogRecords(log, "trajectory_output_content_chunk");
      const terminal = jsonLogRecords(log, "trajectory_execution_terminal");

      expect(started).toHaveLength(1);
      expect(attached).toEqual([
        expect.objectContaining({
          executionId: started[0].executionId,
          agentId: agent.agentId,
          runId: `run-${agent.agentId}`
        })
      ]);
      expect(inputChunks).toEqual([
        expect.objectContaining({ source: "user", content, contentSha256, itemIndex: 0 })
      ]);
      expect(accepted).toEqual([
        expect.objectContaining({
          inputId: inputChunks[0].inputId,
          itemIndex: 0,
          executionId: started[0].executionId,
          runId: `run-${agent.agentId}`
        })
      ]);
      expect(outputChunks).toEqual([
        expect.objectContaining({
          outputId: output.outputID,
          outputType: "final",
          content: "trajectory final"
        })
      ]);
      expect(terminal).toEqual([
        expect.objectContaining({ executionId: started[0].executionId, status: "finished" })
      ]);
    } finally {
      log.mockRestore();
      createAgent.mockRestore();
      agent.close();
    }
  });

  it("registers changing client tools as local SDK custom tools", () => {
    const baseInput = {
      apiKey: "test-key",
      model: "composer-2.5",
      workingDirectory: "/tmp/project",
      sessionKey: "shared-session",
      clientTools: [
        {
          name: "webfetch",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"]
          }
        }
      ]
    };
    const dynamicInput = {
      ...baseInput,
      clientTools: [
        {
          name: "webfetch",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"]
          }
        },
        {
          name: "probe_write_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" }
            },
            required: ["path", "content"]
          }
        }
      ]
    };

    const baseSendOptions = localAgentSendOptions(baseInput);
    const dynamicSendOptions = localAgentSendOptions(dynamicInput);

    expect(Object.keys(baseSendOptions.local.customTools)).toEqual(["webfetch"]);
    expect(Object.keys(dynamicSendOptions.local.customTools)).toEqual([
      "webfetch",
      "probe_write_file"
    ]);
    expect(baseSendOptions.local.customTools.webfetch.inputSchema).toEqual(
      baseInput.clientTools[0].parameters
    );
    expect(typeof dynamicSendOptions.local.customTools.probe_write_file.execute).toBe("function");
    expect(baseSendOptions).not.toHaveProperty("mcpServers");
    expect(dynamicSendOptions).not.toHaveProperty("mcpServers");
  });
});
