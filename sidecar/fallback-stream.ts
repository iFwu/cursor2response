import { Buffer } from "node:buffer";
import { HttpError } from "../core/http.ts";
import { responseFailedEvent } from "../core/openai.ts";

const MAX_PENDING_BYTES = 16 * 1024 * 1024;

// Protocol framing is independent of best-effort trajectory observation. Never
// publish a partial frame: a transport reset must not corrupt the failure event.
export function guardFallbackStream(response: Response): Response {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  let pending = Buffer.alloc(0);
  let scanFrom = 0;
  let terminal = false;
  let cancelled = false;
  let sequence = -1;
  let identity = { id: `resp_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "" };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, code: string) => {
    if (!terminal) {
      controller.enqueue(responseFailedEvent({ ...identity, sequenceNumber: sequence + 1,
        error: new HttpError("Upstream response stream interrupted before completion.", 502, code) }));
      terminal = true;
    }
    pending = Buffer.alloc(0);
    controller.close();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (cancelled) return;
          if (done) {
            fail(controller, "api_fallback_missing_terminal");
            reader.releaseLock();
            return;
          }
          pending = Buffer.concat([pending, value]);
          let emitted = false;
          for (;;) {
            const boundaries = ["\r\n\r\n", "\n\n", "\r\r"].map((delimiter) => ({
              index: pending.indexOf(delimiter, scanFrom), length: delimiter.length
            })).filter((entry) => entry.index >= 0).sort((a, b) => a.index - b.index);
            const boundary = boundaries[0];
            if (!boundary) {
              scanFrom = Math.max(0, pending.length - 3);
              break;
            }
            if (boundary.index > MAX_PENDING_BYTES) throw new HttpError("SSE frame too large", 502, "api_fallback_frame_too_large");
            const end = boundary.index + boundary.length;
            const frame = pending.subarray(0, end);
            const data = frame.toString("utf8").split(/\r\n|\r|\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
            if (data && data !== "[DONE]") {
              let event;
              try { event = JSON.parse(data); } catch {
                throw new HttpError("Invalid SSE event", 502, "api_fallback_invalid_stream");
              }
              if (event && typeof event === "object") {
                const result = event.response;
                if (result && typeof result.id === "string") {
                  identity = { id: result.id,
                    created: typeof result.created_at === "number" ? result.created_at : identity.created,
                    model: typeof result.model === "string" ? result.model : identity.model };
                }
                if (Number.isSafeInteger(event.sequence_number)) sequence = Math.max(sequence, event.sequence_number);
                if (["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(event.type)) terminal = true;
              }
            } else if (data === "[DONE]" && !terminal) {
              throw new HttpError("Missing Responses terminal event", 502, "api_fallback_missing_terminal");
            }
            controller.enqueue(frame);
            emitted = true;
            pending = pending.subarray(end);
            scanFrom = 0;
          }
          if (pending.length > MAX_PENDING_BYTES) throw new HttpError("SSE frame too large", 502, "api_fallback_frame_too_large");
          if (emitted) return;
        }
      } catch (error) {
        if (cancelled) return;
        fail(controller, error instanceof HttpError ? error.code : "api_fallback_stream_failed");
        await reader.cancel(error).catch(() => undefined);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
    }
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}
