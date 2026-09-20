import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { startTraceViewerServer } from "./server.mjs";

const record = JSON.stringify({
  event: "trajectory_request",
  trajectorySchemaVersion: 1,
  eventId: "event-test-request",
  serviceInvocationId: "inv-test",
  wallTime: "2026-08-22T10:00:00Z",
  invocationId: "inv-test",
  requestId: "req-test",
  ingressRequestId: "ingress-test",
  sessionKey: "session-test",
  model: { id: "grok-4.6" },
  requestKind: "initial",
  replayKind: "none",
  attemptIndex: 0,
  inputIds: []
});

async function fixtureServer(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor2response-trace-viewer-test-"));
  const traceDirectory = path.join(root, "traces");
  const staticDirectory = path.join(root, "static");
  const logDirectory = path.join(root, "logs");
  await mkdir(logDirectory);
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>trace viewer</title>");
  const server = await startTraceViewerServer({
    traceDirectory,
    logDirectory,
    staticDirectory,
    host: "127.0.0.1",
    port: 0,
    ...options
  });
  const address = server.address();
  return {
    root,
    logDirectory,
    traceDirectory,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("imports a trace into the configured directory and allocates unique names", async (context) => {
  const fixture = await fixtureServer();
  context.after(() => close(fixture.server));

  const first = await fetch(`${fixture.baseUrl}/api/import?name=sample.jsonl`, { method: "POST", body: record });
  const second = await fetch(`${fixture.baseUrl}/api/import?name=sample.jsonl`, { method: "POST", body: record });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await first.json()).source.name, "sample.jsonl");
  assert.equal((await second.json()).source.name, "sample-2.jsonl");
  assert.equal(await readFile(path.join(fixture.traceDirectory, "sample.jsonl"), "utf8"), record);
  assert.equal((await stat(fixture.traceDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(fixture.traceDirectory, "sample.jsonl"))).mode & 0o777, 0o600);
});

test("lists and reads only supported basenames from the trace directory", async (context) => {
  const fixture = await fixtureServer();
  context.after(() => close(fixture.server));
  await writeFile(path.join(fixture.traceDirectory, "visible.jsonl"), record);
  await writeFile(path.join(fixture.traceDirectory, "ignored.txt"), record);
  await writeFile(path.join(fixture.root, "outside.jsonl"), record);

  const files = await (await fetch(`${fixture.baseUrl}/api/files`)).json();
  assert.deepEqual(files.files.map((file) => file.name), ["visible.jsonl"]);
  const trace = await (await fetch(`${fixture.baseUrl}/api/files/visible.jsonl`)).json();
  assert.equal(trace.sessions[0].id, "session-test");
  const traversal = await fetch(`${fixture.baseUrl}/api/files/%2E%2E%2Foutside.jsonl`);
  assert.ok([400, 404].includes(traversal.status));
});

test("rejects oversized uploads and gzip expansion", async (context) => {
  const fixture = await fixtureServer({ maxFileBytes: 256, maxExpandedBytes: 512 });
  context.after(() => close(fixture.server));
  const oversized = await fetch(`${fixture.baseUrl}/api/import?name=large.jsonl`, {
    method: "POST",
    body: "x".repeat(257)
  });
  assert.equal(oversized.status, 413);

  const compressed = gzipSync(`${record}\n${" ".repeat(600)}`);
  const expanded = await fetch(`${fixture.baseUrl}/api/import?name=expanded.json.gz`, {
    method: "POST",
    body: compressed
  });
  assert.equal(expanded.status, 400);
});

test("serves the built frontend and health endpoint", async (context) => {
  const fixture = await fixtureServer();
  context.after(() => close(fixture.server));
  const page = await fetch(fixture.baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /trace viewer/);
  const health = await (await fetch(`${fixture.baseUrl}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.traceDirectory, fixture.traceDirectory);
});

function envelope(message = record, service = "bridge", timestamp = Date.now()) {
  return `${JSON.stringify({ MESSAGE: message, service, __REALTIME_TIMESTAMP: String(timestamp * 1000) })}\n`;
}

test("reads service-filtered live files and rotations within the requested window", async (context) => {
  const fixture = await fixtureServer();
  context.after(() => close(fixture.server));
  await writeFile(path.join(fixture.logDirectory, "bridge.jsonl"), envelope());
  await writeFile(path.join(fixture.logDirectory, "sidecar.jsonl.1"), envelope(record.replaceAll("session-test", "session-rotated"), "sidecar"));
  await writeFile(path.join(fixture.logDirectory, "bridge.jsonl.1"), envelope(record.replaceAll("session-test", "session-old"), "bridge", Date.now() - 86400001));
  await writeFile(path.join(fixture.logDirectory, "unrelated.jsonl"), envelope(record.replaceAll("session-test", "session-unrelated")));
  const response = await fetch(`${fixture.baseUrl}/api/logs?since=24h`);
  const trace = await response.json();
  assert.equal(response.status, 200);
  assert.equal(trace.source.kind, "logs");
  assert.equal(trace.source.since, "24h");
  assert.deepEqual(trace.sessions.map((session) => session.id).sort(), ["session-rotated", "session-test"]);
  assert.equal(trace.sessions.find((session) => session.id === "session-rotated").events[0].unit, "sidecar");
  assert.equal((await fetch(`${fixture.baseUrl}/api/logs?since=forever`)).status, 400);
  assert.equal((await fetch(`${fixture.baseUrl}/api/logs?since=toString`)).status, 400);
});

test("bounds live reads, rejects symlinks, and marks missing observations partial", async (context) => {
  const fixture = await fixtureServer({ maxLogBytes: Buffer.byteLength(envelope()) + 10 });
  context.after(() => close(fixture.server));
  await writeFile(path.join(fixture.logDirectory, "bridge.jsonl"), envelope().repeat(3));
  await writeFile(path.join(fixture.root, "outside.jsonl"), envelope(record.replaceAll("session-test", "outside"), "sidecar"));
  await symlink(path.join(fixture.root, "outside.jsonl"), path.join(fixture.logDirectory, "sidecar.jsonl"));
  const trace = await (await fetch(`${fixture.baseUrl}/api/logs`)).json();
  assert.equal(trace.source.partial, true);
  assert.equal(trace.diagnostics.acceptedRecords, 1);
  assert.equal(trace.sessions[0].id, "session-test");
  assert.ok(trace.sessions[0].partialReasons.includes("log_source_incomplete"));
});

test("reports unavailable live directory independently of runtime and imported files", async (context) => {
  const fixture = await fixtureServer({ logDirectory: "/nonexistent-cursor2response-test/logs" });
  context.after(() => close(fixture.server));
  const response = await fetch(`${fixture.baseUrl}/api/logs`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "logs_unavailable");
  assert.equal((await fetch(`${fixture.baseUrl}/health`)).status, 200);
});

test("compresses large responses when the client accepts gzip", async (context) => {
  const fixture = await fixtureServer();
  await writeFile(path.join(fixture.logDirectory, "bridge.jsonl"), envelope().repeat(200));
  context.after(() => close(fixture.server));

  const compressed = await fetch(`${fixture.baseUrl}/api/logs?since=1h`, {
    headers: { "Accept-Encoding": "gzip" }
  });
  assert.equal(compressed.headers.get("content-encoding"), "gzip");
  assert.equal(compressed.headers.get("vary"), "Accept-Encoding");
  assert.equal((await compressed.json()).diagnostics.acceptedRecords, 200);

  const identity = await fetch(`${fixture.baseUrl}/api/logs?since=1h`, {
    headers: { "Accept-Encoding": "identity" }
  });
  assert.equal(identity.headers.get("content-encoding"), null);
  assert.equal(identity.headers.get("vary"), "Accept-Encoding");

  const disabled = await fetch(`${fixture.baseUrl}/api/logs?since=1h`, {
    headers: { "Accept-Encoding": "gzip;q=0, *;q=1" }
  });
  assert.equal(disabled.headers.get("content-encoding"), null);
});

function runtimeSnapshot() {
  const observedAt = new Date().toISOString();
  const identity = {
    sessionKey: "full-session-id", sdkSessionKey: "sdk-session", requestId: "request-latest",
    executionId: "execution-test", agentId: "agent-test", runId: "run-test", generation: 2
  };
  return {
    schemaVersion: 1, observedAt, serviceInvocationId: "invocation-test", pid: 123,
    startedAt: observedAt, pendingLeaseMs: 3900000, cleanupTimeoutMs: 5000,
    counts: { agents: 1, activeRuns: 1, waitingTools: 1, detachedRuns: 1 },
    runs: [{
      ...identity, initialRequestId: "request-initial", model: "test-model", phase: "waiting_tools",
      createdAt: observedAt, ageMs: 1000, subscriber: { attached: false, requestId: null },
      pendingToolCount: 1, pendingToolCallIds: ["call-test"], waitingSince: observedAt,
      leaseExpiresAt: observedAt, leaseRemainingMs: 3899000, terminalError: null
    }],
    recentTerminations: [{ ...identity, reason: "lease_expired", errorCode: "cursor_sdk_pending_lease_expired", terminatedAt: observedAt, pendingToolCount: 1 }],
    counters: { cancelled: 0, leaseExpired: 1, authenticationFailures: 0, cleanupFailures: 0 }
  };
}

test("runtime proxy uses the configured Bridge and exposes only validated status metadata", async (context) => {
  const expected = runtimeSnapshot();
  const upstream = structuredClone(expected);
  upstream.apiKey = "upstream-secret";
  upstream.runs[0].toolArguments = { secret: "tool-secret" };
  upstream.runs[0].subscriber.token = "subscriber-secret";
  upstream.recentTerminations[0].prompt = "private-prompt";
  const calls = [];
  const fixture = await fixtureServer({
    bridgeUrl: "http://127.0.0.1:8792/sdk/", bridgeToken: "test-bridge-token",
    runtimeFetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json(upstream);
    }
  });
  context.after(() => close(fixture.server));

  const response = await fetch(`${fixture.baseUrl}/api/runtime`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), expected);
  assert.equal(calls[0].url, "http://127.0.0.1:8792/runtime");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-bridge-token");
  assert.equal(calls[0].options.redirect, "error");

  const override = await fetch(`${fixture.baseUrl}/api/runtime?url=http://untrusted.invalid/runtime`);
  assert.equal(override.status, 400);
  assert.equal((await override.json()).error.code, "invalid_runtime_query");
  assert.equal(calls.length, 1);
  assert.equal((await fetch(`${fixture.baseUrl}/api/runtime`, { method: "POST" })).status, 404);
});

test("runtime proxy reports invalid snapshots and unavailable upstreams without exposing their bodies", async (context) => {
  let upstream = Response.json({ ...runtimeSnapshot(), counts: { agents: "0" } });
  const fixture = await fixtureServer({
    bridgeUrl: "http://127.0.0.1:8792", bridgeToken: "",
    runtimeFetch: async () => upstream
  });
  context.after(() => close(fixture.server));

  const invalid = await fetch(`${fixture.baseUrl}/api/runtime`);
  assert.equal(invalid.status, 503);
  assert.equal((await invalid.json()).error.code, "runtime_invalid_snapshot");

  upstream = new Response("unauthorized: private-token", { status: 401 });
  const unavailable = await fetch(`${fixture.baseUrl}/api/runtime`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: { code: "runtime_unavailable", message: "Bridge runtime is unavailable." } });

  const unknownPhase = runtimeSnapshot();
  unknownPhase.runs[0].phase = "healthy";
  upstream = Response.json(unknownPhase);
  assert.equal((await (await fetch(`${fixture.baseUrl}/api/runtime`)).json()).error.code, "runtime_invalid_snapshot");
});

test("runtime proxy aborts a stalled Bridge request after three seconds", async (context) => {
  let signal;
  const fixture = await fixtureServer({
    bridgeUrl: "http://127.0.0.1:8792", bridgeToken: "",
    runtimeFetch: async (_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });
  context.after(() => close(fixture.server));
  const startedAt = Date.now();
  const response = await fetch(`${fixture.baseUrl}/api/runtime`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "runtime_unavailable");
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - startedAt >= 2900);
  assert.ok(Date.now() - startedAt < 6000);
});
