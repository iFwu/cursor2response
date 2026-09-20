import { expect, test } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  createFailureTraceCapture,
  initializeFailureTraceStore,
  type FailureTraceStoreOptions
} from "./failure-trace.ts";

function traceInput(label: string, body: unknown = { model: "grok-4.6", input: label }) {
  return {
    requestBody: body,
    responseId: `resp_${label}`,
    model: "grok-4.6",
    stream: true,
    clientSource: "codex",
    session: {
      key: `session-${label}`,
      source: "header:session-id",
      sessionHeaders: ["session-id"]
    },
    prompt: `prepared ${label}`,
    incrementalPrompt: `incremental ${label}`,
    toolNames: ["read"],
    resumeToolResultsCount: 0,
    supersedePendingRun: false,
    supersedingTurnAborted: false,
    supersededToolCallIds: []
  };
}

async function temporaryOptions(overrides: Partial<FailureTraceStoreOptions> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "cursor2response-failure-trace-"));
  return {
    directory,
    maxBytes: 1024 * 1024,
    maxFiles: 20,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides
  } satisfies FailureTraceStoreOptions;
}

test("writes complete gzip failure traces with private permissions", async () => {
  const options = await temporaryOptions();
  try {
    await initializeFailureTraceStore(options);
    const capture = createFailureTraceCapture(traceInput("timeout", {
      model: "grok-4.6",
      input: "timeout",
      apiKey: "root-secret",
      api_key: "root-secret",
      Authorization: "root-secret",
      nested: { apiKey: "model-visible-value" }
    }), options);
    capture.recordSse(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
    capture.recordSse(new TextEncoder().encode("event: response.failed\ndata: {}\n\n"));

    const filePath = await capture.capture({
      status: 504,
      code: "cursor_sdk_bridge_timeout",
      message: "Cursor SDK bridge request timed out."
    });

    expect(filePath).toMatch(/\.json\.gz$/);
    expect((await stat(options.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath!)).mode & 0o777).toBe(0o600);
    const artifact = JSON.parse(gunzipSync(await readFile(filePath!)).toString("utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: "cursor2response_failure_trace",
      request: {
        route: "/v1/responses",
        body: {
          model: "grok-4.6",
          input: "timeout",
          nested: { apiKey: "model-visible-value" }
        },
        responseId: "resp_timeout",
        clientSource: "codex",
        model: "grok-4.6",
        stream: true,
        session: {
          source: "header:session-id",
          sessionHeaders: ["session-id"]
        }
      },
      derived: {
        promptChars: "prepared timeout".length,
        incrementalPromptChars: "incremental timeout".length,
        toolCount: 1,
        toolNames: ["read"],
        lineage: "body",
        statelessReplayEligible: false
      },
      failure: {
        status: 504,
        code: "cursor_sdk_bridge_timeout"
      }
    });
    expect(artifact.events.map((event: { sse: string }) => event.sse).join(""))
      .toContain("event: response.failed");
  } finally {
    await rm(options.directory, { recursive: true, force: true });
  }
});

test("marks only first-turn request shapes as stateless replay eligible", async () => {
  const options = await temporaryOptions();
  try {
    const firstTurn = { ...traceInput("first"), incrementalPrompt: undefined };
    const firstPath = await createFailureTraceCapture(firstTurn, options).capture({
      status: 409,
      code: "cursor_sdk_request_conflict",
      message: "first"
    });
    const firstArtifact = JSON.parse(gunzipSync(await readFile(firstPath!)).toString("utf8"));
    expect(firstArtifact.derived).toMatchObject({
      lineage: "body",
      statelessReplayEligible: true
    });

    const unresolvedLineage = {
      ...firstTurn,
      requestBody: {
        model: "grok-4.6",
        input: "follow-up",
        previous_response_id: "resp_previous"
      }
    };
    const lineagePath = await createFailureTraceCapture(unresolvedLineage, options).capture({
      status: 409,
      code: "cursor_sdk_request_conflict",
      message: "lineage"
    });
    const lineageArtifact = JSON.parse(gunzipSync(await readFile(lineagePath!)).toString("utf8"));
    expect(lineageArtifact.derived).toMatchObject({
      lineage: "body-only-unresolved",
      statelessReplayEligible: false
    });
  } finally {
    await rm(options.directory, { recursive: true, force: true });
  }
});

test("captures only terminal protocol conflicts and automatic SDK deadlines", async () => {
  const options = await temporaryOptions();
  try {
    const ignored = [
      { status: 401, code: "unauthorized", message: "invalid key" },
      { status: 500, code: "cursor_model_error", message: "model failed" },
      new DOMException("Client disconnected", "AbortError"),
      { status: 499, code: "cursor_sdk_cancelled", message: "cancelled" }
    ];
    for (const [index, error] of ignored.entries()) {
      expect(await createFailureTraceCapture(traceInput(`ignored-${index}`), options).capture(error)).toBeNull();
    }
    expect(await readdir(options.directory).catch(() => [])).toEqual([]);

    expect(await createFailureTraceCapture(traceInput("conflict"), options).capture({
      status: 409,
      code: "cursor_sdk_tool_result_unmatched",
      message: "No pending tool call"
    })).toMatch(/\.json\.gz$/);
    expect(await createFailureTraceCapture(traceInput("idle"), options).capture({
      status: 504,
      code: "cursor_sdk_idle_timeout",
      message: "Idle"
    })).toMatch(/\.json\.gz$/);
  } finally {
    await rm(options.directory, { recursive: true, force: true });
  }
});

test("prunes oldest traces and retains a metadata marker below the minimum byte ceiling", async () => {
  const options = await temporaryOptions({ maxFiles: 2, maxBytes: 1 });
  try {
    for (const label of ["one", "two", "three"]) {
      await createFailureTraceCapture(traceInput(label), options).capture({
        status: 409,
        code: "cursor_sdk_request_conflict",
        message: label
      });
    }
    expect((await readdir(options.directory)).filter((name) => name.endsWith(".json.gz"))).toHaveLength(2);

    const markerPath = await createFailureTraceCapture(
      traceInput("oversized", { model: "grok-4.6", input: "x".repeat(100_000) }),
      options
    ).capture({ status: 409, code: "cursor_sdk_request_conflict", message: "too large" });
    expect(markerPath).toMatch(/\.rejected\.json$/);
    expect(JSON.parse(await readFile(markerPath!, "utf8"))).toMatchObject({
      schemaVersion: 1,
      kind: "cursor2response_failure_trace_rejection",
      reason: "capture_rejected_size_limit",
      maxBytes: 16 * 1024
    });
    expect((await stat(markerPath!)).isFile()).toBe(true);
    const files = await readdir(options.directory);
    expect(files).toHaveLength(2);
    const sizes = await Promise.all(files.map(async (name) => (await stat(path.join(options.directory, name))).size));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(16 * 1024);
  } finally {
    await rm(options.directory, { recursive: true, force: true });
  }
});
