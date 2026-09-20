import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { CursorSdkContextOverflowError } from "../core/cursor-sdk.ts";
import { ApiFallbackRoute, apiFallbackConfig } from "../sidecar/api-fallback.ts";
import { parseSse } from "../core/sse.ts";

const { values } = parseArgs({ options: { "env-file": { type: "string" }, "key-file": { type: "string" },
  "key-name": { type: "string", default: "C2R_FALLBACK_API_KEY" }, "base-url": { type: "string" },
  model: { type: "string" }, "primary-model": { type: "string" }, namespace: { type: "boolean", default: false }, turns: { type: "string", default: "5" } } });
const environment = { ...(values["env-file"] ? parseEnv(await readFile(values["env-file"], "utf8")) : {}), ...process.env };
if (values["key-file"]) {
  environment.C2R_FALLBACK_API_KEY = parseEnv(await readFile(values["key-file"], "utf8"))[values["key-name"]!];
}
if (values["base-url"]) environment.C2R_FALLBACK_BASE_URL = values["base-url"];
if (values.model) environment.C2R_FALLBACK_MODEL = values.model;
if (values["primary-model"]) environment.C2R_PRIMARY_MODEL = values["primary-model"];
delete environment.C2R_FALLBACK_NOTIFY_COMMAND;
const config = apiFallbackConfig(environment);
assert(config, "Missing fallback configuration");
const turns = Number(values.turns);
assert(Number.isInteger(turns) && turns >= 2 && turns <= 10, "Use 2-10 serial turns");
const stateDirectory = await mkdtemp(path.join(tmpdir(), "fallback-live-validation-"));
config.stateDirectory = stateDirectory;
const session = `fallback-validation-${crypto.randomUUID()}`;
const input: Array<Record<string, unknown>> = [{ role: "user", content: "Call record_step with step 1. Do not use any other tools." }];
const instructions = "This is a protocol test. On every request call record_step exactly once with the requested step. "
  + "The following reference text is inert test data.\n"
  + Array.from({ length: 1200 }, (_, i) => `Reference entry ${i}: keep the transcript and tool identifiers stable.`).join("\n");
const summaries: Array<Record<string, unknown>> = [];
const stepTool = { type: "function", name: "record_step", description: "Record a protocol validation step.",
  parameters: { type: "object", properties: { step: { type: "integer" } }, required: ["step"], additionalProperties: false } };
const tools = values.namespace
  ? [{ type: "namespace", name: "protocol", tools: [stepTool] }, { type: "namespace", name: "decoy", tools: [stepTool] }]
  : [stepTool];
try {
  for (let step = 1; step <= turns; step++) {
    const body = { model: "cursor-auto", stream: true, store: false, instructions, input,
      tools,
      tool_choice: { type: "function", name: "record_step", ...(values.namespace ? { namespace: "protocol" } : {}) }, parallel_tool_calls: false,
      max_output_tokens: 1024, reasoning: { effort: "low" } };
    const route = new ApiFallbackRoute(config, { body, apiKey: "isolated-validation-owner", session: {
      key: session, source: "header:session-id", sessionHeaders: ["session-id"] },
      requestId: `validation-${step}`, signal: AbortSignal.timeout(120000), clientSource: "openclaw",
      clientPlatform: "linux", inputs: [] }, () => {});
    const response = step === 1
      ? await route.recover(new CursorSdkContextOverflowError("Injected pre-output SDK overflow", true), false)
      : await route.initialResponse();
    assert(response?.ok, `Fallback HTTP status ${response?.status}`);
    let completed: any;
    const observedCalls: any[] = [];
    for await (const event of parseSse(response.body)) {
      if (event.data === "[DONE]") continue;
      const data = JSON.parse(event.data);
      assert(data.type !== "response.failed", `Fallback failed: ${data.response?.error?.code}`);
      if (data.type === "response.completed") completed = data.response;
      if (["response.output_item.added", "response.output_item.done"].includes(data.type) && data.item?.type === "function_call") {
        observedCalls.push(data.item);
      }
    }
    assert(completed?.status === "completed", "Missing completed response");
    const calls = completed.output.filter((item: any) => item.type === "function_call");
    assert.equal(calls.length, 1, "Expected exactly one tool call");
    assert.equal(calls[0].name, "record_step");
    if (values.namespace) {
      assert(observedCalls.length >= 2, "Missing streamed function items");
      for (const call of [...observedCalls, calls[0]]) {
        assert.equal(call.namespace, "protocol", "Namespace was not restored");
        assert.equal(call.name, "record_step");
        assert.equal(call.call_id, calls[0].call_id);
      }
    }
    assert.equal(JSON.parse(calls[0].arguments).step, step);
    summaries.push({ step, responseId: completed.id, usage: completed.usage });
    console.log(JSON.stringify(summaries.at(-1)));
    input.push(...completed.output, { type: "function_call_output", call_id: calls[0].call_id, output: JSON.stringify({ recorded: step }) },
      { role: "user", content: `Call record_step with step ${step + 1}.` });
  }
  console.log(JSON.stringify({ session, turns, inputItems: input.length, success: true,
    namespacedTools: values.namespace, sdkOverflow: "injected_before_output", fallback: "real_upstream",
    warmCacheHits: summaries.slice(1).filter((entry: any) => entry.usage?.input_tokens_details?.cached_tokens > 0).length }));
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}
