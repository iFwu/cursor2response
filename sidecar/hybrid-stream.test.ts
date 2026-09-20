import { expect, test } from "vitest";
import { guardHybridStream } from "./hybrid-stream.ts";

const encoder = new TextEncoder();
const created = { type: "response.created", sequence_number: 0,
  response: { id: "resp-upstream", created_at: 123, model: "upstream-model", status: "in_progress", output: [] } };
const tool = { type: "response.output_item.done", sequence_number: 4,
  item: { id: "fc-one", type: "function_call", call_id: "call-one", name: "work", arguments: "{}" } };
const completed = { type: "response.completed", sequence_number: 5,
  response: { ...created.response, status: "completed", output: [tool.item] } };
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const events = (body: string) => body.split(/\r?\n\r?\n/)
  .flatMap((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:")))
  .map((line) => JSON.parse(line.slice(5)));

function upstream(chunks: string[], error?: Error): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
      else if (error) controller.error(error);
      else controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

test.each([false, true])("terminates a partial fallback event after EOF or read failure (error=%s)", async (broken) => {
  const body = await guardHybridStream(upstream([sse(created), sse(tool), 'data: {"type":"response.output_text.delta"'],
    broken ? new Error("socket reset") : undefined)).text();
  const parsed = events(body);
  expect(parsed.slice(0, 2)).toEqual([created, tool]);
  expect(parsed).toHaveLength(3);
  expect(parsed[2]).toMatchObject({ type: "response.failed", sequence_number: 5,
    response: { id: "resp-upstream", model: "upstream-model", status: "failed",
      error: { code: broken ? "hybrid_fallback_stream_failed" : "hybrid_fallback_missing_terminal" } } });
  expect(body.match(/"call_id":"call-one"/g)).toHaveLength(1);
});

test("preserves valid SSE bytes and UTF-8 across arbitrary chunk boundaries", async () => {
  const text = ': heartbeat\r\n\r\n' + sse(created) + sse({ type: "response.output_text.delta", delta: "\u4e2d\u6587" }) + sse(completed);
  const bytes = encoder.encode(text);
  let index = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
    else controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  expect(await guardHybridStream(response).text()).toBe(text);
});

test.each(["completed", "failed", "incomplete"])("never adds a second terminal after response.%s", async (status) => {
  const text = sse(created) + sse({ ...completed, type: `response.${status}`, response: { ...completed.response, status } });
  expect(await guardHybridStream(upstream([text], new Error("late reset"))).text()).toBe(text);
});

test("reports failure before the first event without exposing raw transport details", async () => {
  const parsed = events(await guardHybridStream(upstream([], new Error("private transport details"))).text());
  expect(parsed.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed",
    error: { code: "hybrid_fallback_stream_failed" } } });
  expect(JSON.stringify(parsed)).not.toContain("private transport details");
});

test("consumer cancellation cancels the upstream reader", async () => {
  let cancelled = false;
  const response = guardHybridStream(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(encoder.encode(sse(created))); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } }));
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);
});

test.each([
  ["hybrid_fallback_invalid_stream", 'data: {bad-json}\n\n'],
  ["hybrid_fallback_missing_terminal", 'data: [DONE]\n\n'],
  ["hybrid_fallback_frame_too_large", 'data: ' + 'x'.repeat(16 * 1024 * 1024)]
])("reports invalid or unterminated protocol data: %s", async (code, frame) => {
  const parsed = events(await guardHybridStream(upstream([sse(created), frame])).text());
  expect(parsed.at(-1).response.error.code).toBe(code);
  expect(parsed.at(-1).response.id).toBe("resp-upstream");
});

test("passes JSON and HTTP failures through without SSE synthesis", async () => {
  const json = Response.json({ error: "overloaded" }, { status: 503 });
  expect(guardHybridStream(json)).toBe(json);
  const success = Response.json({ id: "resp-json", status: "completed" });
  expect(guardHybridStream(success)).toBe(success);
});
