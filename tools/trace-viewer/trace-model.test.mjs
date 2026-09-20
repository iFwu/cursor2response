import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseTraceText, TRAJECTORY_PRIORITY } from "./trace-model.mjs";

const line = (value) => JSON.stringify(value);
const at = (seconds) => `2026-08-24T10:00:${String(seconds).padStart(2, "0")}.000Z`;

test("retains hybrid route provenance without exposing unrelated upstream credentials", () => {
  const result = parseTraceText(JSON.stringify(base("trajectory_route_decision", 1, {
    route: "fallback", routeCause: "sdk_context_overflow", logicalModel: "grok-hybrid",
    upstreamModel: "mp-grok-4.6", routeStickyHit: false, contextRetrySafe: true,
    fallbackAttempted: true, authorization: "secret", requestId: "request-route"
  })));
  const session = result.sessions[0];
  assert.equal(session.projections[0].kind, "context_decision");
  assert.equal(session.projections[0].title, "Switch to fallback upstream");
  assert.equal(session.events[0].fields.upstreamModel, "mp-grok-4.6");
  assert.equal(session.events[0].fields.contextRetrySafe, true);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

function base(event, seconds, fields = {}) {
  return {
    event,
    trajectorySchemaVersion: 1,
    eventId: `${event}-${seconds}-${fields.requestId ?? fields.inputId ?? fields.outputId ?? fields.executionId ?? "event"}`,
    serviceInvocationId: "test-invocation",
    wallTime: at(seconds),
    sessionKey: "session-a",
    ...fields
  };
}

test("builds a v3 session graph with Agent lane and paired input/final projections", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial",
      replayKind: "none", attemptIndex: 0, inputIds: ["input-1"], clientSource: "codex", clientPlatform: "linux",
      model: { id: "grok-4.6", params: [{ id: "fast", value: "true" }] }
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-1", source: "user", ingressRequestId: "ingress-1",
      contentSha256: "sha-input", chunkIndex: 0, chunkCount: 2, totalChars: 15, content: "Inspect the "
    }),
    base("trajectory_input_content_chunk", 2, {
      inputId: "input-1", source: "user", ingressRequestId: "ingress-1",
      contentSha256: "sha-input", chunkIndex: 1, chunkCount: 2, totalChars: 15, content: "service"
    }),
    base("trajectory_input_accepted", 3, {
      inputId: "input-1", source: "user", requestId: "request-1",
      executionId: "execution-1", agentId: "agent-1", runId: "run-1", acceptedAt: at(3)
    }),
    base("trajectory_execution_started", 4, {
      executionId: "execution-1", requestId: "request-1", agentId: "agent-1", runId: "run-1", status: "running"
    }),
    base("trajectory_output_content_chunk", 5, {
      outputId: "output-1", outputType: "final", executionId: "execution-1",
      agentId: "agent-1", runId: "run-1", chunkIndex: 0, chunkCount: 1, totalChars: 4, content: "Done"
    }),
    base("trajectory_output_published", 6, {
      outputId: "output-1", outputType: "final", responseId: "response-1",
      ingressRequestId: "ingress-1", executionId: "execution-1", agentId: "agent-1",
      runId: "run-1", publicationKind: "completed", publishedAt: at(6)
    }),
    base("trajectory_execution_terminal", 7, {
      executionId: "execution-1", requestId: "request-1", agentId: "agent-1", runId: "run-1", status: "finished"
    })
  ].map(line).join("\n"));

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.title, "Inspect the service");
  assert.equal(session.status, "completed");
  assert.equal(session.partial, false);
  const input = session.projections.find((item) => item.kind === "user_input");
  assert.equal(input.content, "Inspect the service");
  assert.deepEqual(input.executionIds, ["execution-1"]);
  const final = session.projections.find((item) => item.kind === "final_output");
  assert.equal(final.content, "Done");
  assert.equal(final.status, "published");
  assert.equal(final.executionId, "execution-1");
  assert.equal(session.lanes.find((lane) => lane.agentId === "agent-1").status, "finished");
  assert.ok(session.graph.edges.some((edge) => edge.type === "execution"));
  assert.deepEqual(session.clientSources, ["codex"]);
  assert.deepEqual(session.clientPlatforms, ["linux"]);
  assert.equal(session.models[0].id, "grok-4.6");
});

test("keeps request replay on the timeline without repeating stable input content", () => {
  const repeatedChunk = {
    inputId: "input-1", source: "user", contentSha256: "sha-input",
    chunkIndex: 0, chunkCount: 1, totalChars: 14, content: "same user text"
  };
  const result = parseTraceText([
    base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial",
      replayKind: "none", attemptIndex: 0, inputIds: ["input-1"]
    }),
    base("trajectory_input_content_chunk", 1, { ...repeatedChunk, ingressRequestId: "ingress-1" }),
    base("trajectory_input_accepted", 2, {
      inputId: "input-1", source: "user", requestId: "request-1",
      executionId: "execution-1", agentId: "agent-1", runId: "run-1"
    }),
    base("trajectory_request", 3, {
      ingressRequestId: "ingress-1", requestId: "request-2", parentRequestId: "request-1",
      requestKind: "continuation", attemptIndex: 0, transcriptItemCount: 4,
      replayedTranscriptItemCount: 3, transcriptSha256: "sha-transcript"
    }),
    base("trajectory_replay", 4, {
      requestId: "request-2", replayKind: "client_transcript", replayCause: "request_contains_history",
      transcriptItemCount: 4, replayedTranscriptItemCount: 3, transcriptSha256: "sha-transcript"
    }),
    base("trajectory_request", 5, {
      ingressRequestId: "ingress-1", requestId: "request-3", parentRequestId: "request-2",
      requestKind: "retry", replayKind: "transport_retry", replayCause: "connection_reset",
      attemptIndex: 1, inputIds: ["input-1"]
    }),
    base("trajectory_replay", 6, {
      executionId: "execution-2", requestId: "request-3", agentId: "agent-1",
      replayKind: "transport_retry", replayCause: "connection_reset", transcriptItemCount: 1
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  const users = session.projections.filter((item) => item.kind === "user_input");
  assert.equal(users.length, 1);
  assert.equal(users[0].content, "same user text");
  assert.deepEqual(users[0].executionIds, ["execution-1"]);
  const replays = session.projections.filter((item) => item.kind === "replay");
  assert.deepEqual(replays.map((item) => item.replayKind), ["transport_retry", "transport_retry"]);
  assert.equal(replays.every((item) => item.content === null), true);
  const clientReplay = session.events.find((event) => event.fields.replayKind === "client_transcript");
  assert.equal(clientReplay?.fields.replayedTranscriptItemCount, 3);
  assert.equal(clientReplay?.fields.transcriptSha256, "sha-transcript");
  const historyCheck = session.projections.find((item) => item.replayKind === "client_transcript" && item.title === "客户端携带历史");
  assert.equal(historyCheck?.kind, "metadata");
  assert.equal(historyCheck?.severity, "normal");
  assert.equal(historyCheck?.replayedTranscriptItemCount, 3);
  assert.equal(historyCheck?.transcriptItemCount, 4);
  assert.equal(historyCheck?.transcriptSha256, "sha-transcript");
});

test("keeps SDK context replay prominent while demoting routine context decisions", () => {
  const result = parseTraceText([
    base("trajectory_context_decision", 0, {
      requestId: "request-1", executionId: "execution-1", agentId: "agent-1",
      decision: "start_full", decisionCause: "first_turn", sentPromptChars: 100
    }),
    base("trajectory_context_decision", 1, {
      requestId: "request-2", executionId: "execution-1", agentId: "agent-1",
      decision: "continue_run"
    }),
    base("trajectory_context_decision", 2, {
      requestId: "request-3", executionId: "execution-2", agentId: "agent-2",
      decision: "start_full", decisionCause: "agent_transcript_diverged"
    }),
    base("trajectory_replay", 3, {
      requestId: "request-3", executionId: "execution-2", agentId: "agent-2",
      replayKind: "sdk_context", replayCause: "agent_transcript_diverged",
      contextItemCount: 41, checkpointHash: "checkpoint-hash"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  const decisions = session.projections.filter((item) => item.decision);
  assert.equal(decisions.every((item) => item.kind === "metadata"), true);
  const replay = session.projections.find((item) => item.kind === "replay");
  assert.equal(replay.replayKind, "sdk_context");
  assert.equal(replay.severity, "warning");
  assert.equal(replay.contextItemCount, 41);
  assert.equal(replay.checkpointHash, "checkpoint-hash");
});

test("projects the Codex AGENTS wrapper for Superconductor Chat and titles the session from real input", () => {
  const agents = "# AGENTS.md instructions for /home/example/project\n\n<INSTRUCTIONS>\n- Language: reply in Chinese.\n</INSTRUCTIONS>";
  const result = parseTraceText([
    base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial",
      attemptIndex: 0, clientSource: "superconductor"
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-agents", source: "user", chunkIndex: 0, itemIndex: 0, content: agents
    }),
    base("trajectory_input_accepted", 2, {
      inputId: "input-agents", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    }),
    base("trajectory_input_content_chunk", 3, {
      inputId: "input-user", source: "user", chunkIndex: 0, itemIndex: 1, content: "帮我修 statusline"
    }),
    base("trajectory_input_accepted", 4, {
      inputId: "input-user", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.title, "帮我修 statusline");
  const users = session.projections.filter((item) => item.kind === "user_input");
  assert.deepEqual(users.map((item) => item.content), ["帮我修 statusline"]);
  const harness = session.projections.filter((item) => item.kind === "harness_context");
  assert.deepEqual(harness.map((item) => [item.inputId, item.content, item.secondary]), [
    ["input-agents", agents, true]
  ]);
  const chunk = session.events.find((event) => event.fields.inputId === "input-agents" && event.event === "trajectory_input_content_chunk");
  assert.equal(chunk.fields.itemIndex, 0);
});

test("splits the OpenClaw inbound envelope while keeping one accepted Input fact", () => {
  const runtimeContext = [
    "OpenClaw runtime context for the immediately preceding user message.",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "System: model switched.",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"
  ].join("\n");
  const envelope = [
    "[Tue 2026-08-25 11:42 GMT+8] Conversation info (untrusted metadata):",
    "```json",
    "{ \"chat_id\": \"telegram:1\" }",
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    "{ \"name\": \"BK\" }",
    "```",
    "",
    "sub2api 的重试机制是不是丢了？"
  ].join("\n");
  const result = parseTraceText([
    base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial",
      attemptIndex: 0, clientSource: "openclaw"
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-runtime", source: "user", chunkIndex: 0, itemIndex: 0, content: runtimeContext
    }),
    base("trajectory_input_accepted", 2, {
      inputId: "input-runtime", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    }),
    base("trajectory_input_content_chunk", 3, {
      inputId: "input-user", source: "user", chunkIndex: 0, itemIndex: 1, content: envelope
    }),
    base("trajectory_input_accepted", 4, {
      inputId: "input-user", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    }),
    base("trajectory_execution_started", 5, {
      executionId: "execution-1", requestId: "request-1", agentId: "agent-1", runId: "run-1", status: "running"
    }),
    base("trajectory_output_content_chunk", 6, {
      outputId: "output-1", outputType: "final", executionId: "execution-1",
      agentId: "agent-1", runId: "run-1", chunkIndex: 0, content: "已恢复"
    }),
    base("trajectory_output_published", 7, {
      outputId: "output-1", outputType: "final", ingressRequestId: "ingress-1",
      executionId: "execution-1", agentId: "agent-1", runId: "run-1", publicationKind: "completed"
    }),
    base("trajectory_execution_terminal", 8, {
      executionId: "execution-1", requestId: "request-1", agentId: "agent-1", runId: "run-1", status: "finished"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.status, "completed");
  assert.equal(session.title, "sub2api 的重试机制是不是丢了？");
  const users = session.projections.filter((item) => item.kind === "user_input");
  assert.deepEqual(users.map((item) => [item.inputId, item.content]), [
    ["input-user", "sub2api 的重试机制是不是丢了？"]
  ]);
  assert.deepEqual(users[0].executionIds, ["execution-1"]);
  const harness = session.projections.filter((item) => item.kind === "harness_context");
  assert.deepEqual(harness.map((item) => item.inputId), ["input-runtime", "input-user"]);
  assert.ok(harness[1].content.startsWith("[Tue 2026-08-25 11:42 GMT+8] Conversation info"));
  assert.ok(!harness[1].content.includes("sub2api"));
});

test("matches the combined Codex AGENTS + environment_context item behind a UA-rewriting gateway", () => {
  const combined = [
    "# AGENTS.md instructions for /home/example/project",
    "",
    "<INSTRUCTIONS>",
    "- Language: reply in Chinese.",
    "</INSTRUCTIONS>",
    "<environment_context>",
    "  <cwd>/home/example/project</cwd>",
    "</environment_context>"
  ].join("\n");
  const result = parseTraceText([
    base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial",
      attemptIndex: 0, clientSource: "unknown"
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-harness", source: "user", chunkIndex: 0, content: combined
    }),
    base("trajectory_input_accepted", 2, {
      inputId: "input-harness", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    }),
    base("trajectory_input_content_chunk", 3, {
      inputId: "input-user", source: "user", chunkIndex: 0, content: "statusline 不见了，帮我看看"
    }),
    base("trajectory_input_accepted", 4, {
      inputId: "input-user", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.title, "statusline 不见了，帮我看看");
  assert.deepEqual(session.projections.filter((item) => item.kind === "harness_context").map((item) => item.inputId), ["input-harness"]);
  assert.equal(session.projections.filter((item) => item.kind === "user_input").length, 1);
});

test("keeps user text that merely resembles a Harness wrapper as user input", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial",
      attemptIndex: 0, clientSource: "openclaw"
    }),
    // Codex wrapper shape under an OpenClaw session: source gating keeps it as user input.
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-1", source: "user", chunkIndex: 0,
      content: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nquoted\n</INSTRUCTIONS>"
    }),
    base("trajectory_input_accepted", 2, {
      inputId: "input-1", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    }),
    // Sentinel mentioned mid-text, not as the leading envelope: no split.
    base("trajectory_input_content_chunk", 3, {
      inputId: "input-2", source: "user", chunkIndex: 0,
      content: "提到 Conversation info (untrusted metadata): 的消息是什么意思？"
    }),
    base("trajectory_input_accepted", 4, {
      inputId: "input-2", source: "user", requestId: "request-1", executionId: "execution-1", agentId: "agent-1"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.projections.filter((item) => item.kind === "harness_context").length, 0);
  assert.equal(session.projections.filter((item) => item.kind === "user_input").length, 2);
});

test("classifies steering inputs and the turn-aborted control marker", () => {
  const marker = [
    "<turn_aborted>",
    "The user interrupted the previous turn on purpose.",
    "</turn_aborted>"
  ].join("\n");
  const result = parseTraceText([
    base("trajectory_request", 0, {
      requestId: "request-initial", ingressRequestId: "response-initial", requestKind: "initial"
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-initial", source: "user", requestId: "request-initial", chunkIndex: 0, content: "Inspect"
    }),
    base("trajectory_input_accepted", 2, {
      inputId: "input-initial", source: "user", requestId: "request-initial", executionId: "execution-1"
    }),
    base("trajectory_request", 3, {
      requestId: "request-steer", ingressRequestId: "response-steer", requestKind: "steering"
    }),
    base("trajectory_input_content_chunk", 4, {
      inputId: "input-aborted", source: "user", requestId: "request-steer", chunkIndex: 0, content: marker
    }),
    base("trajectory_input_accepted", 5, {
      inputId: "input-aborted", source: "user", requestId: "request-steer", executionId: "execution-1"
    }),
    base("trajectory_input_content_chunk", 6, {
      inputId: "input-steer", source: "user", requestId: "request-steer", chunkIndex: 0, content: "Inspect SSH instead"
    }),
    base("trajectory_input_accepted", 7, {
      inputId: "input-steer", source: "user", requestId: "request-steer", executionId: "execution-1"
    })
  ].map(line).join("\n"));

  const inputs = result.sessions[0].projections.filter((item) => ["user_input", "turn_aborted"].includes(item.kind));
  assert.deepEqual(inputs.map((item) => [item.kind, item.requestKind, item.executionIds]), [
    ["user_input", "initial", ["execution-1"]],
    ["turn_aborted", "steering", ["execution-1"]],
    ["user_input", "steering", ["execution-1"]]
  ]);
});

test("keeps commentary outputs separate across a tool call", () => {
  const result = parseTraceText([
    base("trajectory_execution_started", 0, {
      executionId: "execution-1", requestId: "request-1", agentId: "agent-1", runId: "run-1", status: "running"
    }),
    base("trajectory_output_content_chunk", 1, {
      outputId: "commentary-1", outputType: "commentary", executionId: "execution-1",
      agentId: "agent-1", runId: "run-1", chunkIndex: 0, chunkCount: 1, content: "Before tool"
    }),
    base("trajectory_output_content_chunk", 2, {
      outputId: "tool-1", outputType: "tool_call", executionId: "execution-1",
      agentId: "agent-1", runId: "run-1", callId: "call-1", toolName: "exec",
      chunkIndex: 0, chunkCount: 1, content: "{\"cmd\":\"pwd\"}"
    }),
    base("trajectory_output_published", 3, {
      outputId: "tool-1", outputType: "tool_call", responseId: "response-tool",
      ingressRequestId: "ingress-1", executionId: "execution-1", agentId: "agent-1", runId: "run-1",
      publicationKind: "completed"
    }),
    base("trajectory_output_content_chunk", 4, {
      outputId: "commentary-2", outputType: "commentary", executionId: "execution-1",
      agentId: "agent-1", runId: "run-1", chunkIndex: 0, chunkCount: 1, content: "After tool"
    })
  ].map(line).join("\n"));

  const contentItems = result.sessions[0].projections.filter((item) => ["commentary", "tool_call"].includes(item.kind));
  assert.deepEqual(contentItems.map((item) => [item.kind, item.content]), [
    ["commentary", "Before tool"],
    ["tool_call", "{\"cmd\":\"pwd\"}"],
    ["commentary", "After tool"]
  ]);
  assert.equal(contentItems[0].secondary, true);
  assert.equal(contentItems[2].secondary, true);
});

test("retains failed and provisional Agent lanes after a transition", () => {
  const result = parseTraceText([
    base("trajectory_execution_started", 0, {
      executionId: "execution-old", requestId: "request-1", agentId: "agent-old", runId: "run-old", status: "running"
    }),
    base("trajectory_output_content_chunk", 1, {
      outputId: "commentary-old", outputType: "commentary", executionId: "execution-old",
      agentId: "agent-old", runId: "run-old", provisional: true, chunkIndex: 0, chunkCount: 1, content: "Partial"
    }),
    base("trajectory_execution_terminal", 2, {
      executionId: "execution-old", requestId: "request-1", agentId: "agent-old", runId: "run-old", status: "failed", errorCode: "context_lost"
    }),
    base("trajectory_agent_transition", 3, {
      fromAgentId: "agent-old", toAgentId: "agent-new", transitionKind: "replaced",
      transitionCause: "context_lost", executionId: "execution-new"
    }),
    base("trajectory_execution_started", 4, {
      executionId: "execution-new", requestId: "request-2", agentId: "agent-new", runId: "run-new", status: "running"
    }),
    base("trajectory_execution_terminal", 5, {
      executionId: "execution-new", requestId: "request-2", agentId: "agent-new", runId: "run-new", status: "finished"
    })
  ].map(line).join("\n"));

  const lanes = result.sessions[0].lanes;
  const failed = lanes.find((lane) => lane.agentId === "agent-old");
  const replacement = lanes.find((lane) => lane.agentId === "agent-new");
  assert.equal(failed.status, "failed");
  assert.equal(failed.provisional, true);
  assert.equal(failed.failureCount, 1);
  assert.equal(replacement.status, "finished");
  assert.ok(result.sessions[0].projections.some((item) => item.kind === "agent_transition"));
});

test("classifies a successfully recovered SDK compaction as normal", () => {
  const result = parseTraceText([
    base("trajectory_error", 0, {
      requestId: "request-old", executionId: "execution-old", agentId: "agent-old",
      errorCode: "cursor_sdk_context_compacted", phase: "run", retryable: false, terminal: true
    }),
    base("trajectory_execution_terminal", 1, {
      requestId: "request-old", executionId: "execution-old", agentId: "agent-old", status: "failed",
      errorCode: "cursor_sdk_context_compacted"
    }),
    base("trajectory_agent_transition", 2, {
      requestId: "request-retry", fromAgentId: "agent-old", toAgentId: "agent-new",
      transitionKind: "replaced", transitionCause: "agent_replaced"
    }),
    base("trajectory_context_decision", 3, {
      requestId: "request-retry", executionId: "execution-new", agentId: "agent-new",
      decision: "start_full", decisionCause: "agent_state_dirty"
    }),
    base("trajectory_replay", 4, {
      requestId: "request-retry", executionId: "execution-new", agentId: "agent-new",
      replayKind: "sdk_context", replayCause: "agent_state_dirty"
    }),
    base("trajectory_execution_terminal", 5, {
      requestId: "request-retry", executionId: "execution-new", agentId: "agent-new", status: "finished"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.severity, "normal");
  assert.equal(session.issueCount, 0);
  assert.equal(session.lanes.find((lane) => lane.agentId === "agent-old").failureCount, 0);
  assert.equal(session.compactionRecoveries.length, 1);
  assert.equal(session.events.find((event) => event.event === "trajectory_error").recoveryKind, "context_compaction");
  assert.ok(session.projections.some((item) => item.kind === "recovery" && item.title === "Context compaction recovery"));
});

test("keeps warning and error issue counts distinct", () => {
  const result = parseTraceText([
    base("trajectory_agent_transition", 0, {
      requestId: "request-warning", fromAgentId: "agent-old", toAgentId: "agent-new",
      transitionKind: "replaced", transitionCause: "agent_bootstrap_mismatch"
    }),
    base("trajectory_replay", 1, {
      requestId: "request-warning", replayKind: "sdk_context", replayCause: "agent_bootstrap_mismatch"
    }),
    base("trajectory_error", 2, {
      requestId: "request-error", errorCode: "context_length_exceeded", phase: "run", retryable: false, terminal: true
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.issueCount, 2);
  assert.equal(session.warningCount, 1);
  assert.equal(session.errorCount, 1);
});

test("treats expected SDK cancellation as a notice, not a failure", () => {
  const result = parseTraceText([
    base("trajectory_error", 0, {
      requestId: "request-cancelled", executionId: "execution-cancelled", agentId: "agent-cancelled",
      errorCode: "cursor_sdk_cancelled", phase: "public_response_stream", retryable: false, terminal: true
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  const event = session.events[0];
  const projection = session.projections.find((item) => item.sourceEventIds.includes(event.id));
  assert.equal(event.severity, "notice");
  assert.equal(session.severity, "notice");
  assert.equal(session.issueCount, 0);
  assert.equal(session.lanes[0].failureCount, 0);
  assert.equal(projection.kind, "metadata");
  assert.equal(projection.title, "Request cancelled");
});

test("keeps an unresolved SDK compaction as an error", () => {
  const result = parseTraceText([
    base("trajectory_error", 0, {
      requestId: "request-old", executionId: "execution-old", agentId: "agent-old",
      errorCode: "cursor_sdk_context_compacted", phase: "run", retryable: false, terminal: true
    }),
    base("trajectory_execution_terminal", 1, {
      requestId: "request-old", executionId: "execution-old", agentId: "agent-old", status: "failed",
      errorCode: "cursor_sdk_context_compacted"
    }),
    base("trajectory_agent_transition", 2, {
      requestId: "request-retry", fromAgentId: "agent-old", toAgentId: "agent-new",
      transitionKind: "replaced", transitionCause: "agent_replaced"
    }),
    base("trajectory_context_decision", 3, {
      requestId: "request-retry", executionId: "execution-new", agentId: "agent-new",
      decision: "start_full", decisionCause: "agent_state_dirty"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.severity, "error");
  assert.ok(session.issueCount > 0);
  assert.equal(session.compactionRecoveries.length, 0);
});

test("uses the first real user input as the session title", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, { requestId: "request-1", requestKind: "initial" }),
    base("trajectory_input_content_chunk", 1, { inputId: "input-1", source: "user", chunkIndex: 0, content: "first question" }),
    base("trajectory_input_accepted", 2, { inputId: "input-1", source: "user", requestId: "request-1", executionId: "execution-1" }),
    base("trajectory_input_content_chunk", 3, { inputId: "input-2", source: "user", chunkIndex: 0, content: "replayed prefix followed by another question" }),
    base("trajectory_input_accepted", 4, { inputId: "input-2", source: "user", requestId: "request-2", executionId: "execution-2" })
  ].map(line).join("\n"));

  assert.equal(result.sessions[0].title, "first question");
});

test("uses the projection priority contract when timestamps are equal", () => {
  const sameTime = at(0);
  const result = parseTraceText([
    base("trajectory_context_checkpoint", 0, { wallTime: sameTime, checkpointHash: "checkpoint-1" }),
    base("trajectory_replay", 0, { wallTime: sameTime, executionId: "execution-1", agentId: "agent-1", replayKind: "sdk_context" }),
    base("trajectory_input_content_chunk", 0, { wallTime: sameTime, inputId: "input-1", source: "user", chunkIndex: 0, content: "hello" }),
    base("trajectory_input_accepted", 0, { wallTime: sameTime, inputId: "input-1", source: "user", executionId: "execution-1", agentId: "agent-1" })
  ].map(line).join("\n"));

  assert.deepEqual(result.sessions[0].projections.map((item) => item.kind), ["user_input", "replay", "checkpoint"]);
  assert.ok(TRAJECTORY_PRIORITY.user_input < TRAJECTORY_PRIORITY.replay);
  assert.ok(TRAJECTORY_PRIORITY.replay < TRAJECTORY_PRIORITY.checkpoint);
});

test("unwraps journald v3 records and strips payload fields outside content events", () => {
  const result = parseTraceText(line({
    __REALTIME_TIMESTAMP: "1787392800000000",
    _SYSTEMD_INVOCATION_ID: "inv-journal",
    _SYSTEMD_USER_UNIT: "cursor2response-sidecar.service",
    MESSAGE: line({
      event: "trajectory_execution_started",
      trajectorySchemaVersion: 1,
      eventId: "event-journal-started",
      serviceInvocationId: "bridge-journal",
      sessionKey: "session-a",
      requestId: "request-1",
      executionId: "execution-1",
      agentId: "agent-1",
      status: "running",
      content: "must be stripped",
      secret: "must be stripped"
    })
  }));

  const event = result.sessions[0].events[0];
  assert.equal(event.invocationId, "bridge-journal");
  assert.equal(event.unit, "cursor2response-sidecar.service");
  assert.equal("content" in event.fields, false);
  assert.equal(result.diagnostics.strippedFields, 2);
});

test("ignores v2 events instead of applying a legacy compatibility projection", () => {
  const result = parseTraceText([
    line({ event: "sdk_bridge_request", sessionKey: "legacy", requestId: "request-old" }),
    line(base("trajectory_request", 0, {
      ingressRequestId: "ingress-1", requestId: "request-1", requestKind: "initial", replayKind: "none", attemptIndex: 0
    }))
  ].join("\n"));

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.diagnostics.ignoredRecords, 1);
  assert.deepEqual(result.sessions.map((session) => session.id), ["session-a"]);
});

test("marks a bounded journal window partial without inventing missing facts", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      requestId: "request-late",
      parentRequestId: "request-outside-window",
      requestKind: "continuation"
    }),
    base("trajectory_input_accepted", 1, {
      requestId: "request-late",
      inputId: "input-outside-window",
      source: "user",
      executionId: "execution-late",
      agentId: "agent-late",
      runId: "run-late"
    })
  ].map(line).join("\n"));

  assert.equal(result.sessions[0].partial, true);
  assert.deepEqual(result.sessions[0].partialReasons, [
    "session_start_outside_window",
    "missing_parent_request",
    "missing_input_content"
  ]);
});

test("accepts a parentless attempt-zero steering request as the session root", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      requestId: "request-after-compaction",
      requestKind: "steering",
      attemptIndex: 0
    }),
    base("trajectory_execution_started", 1, {
      requestId: "request-after-compaction",
      executionId: "execution-after-compaction",
      agentId: "agent-after-compaction",
      runId: "run-after-compaction",
      status: "running"
    })
  ].map(line).join("\n"));

  assert.equal(result.sessions[0].partial, false);
  assert.deepEqual(result.sessions[0].partialReasons, []);
});

test("labels an observed OpenClaw compaction request without merging its session", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      requestId: "request-compaction",
      requestKind: "initial",
      requestPurpose: "compaction",
      sessionSource: "generated",
      attemptIndex: 0,
      clientSource: "openclaw",
      clientPlatform: "unknown"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.title, "OpenClaw 压缩请求");
  assert.deepEqual(session.requestPurposes, ["compaction"]);
  assert.equal(session.projections.find((item) => item.requestId === "request-compaction")?.title, "OpenClaw 压缩请求");
});

test("backfills compaction purpose from accepted OpenClaw summary content", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      requestId: "request-compaction",
      requestKind: "initial",
      attemptIndex: 0,
      clientSource: "openclaw"
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-compaction",
      source: "user",
      chunkIndex: 0,
      content: "<conversation>\n[User]: inspect\n</conversation>\n\nThe messages above are a conversation to summarize. Create a structured context checkpoint summary."
    }),
    base("trajectory_input_accepted", 2, {
      requestId: "request-compaction",
      inputId: "input-compaction",
      source: "user",
      executionId: "execution-compaction"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.title, "OpenClaw 压缩请求");
  assert.deepEqual(session.requestPurposes, ["compaction"]);
  assert.equal(session.events.find((event) => event.event === "trajectory_request")?.fields.requestPurpose, undefined);
});

test("keeps the conversation title when a session also contains a compaction request", () => {
  const result = parseTraceText([
    base("trajectory_request", 0, {
      requestId: "request-user",
      requestKind: "initial",
      attemptIndex: 0,
      clientSource: "openclaw"
    }),
    base("trajectory_input_content_chunk", 1, {
      inputId: "input-user",
      source: "user",
      chunkIndex: 0,
      content: "继续检查服务"
    }),
    base("trajectory_input_accepted", 2, {
      requestId: "request-user",
      inputId: "input-user",
      source: "user",
      executionId: "execution-user"
    }),
    base("trajectory_request", 3, {
      requestId: "request-compaction",
      parentRequestId: "request-user",
      requestKind: "continuation",
      requestPurpose: "compaction",
      attemptIndex: 0,
      clientSource: "openclaw"
    })
  ].map(line).join("\n"));

  const session = result.sessions[0];
  assert.equal(session.title, "继续检查服务");
  assert.equal(session.projections.find((item) => item.requestId === "request-compaction")?.title, "OpenClaw 压缩请求");
});

test("loads the bundled v3 demo fixture", async () => {
  const fixture = await readFile(new URL("./fixtures/demo.jsonl", import.meta.url), "utf8");
  const result = parseTraceText(fixture, { name: "demo.jsonl" });
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.sessions.length, 3);
  assert.ok(result.sessions.some((session) => session.lanes.length > 1));
  assert.ok(result.sessions.some((session) => session.severity === "error"));
  assert.ok(result.sessions.some((session) => session.projections.some((item) => item.kind === "user_input")));
});
