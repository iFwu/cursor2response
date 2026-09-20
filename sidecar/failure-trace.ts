import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gzip } from "node:zlib";

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const MIN_MAX_BYTES = 16 * 1024;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOMATIC_FAILURE_CODES = new Set([
  "cursor_sdk_bridge_timeout",
  "cursor_sdk_idle_timeout",
  "cursor_sdk_stream_timeout",
  "cursor_sdk_timeout",
  "cursor_sdk_tool_correction_timeout"
]);
const CREDENTIAL_BODY_KEYS = new Set(["apikey", "api_key", "authorization"]);
let storeOperations: Promise<unknown> = Promise.resolve();

export interface FailureTraceStoreOptions {
  directory: string;
  maxBytes: number;
  maxFiles: number;
  maxAgeMs: number;
}

export interface FailureTraceInput {
  requestBody: unknown;
  responseId: string;
  model: string;
  stream: boolean;
  session: {
    key: string;
    source: string;
    sessionHeaders: string[];
  };
  clientSource: string;
  clientPlatform?: string;
  prompt: string;
  incrementalPrompt?: string;
  toolNames: string[];
  resumeToolResultsCount: number;
  supersedePendingRun: boolean;
  supersedingTurnAborted: boolean;
  supersededToolCallIds: string[];
}

interface CapturedEvent {
  offsetMs: number;
  sse: string;
}

export function failureTraceStoreOptionsFromEnv(): FailureTraceStoreOptions {
  return {
    directory: path.resolve(process.env.CURSOR2RESPONSE_FAILURE_TRACE_DIR || path.join(
      process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"),
      "cursor2response",
      "failure-traces"
    )),
    maxBytes: Math.max(
      MIN_MAX_BYTES,
      positiveInteger(process.env.CURSOR2RESPONSE_FAILURE_TRACE_MAX_BYTES, DEFAULT_MAX_BYTES)
    ),
    maxFiles: DEFAULT_MAX_FILES,
    maxAgeMs: DEFAULT_MAX_AGE_MS
  };
}

export function initializeFailureTraceStore(
  options: FailureTraceStoreOptions = failureTraceStoreOptionsFromEnv()
): Promise<void> {
  const normalized = normalizedStoreOptions(options);
  return queueStoreOperation(async () => {
    await ensureTraceDirectory(normalized.directory);
    await pruneFailureTraces(normalized);
  });
}

export function createFailureTraceCapture(
  input: FailureTraceInput,
  options: FailureTraceStoreOptions = failureTraceStoreOptionsFromEnv()
): FailureTraceCapture {
  return new FailureTraceCapture(input, options);
}

export class FailureTraceCapture {
  private readonly startedAt = Date.now();
  private readonly events: CapturedEvent[] = [];
  private eventBytes = 0;
  private oversized = false;

  private readonly options: FailureTraceStoreOptions;

  constructor(private readonly input: FailureTraceInput, options: FailureTraceStoreOptions) {
    this.options = normalizedStoreOptions(options);
  }

  recordSse(bytes: Uint8Array): void {
    if (this.oversized) return;
    this.eventBytes += bytes.byteLength;
    if (this.eventBytes > this.options.maxBytes) {
      this.oversized = true;
      this.events.length = 0;
      return;
    }
    this.events.push({
      offsetMs: Math.max(0, Date.now() - this.startedAt),
      sse: new TextDecoder().decode(bytes)
    });
  }

  async capture(error: unknown): Promise<string | null> {
    const failure = capturedFailure(error);
    if (!failure) return null;
    return queueStoreOperation(() => writeFailureTrace(
      this.input,
      this.events,
      this.oversized,
      failure,
      this.options
    ));
  }
}

function queueStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  const current = storeOperations.catch(() => undefined).then(operation);
  storeOperations = current;
  return current;
}

async function writeFailureTrace(
  input: FailureTraceInput,
  events: CapturedEvent[],
  oversized: boolean,
  failure: { status: number; code: string; message: string },
  options: FailureTraceStoreOptions
): Promise<string> {
  await ensureTraceDirectory(options.directory);
  const capturedAt = new Date().toISOString();
  const artifact = failureTraceArtifact(input, events, failure, capturedAt);
  const uncompressed = oversized ? null : Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  if (oversized || !uncompressed || uncompressed.byteLength > options.maxBytes) {
    const marker = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      kind: "cursor2response_failure_trace_rejection",
      capturedAt,
      reason: "capture_rejected_size_limit",
      maxBytes: options.maxBytes,
      uncompressedBytes: uncompressed?.byteLength ?? null,
      responseId: input.responseId,
      failure
    })}\n`, "utf8");
    await pruneFailureTraces(options, marker.byteLength, 1);
    const markerPath = path.join(options.directory, traceFilename(capturedAt, input.responseId, failure.code, ".rejected.json"));
    await atomicWrite(markerPath, marker);
    await pruneFailureTraces(options);
    return markerPath;
  }

  const compressed = await gzipBuffer(uncompressed);
  if (compressed.byteLength > options.maxBytes) {
    const marker = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      kind: "cursor2response_failure_trace_rejection",
      capturedAt,
      reason: "capture_rejected_size_limit",
      maxBytes: options.maxBytes,
      uncompressedBytes: uncompressed.byteLength,
      compressedBytes: compressed.byteLength,
      responseId: input.responseId,
      failure
    })}\n`, "utf8");
    await pruneFailureTraces(options, marker.byteLength, 1);
    const markerPath = path.join(options.directory, traceFilename(capturedAt, input.responseId, failure.code, ".rejected.json"));
    await atomicWrite(markerPath, marker);
    await pruneFailureTraces(options);
    return markerPath;
  }

  await pruneFailureTraces(options, compressed.byteLength, 1);
  const filePath = path.join(options.directory, traceFilename(capturedAt, input.responseId, failure.code, ".json.gz"));
  await atomicWrite(filePath, compressed);
  await pruneFailureTraces(options);
  return filePath;
}

function failureTraceArtifact(
  input: FailureTraceInput,
  events: CapturedEvent[],
  failure: { status: number; code: string; message: string },
  capturedAt: string
) {
  const body = sanitizedRequestBody(input.requestBody);
  const previousResponseId = stringProperty(body, "previous_response_id");
  const hasToolOutputs = responseInputItems(body).some((item) => {
    const type = recordProperty(item, "type");
    return type === "function_call_output" || type === "custom_tool_call_output";
  });
  return {
    schemaVersion: 1,
    kind: "cursor2response_failure_trace",
    capturedAt,
    request: {
      route: "/v1/responses",
      body,
      responseId: input.responseId,
      model: input.model,
      stream: input.stream,
      clientSource: input.clientSource,
      ...(input.clientPlatform ? { clientPlatform: input.clientPlatform } : {}),
      session: {
        source: input.session.source,
        sessionHeaders: input.session.sessionHeaders,
        keySha256: sha256(input.session.key)
      }
    },
    derived: {
      promptChars: input.prompt.length,
      promptSha256: sha256(input.prompt),
      incrementalPromptChars: input.incrementalPrompt?.length ?? 0,
      incrementalPromptSha256: input.incrementalPrompt ? sha256(input.incrementalPrompt) : null,
      toolCount: input.toolNames.length,
      toolNames: input.toolNames,
      resumeToolResultsCount: input.resumeToolResultsCount,
      supersedePendingRun: input.supersedePendingRun,
      supersedingTurnAborted: input.supersedingTurnAborted,
      supersededToolCallIds: input.supersededToolCallIds,
      lineage: previousResponseId ? "body-only-unresolved" : "body",
      statelessReplayEligible: !previousResponseId
        && !hasToolOutputs
        && !input.incrementalPrompt
        && input.resumeToolResultsCount === 0
        && !input.supersedePendingRun
    },
    events,
    failure
  };
}

function capturedFailure(error: unknown): { status: number; code: string; message: string } | null {
  const candidates = flattenedErrorRecords(error);
  const matched = candidates.find((value) => Number(value.status) === 409)
    ?? candidates.find((value) => AUTOMATIC_FAILURE_CODES.has(String(value.code || "").toLowerCase()));
  if (!matched) return null;
  const code = typeof matched.code === "string" && matched.code
    ? matched.code
    : Number(matched.status) === 409 ? "protocol_conflict" : "cursor_sdk_timeout";
  const rawStatus = Number(matched.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus
    : AUTOMATIC_FAILURE_CODES.has(code.toLowerCase()) ? 504 : 500;
  const message = firstString(matched.message, error instanceof Error ? error.message : undefined, "Request failed");
  return { status, code, message: message.slice(0, 4096) };
}

function flattenedErrorRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    records.push(record);
    pending.push(record.cause, record.error, record.reason);
    if (Array.isArray(record.errors)) pending.push(...record.errors);
  }
  return records;
}

async function pruneFailureTraces(
  options: FailureTraceStoreOptions,
  reserveBytes = 0,
  reserveFiles = 0
): Promise<void> {
  const entries = await readdir(options.directory, { withFileTypes: true });
  const now = Date.now();
  const retained: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    const filePath = path.join(options.directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tmp")) {
      await unlink(filePath).catch(() => undefined);
      continue;
    }
    if (!entry.isFile() || (!entry.name.endsWith(".json.gz") && !entry.name.endsWith(".rejected.json"))) continue;
    try {
      const metadata = await stat(filePath);
      if (now - metadata.mtimeMs > options.maxAgeMs) {
        await unlink(filePath);
      } else {
        retained.push({ filePath, mtimeMs: metadata.mtimeMs, size: metadata.size });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
  retained.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const fileLimit = Math.max(0, options.maxFiles - reserveFiles);
  const byteLimit = Math.max(0, options.maxBytes - reserveBytes);
  let keptFiles = 0;
  let keptBytes = 0;
  for (const entry of retained) {
    if (keptFiles >= fileLimit || keptBytes + entry.size > byteLimit) {
      await unlink(entry.filePath).catch((error) => {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      });
      continue;
    }
    keptFiles += 1;
    keptBytes += entry.size;
  }
}

async function ensureTraceDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWrite(filePath: string, contents: Uint8Array): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function gzipBuffer(contents: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(contents, (error, result) => error ? reject(error) : resolve(result));
  });
}

function traceFilename(capturedAt: string, responseId: string, code: string, suffix: string): string {
  const timestamp = capturedAt.replaceAll(":", "-").replace(".", "-");
  return `${timestamp}-${safeFilenamePart(responseId)}-${safeFilenamePart(code)}-${randomUUID()}${suffix}`;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96) || "unknown";
}

function sanitizedRequestBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([key]) => !CREDENTIAL_BODY_KEYS.has(key.toLowerCase())));
}

function responseInputItems(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  const input = (body as Record<string, unknown>).input;
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() ? property.trim() : undefined;
}

function recordProperty(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && Boolean(value)) ?? "";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedStoreOptions(options: FailureTraceStoreOptions): FailureTraceStoreOptions {
  return {
    ...options,
    maxBytes: Math.max(MIN_MAX_BYTES, options.maxBytes)
  };
}
