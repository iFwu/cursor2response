import { expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { EMPTY_RESPONSES_TURN_MESSAGE } from "../core/openai.ts";

const host = "127.0.0.1";
const serverPath = fileURLToPath(new URL("../dist/runtime/sidecar/server.js", import.meta.url));

test("reports missing local Bridge configuration through Responses", async () => {
  const sidecarPort = await reservePort();
  const sidecar = spawn(process.execPath, [serverPath], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(sidecarPort),
      CURSOR_API_KEY: "cursor-test-key",
      CURSOR_SDK_BRIDGE_URL: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const childOutput: Buffer[] = [];
  sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
  sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
  try {
    await waitForSidecar(sidecarPort, sidecar, childOutput);
    const response = await fetch(`http://${host}:${sidecarPort}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", input: "Hello" })
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "cursor_sdk_bridge_missing", message: expect.stringContaining("CURSOR_SDK_BRIDGE_URL") }
    });
  } finally {
    await stopChild(sidecar);
  }
}, 10_000);

test("closes the SDK bridge request at the server deadline without a client disconnect signal", async () => {
  let bridgeResponse: ServerResponse | undefined;
  let bridgeRequests = 0;
  let cancelRequests = 0;
  let bridgeRequestBody: Record<string, unknown> | undefined;
  let sidecar: ChildProcess | undefined;
  let client: ChildProcess | undefined;
  let resolveBridgeStarted!: () => void;
  let resolveBridgeClosed!: () => void;
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "cursor2response-sidecar-timeout-trace-"));
  const bridgeStarted = new Promise<void>((resolve) => { resolveBridgeStarted = resolve; });
  const bridgeClosed = new Promise<void>((resolve) => { resolveBridgeClosed = resolve; });
  const bridge = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/sdk/cancel") {
      cancelRequests += 1;
      request.resume();
      bridgeResponse?.destroy();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true,"cancelled":true}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/sdk") {
      response.writeHead(404).end();
      return;
    }
    bridgeRequests += 1;
    const requestChunks: Buffer[] = [];
    request.on("data", (chunk) => requestChunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      bridgeRequestBody = JSON.parse(Buffer.concat(requestChunks).toString("utf8"));
    });
    bridgeResponse = response;
    response.on("close", () => {
      resolveBridgeClosed();
    });
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    response.flushHeaders();
    resolveBridgeStarted();
  });

  try {
    const bridgePort = await listenOnRandomPort(bridge);
    const sidecarPort = await reservePort();
    sidecar = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        HOST: host,
        PORT: String(sidecarPort),
        CURSOR_API_KEY: "cursor-test-key",
        CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`,
        CURSOR_SDK_BRIDGE_TIMEOUT_MS: "100",
        CURSOR2RESPONSE_FAILURE_TRACE_DIR: traceDirectory
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childOutput: Buffer[] = [];
    sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    await waitForSidecar(sidecarPort, sidecar, childOutput);

    const payload = JSON.stringify({ model: "grok-4.6", stream: true, input: "Keep running" });
    client = spawn(process.execPath, ["-e", streamingClientSource, payload, String(sidecarPort)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await Promise.all([firstChunk(client), bridgeStarted]);

    const closedPromptly = await Promise.race([
      bridgeClosed.then(() => true),
      delay(500).then(() => false)
    ]);
    if (!closedPromptly) console.error(Buffer.concat(childOutput).toString("utf8"));
    expect(closedPromptly).toBe(true);
    await delay(150);
    expect(bridgeRequests).toBe(1);
    expect(cancelRequests).toBe(1);
    await waitFor(() => bridgeRequestBody !== undefined);
    expect(bridgeRequestBody).toMatchObject({
      clientSource: "openclaw"
    });
    const cacheObservation = Buffer.concat(childOutput).toString("utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      })
      .find((record) => record.tag === "cache-observe");
    expect(cacheObservation).toMatchObject({
      requestId: bridgeRequestBody?.requestId,
      sessionKey: bridgeRequestBody?.sessionKey,
      clientSource: "openclaw"
    });
    const artifact = await readOnlyGzipArtifact(traceDirectory);
    expect(artifact).toMatchObject({
      request: {
        body: { model: "grok-4.6", stream: true, input: "Keep running" },
        clientSource: "openclaw"
      },
      failure: { status: 504, code: "cursor_sdk_bridge_timeout" }
    });
    expect(artifact.events.map((event: { sse: string }) => event.sse).join(""))
      .toContain("event: response.failed");
    expect(JSON.stringify(artifact)).not.toContain("cursor-test-key");
    const [artifactName] = await readdir(traceDirectory);
    expect((await stat(traceDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(traceDirectory, artifactName))).mode & 0o777).toBe(0o600);
  } finally {
    await stopChild(client);
    bridgeResponse?.destroy();
    await stopChild(sidecar);
    await closeServer(bridge);
    await rm(traceDirectory, { recursive: true, force: true });
  }
}, 15_000);

test("does not capture a manual client disconnect", async () => {
  let bridgeResponse: ServerResponse | undefined;
  let bridgeRequests = 0;
  let cancelRequests = 0;
  let sidecar: ChildProcess | undefined;
  let client: ChildProcess | undefined;
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "cursor2response-sidecar-disconnect-trace-"));
  const bridge = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/sdk/cancel") {
      cancelRequests += 1;
      request.resume();
      bridgeResponse?.destroy();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true,"cancelled":true}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/sdk") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    bridgeRequests += 1;
    request.resume();
    bridgeResponse = response;
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    response.flushHeaders();
    response.write(`${JSON.stringify({ type: "text", text: "Started" })}\n`);
  });

  try {
    const bridgePort = await listenOnRandomPort(bridge);
    const sidecarPort = await reservePort();
    sidecar = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        HOST: host,
        PORT: String(sidecarPort),
        CURSOR_API_KEY: "cursor-test-key",
        CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`,
        CURSOR_SDK_BRIDGE_TIMEOUT_MS: "5000",
        CURSOR2RESPONSE_FAILURE_TRACE_DIR: traceDirectory
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childOutput: Buffer[] = [];
    sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    await waitForSidecar(sidecarPort, sidecar, childOutput);

    const payload = JSON.stringify({ model: "grok-4.6", stream: true, input: "Disconnect now" });
    client = spawn(process.execPath, ["-e", disconnectingClientSource, payload, String(sidecarPort)], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await Promise.all([firstChunk(client), waitFor(() => bridgeRequests === 1)]);
    await waitFor(() => cancelRequests === 1);
    await delay(200);
    const trajectoryError = Buffer.concat(childOutput)
      .toString("utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      })
      .find((record) => record.event === "trajectory_error");
    expect(trajectoryError).toMatchObject({
      errorCode: "cursor_sdk_cancelled",
      phase: "public_response_stream",
      retryable: false,
      terminal: true
    });
    expect(await readdir(traceDirectory)).toEqual([]);
  } finally {
    await stopChild(client);
    bridgeResponse?.destroy();
    await stopChild(sidecar);
    await closeServer(bridge);
    await rm(traceDirectory, { recursive: true, force: true });
  }
}, 15_000);

test("replays matched tool results after the SDK bridge loses its pending run", async () => {
  const bridgeRequests: Array<Record<string, unknown>> = [];
  let sidecar: ChildProcess | undefined;
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "cursor2response-sidecar-recovery-trace-"));
  const bridge = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/sdk") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bridgeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    if (bridgeRequests.length === 1) {
      response.end(`${JSON.stringify({
        type: "error",
        error: {
          message: "No pending Cursor SDK tool call matches the returned results.",
          code: "cursor_sdk_tool_result_unmatched",
          status: 409
        }
      })}\n`);
      return;
    }
    response.end([
      JSON.stringify({ type: "text", text: "Restart completed." }),
      JSON.stringify({
        type: "done",
        output: { text: "Restart completed.", toolCalls: [], status: "completed" }
      }),
      ""
    ].join("\n"));
  });

  try {
    const bridgePort = await listenOnRandomPort(bridge);
    const sidecarPort = await reservePort();
    sidecar = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        HOST: host,
        PORT: String(sidecarPort),
        CURSOR_API_KEY: "cursor-test-key",
        CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`,
        CURSOR2RESPONSE_FAILURE_TRACE_DIR: traceDirectory
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childOutput: Buffer[] = [];
    sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    await waitForSidecar(sidecarPort, sidecar, childOutput);

    const response = await fetch(`http://${host}:${sidecarPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cursor-test-key",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        input: [
          { type: "function_call", call_id: "call-restart", name: "exec", arguments: "{\"cmd\":\"systemctl --user restart cursor2response-bridge\"}" },
          { type: "function_call_output", call_id: "call-restart", output: "Services restarted and healthy." }
        ],
        tools: [{
          type: "function",
          name: "exec",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"]
          }
        }]
      })
    });
    const body = await response.text();

    expect(response.status, `${Buffer.concat(childOutput).toString("utf8")}\n${body}`).toBe(200);
    expect(body).toContain("event: response.completed");
    expect(body).toContain("Restart completed.");
    expect(bridgeRequests).toHaveLength(2);
    expect(bridgeRequests[0].resumeToolResults).toEqual([{
      callId: "call-restart",
      output: "Services restarted and healthy.",
      isError: false
    }]);
    expect(String(bridgeRequests[0].prompt)).toContain("TOOL RESULT (name=exec tool_call_id=call-restart)");
    expect(bridgeRequests[0].agentContext).toBeDefined();
    expect(bridgeRequests[1]).not.toHaveProperty("resumeToolResults");
    expect(bridgeRequests[1]).not.toHaveProperty("incrementalPrompt");
    expect(bridgeRequests[1].fullReplayCause).toBe("unmatched_tool_results");
    expect(bridgeRequests[1].sessionKey).toBe(bridgeRequests[0].sessionKey);
    expect(String(bridgeRequests[1].prompt)).toContain("ASSISTANT TOOL_CALLS");
    expect(String(bridgeRequests[1].prompt)).toContain("TOOL RESULT (name=exec tool_call_id=call-restart)");
    const trajectoryRecords = childJsonRecords(childOutput);
    expect(trajectoryRecords).toContainEqual(expect.objectContaining({
      event: "trajectory_request",
      requestId: bridgeRequests[0].requestId,
      inputCount: 1,
      inputHashes: [createHash("sha256").update("Services restarted and healthy.").digest("hex")]
    }));
    expect(trajectoryRecords.some((record) => record.event === "trajectory_input_content_chunk")).toBe(false);
    expect(await readdir(traceDirectory)).toEqual([]);
  } finally {
    await stopChild(sidecar);
    await closeServer(bridge);
    await rm(traceDirectory, { recursive: true, force: true });
  }
}, 15_000);

test("preserves and captures a terminal non-stream SDK protocol conflict", async () => {
  let sidecar: ChildProcess | undefined;
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "cursor2response-sidecar-conflict-trace-"));
  const bridge = createServer((request, response) => {
    request.resume();
    if (request.method !== "POST" || request.url !== "/sdk") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: "No pending Cursor SDK tool call matches the returned results.",
        code: "cursor_sdk_tool_result_unmatched"
      }
    }));
  });

  try {
    const bridgePort = await listenOnRandomPort(bridge);
    const sidecarPort = await reservePort();
    sidecar = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        HOST: host,
        PORT: String(sidecarPort),
        CURSOR_API_KEY: "cursor-test-key",
        CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`,
        CURSOR2RESPONSE_FAILURE_TRACE_DIR: traceDirectory
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childOutput: Buffer[] = [];
    sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    await waitForSidecar(sidecarPort, sidecar, childOutput);

    const response = await fetch(`http://${host}:${sidecarPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cursor-test-key",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-4.6",
        input: [{ type: "function_call_output", call_id: "call-orphan", output: "done" }]
      })
    });

    expect(response.status, Buffer.concat(childOutput).toString("utf8")).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "cursor_sdk_tool_result_unmatched" }
    });
    const artifact = await readOnlyGzipArtifact(traceDirectory);
    expect(artifact).toMatchObject({
      request: {
        body: {
          model: "grok-4.6",
          input: [{ type: "function_call_output", call_id: "call-orphan", output: "done" }]
        }
      },
      derived: {
        lineage: "body",
        statelessReplayEligible: false,
        resumeToolResultsCount: 1
      },
      failure: { status: 409, code: "cursor_sdk_tool_result_unmatched" }
    });
  } finally {
    await stopChild(sidecar);
    await closeServer(bridge);
    await rm(traceDirectory, { recursive: true, force: true });
  }
}, 15_000);

test("forwards a tool result and superseding Responses user turn together", async () => {
  const bridgeRequests: Array<Record<string, unknown>> = [];
  let sidecar: ChildProcess | undefined;
  const bridge = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/sdk") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bridgeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ text: "Tunnel ready.", toolCalls: [], status: "completed" }));
  });

  try {
    const bridgePort = await listenOnRandomPort(bridge);
    const sidecarPort = await reservePort();
    sidecar = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        HOST: host,
        PORT: String(sidecarPort),
        CURSOR_API_KEY: "cursor-test-key",
        CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childOutput: Buffer[] = [];
    sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    await waitForSidecar(sidecarPort, sidecar, childOutput);

    const response = await fetch(`http://${host}:${sidecarPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cursor-test-key",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-4.6",
        input: [
          { type: "message", role: "user", content: "Inspect the service." },
          { type: "function_call", call_id: "call-read", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "call-read", output: "config" },
          { type: "function_call", call_id: "call-ports", name: "exec", arguments: "{}" },
          { type: "function_call_output", call_id: "call-ports", output: "ports" },
          { type: "function_call", call_id: "call-exec", name: "exec", arguments: "{}" },
          { type: "function_call_output", call_id: "call-exec", output: "aborted" },
          { type: "message", role: "assistant", content: "Reply operation aborted by user." },
          { type: "message", role: "developer", content: "<turn_aborted>" },
          { type: "message", role: "user", content: "Start the SSH tunnel properly." }
        ],
        tools: [{ type: "function", name: "exec", parameters: { type: "object" } }]
      })
    });

    expect(response.status, Buffer.concat(childOutput).toString("utf8")).toBe(200);
    expect(bridgeRequests).toHaveLength(1);
    expect(bridgeRequests[0]).toMatchObject({
      resumeToolResults: [{ callId: "call-exec", output: "aborted", isError: false }],
      supersedePendingRun: true,
      supersedingTurnAborted: true,
      supersededToolCallIds: ["call-exec"]
    });
    expect(String(bridgeRequests[0].prompt)).toContain("Start the SSH tunnel properly.");
    expect(String(bridgeRequests[0].incrementalPrompt)).toContain("Start the SSH tunnel properly.");
    expect(String(bridgeRequests[0].incrementalPrompt)).not.toContain("TOOL RESULT");
    const trajectoryRecords = childJsonRecords(childOutput);
    const requestRecord = trajectoryRecords.find((record) => record.event === "trajectory_request");
    expect(requestRecord).toEqual(expect.objectContaining({
      requestKind: "steering",
      transcriptItemCount: 10,
      replayedTranscriptItemCount: 8,
      userInputCount: 1,
      toolResultCount: 1,
      transcriptSha256: expect.any(String)
    }));
    expect(trajectoryRecords).toContainEqual(expect.objectContaining({
      event: "trajectory_replay",
      requestId: bridgeRequests[0].requestId,
      replayKind: "client_transcript",
      replayCause: "request_contains_history",
      transcriptItemCount: 10,
      replayedTranscriptItemCount: 8,
      transcriptSha256: requestRecord?.transcriptSha256
    }));
    expect(trajectoryRecords.some((record) => record.event === "trajectory_input_content_chunk")).toBe(false);
  } finally {
    await stopChild(sidecar);
    await closeServer(bridge);
  }
}, 15_000);

test("links actual Bridge attempts across Responses requests in one session", async () => {
  const bridgeRequests: Array<Record<string, unknown>> = [];
  const bridge = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bridgeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ text: "Done", toolCalls: [], status: "finished" }));
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    for (const input of ["first request", "second request"]) {
      const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer cursor-test-key",
          "Content-Type": "application/json",
          "session-id": "trajectory-session"
        },
        body: JSON.stringify({ model: "grok-4.6", input })
      });
      expect(response.status, Buffer.concat(runtime.childOutput).toString("utf8")).toBe(200);
    }

    expect(bridgeRequests).toHaveLength(2);
    const requests = childJsonRecords(runtime.childOutput)
      .filter((record) => record.event === "trajectory_request");
    expect(requests).toEqual([
      expect.objectContaining({
        requestId: bridgeRequests[0].requestId,
        requestKind: "initial",
        attemptIndex: 0
      }),
      expect.objectContaining({
        requestId: bridgeRequests[1].requestId,
        parentRequestId: bridgeRequests[0].requestId,
        requestKind: "continuation",
        attemptIndex: 0
      })
    ]);
    expect(requests[0].sessionKey).toBe(requests[1].sessionKey);
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

for (const stream of [false, true]) {
  test(`preserves assistant phases through Responses tool continuation (stream=${stream})`, async () => {
    const bridgeRequests: Array<Record<string, unknown>> = [];
    const callId = "call_sdk_0123456789abcdef0123456789abcdef_read";
    const bridge = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bridgeRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const first = bridgeRequests.length === 1;
      const output = first
        ? { text: "Checking the workspace.", outputType: "commentary", status: "tool_call",
            toolCalls: [{ callId, name: "read", arguments: { file: "README.md" } }] }
        : { text: "The workspace is ready.", outputType: "final", status: "finished", toolCalls: [] };
      if (stream) {
        response.writeHead(200, { "Content-Type": "application/x-ndjson" });
        response.end([
          JSON.stringify({ type: "text", text: output.text }),
          JSON.stringify({ type: "done", output }), ""
        ].join("\n"));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(output));
      }
    });
    let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
    try {
      runtime = await startTestSidecar(await listenOnRandomPort(bridge));
      const input: unknown[] = [{ role: "user", content: "Inspect the workspace." }];
      for (const phase of ["commentary", "final_answer"]) {
        const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
          method: "POST",
          headers: {
            Authorization: "Bearer cursor-test-key", "Content-Type": "application/json",
            "session-id": `phase-continuation-${stream}`
          },
          body: JSON.stringify({ model: "grok-4.6", stream, input,
            tools: [{ type: "function", name: "read", parameters: {
              type: "object", properties: { file: { type: "string" } }, required: ["file"]
            } }] })
        });
        expect(response.status, Buffer.concat(runtime.childOutput).toString("utf8")).toBe(200);
        type OutputItem = { type: string; id: string; phase?: string; call_id?: string };
        let output: OutputItem[];
        if (stream) {
          const events = (await response.text()).split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)) as {
              type: string; item?: OutputItem; response?: { output: OutputItem[] };
            });
          output = events.find((event) => event.type === "response.completed")!.response!.output;
          const added = events.find((event) => event.type === "response.output_item.added" && event.item?.type === "message")!;
          const done = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message")!;
          expect(added.item).not.toHaveProperty("phase");
          expect(done.item).toMatchObject({ id: added.item!.id, phase });
          expect(done.item).toEqual(output.find((item) => item.type === "message"));
        } else {
          output = ((await response.json()) as { output: OutputItem[] }).output;
        }
        expect(output.find((item) => item.type === "message")).toMatchObject({ phase });
        if (phase === "commentary") {
          const call = output.find((item) => item.type === "function_call")!;
          expect(call.call_id).toBe(callId);
          input.push(...output, { type: "function_call_output", call_id: call.call_id, output: "Workspace ready" });
        }
      }
      expect(bridgeRequests).toHaveLength(2);
      expect(bridgeRequests[1]).toMatchObject({
        resumeToolResults: [{ callId, output: "Workspace ready" }]
      });
      expect(bridgeRequests[1].sessionKey).toBe(bridgeRequests[0].sessionKey);
    } finally {
      await stopChild(runtime?.sidecar);
      if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
      await closeServer(bridge);
    }
  }, 15_000);
}

test("does not expose Responses state endpoints", async () => {
  let sidecar: ChildProcess | undefined;
  try {
    const sidecarPort = await reservePort();
    sidecar = spawn(process.execPath, [serverPath], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        HOST: host,
        PORT: String(sidecarPort),
        CURSOR_API_KEY: "cursor-test-key"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const childOutput: Buffer[] = [];
    sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
    await waitForSidecar(sidecarPort, sidecar, childOutput);

    for (const [method, path] of [
      ["GET", "/v1/responses/resp_test"],
      ["DELETE", "/v1/responses/resp_test"],
      ["GET", "/v1/responses/resp_test/input_items"],
      ["POST", "/v1/responses/resp_test/cancel"],
      ["POST", "/v1/responses/compact"]
    ] as const) {
      const response = await fetch(`http://${host}:${sidecarPort}${path}`, {
        method,
        headers: { Authorization: "Bearer cursor-test-key" }
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  } finally {
    await stopChild(sidecar);
  }
}, 15_000);

test("does not project provider reasoning into Responses output", async () => {
  const bridgeRequests: Array<Record<string, unknown>> = [];
  const bridge = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bridgeRequests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      response.end([
        JSON.stringify({ type: "reasoning", text: "Inspecting ", done: false }),
        JSON.stringify({ type: "reasoning", text: "the code", done: false }),
        JSON.stringify({ type: "reasoning", text: "", done: true, thinkingDurationMs: 80 }),
        JSON.stringify({ type: "text", text: "Done" }),
        JSON.stringify({ type: "done", output: { text: "Done", toolCalls: [], status: "finished" } }),
        ""
      ].join("\n"));
    });
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cursor-test-key",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        input: "Inspect the code",
        reasoning: { summary: "detailed" }
      })
    });
    const sse = await response.text();

    expect(response.status, Buffer.concat(runtime.childOutput).toString("utf8")).toBe(200);
    expect(bridgeRequests).toHaveLength(1);
    expect(bridgeRequests[0]).toMatchObject({ streamEvents: true });
    expect(bridgeRequests[0]).not.toHaveProperty("emitReasoning");
    expect(sse).toContain("event: response.completed");
    expect(sse).toContain('"type":"output_text","text":"Done"');
    expect(sse).not.toContain("response.reasoning_summary_");
    expect(sse).not.toContain('"type":"reasoning"');
    expect(sse).not.toContain('"id":"rs_');
    const trajectoryRecords = childJsonRecords(runtime.childOutput);
    expect(trajectoryRecords).toContainEqual(expect.objectContaining({
      event: "trajectory_request",
      requestId: bridgeRequests[0].requestId,
      inputCount: 1,
      inputHashes: [createHash("sha256").update("Inspect the code").digest("hex")]
    }));
    expect(trajectoryRecords.some((record) => record.event === "trajectory_input_content_chunk")).toBe(false);
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

test("records OpenClaw compaction purpose as fail-open trajectory metadata", async () => {
  const bridgeRequests: Array<Record<string, unknown>> = [];
  const bridge = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bridgeRequests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ text: "summary", toolCalls: [], status: "finished" }));
    });
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer cursor-test-key",
        "Content-Type": "application/json",
        "User-Agent": "OpenAI/JS 6.39.1"
      },
      body: JSON.stringify({
        model: "grok-4.6",
        input: `<conversation>\n[User]: inspect\n</conversation>\n\nThe messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.`
      })
    });

    expect(response.status, Buffer.concat(runtime.childOutput).toString("utf8")).toBe(200);
    expect(bridgeRequests).toHaveLength(1);
    const trajectoryRecords = childJsonRecords(runtime.childOutput);
    expect(trajectoryRecords).toContainEqual(expect.objectContaining({
      event: "trajectory_request",
      requestId: bridgeRequests[0].requestId,
      requestPurpose: "compaction",
      sessionSource: "generated",
      clientSource: "openclaw"
    }));
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

test("fails a reasoning-only SDK turn as an empty Responses turn", async () => {
  const bridge = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    response.end([
      JSON.stringify({ type: "reasoning", text: "Inspecting", done: false }),
      JSON.stringify({ type: "reasoning", text: "", done: true, thinkingDurationMs: 80 }),
      JSON.stringify({ type: "done", output: { text: "", toolCalls: [], status: "finished" } }),
      ""
    ].join("\n"));
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer cursor-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        input: "Inspect the code",
        reasoning: { summary: "detailed" }
      })
    });
    const sse = await response.text();

    expect(response.status, Buffer.concat(runtime.childOutput).toString("utf8")).toBe(200);
    expect(sse).toContain("event: response.failed");
    expect(sse).toContain(EMPTY_RESPONSES_TURN_MESSAGE);
    expect(sse).not.toContain("response.reasoning_summary_");
    expect(sse).not.toContain('"type":"reasoning"');
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

test("fails a non-streaming empty SDK Responses turn", async () => {
  const bridge = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ text: "", toolCalls: [], status: "finished" }));
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer cursor-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.6",
        input: "Inspect the code",
        reasoning: { summary: "detailed" }
      })
    });
    const body = await response.json() as any;

    expect(response.status).not.toBe(200);
    expect(body).toMatchObject({ error: { message: EMPTY_RESPONSES_TURN_MESSAGE } });
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

test("maps SDK compact to public context errors for non-streaming and streaming Responses", async () => {
  const bridge = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const error = {
        message: "Cursor SDK compacted the conversation",
        status: 413,
        code: "cursor_sdk_context_compacted"
      };
      if (parsed.streamEvents === true) {
        response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
        response.end(`${JSON.stringify({ type: "error", error })}\n`);
      } else {
        response.writeHead(413, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error }));
      }
    });
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    const nonStream = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer cursor-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-4.6", input: "Long transcript" })
    });
    const nonStreamBody = await nonStream.json() as any;
    expect(nonStream.status).toBe(413);
    expect(nonStreamBody.error.code).toBe("context_length_exceeded");

    const stream = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer cursor-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "grok-4.6", stream: true, input: "Long transcript" })
    });
    const sse = await stream.text();
    expect(stream.status).toBe(200);
    expect(sse).toContain("event: response.failed");
    expect(sse).toContain('"code":"context_length_exceeded"');
    expect(sse).toContain('"status_code":413');
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

test("rejects encrypted reasoning before opening a Responses stream", async () => {
  let bridgeRequests = 0;
  const bridge = createServer((request, response) => {
    bridgeRequests += 1;
    request.resume();
    response.writeHead(500).end();
  });
  let runtime: Awaited<ReturnType<typeof startTestSidecar>> | undefined;
  try {
    const bridgePort = await listenOnRandomPort(bridge);
    runtime = await startTestSidecar(bridgePort);
    const response = await fetch(`http://${host}:${runtime.sidecarPort}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer cursor-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        input: [{ type: "reasoning", summary: [], encrypted_content: "opaque" }]
      })
    });
    const body = await response.json() as any;

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.error.code).toBe("invalid_encrypted_content");
    expect(bridgeRequests).toBe(0);
  } finally {
    await stopChild(runtime?.sidecar);
    if (runtime) await rm(runtime.traceDirectory, { recursive: true, force: true });
    await closeServer(bridge);
  }
}, 15_000);

const streamingClientSource = `
const http = require("node:http");
const payload = process.argv[1];
const port = Number(process.argv[2]);
const request = http.request({
  host: "127.0.0.1",
  port,
  path: "/v1/responses",
  method: "POST",
  headers: {
    Authorization: "Bearer cursor-test-key",
    "Content-Type": "application/json",
    "User-Agent": "OpenAI/JS 6.39.1",
    "Content-Length": Buffer.byteLength(payload)
  }
}, (response) => {
  response.once("data", () => process.stdout.write("ready\\n"));
  response.resume();
});
request.end(payload);
setInterval(() => {}, 1000);
`;

const disconnectingClientSource = `
const http = require("node:http");
const payload = process.argv[1];
const port = Number(process.argv[2]);
const request = http.request({
  host: "127.0.0.1",
  port,
  path: "/v1/responses",
  method: "POST",
  headers: {
    Authorization: "Bearer cursor-test-key",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  }
}, (response) => {
  let buffer = "";
  let disconnected = false;
  response.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (disconnected || !buffer.includes("event: response.output_text.delta")) return;
    disconnected = true;
    process.stdout.write("ready\\n");
    response.socket.destroy();
    response.destroy();
    request.destroy();
  });
  response.resume();
});
request.end(payload);
`;

function firstChunk(client: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    client.stdout?.once("data", () => resolve());
    client.once("error", reject);
    client.once("exit", (code) => reject(new Error(`Client exited before streaming began (${code})`)));
  });
}

async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IP bridge address");
  return address.port;
}

async function reservePort(): Promise<number> {
  const reservation = createServer();
  const port = await listenOnRandomPort(reservation);
  await closeServer(reservation);
  return port;
}

async function startTestSidecar(bridgePort: number): Promise<{
  sidecar: ChildProcess;
  sidecarPort: number;
  childOutput: Buffer[];
  traceDirectory: string;
}> {
  const sidecarPort = await reservePort();
  const traceDirectory = await mkdtemp(path.join(tmpdir(), "cursor2response-sidecar-contract-trace-"));
  const sidecar = spawn(process.execPath, [serverPath], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(sidecarPort),
      CURSOR_API_KEY: "cursor-test-key",
      CURSOR_SDK_BRIDGE_URL: `http://${host}:${bridgePort}/sdk`,
      CURSOR2RESPONSE_FAILURE_TRACE_DIR: traceDirectory
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const childOutput: Buffer[] = [];
  sidecar.stdout?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
  sidecar.stderr?.on("data", (chunk) => childOutput.push(Buffer.from(chunk)));
  await waitForSidecar(sidecarPort, sidecar, childOutput);
  return { sidecar, sidecarPort, childOutput, traceDirectory };
}

async function waitForSidecar(port: number, child: ChildProcess, output: Buffer[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Sidecar exited before startup (${child.exitCode}): ${Buffer.concat(output).toString("utf8")}`);
    }
    try {
      const response = await fetch(`http://${host}:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(25);
  }
  throw new Error(`Sidecar did not start: ${Buffer.concat(output).toString("utf8")}`);
}

function childJsonRecords(output: Buffer[]): Array<Record<string, unknown>> {
  return Buffer.concat(output).toString("utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(1_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING") {
      resolve();
      return;
    }
    error ? reject(error) : resolve();
  }));
}

async function readOnlyGzipArtifact(directory: string): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json.gz"));
    if (files.length === 1) {
      return JSON.parse(gunzipSync(await readFile(path.join(directory, files[0]))).toString("utf8"));
    }
    await delay(10);
  }
  throw new Error(`Expected one failure trace in ${directory}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for condition");
}
