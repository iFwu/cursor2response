import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { parseSse } from "../core/sse.ts";

const { values } = parseArgs({ options: {
  "key-file": { type: "string" }, "key-name": { type: "string", default: "CURSOR_API_KEY" },
  "base-url": { type: "string" }, model: { type: "string" },
  "require-commentary": { type: "boolean", default: false }
} });
assert(values["key-file"] && values["base-url"] && values.model, "Supply --key-file, --base-url and --model");
const key = parseEnv(await readFile(values["key-file"], "utf8"))[values["key-name"]!];
assert(key, "Missing configured API key");
const directory = await mkdtemp(path.join(tmpdir(), "responses-phase-validation-"));
const session = `responses-phase-validation-${crypto.randomUUID()}`;
const input: Array<Record<string, unknown>> = [{ role: "user", content:
  "Check the five deployment stages in order using inspect_stage. Call it once per response, then wait for its result. " +
  "Before each call, tell me briefly in Chinese what you will check. After stage 5, summarize the five returned receipts in Chinese without calling more tools." }];
const instructions = "You are validating a fictional deployment. Never execute real operations. " +
  "Use inspect_stage with stage 1 through 5 in sequence, one call per response. " +
  "Tool results contain the only authoritative receipts. Keep progress text and the final answer concise.\n" +
  Array.from({ length: 1200 }, (_, i) => `Reference ${i}: preserve the deployment history, tool identities and received receipts.`).join("\n");
const summaries: any[] = [];
console.log(JSON.stringify({ session, directory, model: values.model }));
for (let stage = 1; stage <= 6; stage++) {
  const body = { model: values.model, stream: true, store: false, instructions, input,
    tools: [{ type: "function", name: "inspect_stage", description: "Read one fictional deployment stage and its receipt.",
      parameters: { type: "object", properties: { stage: { type: "integer", minimum: 1, maximum: 5 } },
        required: ["stage"], additionalProperties: false } }],
    tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "low" }, max_output_tokens: 2048,
    prompt_cache_key: session };
  const response = await fetch(`${values["base-url"].replace(/\/+$/, "")}/responses`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json",
      "session-id": session, "x-openclaw-session-id": session, "user-agent": "OpenClaw/validation" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000), redirect: "error"
  });
  const raw = await response.text();
  await writeFile(path.join(directory, `${stage}.sse`), raw, { mode: 0o600 });
  assert(response.ok, `HTTP ${response.status}; response saved in ${directory}`);
  let completed: any;
  const messageEvents: any[] = [];
  for await (const event of parseSse(new Response(raw.replaceAll("\r\n", "\n")).body)) {
    if (event.data === "[DONE]") continue;
    const data = JSON.parse(event.data);
    assert(data.type !== "response.failed" && data.type !== "error", `Response failed; inspect ${directory}`);
    if (data.item?.type === "message") messageEvents.push({ event: data.type, id: data.item.id, phase: data.item.phase ?? null });
    if (data.type === "response.completed") completed = data.response;
  }
  assert(completed?.status === "completed", `Missing completed response; inspect ${directory}`);
  const calls = completed.output.filter((item: any) => item.type === "function_call");
  const messages = completed.output.filter((item: any) => item.type === "message");
  const text = messages.flatMap((item: any) => item.content ?? []).map((part: any) => part.text ?? "").join("\n");
  const summary = { stage, responseId: completed.id, model: completed.model, calls: calls.length,
    messageEvents, phases: messages.map((item: any) => item.phase ?? null), text, usage: completed.usage };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
  if (stage <= 5) {
    assert.equal(calls.length, 1, "Expected one serial tool call");
    assert.equal(calls[0].name, "inspect_stage");
    assert.equal(JSON.parse(calls[0].arguments).stage, stage);
    input.push(...completed.output, { type: "function_call_output", call_id: calls[0].call_id,
      output: JSON.stringify({ stage, receipt: `RECEIPT_${stage}_NATIVE`, status: "ready", nextStage: stage < 5 ? stage + 1 : null }) });
  } else {
    assert.equal(calls.length, 0, "Final response must not call tools");
    for (let n = 1; n <= 5; n++) assert(text.includes(`RECEIPT_${n}_NATIVE`), `Missing receipt ${n}`);
  }
}
const toolTextTurns = summaries.slice(0, 5).filter((entry) => entry.text.trim());
const commentaryTurns = toolTextTurns.filter((entry) => entry.phases.includes("commentary")).length;
const warmCacheHits = summaries.slice(1).filter((entry) => entry.usage?.input_tokens_details?.cached_tokens > 0).length;
await writeFile(path.join(directory, "summary.json"), JSON.stringify({ session, summaries, commentaryTurns, warmCacheHits }, null, 2), { mode: 0o600 });
if (values["require-commentary"]) {
  assert(toolTextTurns.length > 0, "No pre-tool text emitted; commentary coverage is inconclusive");
  for (const entry of toolTextTurns) {
    assert(entry.phases.every((phase: unknown) => phase === "commentary"), "Missing completed commentary classification");
    const done = entry.messageEvents.filter((event: any) => event.event === "response.output_item.done");
    assert(done.length > 0 && done.every((event: any) => event.phase === "commentary"), "Missing streaming commentary classification");
  }
  assert(!summaries[5].phases.includes("commentary"), "Final answer must not be classified as commentary");
}
console.log(JSON.stringify({ session, directory, toolTurns: 5, toolTextTurns: toolTextTurns.length, commentaryTurns, warmCacheHits, success: true }));
