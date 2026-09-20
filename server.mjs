#!/usr/bin/env node
/**
 * cursor2response local server CLI — cross-platform replacement for *.ps1 helpers.
 *
 *   node server.mjs start [--port 6718] [--foreground]
 *   node server.mjs stop
 *   node server.mjs status
 *   node server.mjs models [--json] [--port 6718]
 *   node server.mjs claude [--port 6718] [-- ...claude args]
 *   node server.mjs codex [--port 6718] [--profile NAME] [-- ...codex args]
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PORT = 6718;
const RUNTIME_DIR = path.join(os.homedir(), ".cursor2response");
const STATE_PATH = path.join(RUNTIME_DIR, "state.json");
const BRIDGE_SCRIPT = path.join(repoRoot, "bridge", "server.mjs");
const SIDECAR_SCRIPT = path.join(repoRoot, "dist", "runtime", "sidecar", "server.js");

function usage() {
  console.log(`cursor2response local server

Usage:
  node server.mjs start [--port PORT] [--host HOST] [--foreground]
  node server.mjs stop
  node server.mjs status
  node server.mjs models [--json] [--port PORT]
  node server.mjs claude [--port PORT] [-- ...args]
  node server.mjs codex [--port PORT] [--profile NAME] [-- ...args]

Environment:
  CURSOR_API_KEY   Cursor Dashboard API key (crsr_…), required for models/claude/codex

Defaults:
  port=${DEFAULT_PORT}  host=127.0.0.1  runtime=${RUNTIME_DIR}
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const positional = [];
  const flags = {};

  while (args.length > 0) {
    const token = args[0];
    if (token === "--") {
      args.shift();
      positional.push(...args);
      break;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (key.includes("=")) {
        const [name, value] = key.split("=", 2);
        flags[name] = value;
        args.shift();
        continue;
      }
      const next = args[1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        args.shift();
        args.shift();
        continue;
      }
      flags[key] = true;
      args.shift();
      continue;
    }
    positional.push(token);
    args.shift();
  }

  return { positional, flags };
}

function requireCommand(flags) {
  return Number.parseInt(String(flags.port ?? DEFAULT_PORT), 10);
}

function requireHost(flags) {
  return String(flags.host ?? "127.0.0.1").trim() || "127.0.0.1";
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
}

function clearState() {
  if (existsSync(STATE_PATH)) rmSync(STATE_PATH, { force: true });
}

function commandExists(name) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [name], { stdio: "ignore" });
  return result.status === 0;
}

function resolveExecutable(name) {
  if (!commandExists(name)) {
    throw new Error(`Required executable not found on PATH: ${name}`);
  }
  return name;
}

function assertDependencies() {
  if (!existsSync(path.join(repoRoot, "node_modules", "@cursor", "sdk"))) {
    throw new Error(`Dependencies missing. Run 'npm ci' in ${repoRoot} first.`);
  }
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Node.js 24 LTS is required.");
  if (!existsSync(SIDECAR_SCRIPT)) throw new Error("Server build missing. Run 'npm run build:server' first.");
}

function getFreePort(startPort, host = "127.0.0.1") {
  const end = Math.min(startPort + 99, 65535);
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > end) {
        reject(new Error(`No free port found from ${startPort}.`));
        return;
      }
      const server = createServer();
      server.unref();
      server.on("error", () => tryPort(port + 1));
      server.listen({ port, host }, () => {
        const chosen = server.address()?.port;
        server.close(() => resolve(chosen ?? port));
      });
    };
    tryPort(startPort);
  });
}

async function fetchHealth(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(url, { pid, launchId, interrupted = () => false, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interrupted()) throw new Error("Local startup interrupted.");
    if (pid && !isProcessAlive(pid)) {
      throw new Error(`Process ${pid} exited before ${url} became healthy.`);
    }
    const health = await fetchHealth(url);
    if (health?.launchId === launchId && health?.launcherPid === pid) return health;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (status.slice(status.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid) {
  if (!pid || !isProcessAlive(pid)) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
  }
  return true;
}

function spawnLogged(name, command, args, env, logPaths, detached) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const descriptors = detached
    ? [openSync(logPaths.stdout, "w", 0o600), openSync(logPaths.stderr, "w", 0o600)]
    : [];
  let child;
  try {
    child = spawn(process.execPath, [path.join(repoRoot, "scripts/structured-log-runner.mjs"), name, "--", command, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      detached: Boolean(detached),
      stdio: detached ? ["ignore", ...descriptors] : "inherit"
    });
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
  if (detached) child.unref();
  if (!child.pid) {
    throw new Error(`Failed to start ${name}.`);
  }
  return child;
}

async function waitForExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit; its state was retained.`);
    await sleep(50);
  }
}

function healthHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  return host.includes(":") ? `[${host === "::" ? "::1" : host}]` : host;
}

async function cmdStart(flags) {
  assertDependencies();
  const port = requireCommand(flags);
  const host = requireHost(flags);
  const localHost = healthHost(host);
  const foreground = Boolean(flags.foreground);
  const previous = readState();
  if (previous && [previous.launcherPid, previous.bridgePid, previous.serverPid].some(isProcessAlive)) {
    throw new Error("A managed local stack already has live processes. Run 'node server.mjs stop' before starting another.");
  }
  const existing = await fetchHealth(`http://${localHost}:${port}/health`);
  if (existing?.service === "cursor2response") {
    console.log(JSON.stringify({ status: "already_running", baseUrl: existing.baseUrl ?? `http://${localHost}:${port}/v1`, anthropicBaseUrl: `http://${localHost}:${port}` }));
    return;
  }
  if (existing) throw new Error(`Port ${port} is already in use by another service.`);
  if (previous) clearState();
  const bridgePort = await getFreePort(port + 1, host);
  const bridgeToken = cryptoRandomHex(16);
  const launchId = cryptoRandomHex(24);
  const state = { port, host, bridgePort, launchId, launcherPid: process.pid, startedAt: new Date().toISOString() };
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_PATH, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  const children = [];
  let interrupted = false;
  let handedOff = false;
  const shutdown = () => {
    interrupted = true;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    const bridge = spawnLogged("bridge", process.execPath, [BRIDGE_SCRIPT], {
      CURSOR_SDK_BRIDGE_HOST: host,
      CURSOR_SDK_BRIDGE_PORT: String(bridgePort),
      CURSOR_SDK_BRIDGE_TOKEN: bridgeToken,
      CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS: "180000",
      CURSOR2RESPONSE_LAUNCH_ID: launchId
    }, { stdout: path.join(RUNTIME_DIR, "bridge.stdout.log"), stderr: path.join(RUNTIME_DIR, "bridge.stderr.log") }, !foreground);
    children.push(bridge);
    state.bridgePid = bridge.pid;
    writeState(state);
    await waitForHealth(`http://${localHost}:${bridgePort}/health`, { pid: bridge.pid, launchId, interrupted: () => interrupted });
    if (interrupted) throw new Error("Local startup interrupted.");
    const sidecar = spawnLogged("sidecar", process.execPath, [SIDECAR_SCRIPT], {
      HOST: host, PORT: String(port), CURSOR_SDK_BRIDGE_URL: `http://${localHost}:${bridgePort}/sdk`,
      CURSOR_SDK_BRIDGE_TOKEN: bridgeToken, CURSOR2RESPONSE_LAUNCH_ID: launchId
    }, { stdout: path.join(RUNTIME_DIR, "server.stdout.log"), stderr: path.join(RUNTIME_DIR, "server.stderr.log") }, !foreground);
    children.push(sidecar);
    state.serverPid = sidecar.pid;
    writeState(state);
    const health = await waitForHealth(`http://${localHost}:${port}/health`, { pid: sidecar.pid, launchId, interrupted: () => interrupted });
    if (interrupted) throw new Error("Local startup interrupted.");
    delete state.launcherPid;
    writeState(state);
    console.log(JSON.stringify({ status: "started", baseUrl: health.baseUrl ?? `http://${localHost}:${port}/v1`, anthropicBaseUrl: `http://${localHost}:${port}`, serverPid: sidecar.pid, bridgePid: bridge.pid }));
    if (!foreground) { handedOff = true; return; }
    console.error("Press Ctrl+C to stop both processes.");
    while (!interrupted && children.every((child) => child.exitCode === null && child.signalCode === null)) await sleep(100);
    if (!interrupted) throw new Error("A local component exited; stopping the remaining stack.");
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    if (!handedOff) {
      shutdown();
      await Promise.all(children.map((child) => waitForExit(child.pid)));
      if (readState()?.launchId === launchId) clearState();
    }
  }
}

async function cmdStop() {
  const state = readState();
  if (!state) { console.log(JSON.stringify({ status: "not_running" })); return; }
  const stopped = [];
  const failures = [];
  for (const [name, pid, port] of [["Sidecar", state.serverPid, state.port], ["Bridge", state.bridgePid, state.bridgePort]]) {
    if (!pid || !isProcessAlive(pid)) continue;
    const health = await fetchHealth(`http://${healthHost(state.host || "127.0.0.1")}:${port}/health`);
    if (!state.launchId || health?.launchId !== state.launchId || health?.launcherPid !== pid) {
      failures.push(`${name} process ${pid} ownership could not be verified; no signal was sent.`);
      continue;
    }
    killProcess(pid);
    try { await waitForExit(pid); stopped.push(pid); }
    catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  if (readState()?.launchId === state.launchId) clearState();
  console.log(JSON.stringify({ status: "stopped", processIds: stopped }));
}

async function cmdStatus(flags) {
  const port = requireCommand(flags);
  const host = requireHost(flags);
  const state = readState();
  const health = await fetchHealth(`http://${host}:${port}/health`);

  console.log(JSON.stringify({
    state,
    health,
    running: health?.service === "cursor2response"
  }, null, 2));
}

function requireApiKey() {
  const key = (process.env.CURSOR_API_KEY || "").trim();
  if (!key) {
    throw new Error("Set CURSOR_API_KEY to your Cursor Dashboard API key first.");
  }
  return key;
}

async function cmdModels(flags) {
  const port = requireCommand(flags);
  const host = requireHost(flags);
  const apiKey = requireApiKey();
  const response = await fetch(`http://${host}:${port}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    throw new Error(`GET /v1/models failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (flags.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const rows = (body.data ?? []).map((model) => {
    const parameters = (model.cursor_parameters ?? [])
      .map((item) => `${item.id}=[${(item.values?.value ?? []).join("|")}]`)
      .join("; ");
    const selected = (model.cursor_params ?? [])
      .map((item) => `${item.id}=${item.value}`)
      .join(", ");
    return { id: model.id, name: model.name, parameters, selected };
  });

  if (rows.length === 0) {
    console.log("No models returned.");
    return;
  }

  const widths = {
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    name: Math.max(4, ...rows.map((row) => row.name.length))
  };
  console.log(
    `${"ID".padEnd(widths.id)}  ${"NAME".padEnd(widths.name)}  PARAMETERS`
  );
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(widths.id)}  ${row.name.padEnd(widths.name)}  ${row.parameters}${row.selected ? `  (${row.selected})` : ""}`
    );
  }
}

function spawnClient(command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32"
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function cmdClaude(flags, rest) {
  requireApiKey();
  const port = requireCommand(flags);
  const host = requireHost(flags);
  spawnClient("claude", rest, {
    ANTHROPIC_BASE_URL: `http://${host}:${port}`,
    ANTHROPIC_API_KEY: process.env.CURSOR_API_KEY
  });
}

function cmdCodex(flags, rest) {
  const apiKey = requireApiKey();
  const profile = String(flags.profile ?? "cursor6718");
  spawnClient("codex", ["-p", profile, ...rest], {
    CODEX_API_KEY: apiKey
  });
}

function cryptoRandomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === "help" || flags.help) {
    usage();
    process.exit(command ? 0 : 1);
  }

  const rest = positional.slice(1);

  switch (command) {
    case "start":
      await cmdStart(flags);
      break;
    case "stop":
      await cmdStop();
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "models":
      await cmdModels(flags);
      break;
    case "claude":
      cmdClaude(flags, rest);
      break;
    case "codex":
      cmdCodex(flags, rest);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
