import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { parseTraceText } from "./trace-model.mjs";
import { createRuntimeReader } from "./runtime.mjs";
import { logWindows, readLiveLogs } from "./live-logs.mjs";
import { defaultLogDirectory } from "../../scripts/structured-log-runner.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const allowedSuffixes = [".rejected.json", ".json.gz", ".jsonl", ".ndjson", ".json", ".log"];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultTraceDirectory() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return process.env.CURSOR2RESPONSE_TRACE_VIEWER_DIR || path.join(stateHome, "cursor2response", "traces");
}

function allowedSuffix(name) {
  return allowedSuffixes.find((suffix) => name.toLowerCase().endsWith(suffix));
}

function assertFileName(name) {
  if (
    typeof name !== "string"
    || name.length === 0
    || name.length > 180
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || !allowedSuffix(name)
  ) {
    throw new HttpError(400, "invalid_trace_name", "Invalid trace file name.");
  }
  return name;
}

function importedFileName(input) {
  const original = path.basename(String(input || "trace.jsonl"));
  const suffix = allowedSuffix(original) || ".jsonl";
  const stem = original.slice(0, original.length - suffix.length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120) || "trace";
  return `${stem}${suffix}`;
}

function withinDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureTraceDirectory(traceDirectory) {
  await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
}

async function readTraceBytes(traceDirectory, name, maxFileBytes) {
  assertFileName(name);
  const candidate = path.resolve(traceDirectory, name);
  if (!withinDirectory(traceDirectory, candidate)) {
    throw new HttpError(400, "invalid_trace_path", "Trace path leaves the configured directory.");
  }
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new HttpError(400, "invalid_trace_file", "Trace entry is not a regular file.");
    if (metadata.size > maxFileBytes) {
      throw new HttpError(413, "trace_too_large", `Trace file exceeds ${maxFileBytes} bytes.`);
    }
    return { bytes: await handle.readFile(), metadata };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (["ENOENT", "ELOOP"].includes(error?.code)) {
      throw new HttpError(404, "trace_not_found", "Trace file was not found.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseTraceBytes(bytes, name, maxExpandedBytes, source = {}) {
  let decoded = bytes;
  if (name.toLowerCase().endsWith(".gz")) {
    try {
      decoded = gunzipSync(bytes, { maxOutputLength: maxExpandedBytes });
    } catch {
      throw new HttpError(400, "invalid_gzip_trace", "Trace gzip could not be decoded within the size limit.");
    }
  }
  if (decoded.byteLength > maxExpandedBytes) {
    throw new HttpError(413, "trace_expanded_too_large", `Decoded trace exceeds ${maxExpandedBytes} bytes.`);
  }
  return parseTraceText(decoded.toString("utf8"), {
    kind: "file",
    ...source,
    name,
    bytes: bytes.byteLength,
    decodedBytes: decoded.byteLength
  });
}

async function listTraceFiles(traceDirectory, maxFileBytes) {
  await ensureTraceDirectory(traceDirectory);
  const entries = await readdir(traceDirectory, { withFileTypes: true });
  const files = await Promise.all(entries.flatMap((entry) => {
    if (!entry.isFile() || !allowedSuffix(entry.name)) return [];
    return [stat(path.join(traceDirectory, entry.name)).then((metadata) => ({
      name: entry.name,
      bytes: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      oversized: metadata.size > maxFileBytes
    }))];
  }));
  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

async function readBody(request, maxFileBytes) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxFileBytes) {
    throw new HttpError(413, "trace_too_large", `Trace upload exceeds ${maxFileBytes} bytes.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxFileBytes) {
      throw new HttpError(413, "trace_too_large", `Trace upload exceeds ${maxFileBytes} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function numberedName(name, number) {
  if (number === 1) return name;
  const suffix = allowedSuffix(name);
  return `${name.slice(0, -suffix.length)}-${number}${suffix}`;
}

async function writeUniqueTrace(traceDirectory, requestedName, bytes) {
  const name = importedFileName(requestedName);
  for (let number = 1; number <= 999; number += 1) {
    const candidateName = numberedName(name, number);
    const candidate = path.join(traceDirectory, candidateName);
    let handle;
    try {
      handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(bytes);
      return candidateName;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      await handle?.close();
    }
  }
  throw new HttpError(409, "trace_name_exhausted", "Could not allocate a unique trace file name.");
}

function json(response, status = 200) {
  return {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: Buffer.from(`${JSON.stringify(response)}\n`)
  };
}

function acceptsGzip(value) {
  let wildcardQuality = 0;
  for (const entry of String(value ?? "").split(",")) {
    const [coding, ...parameters] = entry.trim().toLowerCase().split(";");
    const quality = parameters
      .map((parameter) => parameter.trim().match(/^q\s*=\s*(\d(?:\.\d+)?)$/)?.[1])
      .find((parameter) => parameter !== undefined);
    const numericQuality = quality === undefined ? 1 : Number(quality);
    if (coding === "gzip") return numericQuality > 0;
    if (coding === "*") wildcardQuality = numericQuality;
  }
  return wildcardQuality > 0;
}

function compressResponse(request, result) {
  if (result.body.byteLength < 1024) return result;
  const headers = { ...result.headers, "Vary": "Accept-Encoding" };
  if (!acceptsGzip(request.headers["accept-encoding"])) return { ...result, headers };
  return {
    ...result,
    headers: {
      ...headers,
      "Content-Encoding": "gzip"
    },
    body: gzipSync(result.body, { level: 1 })
  };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function staticResponse(staticDirectory, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const candidate = path.resolve(staticDirectory, relative);
  if (!withinDirectory(staticDirectory, candidate)) {
    throw new HttpError(404, "asset_not_found", "Asset was not found.");
  }
  try {
    return {
      status: 200,
      headers: { "Content-Type": contentType(candidate), "Cache-Control": "no-cache" },
      body: await readFile(candidate)
    };
  } catch (error) {
    if (error?.code === "ENOENT") throw new HttpError(404, "asset_not_found", "Asset was not found.");
    throw error;
  }
}

export function createTraceViewerServer(options = {}) {
  const traceDirectory = path.resolve(options.traceDirectory ?? defaultTraceDirectory());
  const staticDirectory = path.resolve(options.staticDirectory ?? path.join(moduleDirectory, "dist"));
  const maxFileBytes = options.maxFileBytes ?? positiveInteger(process.env.CURSOR2RESPONSE_TRACE_VIEWER_MAX_BYTES, 32 * 1024 * 1024);
  const maxExpandedBytes = options.maxExpandedBytes ?? Math.max(maxFileBytes, 64 * 1024 * 1024);
  const maxLogBytes = options.maxLogBytes ?? positiveInteger(
    process.env.CURSOR2RESPONSE_TRACE_VIEWER_LOG_MAX_BYTES,
    128 * 1024 * 1024
  );
  const logDirectory = path.resolve(options.logDirectory ?? defaultLogDirectory());
  const runtimeReader = createRuntimeReader(options);

  const server = createServer(async (request, response) => {
    try {
      await ensureTraceDirectory(traceDirectory);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      let result;
      if (request.method === "GET" && url.pathname === "/health") {
        result = json({ ok: true, traceDirectory });
      } else if (request.method === "GET" && url.pathname === "/api/runtime") {
        if (url.search) throw new HttpError(400, "invalid_runtime_query", "Runtime does not accept query parameters.");
        try {
          result = json(await runtimeReader());
        } catch (error) {
          throw new HttpError(503, error.code, error.code === "runtime_invalid_snapshot"
            ? "Bridge runtime snapshot is invalid." : "Bridge runtime is unavailable.");
        }
      } else if (request.method === "GET" && url.pathname === "/api/logs") {
        const since = url.searchParams.get("since") || "6h";
        if (!Object.hasOwn(logWindows, since)) {
          throw new HttpError(400, "invalid_log_window", "Log window must be 1h, 6h, 24h, 3d, or 7d.");
        }
        let logs;
        try { logs = await readLiveLogs(logDirectory, since, maxLogBytes); }
        catch { throw new HttpError(503, "logs_unavailable", "The configured live log directory could not be read."); }
        result = json(parseTraceText(logs.text, {
          kind: "logs", name: "Live logs", since,
          bytes: logs.bytes, partial: logs.partial, retentionBounded: true
        }));
      } else if (request.method === "GET" && url.pathname === "/api/files") {
        result = json({ files: await listTraceFiles(traceDirectory, maxFileBytes) });
      } else if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/files/".length));
        const { bytes, metadata } = await readTraceBytes(traceDirectory, name, maxFileBytes);
        result = json(parseTraceBytes(bytes, name, maxExpandedBytes, { modifiedAt: metadata.mtime.toISOString() }));
      } else if (request.method === "POST" && url.pathname === "/api/import") {
        const bytes = await readBody(request, maxFileBytes);
        const requestedName = url.searchParams.get("name") || "trace.jsonl";
        const parsed = parseTraceBytes(bytes, importedFileName(requestedName), maxExpandedBytes, { imported: true });
        if (parsed.diagnostics.acceptedRecords === 0) {
          throw new HttpError(422, "empty_trace", "No structured trace records were found.");
        }
        const name = await writeUniqueTrace(traceDirectory, requestedName, bytes);
        parsed.source.name = name;
        result = json(parsed, 201);
      } else if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        result = await staticResponse(staticDirectory, url.pathname);
      } else {
        throw new HttpError(404, "not_found", "Route was not found.");
      }
      result = compressResponse(request, result);
      response.writeHead(result.status, {
        ...result.headers,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      });
      response.end(result.body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const message = error instanceof HttpError ? error.message : "Trace viewer request failed.";
      const result = json({ error: { code, message } }, status);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    }
  });
  server.traceViewer = { traceDirectory, staticDirectory, maxFileBytes, maxExpandedBytes, maxLogBytes, logDirectory };
  return server;
}

export async function startTraceViewerServer(options = {}) {
  const server = createTraceViewerServer(options);
  await ensureTraceDirectory(server.traceViewer.traceDirectory);
  const host = options.host ?? process.env.CURSOR2RESPONSE_TRACE_VIEWER_HOST ?? "127.0.0.1";
  const port = options.port ?? positiveInteger(process.env.CURSOR2RESPONSE_TRACE_VIEWER_PORT, 4319);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startTraceViewerServer();
  const address = server.address();
  console.info(`cursor2response trace viewer listening on http://${address.address}:${address.port}`);
  console.info(`trace directory: ${server.traceViewer.traceDirectory}`);
}
