import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errorResponse, HttpError } from "../core/http.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BODY_TIMEOUT_MS = 60_000;

function readBody(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    return Promise.reject(new HttpError("Request body exceeds 64 MiB.", 413, "request_too_large"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      if (error) {
        request.pause();
        reject(error);
      } else resolve(Buffer.concat(chunks, bytes));
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        finish(new HttpError("Request body exceeds 64 MiB.", 413, "request_too_large"));
      } else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () => finish(new DOMException("Request aborted", "AbortError"));
    const timer = setTimeout(() => finish(new HttpError("Request body timed out.", 408, "request_timeout")), BODY_TIMEOUT_MS);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

async function writeResponse(response: Response, target: ServerResponse, signal: AbortSignal, head: boolean): Promise<void> {
  if (signal.aborted) await response.body?.cancel(signal.reason).catch(() => {});
  signal.throwIfAborted();
  for (const [name, value] of response.headers) target.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) target.setHeader("set-cookie", cookies);
  target.statusCode = response.status;
  if (response.statusText) target.statusMessage = response.statusText;
  target.flushHeaders();
  if (head || !response.body) {
    await response.body?.cancel();
    target.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (!target.write(chunk.value)) await once(target, "drain", { signal });
    }
    target.end();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createSidecarServer(handler: (request: Request) => Promise<Response>) {
  return createServer({ headersTimeout: 60_000, requestTimeout: 60_000 }, (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Client disconnected", "AbortError"));
    incoming.once("aborted", abort);
    outgoing.once("error", abort);
    outgoing.once("close", () => { if (!outgoing.writableFinished) abort(); });
    void (async () => {
      let response: Response;
      try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        }
        const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
        const body = hasBody ? await readBody(incoming) : undefined;
        controller.signal.throwIfAborted();
        response = await handler(new Request(`http://localhost${incoming.url || "/"}`, {
          method: incoming.method,
          headers,
          ...(body ? { body: new Uint8Array(body) } : {}),
          signal: controller.signal
        }));
      } catch (error) {
        if (controller.signal.aborted) return;
        response = errorResponse(error);
        if (!incoming.complete) outgoing.setHeader("connection", "close");
      }
      await writeResponse(response, outgoing, controller.signal, incoming.method === "HEAD");
    })().catch(() => {
      abort();
      outgoing.destroy();
    });
  });
}
