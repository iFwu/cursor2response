import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CursorSdkContextOverflowError } from "../core/cursor-sdk.ts";
import { HttpError } from "../core/http.ts";
import { API_FALLBACK_MODEL, ApiFallbackRoute, apiFallbackConfig, fallbackNotifyArgs, isApiFallbackModel, lastUserSnippet, type ApiFallbackConfig, type ApiFallbackRequest } from "./api-fallback.ts";
import { observeFallbackResponse } from "./fallback-trace.ts";

// Frozen pre-rename marker identity for the fixture below.
const LEGACY_ROUTE_FILENAME = "634528cc585e2dcc2029ea4fa35624a1476d6d570a3a5691d9d0a7bb1f421078.json";

async function fixture(run: (input: {
  config: ApiFallbackConfig; request: ApiFallbackRequest; calls: RequestInit[];
  events: Array<{ event: string; fields: Record<string, unknown> }>;
  route: (changes?: Partial<ApiFallbackRequest>) => ApiFallbackRoute;
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "api-fallback-test-"));
  const config: ApiFallbackConfig = { primaryModel: "cursor-primary", responsesUrl: "https://fallback.example/v1/responses",
    apiKey: "fallback-secret", model: "mp-grok", stateDirectory: directory };
  const request: ApiFallbackRequest = {
    apiKey: "cursor-secret", body: { model: "cursor-relay", input: "hello", stream: false },
    session: { key: "session-one", source: "header:session-id", sessionHeaders: ["session-id"] },
    workingDirectory: "/project", requestId: "resp-one", signal: new AbortController().signal,
    clientSource: "openclaw", clientPlatform: "linux", inputs: [{ source: "user", content: "hello" }]
  };
  const calls: RequestInit[] = [];
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const route = (changes: Partial<ApiFallbackRequest> = {}) => new ApiFallbackRoute(config, { ...request, ...changes },
    (event, fields) => { events.push({ event, fields }); },
    (async (_url, init) => {
      calls.push(init!);
      return Response.json({ id: "resp-mp", object: "response", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 3 } });
    }));
  try { await run({ config, request, calls, events, route }); } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("recognizes cursor-relay and the unlisted cursor-auto migration alias", () => {
  expect(isApiFallbackModel(API_FALLBACK_MODEL)).toBe(true);
  expect(isApiFallbackModel(" CURSOR-RELAY ")).toBe(true);
  expect(isApiFallbackModel(" CURSOR-AUTO ")).toBe(true);
  for (const model of ["grok-hybrid", "grok-hybrid-fast", "api-fallback", "cursor-relay-fast", "cursor-auto-fast", "grok-4.6"]) {
    expect(isApiFallbackModel(model)).toBe(false);
  }
  expect(isApiFallbackModel("api-fallback-other")).toBe(false);
});

test("requires an explicit complete fallback configuration and rejects recursive model configuration", () => {
  expect(apiFallbackConfig({})).toBeUndefined();
  expect(() => apiFallbackConfig({ C2R_FALLBACK_MODEL: "mp-grok" })).toThrow("incomplete");
  const env = { C2R_PRIMARY_MODEL: "cursor-primary", C2R_FALLBACK_BASE_URL: "https://fallback.example/v1/",
    C2R_FALLBACK_API_KEY: "key", C2R_FALLBACK_MODEL: "mp-grok" };
  expect(apiFallbackConfig(env)?.responsesUrl).toBe("https://fallback.example/v1/responses");
  expect(apiFallbackConfig(env)?.primaryModel).toBe("cursor-primary");
  expect(apiFallbackConfig(env)?.notifyCommand).toBeUndefined();
  expect(apiFallbackConfig({ ...env, C2R_FALLBACK_NOTIFY_COMMAND: "/example/notify" })?.notifyCommand).toBe("/example/notify");
  for (const name of Object.keys(env)) {
    expect(() => apiFallbackConfig({ ...env, [name]: " " })).toThrow(name);
  }
  for (const model of ["cursor-relay", "cursor-auto"]) {
    expect(() => apiFallbackConfig({ ...env, C2R_PRIMARY_MODEL: ` ${model.toUpperCase()} ` })).toThrow();
    expect(() => apiFallbackConfig({ ...env, C2R_PRIMARY_MODEL: `${model}[fast=true]` })).toThrow();
    expect(() => apiFallbackConfig({ ...env, C2R_FALLBACK_MODEL: ` ${model.toUpperCase()} ` })).toThrow();
  }
  expect(apiFallbackConfig({ ...env, C2R_FALLBACK_TIMEOUT_MS: "" })?.timeoutMs).toBe(180000);
  for (const timeout of ["0", "-1", "1.5", "invalid", "3600001"]) {
    expect(() => apiFallbackConfig({ ...env, C2R_FALLBACK_TIMEOUT_MS: timeout })).toThrow("timeout");
  }
  expect(() => apiFallbackConfig({ ...env, C2R_FALLBACK_BASE_URL: "file:///tmp" })).toThrow();
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
    expect(files).toEqual([LEGACY_ROUTE_FILENAME]);
    expect((await stat(path.join(config.stateDirectory, files[0]))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(config.stateDirectory, files[0]), "utf8")).not.toContain("secret");
    expect(await route({ apiKey: "other-key" }).initialResponse()).toBeUndefined();
    expect(await route({ workingDirectory: "/other" }).initialResponse()).toBeUndefined();
    expect(await route({ session: { ...request.session, key: "new-session" } }).initialResponse()).toBeUndefined();
  });
});

test("cursor-relay and cursor-auto reuse pre-rename fallback markers immediately", async () => {
  await fixture(async ({ route, calls, config, request, events }) => {
    await writeFile(path.join(config.stateDirectory, LEGACY_ROUTE_FILENAME), JSON.stringify({
      version: 1, route: "fallback", since: "2026-09-01T00:00:00.000Z",
      sessionKey: request.session.key, requestId: "resp-before-rename"
    }), { mode: 0o600 });
    for (const model of ["cursor-relay", "cursor-auto"]) {
      const response = await route({ body: { ...request.body, model } }).initialResponse();
      expect(response?.ok).toBe(true);
      expect(await response?.json()).toMatchObject({ id: "resp-mp", status: "completed" });
    }
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(call.body as string).model)).toEqual(["mp-grok", "mp-grok"]);
    expect(events.filter((event) => event.event === "trajectory_route_decision").map((event) => event.fields))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "fallback", routeStickyHit: true, logicalModel: "cursor-relay" })
      ]));
    expect(events.some((event) => event.fields.route === "cursor_sdk")).toBe(false);
    expect(await readdir(config.stateDirectory)).toEqual([LEGACY_ROUTE_FILENAME]);
  });
});

test("isolates sticky routes by configured primary and fallback target, but permits key rotation", async () => {
  await fixture(async ({ route, config, request }) => {
    await (await route().recover(new CursorSdkContextOverflowError("SDK compacted", true), false))!.text();
    for (const change of [{ primaryModel: "another-primary" }, { model: "another-fallback" },
      { responsesUrl: "https://other.example/v1/responses" }]) {
      const next = new ApiFallbackRoute({ ...config, ...change }, request, () => {});
      expect(await next.initialResponse()).toBeUndefined();
    }
    let key: string | null = null;
    const rotated = new ApiFallbackRoute({ ...config, apiKey: "rotated-key" }, request, () => {}, async (_url, init) => {
      key = new Headers(init?.headers).get("authorization");
      return Response.json({ status: "completed", output: [] });
    });
    await (await rotated.initialResponse())!.text();
    expect(key).toBe("Bearer rotated-key");
  });
});

test("a missing notification executable cannot fail recovery", async () => {
  await fixture(async ({ config, request }) => {
    const route = new ApiFallbackRoute({ ...config, notifyCommand: path.join(config.stateDirectory, "missing-command") },
      request, () => {}, async () => Response.json({ status: "completed", output: [] }));
    expect((await route.recover(new CursorSdkContextOverflowError("SDK compacted", true), false))?.ok).toBe(true);
    await delay(30);
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

test("keeps generated identities request-scoped without reading or writing sticky markers", async () => {
  await fixture(async ({ route, request, config, calls }) => {
    // A matching durable marker must not turn an anonymous request into a continuation.
    await writeFile(path.join(config.stateDirectory, LEGACY_ROUTE_FILENAME), "invalid state");
    const session = { ...request.session, source: "generated" as const, sessionHeaders: [] };
    const first = route({ session });
    expect(await first.initialResponse()).toBeUndefined();
    expect((await first.recover(new CursorSdkContextOverflowError("SDK compacted", true), false))?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await route({ session }).initialResponse()).toBeUndefined();
    expect(await readdir(config.stateDirectory)).toEqual([LEGACY_ROUTE_FILENAME]);
    expect(await readFile(path.join(config.stateDirectory, LEGACY_ROUTE_FILENAME), "utf8")).toBe("invalid state");
  });
});

test.each(["published", "unsafe", "cancelled"])("does not recover or persist an anonymous %s request", async (state) => {
  await fixture(async ({ route, request, config, calls }) => {
    const controller = new AbortController();
    const first = route({ session: { ...request.session, source: "generated", sessionHeaders: [] }, signal: controller.signal });
    if (state === "cancelled") controller.abort();
    expect(await first.recover(new CursorSdkContextOverflowError("SDK compacted", state !== "unsafe"), state === "published")).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await readdir(config.stateDirectory)).toEqual([]);
  });
});

test("rejects provider-owned continuation state", async () => {
  await fixture(async ({ route, request }) => {
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
  const response = observeFallbackResponse(new Response(bytes, { headers: { "content-type": "text/event-stream" } }),
    (event, fields) => { observed.push({ event, fields }); }, [{ source: "user", content: "hello" }]);
  expect(await response.text()).toBe(bytes);
  expect(observed.filter((entry) => entry.event === "trajectory_output_content_chunk")).toHaveLength(1);
  expect(observed.find((entry) => entry.event === "trajectory_execution_terminal")?.fields).toMatchObject({
    status: "finished", inputTokens: 100, outputTokens: 4, cachedInputTokens: 50
  });
});

test("malformed or oversized observations and trace writer failure do not alter upstream bytes", async () => {
  for (const text of ["data: invalid-json\n\n", `data: ${"x".repeat(1024 * 1024 + 1)}`]) {
    const response = observeFallbackResponse(new Response(text, { headers: { "content-type": "text/event-stream" } }),
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
    const create = () => new ApiFallbackRoute(config, request, () => { throw new Error("trace failure"); },
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
  expect(fallbackNotifyArgs({
    primaryModel: "cursor-primary", fallbackModel: "api-model",
    sessionKey: "e098afb2-857e-44fd-aec2-7f444083f956:5",
    thisTurn: "recovered",
    userSnippet: "你好，我现在用了grok hybird，默认模型仍是cursor grok吗？",
    requestId: "resp_1313eeed0d87477cb14ccf57aaf55e1a"
  })).toEqual([
    "--title", "cursor-primary → api-model",
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
    const create = () => new ApiFallbackRoute({ ...config, notifyCommand: script }, request, () => {},
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
    expect(apiFallbackConfig({
      C2R_PRIMARY_MODEL: "cursor-primary",
      C2R_FALLBACK_BASE_URL: "https://fallback.example/v1",
      C2R_FALLBACK_API_KEY: "key",
      C2R_FALLBACK_MODEL: "mp-grok"
    })?.notifyCommand).toBeUndefined();
  });
});
