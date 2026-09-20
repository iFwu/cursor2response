import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

test('starts a detached local stack, reports it, and stops its processes', { timeout: 45000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'local-launcher-'));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const environment = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, 'state') };
  delete environment.CURSOR_API_KEY;
  const command = (action) => spawnSync(process.execPath, ['server.mjs', action, '--port', String(port)], {
    cwd: root, env: environment, encoding: 'utf8', timeout: 35000,
  });
  try {
    const started = command('start');
    assert.equal(started.status, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).status, 'started');
    const status = command('status');
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).running, true);
    const state = JSON.parse(readFileSync(path.join(home, '.cursor2response/state.json'), 'utf8'));
    const stopped = command('stop');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).status, 'stopped');
    for (let attempt = 0; attempt < 50; attempt++) {
      const alive = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
      if (!alive) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    await assert.rejects(fetch(`http://127.0.0.1:${state.bridgePort}/health`));
  } finally {
    command('stop');
    rmSync(home, { recursive: true, force: true });
  }
});

test('cleans the healthy Bridge and launch state when Sidecar startup fails', { timeout: 45000 }, async () => {
  const fixture = createLauncherFixture();
  const bridgeReceipt = path.join(fixture.root, 'bridge-started.json');
  const sidecarReceipt = path.join(fixture.root, 'sidecar-started.json');
  writeFileSync(path.join(fixture.root, '.env'), [
    'HTTPS_PROXY=http://proxy.example:8080',
    'NODE_USE_ENV_PROXY=1',
    'CURSOR_SDK_USE_HTTP1_FOR_AGENT=1',
    ''
  ].join('\n'));
  writeFileSync(path.join(fixture.root, 'bridge/server.mjs'), `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const server = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    service: 'cursor2response-bridge',
    launchId: process.env.CURSOR2RESPONSE_LAUNCH_ID,
    launcherPid: Number(process.env.CURSOR2RESPONSE_LAUNCHER_PID)
  }));
});
server.listen(Number(process.env.CURSOR_SDK_BRIDGE_PORT), '127.0.0.1', () => {
  writeFileSync('bridge-started.json', JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    httpsProxy: process.env.HTTPS_PROXY,
    nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,
    useHttp1ForAgent: process.env.CURSOR_SDK_USE_HTTP1_FOR_AGENT
  }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  writeFileSync(path.join(fixture.root, 'dist/runtime/sidecar/server.js'), `
const { readFileSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
writeFileSync('sidecar-started.json', readFileSync(join(homedir(), '.cursor2response/state.json')));
console.error('Injected Sidecar startup failure');
process.exit(23);
`);
  try {
    const started = fixture.command('start', await reservePort());
    assert.equal(started.error, undefined);
    assert.equal(started.status, 1, started.stderr);
    assert.match(started.stderr, /exited before .* became healthy/);
    const bridge = JSON.parse(readFileSync(bridgeReceipt, 'utf8'));
    const state = JSON.parse(readFileSync(sidecarReceipt, 'utf8'));
    assert.equal(bridge.httpsProxy, 'http://proxy.example:8080');
    assert.equal(bridge.nodeUseEnvProxy, '1');
    assert.equal(bridge.useHttp1ForAgent, '1');
    assert.equal(state.bridgePort, bridge.port);
    assert.match(readFileSync(path.join(fixture.home, '.cursor2response/server.stderr.log'), 'utf8'), /Injected Sidecar startup failure/);
    assert.equal(existsSync(fixture.statePath), false);
    for (const pid of [bridge.pid, state.bridgePid, state.serverPid]) {
      assert.equal(Number.isInteger(pid) && pid > 0, true);
      assert.equal(processIsAlive(pid), false, `Startup failure left process ${pid} running`);
    }
    await assert.rejects(fetch(`http://127.0.0.1:${bridge.port}/health`));
  } finally {
    const bridge = existsSync(bridgeReceipt) ? JSON.parse(readFileSync(bridgeReceipt, 'utf8')) : {};
    const state = existsSync(sidecarReceipt) ? JSON.parse(readFileSync(sidecarReceipt, 'utf8'))
      : existsSync(fixture.statePath) ? JSON.parse(readFileSync(fixture.statePath, 'utf8')) : {};
    await terminateFixtureProcesses([bridge.pid, state.launcherPid, state.bridgePid, state.serverPid]);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('refuses to stop an unrelated process named by stale launch state and preserves that state', { timeout: 15000 }, async () => {
  const fixture = createLauncherFixture();
  const unrelated = spawn(process.execPath, ['--input-type=module', '-e', `
import { createServer } from 'node:http';
let signals = 0;
process.on('SIGTERM', () => { signals++; });
const server = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    launchId: 'unrelated-launch', launcherPid: process.pid, signals
  }));
});
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: fixture.environment });
  try {
    const [{ port }] = await once(unrelated, 'message', { signal: AbortSignal.timeout(5000) });
    mkdirSync(path.dirname(fixture.statePath), { recursive: true });
    const state = `${JSON.stringify({
      launchId: 'expired-launch', serverPid: unrelated.pid, port, host: '127.0.0.1',
    }, null, 2)}\n`;
    writeFileSync(fixture.statePath, state);
    const stopped = fixture.command('stop');
    assert.equal(stopped.error, undefined);
    assert.equal(stopped.status, 1, stopped.stderr);
    assert.match(stopped.stderr, /ownership could not be verified; no signal was sent/);
    assert.equal(readFileSync(fixture.statePath, 'utf8'), state);
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.deepEqual(health, { launchId: 'unrelated-launch', launcherPid: unrelated.pid, signals: 0 });
    assert.equal(processIsAlive(unrelated.pid), true);
  } finally {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const closed = once(unrelated, 'close');
      unrelated.kill('SIGKILL');
      await closed;
    }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createLauncherFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'local-launcher-fixture-'));
  const root = path.join(directory, 'app');
  const home = path.join(directory, 'home');
  for (const subdirectory of ['scripts', 'bridge', 'dist/runtime/sidecar', 'node_modules/@cursor/sdk']) {
    mkdirSync(path.join(root, subdirectory), { recursive: true });
  }
  mkdirSync(home);
  copyFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), path.join(root, 'server.mjs'));
  copyFileSync(fileURLToPath(new URL('./structured-log-runner.mjs', import.meta.url)), path.join(root, 'scripts/structured-log-runner.mjs'));
  const environment = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, 'state') };
  delete environment.CURSOR_API_KEY;
  delete environment.CURSOR2RESPONSE_TRACE_LOG_DIR;
  delete environment.HTTP_PROXY;
  delete environment.HTTPS_PROXY;
  delete environment.NODE_USE_ENV_PROXY;
  delete environment.CURSOR_SDK_USE_HTTP1_FOR_AGENT;
  return {
    directory, root, home, environment, statePath: path.join(home, '.cursor2response/state.json'),
    command: (action, port) => spawnSync(process.execPath, ['server.mjs', action, ...(port ? ['--port', String(port)] : [])], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 35000,
    }),
  };
}

async function reservePort() {
  const server = createServer();
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !status.slice(status.lastIndexOf(')') + 2).startsWith('Z');
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

async function terminateFixtureProcesses(pids) {
  for (const pid of pids.filter(Boolean)) {
    if (!processIsAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (pids.every((pid) => !processIsAlive(pid))) return;
    await delay(20);
  }
  throw new Error('Fixture processes did not exit');
}
