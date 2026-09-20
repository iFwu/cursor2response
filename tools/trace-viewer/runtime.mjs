import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const maxSnapshotBytes = 2 * 1024 * 1024;
const configKeys = [
  "CURSOR2RESPONSE_TRACE_VIEWER_BRIDGE_URL", "CURSOR_SDK_BRIDGE_URL",
  "CURSOR_SDK_BRIDGE_HOST", "CURSOR_SDK_BRIDGE_PORT", "CURSOR_SDK_BRIDGE_TOKEN"
];

function bridgeConfig(options) {
  const config = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]));
  for (const directory of new Set([rootDirectory, process.cwd()])) {
    let source;
    try {
      source = parseEnv(readFileSync(path.join(directory, ".env"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const key of configKeys) if (!config[key]) config[key] = source[key];
  }
  const host = config.CURSOR_SDK_BRIDGE_HOST || "127.0.0.1";
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const base = options.bridgeUrl ?? config.CURSOR2RESPONSE_TRACE_VIEWER_BRIDGE_URL
    ?? config.CURSOR_SDK_BRIDGE_URL ?? `http://${hostname}:${config.CURSOR_SDK_BRIDGE_PORT || 8792}`;
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Bridge URL");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/sdk$/, "")}/runtime`;
  return { url, token: options.bridgeToken ?? config.CURSOR_SDK_BRIDGE_TOKEN ?? "" };
}

function invalid() {
  throw Object.assign(new Error("Invalid runtime snapshot"), { code: "runtime_invalid_snapshot" });
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function text(value) {
  if (typeof value !== "string" || value.length > 2048) invalid();
  return value;
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}

function choice(value, options) {
  if (!options.includes(value)) invalid();
  return value;
}

function nullable(value, parse) {
  return value === null ? null : parse(value);
}

function list(value, parse) {
  if (!Array.isArray(value) || value.length > 10000) invalid();
  return value.map(parse);
}

function identity(value) {
  const item = record(value);
  return {
    sessionKey: text(item.sessionKey), sdkSessionKey: text(item.sdkSessionKey),
    requestId: text(item.requestId), executionId: text(item.executionId),
    agentId: text(item.agentId), runId: nullable(item.runId, text), generation: integer(item.generation)
  };
}

function snapshot(value) {
  const data = record(value);
  const counts = record(data.counts);
  const counters = record(data.counters);
  return {
    schemaVersion: choice(data.schemaVersion, [1]),
    observedAt: timestamp(data.observedAt), serviceInvocationId: text(data.serviceInvocationId),
    pid: integer(data.pid), startedAt: timestamp(data.startedAt),
    pendingLeaseMs: integer(data.pendingLeaseMs), cleanupTimeoutMs: integer(data.cleanupTimeoutMs),
    counts: {
      agents: integer(counts.agents), activeRuns: integer(counts.activeRuns),
      waitingTools: integer(counts.waitingTools), detachedRuns: integer(counts.detachedRuns)
    },
    runs: list(data.runs, (item) => ({
      ...identity(item), initialRequestId: text(item.initialRequestId), model: nullable(item.model, text),
      phase: choice(item.phase, ["starting", "running", "waiting_tools", "terminal_delivery", "cancelling"]),
      createdAt: timestamp(item.createdAt), ageMs: integer(item.ageMs),
      subscriber: { attached: boolean(record(item.subscriber).attached), requestId: nullable(item.subscriber.requestId, text) },
      pendingToolCount: integer(item.pendingToolCount), pendingToolCallIds: list(item.pendingToolCallIds, text),
      waitingSince: nullable(item.waitingSince, timestamp),
      leaseExpiresAt: nullable(item.leaseExpiresAt, timestamp), leaseRemainingMs: nullable(item.leaseRemainingMs, integer),
      terminalError: nullable(item.terminalError, (error) => ({ code: text(record(error).code), status: integer(error.status) }))
    })),
    recentTerminations: list(data.recentTerminations, (item) => ({
      ...identity(item), reason: choice(item.reason, ["cancelled", "lease_expired", "failed"]),
      errorCode: text(item.errorCode), terminatedAt: timestamp(item.terminatedAt), pendingToolCount: integer(item.pendingToolCount)
    })),
    counters: {
      cancelled: integer(counters.cancelled), leaseExpired: integer(counters.leaseExpired),
      authenticationFailures: integer(counters.authenticationFailures), cleanupFailures: integer(counters.cleanupFailures)
    }
  };
}

export function createRuntimeReader(options = {}) {
  let config;
  const fetchRuntime = options.runtimeFetch ?? fetch;
  return async () => {
    try {
      config ??= bridgeConfig(options);
      const response = await fetchRuntime(config.url, {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        signal: AbortSignal.timeout(3000), redirect: "error"
      });
      if (!response.ok) throw new Error("Runtime request failed");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > maxSnapshotBytes) invalid();
        chunks.push(chunk);
      }
      let data;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        invalid();
      }
      return snapshot(data);
    } catch (error) {
      if (error?.code === "runtime_invalid_snapshot") throw error;
      throw Object.assign(new Error("Bridge runtime is unavailable"), { code: "runtime_unavailable" });
    }
  };
}
