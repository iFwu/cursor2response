import { expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";
import { json, text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";

const serverPath = fileURLToPath(new URL("../dist/runtime/sidecar/server.js", import.meta.url));

test.each([
  { stream: false, published: false, safe: true, model: "cursor-relay", recovered: true },
  { stream: false, published: false, safe: true, model: "cursor-auto", recovered: true },
  { stream: true, published: false, safe: true, model: "cursor-relay", recovered: true },
  { stream: true, published: false, safe: true, model: "cursor-relay", recovered: true, bodySession: true },
  { stream: true, published: true, safe: true, model: "cursor-relay", recovered: false },
  { stream: true, published: false, safe: false, model: "cursor-relay", recovered: false },
  { stream: true, published: false, safe: true, model: "grok-4.6", recovered: false },
  { stream: false, published: false, safe: true, model: "cursor-relay", recovered: true, primary: "grok-4.6-fast" },
  { stream: false, published: false, safe: true, model: "grok-hybrid", recovered: false },
  { stream: false, published: false, safe: true, model: "grok-hybrid-fast", recovered: false }
])("routes SDK overflow through the real Sidecar HTTP boundary: %j", async (scenario) => {
  const directory = await mkdtemp(path.join(tmpdir(), "fallback-http-test-"));
  let sdkCalls = 0;
  const sdkModels: unknown[] = [];
  const fallbackCalls: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const bridge = createServer(async (request, response) => {
    if (request.url === "/models") {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        models: [{ id: "cursor-primary", displayName: "Primary", parameters: [] }]
      }));
      return;
    }
    if (request.url === "/sdk/cancel") {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    sdkCalls++;
    const body = await json(request) as Record<string, unknown>;
    sdkModels.push(body.model);
    const error = { status: 413, code: "cursor_sdk_context_compacted", message: "SDK compacted", contextRetrySafe: scenario.safe };
    if (!body.streamEvents) {
      response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error }));
      return;
    }
    const events = [
      ...(scenario.published ? [{ type: "text", text: "SDK prefix", outputId: "output-sdk" }] : []),
      { type: "error", error }
    ];
    response.writeHead(200, { "content-type": "application/x-ndjson" })
      .end(events.map((event) => JSON.stringify(event) + "\n").join(""));
  });
  const upstream = createServer(async (request, response) => {
    const body = await json(request) as Record<string, unknown>;
    fallbackCalls.push({ body, authorization: request.headers.authorization ?? null });
    const payload = { id: `resp-mp-${fallbackCalls.length}`, object: "response", status: "completed", model: "grok-4.6",
      output: [{ id: "msg-mp", type: "message", role: "assistant", content: [{ type: "output_text", text: "MP result" }] }],
      usage: { input_tokens: 10, output_tokens: 2 } };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" }).end([
      { type: "response.created", response: { ...payload, status: "in_progress", output: [] } },
      { type: "response.completed", response: payload }
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  let child: ChildProcess | undefined;
  let logs: Promise<string> | undefined;
  let port: number;
  let bridgePort: number;
  let upstreamPort: number;
  const start = async () => {
    const envFile = path.join(directory, "fallback.env");
    await writeFile(envFile, [
      `C2R_PRIMARY_MODEL=${scenario.primary ?? "cursor-primary"}`,
      `C2R_FALLBACK_BASE_URL=http://127.0.0.1:${upstreamPort}/v1`,
      "C2R_FALLBACK_API_KEY=file-key",
      "C2R_FALLBACK_MODEL=mp-grok-4.6"
    ].join("\n"));
    const startedChild = spawn(process.execPath, [`--env-file=${envFile}`, serverPath], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CURSOR_API_KEY: "cursor-key",
        CURSOR_SDK_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/sdk`, CURSOR_SDK_BRIDGE_TIMEOUT_MS: "5000",
        C2R_FALLBACK_API_KEY: "mp-key",
        C2R_FALLBACK_STATE_DIR: path.join(directory, "routes"),
        CURSOR2RESPONSE_FAILURE_TRACE_DIR: path.join(directory, "failures"),
        C2R_FALLBACK_NOTIFY_COMMAND: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = startedChild;
    logs = Promise.all([text(startedChild.stdout), text(startedChild.stderr)]).then((parts) => parts.join("\n"));
    await waitForSidecar(port, child, logs);
  };
  const stop = async () => {
    await stopChild(child);
    child = undefined;
    return await logs;
  };
  const request = (session: string, input: unknown = "continue", model = scenario.model) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { authorization: "Bearer cursor-key", "content-type": "application/json",
      ...(scenario.bodySession ? {} : { session_id: session }) },
    body: JSON.stringify({ model, stream: scenario.stream, input,
      ...(scenario.bodySession ? { prompt_cache_key: session } : {}) })
  });
  try {
    bridgePort = await listen(bridge);
    upstreamPort = await listen(upstream);
    port = await reservePort();
    await start();
    const headers = { authorization: "Bearer cursor-key" };
    const catalog = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers })).json() as { data: Array<{ id: string; name?: string }> };
    expect(catalog.data.map((model) => model.id)).toEqual(["cursor-primary", "cursor-relay"]);
    expect(catalog.data.at(-1)?.name).toBe("Cursor Relay");
    for (const id of ["cursor-relay", "cursor-auto"]) {
      const lookup = await fetch(`http://127.0.0.1:${port}/v1/models/${id}`, { headers });
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toMatchObject({ id, name: "Cursor Relay" });
    }
    for (const removed of ["grok-hybrid", "grok-hybrid-fast", "api-fallback", "cursor-relay-fast", "cursor-auto-fast"]) {
      expect((await fetch(`http://127.0.0.1:${port}/v1/models/${removed}`, { headers })).status).toBe(404);
    }
    if (scenario.bodySession) {
      const missingSession = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model: "cursor-relay", input: "continue" })
      });
      expect(missingSession.status).toBe(400);
      expect(await missingSession.json()).toMatchObject({ error: { code: "api_fallback_session_required" } });
      expect(sdkCalls).toBe(0);
      expect(fallbackCalls).toHaveLength(0);
    }
    const first = await request("session-one");
    const firstBody = await first.text();
    expect(firstBody.includes("MP result")).toBe(scenario.recovered);
    expect(firstBody.includes("context_length_exceeded")).toBe(!scenario.recovered);
    expect(sdkCalls).toBe(1);
    if (["cursor-relay", "cursor-auto"].includes(scenario.model)) {
      expect(sdkModels[0]).toBe(scenario.primary ? "grok-4.6[fast=true,effort=high]" : "cursor-primary");
    }
    expect(fallbackCalls).toHaveLength(scenario.recovered ? 1 : 0);
    if (scenario.recovered && scenario.stream) {
      expect(firstBody.match(/event: response.created/g)).toHaveLength(1);
      expect(firstBody).not.toContain("response.failed");
    }
    if (["cursor-relay", "cursor-auto"].includes(scenario.model)) {
      const oldLogs = await stop();
      expect(oldLogs).toContain("trajectory_route_decision");
      await start();
      const input = [
        { type: "function_call", call_id: "call-old", name: "work", arguments: "{}" },
        { type: "function_call_output", call_id: "call-old", output: "already executed" },
        { role: "user", content: "continue" }
      ];
      expect(await (await request("session-one", input, "cursor-relay")).text()).toContain("MP result");
      expect(sdkCalls).toBe(1);
      expect(fallbackCalls.at(-1)).toMatchObject({ authorization: "Bearer mp-key", body: { model: "mp-grok-4.6", input } });
      await (await request("session-two")).text();
      expect(sdkCalls).toBe(2);
    }
  } finally {
    await stop();
    await closeServer(bridge);
    await closeServer(upstream);
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

test.each(["reset", "eof"])("terminates interrupted fallback SSE over HTTP (%s), including sticky reuse", async (failure) => {
  const directory = await mkdtemp(path.join(tmpdir(), "fallback-stream-test-"));
  let sdkCalls = 0;
  let fallbackCalls = 0;
  const bridge = createServer((request, response) => {
    request.resume();
    if (request.url === "/sdk/cancel") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    sdkCalls++;
    response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({
      error: { status: 413, code: "cursor_sdk_context_compacted", contextRetrySafe: true, message: "SDK compacted" }
    }));
  });
  let activeResponse: ServerResponse | undefined;
  const upstream = createServer((request, response) => {
    request.resume();
    fallbackCalls++;
    activeResponse = response;
    const sse = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.created", sequence_number: 0,
      response: { id: `resp-mp-${fallbackCalls}`, model: "grok-4.6", status: "in_progress", output: [] } }));
    response.write(sse({ type: "response.output_item.done", sequence_number: 4,
      item: { id: "fc-one", type: "function_call", call_id: "call-one", name: "work", arguments: "{}" } }));
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta"');
  });
  let child: ChildProcess | undefined;
  let logs: Promise<string> | undefined;
  try {
    const bridgePort = await listen(bridge);
    const upstreamPort = await listen(upstream);
    const port = await reservePort();
    const startedChild = spawn(process.execPath, [serverPath], {
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CURSOR_API_KEY: "cursor-key",
        CURSOR_SDK_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/sdk`, CURSOR_SDK_BRIDGE_TIMEOUT_MS: "5000",
        C2R_PRIMARY_MODEL: "grok-4.6",
        C2R_FALLBACK_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        C2R_FALLBACK_API_KEY: "mp-key", C2R_FALLBACK_MODEL: "mp-grok-4.6",
        C2R_FALLBACK_STATE_DIR: path.join(directory, "routes"),
        CURSOR2RESPONSE_FAILURE_TRACE_DIR: path.join(directory, "failures"),
        C2R_FALLBACK_NOTIFY_COMMAND: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = startedChild;
    logs = Promise.all([text(startedChild.stdout), text(startedChild.stderr)]).then((parts) => parts.join("\n"));
    await waitForSidecar(port, child, logs);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { authorization: "Bearer cursor-key", "content-type": "application/json", session_id: "stream-session" },
        body: JSON.stringify({ model: "cursor-relay", stream: true, input: "continue" })
      });
      expect(response.ok).toBe(true);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let body = "";
      while (!body.includes('"call_id":"call-one"')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        body += decoder.decode(chunk.value, { stream: true });
      }
      // The downstream has observed the tool before we interrupt the connection.
      if (failure === "reset") activeResponse!.destroy();
      else activeResponse!.end();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
      reader.releaseLock();
      const events = body.split("\n\n").filter(Boolean).map((frame) =>
        JSON.parse(frame.split("\n").find((line) => line.startsWith("data:"))!.slice(5)));
      expect(events.map((event) => event.type)).toEqual(["response.created", "response.output_item.done", "response.failed"]);
      expect(events[2]).toMatchObject({ sequence_number: 5, response: { id: `resp-mp-${attempt}`,
        model: "grok-4.6", status: "failed", error: { code: failure === "reset"
          ? "api_fallback_stream_failed" : "api_fallback_missing_terminal" } } });
      expect(fallbackCalls).toBe(attempt);
    }
    expect(sdkCalls).toBe(1);
  } finally {
    await stopChild(child);
    await closeServer(bridge);
    await closeServer(upstream);
    await rm(directory, { recursive: true, force: true });
  }
  expect(await logs).toContain("api_fallback_");
}, 15000);

async function listen(server: Server): Promise<number> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IP server address");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

async function reservePort(): Promise<number> {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(1_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}

async function waitForSidecar(port: number, child: ChildProcess, logs: Promise<string>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(await logs);
    if (await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok).catch(() => false)) return;
    await delay(25);
  }
  throw new Error("Sidecar did not start");
}
