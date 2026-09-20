import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
export function defaultLogDirectory() {
  return process.env.CURSOR2RESPONSE_TRACE_LOG_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cursor2response', 'logs');
}

export function runLoggedCommand(service, command, args = []) {
  if (!['bridge', 'sidecar'].includes(service) || !command) throw new Error('Usage: structured-log-runner.mjs bridge|sidecar -- command [args]');
  const directory = defaultLogDirectory();
  const maxBytes = positive(process.env.CURSOR2RESPONSE_TRACE_LOG_MAX_BYTES, 16 * 1024 * 1024);
  const files = Math.min(16, positive(process.env.CURSOR2RESPONSE_TRACE_LOG_FILES, 4));
  const filename = path.join(directory, `${service}.jsonl`);
  const queue = [];
  let queuedBytes = 0;
  let flushing = false;
  let lost = false;
  let file;
  let size = 0;
  let disabled = false;
  let spawnFailed = false;
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: grouped, env: { ...process.env, CURSOR2RESPONSE_LAUNCHER_PID: String(process.pid) } });

  async function flush() {
    if (flushing || disabled) return;
    flushing = true;
    try {
      if (!file) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        size = (await file.stat()).size;
      }
      while (queue.length) {
        const line = queue.shift();
        queuedBytes -= line.length;
        if (size + line.length > maxBytes) {
          await file.close();
          file = null;
          await unlink(`${filename}.${files - 1}`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          for (let index = files - 2; index >= 0; index--) {
            await rename(index ? `${filename}.${index}` : filename, `${filename}.${index + 1}`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          }
          if (files === 1) await unlink(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
          size = 0;
        }
        await file.writeFile(line);
        size += line.length;
      }
    } catch {
      disabled = true;
      queue.length = 0;
      queuedBytes = 0;
    } finally {
      flushing = false;
    }
  }

  function observe(message, stream) {
    if (disabled || !message) return;
    try {
      const line = Buffer.from(`${JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: String(Date.now() * 1000), service, stream, tracePartial: lost })}\n`);
      if (line.length > maxBytes || queuedBytes + line.length > 4 * 1024 * 1024) { lost = true; return; }
      lost = false;
      queue.push(line);
      queuedBytes += line.length;
      void flush();
    } catch { lost = true; }
  }

  for (const [stream, target, name] of [[child.stdout, process.stdout, 'stdout'], [child.stderr, process.stderr, 'stderr']]) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let discard = false;
    target.on('error', () => {});
    stream.on('data', (bytes) => {
      // Child pipes must drain even when the runner's stdout consumer stalls.
      try { if (!target.destroyed && target.writableLength < 1024 * 1024) target.write(bytes); } catch {}
      try {
        pending += decoder.write(bytes);
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          if (!discard) observe(pending.slice(0, newline), name);
          pending = pending.slice(newline + 1);
          discard = false;
        }
        if (pending.length > 1024 * 1024) { pending = ''; discard = true; lost = true; }
      } catch { pending = ''; discard = true; lost = true; }
    });
    stream.on('end', () => { if (!discard) observe(pending + decoder.end(), name); });
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try { grouped ? process.kill(-child.pid, signal) : child.kill(signal); } catch {}
    });
  }
  child.once('error', () => { spawnFailed = true; });
  child.once('close', async (code, signal) => {
    const exitCode = spawnFailed ? 127 : code ?? 128 + (os.constants.signals[signal] || 0);
    // Logging must never delay the child's exit indefinitely on a stuck filesystem.
    const deadline = setTimeout(() => process.exit(exitCode), 250);
    while (flushing) await new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
    await file?.close().catch(() => {});
    clearTimeout(deadline);
    process.exit(exitCode);
  });
  return child;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [service, separator, command, ...args] = process.argv.slice(2);
  if (separator !== '--') throw new Error('Expected -- before command');
  runLoggedCommand(service, command, args);
}
