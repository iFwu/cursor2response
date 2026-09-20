import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const logWindows = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '3d': 259200000, '7d': 604800000 };

export async function readLiveLogs(directory, since, maxBytes) {
  const now = Date.now();
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(bridge|sidecar)\.jsonl(?:\.(?:[1-9]|1[0-5]))?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a.split('.')[2] || 0) - Number(b.split('.')[2] || 0));
  const lines = [];
  let remaining = maxBytes;
  let partial = false;
  for (const name of names) {
    if (remaining <= 0) { partial = true; break; }
    let file;
    try {
      file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await file.stat();
      if (!metadata.isFile()) { partial = true; continue; }
      const count = Math.min(remaining, metadata.size);
      const offset = metadata.size - count;
      const buffer = Buffer.alloc(count);
      const { bytesRead } = await file.read(buffer, 0, count, offset);
      remaining -= bytesRead;
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (offset) { text = text.slice(text.indexOf('\n') + 1); partial = true; }
      if (!text.endsWith('\n') && text) { text = text.slice(0, text.lastIndexOf('\n') + 1); partial = true; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          if (record.service !== name.split('.')[0] || typeof record.MESSAGE !== 'string') { partial = true; continue; }
          const timestamp = Number(record.__REALTIME_TIMESTAMP) / 1000;
          if (!Number.isFinite(timestamp)) { partial = true; continue; }
          if (timestamp < now - logWindows[since] || timestamp > now) continue;
          if (record.tracePartial) partial = true;
          lines.push(line);
        } catch { partial = true; }
      }
    } catch { partial = true; }
    finally { await file?.close().catch(() => {}); }
  }
  return { text: lines.join('\n'), partial, bytes: maxBytes - remaining };
}
