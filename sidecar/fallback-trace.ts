export type FallbackTrace = (event: string, fields: Record<string, unknown>) => void;

const MAX_FRAME_CHARS = 1024 * 1024;
const MAX_CONTENT_CHARS = 128 * 1024;

export function observeFallbackResponse(
  response: Response,
  record: FallbackTrace,
  inputs: Array<{ source: "user" | "tool_result"; content: string; callId?: string }>
): Response {
  const trace: FallbackTrace = (event, fields) => { try { record(event, fields); } catch { /* Observation only. */ } };
  if (!response.ok) {
    trace("trajectory_execution_terminal", { status: "failed", errorCode: "api_fallback_http_error", upstreamStatus: response.status });
  }
  if (!response.body) return response;
  let accepted = false;
  let terminal = !response.ok;
  let disabled = false;
  let buffer = "";
  const decoder = new TextDecoder();
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  const published = new Set<string>();
  const prefixPublished = new Set<string>();
  const acceptInputs = () => {
    if (accepted) return;
    accepted = true;
    inputs.forEach((input, index) => {
      const inputId = `input_${crypto.randomUUID()}`;
      trace("trajectory_input_content_chunk", { inputId, source: input.source, callId: input.callId,
        content: input.content.slice(0, MAX_CONTENT_CHARS), contentChars: input.content.length,
        truncated: input.content.length > MAX_CONTENT_CHARS, chunkIndex: 0, chunkCount: 1, itemIndex: index });
      trace("trajectory_input_accepted", { inputId, source: input.source, callId: input.callId, acceptedBy: "responses_upstream" });
    });
  };
  const publishItem = (item: Record<string, any>) => {
    if (!item.id || published.has(item.id)) return;
    published.add(item.id);
    const tool = item.type === "function_call" || item.type === "custom_tool_call";
    const content = tool ? item.arguments ?? item.input : Array.isArray(item.content)
      ? item.content.filter((part: any) => part.type === "output_text" || part.type === "refusal")
        .map((part: any) => part.text ?? part.refusal ?? "").join("") : "";
    if (typeof content !== "string" || (!content && !tool)) return;
    const outputType = tool ? "tool_call" : item.phase === "commentary" ? "commentary" : "final";
    trace("trajectory_output_content_chunk", { outputId: item.id, outputType,
      callId: item.call_id, toolName: item.name, contentKind: tool ? "arguments" : "text",
      content: content.slice(0, MAX_CONTENT_CHARS), contentChars: content.length,
      truncated: content.length > MAX_CONTENT_CHARS, chunkIndex: 0, chunkCount: 1 });
    trace("trajectory_output_published", { outputId: item.id, outputType, publicationKind: "completed" });
  };
  const observe = (event: Record<string, any>) => {
    if (!response.ok) return;
    if (event.type === "response.created" || event.object === "response") acceptInputs();
    if (event.type === "response.output_text.delta" && event.item_id && !prefixPublished.has(event.item_id)) {
      prefixPublished.add(event.item_id);
      trace("trajectory_output_published", { outputId: event.item_id, publicationKind: "prefix" });
    }
    if (event.type === "response.output_item.done" && event.item) publishItem(event.item);
    const result = event.response ?? (event.object === "response" ? event : undefined);
    if (!result || !["completed", "failed", "incomplete", "cancelled"].includes(result.status)) return;
    if (terminal) return;
    terminal = true;
    for (const item of result.output ?? []) publishItem(item);
    const usage = result.usage;
    trace("trajectory_execution_terminal", {
      status: result.status === "completed" ? "finished" : result.status === "cancelled" ? "cancelled" : "failed",
      responseId: result.id,
      errorCode: result.error?.code ?? (result.status === "incomplete" ? "api_fallback_incomplete" : undefined),
      inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens
    });
  };
  const observeBytes = (bytes?: Uint8Array, done = false) => {
    if (disabled) return;
    try {
      buffer += decoder.decode(bytes, { stream: !done });
      if (streaming) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (frame.length > MAX_FRAME_CHARS) throw new Error("Observation frame too large");
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (data && data !== "[DONE]") observe(JSON.parse(data));
        }
      } else if (done && buffer.trim()) {
        observe(JSON.parse(buffer));
        buffer = "";
      }
      if (buffer.length > MAX_FRAME_CHARS) throw new Error("Observation frame too large");
    } catch {
      disabled = true;
      buffer = "";
      trace("trajectory_observation_error", { scope: "fallback_response", errorCode: "trace_upstream_parse_failed" });
    }
  };
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          observeBytes(undefined, true);
          if (!terminal) trace("trajectory_error", { phase: "fallback_publication", errorCode: "fallback_terminal_unobserved", terminal: false });
          controller.close();
          reader.releaseLock();
        } else {
          controller.enqueue(value);
          observeBytes(value);
        }
      } catch (error) {
        trace("trajectory_execution_terminal", { status: "failed", errorCode: "api_fallback_stream_failed" });
        controller.error(error);
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      trace("trajectory_execution_terminal", { status: "cancelled", errorCode: "cursor_sdk_cancelled" });
      await reader.cancel(reason);
      reader.releaseLock();
    }
  });
  const headers = new Headers();
  for (const key of ["content-type", "cache-control", "x-request-id", "retry-after"]) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("x-accel-buffering", "no");
  return new Response(body, { status: response.status, headers });
}
