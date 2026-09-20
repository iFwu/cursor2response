import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CursorSdkContextOverflowError } from "../core/cursor-sdk.ts";
import { HttpError } from "../core/http.ts";
import { GROK_HYBRID_FAST_MODEL, GROK_HYBRID_MODEL, GrokHybridRoute, hybridConfig, hybridFallbackNotifyArgs, isGrokHybridFastModel, isGrokHybridModel, lastUserSnippet, type HybridConfig, type HybridRequest } from "./grok-hybrid.ts";
import { observeHybridResponse } from "./hybrid-trace.ts";

async function fixture(run: (input: {
  config: HybridConfig; request: HybridRequest; calls: RequestInit[];
  events: Array<{ event: string; fields: Record<string, unknown> }>;
  route: (changes?: Partial<HybridRequest>) => GrokHybridRoute;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "grok-hybrid-test-"));
  const config: HybridConfig = { responsesUrl: "https://fallback.example/v1/responses",
    apiKey: "fallback-secret", model: "mp-grok", stateDirectory: directory };
  const request: HybridRequest = {
    apiKey: "cursor-secret", body: { model: "grok-hybrid", input: "hello", stream: false },
    session: { key: "session-one", source: "header:session-id", sessionHeaders: ["session-id"] },
    workingDirectory: "/project", requestId: "resp-one", signal: new AbortController().signal,
    clientSource: "openclaw", clientPlatform: "linux", inputs: [{ source: "user", content: "hello" }]
  };
  const calls: RequestInit[] = [];
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const route = (changes: Partial<HybridRequest> = {}) => new GrokHybridRoute(config, { ...request, ...changes },
    (event, fields) => { events.push({ event, fields }); },
    (async (_url, init) => {
      calls.push(init!);
      return Response.json({ id: "resp-mp", object: "response", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 3 } });
    }));
  try { await run({ config, request, calls, events, route }); } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("recognizes the default and explicit fast model variants", () => {
  expect(isGrokHybridModel(GROK_HYBRID_MODEL)).toBe(true);
  expect(isGrokHybridModel(GROK_HYBRID_FAST_MODEL)).toBe(true);
  expect(isGrokHybridFastModel(GROK_HYBRID_FAST_MODEL)).toBe(true);
  expect(isGrokHybridFastModel(GROK_HYBRID_MODEL)).toBe(false);
  expect(isGrokHybridModel("grok-hybrid-other")).toBe(false);
});

test("requires an explicit complete fallback configuration and rejects recursive model configuration", () => {
  expect(hybridConfig({})).toBeUndefined();
  expect(() => hybridConfig({ CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_MODEL: "mp-grok" })).toThrow("incomplete");
  const env = { CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_BASE_URL: "https://fallback.example/v1/",
    CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_API_KEY: "key", CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_MODEL: "mp-grok" };
  expect(hybridConfig(env)?.responsesUrl).toBe("https://fallback.example/v1/responses");
  expect(() => hybridConfig({ ...env, CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_MODEL: "grok-hybrid" })).toThrow();
  expect(() => hybridConfig({ ...env, CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_BASE_URL: "file:///tmp" })).toThrow();
});

test("persists overflow routing across instances without forwarding Cursor credentials or losing tool history", async () => {
  await fixture(async ({ route, calls, config, request }) => {
    const first = route();
    expect(await first.initialResponse()).toBeUndefined();
    await (await first.recover(new CursorSdkContextOverflowError("SDK compacted", true), false))!.text();
    expect(calls).toHaveLength(1);
    const history = [{ type: "function_call", call_id: "call-one", name: "work", arguments: "{}" },
      { type: "function_call_output", call_id: "call-one", output: "done" }];
    const next = route({ body: { ...request.body, input: history } });
    await (await next.initialResponse())!.text();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body as string)).toEqual({ model: "mp-grok", stream: false, input: history });
    expect(new Headers(calls[1].headers).get("authorization")).toBe("Bearer fallback-secret");
    expect(JSON.stringify(calls)).not.toContain("cursor-secret");
    const files = await readdir(config.stateDirectory);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(config.stateDirectory, files[0]))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(config.stateDirectory, files[0]), "utf8")).not.toContain("secret");
    expect(await route({ apiKey: "other-key" }).initialResponse()).toBeUndefined();
    expect(await route({ workingDirectory: "/other" }).initialResponse()).toBeUndefined();
    expect(await route({ session: { ...request.session, key: "new-session" } }).initialResponse()).toBeUndefined();
  });
});

test.each([[true, true], [false, false], [true, false]])(
  "does not resend a published or cleanup-unconfirmed failure (published=%s safe=%s)",
  async (published, safe) => fixture(async ({ route, calls, events }) => {
    const first = route();
    expect(await first.recover(new CursorSdkContextOverflowError("SDK compacted", safe), published)).toBeUndefined();
    expect(calls).toHaveLength(0);
    await (await route().initialResponse())!.text();
    expect(calls).toHaveLength(1);
    expect(events.some((entry) => entry.fields.fallbackAttempted === false)).toBe(true);
  })
);

test("does not activate fallback for generic 413, timeout, rate limit or authentication errors", async () => {
  await fixture(async ({ route, calls }) => {
    for (const [status, code] of [[413, "context_length_exceeded"], [504, "cursor_sdk_bridge_timeout"], [429, "rate_limit"], [401, "unauthorized"]] as const) {
      expect(await route().recover(new HttpError("failure", status, code), false)).toBeUndefined();
    }
    expect(await route().initialResponse()).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

test.each([
  "cursor_sdk_tool_result_pending",
  "cursor_sdk_tool_result_batch_mismatch",
  "cursor_sdk_tool_result_unmatched"
])("does not replay or mark fallback for SDK tool conflict %s", async (code) => {
  for (const published of [false, true]) {
    for (const wrapped of [false, true]) {
      await fixture(async ({ route, calls, events, config, request }) => {
        const first = route({ body: { ...request.body, input: [
          { type: "function_call", call_id: "call-one", name: "work", arguments: "{}" }
        ] } });
        expect(await first.initialResponse()).toBeUndefined();
        const conflict = new HttpError("Cursor SDK tool result conflict.", 409, code);
        const error = wrapped ? new Error("bridge request failed", { cause: conflict }) : conflict;
        expect(await first.recover(error, published)).toBeUndefined();
        expect(await readdir(config.stateDirectory)).toEqual([]);
        expect(await route().initialResponse()).toBeUndefined();
        expect(calls).toHaveLength(0);
        expect(events.every((entry) => entry.fields.route === "cursor_sdk")).toBe(true);
      });
    }
  }
});

test("rejects missing session identity and provider-owned continuation state", async () => {
  await fixture(async ({ route, request }) => {
    expect(() => route({ session: { ...request.session, source: "generated" } })).toThrow("session");
    expect(() => route({ body: { ...request.body, previous_response_id: "resp-old" } })).toThrow("complete input");
    expect(() => route({ body: { ...request.body, system_prompt: "SDK-only instruction" } })).toThrow("system_prompt");
  });
});

test("records MP output and usage while forwarding SSE bytes unchanged, including CRLF", async () => {
  const item = { id: "msg-one", type: "message", content: [{ type: "output_text", text: "result" }] };
  const events = [
    { type: "response.created", response: { id: "resp-mp", status: "in_progress" } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id: "resp-mp", status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 4, input_tokens_details: { cached_tokens: 50 } } } }
  ];
  const bytes = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const observed: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const response = observeHybridResponse(new Response(bytes, { headers: { "content-type": "text/event-stream" } }),
    (event, fields) => { observed.push({ event, fields }); }, [{ source: "user", content: "hello" }]);
  expect(await response.text()).toBe(bytes);
  expect(observed.filter((entry) => entry.event === "trajectory_output_content_chunk")).toHaveLength(1);
  expect(observed.find((entry) => entry.event === "trajectory_execution_terminal")?.fields).toMatchObject({
    status: "finished", inputTokens: 100, outputTokens: 4, cachedInputTokens: 50
  });
});

test("malformed or oversized observations and trace writer failure do not alter upstream bytes", async () => {
  for (const text of ["data: invalid-json\n\n", `data: ${"x".repeat(1024 * 1024 + 1)}`]) {
    const response = observeHybridResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }),
      () => { throw new Error("logging unavailable"); }, []);
    expect(await response.text()).toBe(text);
  }
});

test("client cancellation reaches the fallback without a second upstream attempt", async () => {
  await fixture(async ({ route, calls }) => {
    const controller = new AbortController();
    const first = route({ signal: controller.signal });
    controller.abort();
    expect(await first.recover(new CursorSdkContextOverflowError("SDK compacted", true), false)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

test("fallback HTTP failure preserves its status and the sticky route without retrying", async () => {
  await fixture(async ({ config, request }) => {
    let calls = 0;
    const create = () => new GrokHybridRoute(config, request, () => { throw new Error("trace failure"); },
      (async () => { calls++; return Response.json({ error: { code: "rate_limit" } }, { status: 429 }); }));
    const first = await create().recover(new CursorSdkContextOverflowError("SDK compacted", true), false);
    expect(first?.status).toBe(429);
    expect(calls).toBe(1);
    expect(await first?.json()).toEqual({ error: { code: "rate_limit" } });
    const second = await create().initialResponse();
    expect(second?.status).toBe(429);
    expect(calls).toBe(2);
    await second?.text();
  });
});

test("formats a short notify payload around the last user snippet", () => {
  expect(lastUserSnippet([
    { role: "user", content: "[Tue 2026-09-08 22:21 GMT+8] Conversation info: ⟦openclaw:ctx⟧\n```json\n{\"sender\":{\"id\":\"8125678955\"}}\n```\n\n你好，我现在用了grok hybird，默认模型仍是cursor grok吗？" },
    { role: "user", content: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation info" }
  ])).toBe("你好，我现在用了grok hybird，默认模型仍是cursor grok吗？");
  expect(hybridFallbackNotifyArgs({
    sessionKey: "e098afb2-857e-44fd-aec2-7f444083f956:5",
    thisTurn: "recovered",
    userSnippet: "你好，我现在用了grok hybird，默认模型仍是cursor grok吗？",
    requestId: "resp_1313eeed0d87477cb14ccf57aaf55e1a"
  })).toEqual([
    "--title", "grok-hybrid → MP",
    "--text", "你好，我现在用了grok hybird，默认模型仍是cursor grok吗？",
    "--level", "warn",
    "--source", "cursor2response",
    "--field", "session=e098afb2-857e-44fd-aec2-7f444083f956:5",
    "--field", "traceId=resp_1313eeed0d87477cb14ccf57aaf55e1a"
  ]);
});

test("omits non-user content and bounds plain input previews", () => {
  expect(lastUserSnippet("hello world", 5)).toBe("hello...");
  expect(lastUserSnippet([
    { role: "developer", content: "private instructions" },
    { role: "assistant", content: "assistant text" },
    { role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] },
    { type: "function_call_output", output: "tool output" }
  ])).toBeUndefined();
});

test.each([false, true])("notifies with the last user prompt during tool continuation (published=%s)", async (published) => {
  await fixture(async ({ config, request }) => {
    request.body.input = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: [{ type: "input_text", text: "hello" },
        { type: "input_image", image_url: "https://example.test/image.png" }] },
      { role: "user", content: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nPrivate context" },
      { type: "function_call", call_id: "call-one", name: "work", arguments: "{}" },
      { type: "function_call_output", call_id: "call-one", output: "tool output" }
    ];
    request.inputs = [{ source: "tool_result", content: "tool output", callId: "call-one" }];
    const notifyLog = path.join(config.stateDirectory, "notify.log");
    const script = path.join(config.stateDirectory, "notify-send");
    await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}\n`, { mode: 0o755 });
    const create = () => new GrokHybridRoute({ ...config, notifyCommand: script }, request, () => {},
      (async () => Response.json({ id: "resp-mp", object: "response", status: "completed", output: [] })));
    await (await create().recover(new CursorSdkContextOverflowError("SDK compacted", true), published))?.text();
    await (await create().initialResponse())!.text();
    for (let i = 0; i < 50 && !(await readFile(notifyLog, "utf8").catch(() => "")).includes("session=session-one"); i++) {
      await delay(20);
    }
    const lines = (await readFile(notifyLog, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("session=session-one");
    expect(lines[0]).toContain("hello");
    expect(lines[0]).not.toContain("old request");
    expect(lines[0]).not.toContain("Private context");
    expect(lines[0]).not.toContain("tool output");
    expect(lines[0]).toContain("traceId=resp-one");
    expect(lines[0]).toContain("cursor2response");
    expect(lines[0]).not.toContain("thisTurn=");
    expect(hybridConfig({
      CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_BASE_URL: "https://fallback.example/v1",
      CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_API_KEY: "key",
      CURSOR2RESPONSE_GROK_HYBRID_FALLBACK_MODEL: "mp-grok",
      CURSOR2RESPONSE_GROK_HYBRID_NOTIFY: "0"
    })?.notifyCommand).toBeUndefined();
  });
});
