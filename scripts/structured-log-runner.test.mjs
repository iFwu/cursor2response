import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./structured-log-runner.mjs', import.meta.url));
async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cursor2response-logs-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function start(directory, source, env = {}, command = process.execPath) {
  const child = spawn(process.execPath, [runner, 'bridge', '--', command, '-e', source], {
    env: { ...process.env, CURSOR2RESPONSE_TRACE_LOG_DIR: directory, ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

test('preserves stdout, stderr, final unterminated lines, and child exit status', async (context) => {
  const directory = await fixture(context);
  const result = await start(directory, `console.log('hello'); process.stderr.write('世界'); process.exitCode = 7;`).done;
  assert.equal(result.stdout, 'hello\n');
  assert.equal(result.stderr, '世界');
  assert.equal(result.code, 7);
  const records = (await readFile(path.join(directory, 'bridge.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((record) => record.MESSAGE).sort(), ['hello', '世界']);
  assert.ok(records.every((record) => record.service === 'bridge' && Number(record.__REALTIME_TIMESTAMP) > 0));
  assert.equal((await stat(path.join(directory, 'bridge.jsonl'))).mode & 0o777, 0o600);
});

test('bounds rotation size and retains complete JSON records', async (context) => {
  const directory = await fixture(context);
  const result = await start(directory, `for (let i = 0; i < 80; i++) console.log(JSON.stringify({ event: 'test', i }));`, {
    CURSOR2RESPONSE_TRACE_LOG_MAX_BYTES: '1024', CURSOR2RESPONSE_TRACE_LOG_FILES: '3'
  }).done;
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 80);
  const files = await readdir(directory);
  assert.equal(files.length, 3);
  const records = [];
  for (const filename of files) {
    assert.ok((await stat(path.join(directory, filename))).size <= 1024);
    records.push(...(await readFile(path.join(directory, filename), 'utf8')).trim().split('\n').map(JSON.parse));
  }
  assert.ok(records.length < 80);
  assert.ok(records.some((record) => JSON.parse(record.MESSAGE).i === 79));
});

test('logging failures do not change output or child success', async (context) => {
  const directory = await fixture(context);
  const occupied = path.join(directory, 'not-a-directory');
  await writeFile(occupied, 'existing');
  const result = await start(occupied, `console.log('success');`).done;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'success\n');
});

test('forwards termination signals and preserves signal exit status', { timeout: 5000 }, async (context) => {
  const directory = await fixture(context);
  const { child, done } = start(directory, `console.log('ready'); setInterval(() => {}, 1000);`);
  context.after(() => child.kill('SIGKILL'));
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.kill('SIGTERM');
  assert.equal((await done).code, 143);
});

test('returns command-not-found status when the child cannot start', async (context) => {
  const directory = await fixture(context);
  assert.equal((await start(directory, '', {}, '/nonexistent-cursor2response-command').done).code, 127);
});

test('marks an observation gap after dropping an oversized record', async (context) => {
  const directory = await fixture(context);
  assert.equal((await start(directory, `console.log('x'.repeat(4000)); console.log('retained');`, {
    CURSOR2RESPONSE_TRACE_LOG_MAX_BYTES: '512'
  }).done).code, 0);
  const records = (await readFile(path.join(directory, 'bridge.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].MESSAGE, 'retained');
  assert.equal(records[0].tracePartial, true);
});

test('a blocked stdout consumer cannot keep the child alive', { timeout: 5000 }, async (context) => {
  const directory = await fixture(context);
  const child = spawn(process.execPath, [runner, 'bridge', '--', process.execPath, '-e',
    `for (let i = 0; i < 128; i++) console.log('x'.repeat(65536));`], {
    env: { ...process.env, CURSOR2RESPONSE_TRACE_LOG_DIR: directory }, stdio: ['ignore', 'pipe', 'ignore']
  });
  context.after(() => child.kill('SIGKILL'));
  // The pipe is deliberately never read: the runner must discard observation output.
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  child.stdout.destroy();
});
