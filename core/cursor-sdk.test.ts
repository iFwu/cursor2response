import { describe, expect, it } from "vitest";
import {
  collectCursorSdkOutput,
  createCursorSdkCompletion,
  isEmptyCursorSdkTurn,
  isTransientCursorSdkError
} from "./cursor-sdk.ts";
import { sha256Hex } from "./crypto.ts";
import { prepareResponsesRequest } from "./openai.ts";
import type { CursorTextEvent } from "./cursor.ts";

describe("Cursor SDK harness", () => {
  it("rejects missing HTTP Bridge configuration before contacting Cursor", async () => {
    let requests = 0;
    for (const url of [undefined, "", "  "]) {
      await expect(createCursorSdkCompletion(
        { CURSOR_SDK_BRIDGE_URL: url },
        {
          now: () => new Date(),
          randomUUID: () => crypto.randomUUID(),
          fetch: async () => { requests += 1; return Response.json({}); }
        },
        "cursor-test-key",
        { prompt: { text: "Hello" } }
      )).rejects.toMatchObject({ status: 500, code: "cursor_sdk_bridge_missing", message: expect.stringContaining("CURSOR_SDK_BRIDGE_URL") });
    }
    expect(requests).toBe(0);
  });

  it("preserves completed Bridge streaming edits as client writes", async () => {
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" },
      {
        now: () => new Date(),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => Response.json({
          toolCalls: [{ callId: "call_edit", name: "edit", arguments: { path: "empty.txt", streamContent: "" } }],
          status: "waiting_for_tools"
        })
      },
      "cursor-test-key",
      { prompt: { text: "Empty the file" }, sessionKey: "bridge-edit" }
    );
    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({
      toolCalls: [{ callId: "call_edit", name: "write", arguments: { path: "empty.txt", fileText: "" } }]
    });
  });

  it("hashes and forwards Responses Agent context metadata", async () => {
    let requestBody: Record<string, any> | undefined;
    const prepared = prepareResponsesRequest({
      model: "grok-4.6",
      instructions: "Stable instructions",
      input: [
        { type: "message", role: "user", content: "one" },
        { type: "message", role: "assistant", content: "answer" },
        { type: "message", role: "user", content: "two" }
      ]
    }, { id: "grok-4.6" });
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-22T11:30:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({ text: "done", toolCalls: [], status: "completed" });
        }
      },
      "cursor-test-key",
      {
        prompt: prepared.prompt,
        model: prepared.cursorModel,
        sessionKey: "agent-context-wire",
        clientSource: "openclaw",
        clientPlatform: "linux",
        agentContext: prepared.agentContext,
        resumeToolResults: [{ callId: "call_read", output: "contents" }]
      }
    );

    await collectCursorSdkOutput(completion.stream);
    expect(requestBody).toMatchObject({
      prompt: prepared.prompt.text,
      promptAlreadyPrepared: true,
      clientSource: "openclaw",
      clientPlatform: "linux",
      resumeToolResults: [{ callId: "call_read", output: "contents" }]
    });
    expect(completion.sessionKey).toMatch(/^[a-f0-9]{64}$/);
    expect(requestBody?.agentContext).toEqual({
      bootstrapFingerprint: await sha256Hex(prepared.agentContext!.bootstrap),
      transcriptItemHashes: await Promise.all(prepared.agentContext!.transcriptItems.map((item) => (
        sha256Hex(JSON.stringify(item.value, Object.keys(item.value as object).sort()))
      ))),
      transcriptItemOffsets: prepared.agentContext!.transcriptItems.map((item) => item.offset),
      transcriptItemImageCounts: [0, 0, 0],
      transcriptEndOffset: prepared.agentContext!.transcriptEndOffset,
      promptTextChars: prepared.prompt.text.length
    });
  });

  it("classifies abrupt bridge socket closures as transient", () => {
    expect(isTransientCursorSdkError(new TypeError(
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
    ))).toBe(true);
    expect(isTransientCursorSdkError({ cause: { code: "UND_ERR_SOCKET" } })).toBe(true);
    expect(isTransientCursorSdkError(new Error("Invalid Cursor API key"))).toBe(false);
    expect(isTransientCursorSdkError({
      status: 502,
      code: "cursor_sdk_error",
      message: "[unknown] Invalid User API Key"
    })).toBe(false);
  });

  it("does not retry request cancellation or either SDK deadline", () => {
    expect(isTransientCursorSdkError({ name: "AbortError" })).toBe(false);
    expect(isTransientCursorSdkError({ status: 499, code: "cursor_sdk_cancelled" })).toBe(false);
    expect(isTransientCursorSdkError({ status: 504, code: "cursor_sdk_idle_timeout" })).toBe(false);
    expect(isTransientCursorSdkError({ status: 504, code: "cursor_sdk_timeout" })).toBe(false);
    expect(isTransientCursorSdkError({ status: 504, code: "cursor_sdk_bridge_timeout" })).toBe(false);
    expect(isTransientCursorSdkError("cursor_sdk_bridge_timeout")).toBe(false);
    expect(isTransientCursorSdkError({ status: 504, code: "other_gateway_timeout" })).toBe(true);
  });

  it("preserves process narration alongside a forwarded tool call", async () => {
    const narration = "I will inspect the file.";
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-19T03:46:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => new Response(JSON.stringify({
          text: narration,
          toolCalls: [{ callId: "call_sdk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_read", name: "read", arguments: { path: "README.md" } }],
          status: "tool_call"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect README" },
        model: { id: "grok-4.6" },
        sessionKey: "collapsed-narration"
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({
      text: narration,
      toolCalls: [{ callId: "call_sdk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_read", name: "read", arguments: { path: "README.md" } }]
    });
  });

  it("forwards text-only bridge events before the bridge run completes", async () => {
    let releaseSecondChunk!: () => void;
    const secondChunk = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    let requestBody: Record<string, unknown> | undefined;
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"text","text":"Hello "}\n'));
          void secondChunk.then(() => {
            controller.enqueue(encoder.encode('{"type":"text","text":"from stream"}\n'));
            controller.enqueue(encoder.encode('{"type":"done","output":{"text":"Hello from stream","toolCalls":[],"status":"completed"}}\n'));
            controller.close();
          });
        }
      }),
      { headers: { "Content-Type": "application/x-ndjson" } }
    );
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-19T03:46:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return response;
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Say hello" },
        model: { id: "grok-4.6" },
        sessionKey: "streaming-text",
        streamEvents: true
      }
    );

    const iterator = completion.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: { type: "text", text: "Hello " }, done: false });
    expect(requestBody?.streamEvents).toBe(true);

    releaseSecondChunk();
    await expect(iterator.next()).resolves.toEqual({ value: { type: "text", text: "from stream" }, done: false });
    await expect(iterator.next()).resolves.toEqual({
      value: { type: "done", finalText: "Hello from stream", toolCalls: [], usage: undefined },
      done: false
    });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("forwards opted-in reasoning segments and requests Bridge reasoning events", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-22T06:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return new Response([
            JSON.stringify({ type: "reasoning", text: "Inspecting ", done: false }),
            JSON.stringify({ type: "reasoning", text: "the code", done: false }),
            JSON.stringify({ type: "reasoning", text: "", done: true, thinkingDurationMs: 120 }),
            JSON.stringify({ type: "text", text: "Done" }),
            JSON.stringify({ type: "done", output: { text: "Done", toolCalls: [], status: "finished" } }),
            ""
          ].join("\n"), { headers: { "Content-Type": "application/x-ndjson" } });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect the code" },
        model: { id: "grok-4.6" },
        sessionKey: "reasoning-opt-in",
        streamEvents: true,
        reasoningEvents: true
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toEqual({
      text: "Done",
      toolCalls: [],
      usage: undefined,
      reasoning: ["Inspecting the code"]
    });
    expect(requestBody).toMatchObject({ streamEvents: true, emitReasoning: true });
  });

  it("preserves the terminal fallback when reasoning is streamed without text", async () => {
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-22T06:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => new Response([
          JSON.stringify({ type: "reasoning", text: "Inspecting the code", done: false }),
          JSON.stringify({ type: "done", output: { text: "Fallback answer", toolCalls: [], status: "finished" } }),
          ""
        ].join("\n"), { headers: { "Content-Type": "application/x-ndjson" } })
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect the code" },
        model: { id: "grok-4.6" },
        sessionKey: "reasoning-only-fallback",
        streamEvents: true,
        reasoningEvents: true
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toEqual({
      text: "Fallback answer",
      toolCalls: [],
      usage: undefined,
      reasoning: ["Inspecting the code"]
    });
  });

  it.each([
    ["unknown event", [
      { type: "mystery" },
      { type: "done", output: { text: "", toolCalls: [] } }
    ], "cursor_sdk_bridge_unknown_event"],
    ["missing done", [
      { type: "text", text: "partial" }
    ], "cursor_sdk_bridge_missing_done"],
    ["duplicate done", [
      { type: "done", output: { text: "done", toolCalls: [] } },
      { type: "done", output: { text: "done", toolCalls: [] } }
    ], "cursor_sdk_bridge_duplicate_done"]
  ])("fails closed on %s", async (_name, events, code) => {
    let fetchCalls = 0;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-22T06:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => {
          fetchCalls += 1;
          return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
            headers: { "Content-Type": "application/x-ndjson" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect the stream" },
        model: { id: "grok-4.6" },
        sessionKey: `invalid-stream-${code}`,
        streamEvents: true
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).rejects.toMatchObject({ code });
    expect(fetchCalls).toBe(1);
  });

  it.each([false, true])("maps compact failures to the public context error for stream=%s", async (streamEvents) => {
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-22T06:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => streamEvents
          ? new Response(`${JSON.stringify({
              type: "error",
              error: {
                message: "Cursor SDK compacted the conversation",
                status: 413,
                code: "cursor_sdk_context_compacted"
              }
            })}\n`, { headers: { "Content-Type": "application/x-ndjson" } })
          : new Response(JSON.stringify({
              error: {
                message: "Cursor SDK compacted the conversation",
                status: 413,
                code: "cursor_sdk_context_compacted"
              }
            }), { status: 413, headers: { "Content-Type": "application/json" } })
      },
      "cursor-test-key",
      {
        prompt: { text: "A very long transcript" },
        model: { id: "grok-4.6" },
        sessionKey: `compact-${streamEvents}`,
        streamEvents
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).rejects.toMatchObject({
      status: 413,
      code: "context_length_exceeded"
    });
  });

  it("aborts the active bridge request when the caller cancels the turn", async () => {
    const callerAbort = new AbortController();
    const reason = new Error("caller cancelled the turn");
    let bridgeFetchCalls = 0;
    const cancellationBodies: Array<Record<string, unknown>> = [];
    const completion = await createCursorSdkCompletion(
      {
        CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk",
        CURSOR_SDK_BRIDGE_TIMEOUT_MS: "50"
      } as any,
      {
        now: () => new Date("2026-08-20T10:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (request, init) => {
          if (String(request).endsWith("/sdk/cancel")) {
            cancellationBodies.push(JSON.parse(String(init?.body)));
            return Response.json({ ok: true, cancelled: true });
          }
          bridgeFetchCalls += 1;
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Keep working" },
        model: { id: "grok-4.6" },
        sessionKey: "caller-abort",
        streamEvents: true,
        signal: callerAbort.signal
      }
    );

    const output = collectCursorSdkOutput(completion.stream);
    callerAbort.abort(reason);

    await expect(output).rejects.toBe(reason);
    expect(bridgeFetchCalls).toBe(1);
    expect(cancellationBodies).toEqual([expect.objectContaining({
      requestId: expect.any(String), apiKey: "cursor-test-key", model: "grok-4.6",
      sessionKey: expect.any(String), pendingToolCallIds: []
    })]);
  });

  it("cancels an unadmitted tool continuation even when its signal is already aborted", async () => {
    const reason = new Error("caller stopped after executing the tool");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date(), randomUUID: () => crypto.randomUUID(),
        fetch: async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return Response.json({ ok: true, cancelled: true });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "tool was executed" }, model: { id: "grok-4.6" },
        sessionKey: "pre-aborted-continuation", resumeToolResults: [{ callId: "call-owned", output: "sensitive result" }],
        streamEvents: true, signal: AbortSignal.abort(reason)
      }
    );
    await expect(collectCursorSdkOutput(completion.stream)).rejects.toBe(reason);
    expect(requests).toEqual([{
      url: "http://bridge.test/sdk/cancel",
      body: expect.objectContaining({ apiKey: "cursor-test-key", pendingToolCallIds: ["call-owned"] })
    }]);
    expect(JSON.stringify(requests)).not.toContain("sensitive result");
  });

  it("forwards every tool call returned in one bridge batch", async () => {
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-19T03:46:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => Response.json({
          text: "I will inspect both files.",
          toolCalls: [
            { callId: `call_sdk_${"1".repeat(32)}_read`, name: "read", arguments: { path: "README.md" } },
            { callId: `call_sdk_${"2".repeat(32)}_read`, name: "read", arguments: { path: "package.json" } },
            { callId: `call_sdk_${"8".repeat(32)}_status`, name: "status", arguments: {} }
          ],
          status: "tool_call"
        })
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect both files" },
        model: { id: "grok-4.6" },
        sessionKey: "parallel-forwarding"
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({
      text: "I will inspect both files.",
      toolCalls: [
        { callId: `call_sdk_${"1".repeat(32)}_read`, name: "read", arguments: { path: "README.md" } },
        { callId: `call_sdk_${"2".repeat(32)}_read`, name: "read", arguments: { path: "package.json" } },
        { callId: `call_sdk_${"8".repeat(32)}_status`, name: "status", arguments: {} }
      ]
    });
  });

  it("rejects an invalid bridge batch atomically before any tool reaches the caller", async () => {
    let fetchCalls = 0;
    const requests: Array<Record<string, any>> = [];
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-19T03:46:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          fetchCalls += 1;
          requests.push(JSON.parse(String(init?.body)));
          if (fetchCalls === 1) {
            return Response.json({
              text: "I will update both files.",
              toolCalls: [
                { callId: `call_sdk_${"3".repeat(32)}_read`, name: "read", arguments: { path: "README.md" } },
                { callId: `call_sdk_${"4".repeat(32)}_write`, name: "write", arguments: {} }
              ],
              status: "tool_call"
            });
          }
          return Response.json({
            text: "I will inspect the file instead.",
            toolCalls: [
              { callId: `call_sdk_${"5".repeat(32)}_read`, name: "read", arguments: { path: "README.md" } }
            ],
            status: "tool_call"
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect and update files" },
        model: { id: "grok-4.6" },
        sessionKey: "parallel-schema-rejection",
        allowToolCall: (toolCall) => toolCall.name === "write" ? "write requires a path" : true
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({
      toolCalls: [{ callId: `call_sdk_${"5".repeat(32)}_read`, name: "read" }]
    });
    expect(fetchCalls).toBe(2);
    expect(requests[1].resumeToolResults).toEqual([
      expect.objectContaining({
        callId: `call_sdk_${"3".repeat(32)}_read`,
        isError: true,
        output: expect.stringContaining("Another tool call in the same batch was rejected")
      }),
      expect.objectContaining({
        callId: `call_sdk_${"4".repeat(32)}_write`,
        isError: true,
        output: expect.stringContaining("write requires a path")
      })
    ]);
  });

  it("returns rejected streaming tool batches to the same run for correction", async () => {
    let fetchCalls = 0;
    const requests: Array<Record<string, any>> = [];
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-20T07:34:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          fetchCalls += 1;
          requests.push(JSON.parse(String(init?.body)));
          const text = fetchCalls === 1 ? "Inspecting inputs." : "Corrected call.";
          const output = fetchCalls === 1
            ? {
                text,
                toolCalls: [
                  { callId: `call_sdk_${"6".repeat(32)}_exec`, name: "exec", arguments: { command: "pwd" } },
                  { callId: `call_sdk_${"7".repeat(32)}_read`, name: "read", arguments: { limit: 100, offset: 80 } }
                ],
                status: "tool_call"
              }
            : {
                text,
                toolCalls: [
                  { callId: `call_sdk_${"8".repeat(32)}_read`, name: "read", arguments: { path: "backlog/statehub.md" } }
                ],
                status: "tool_call"
              };
          return new Response([
            JSON.stringify({ type: "text", text }),
            JSON.stringify({ type: "done", output }),
            ""
          ].join("\n"), {
            headers: { "Content-Type": "application/x-ndjson" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Inspect statehub configuration" },
        model: { id: "grok-4.6" },
        sessionKey: "streaming-schema-rejection",
        streamEvents: true,
        allowToolCall: (toolCall) => toolCall.name === "read" && !("path" in toolCall.arguments)
          ? "read requires a path"
          : true
      }
    );

    const events: CursorTextEvent[] = [];
    for await (const event of completion.stream) events.push(event);

    expect(events).toEqual([
      { type: "text", text: "Inspecting inputs." },
      { type: "text", text: "Corrected call." },
      {
        type: "tool_call",
        toolCall: {
          callId: `call_sdk_${"8".repeat(32)}_read`,
          name: "read",
          arguments: { path: "backlog/statehub.md" }
        }
      },
      {
        type: "done",
        finalText: "Inspecting inputs.Corrected call.",
        toolCalls: [{
          callId: `call_sdk_${"8".repeat(32)}_read`,
          name: "read",
          arguments: { path: "backlog/statehub.md" }
        }],
        usage: undefined
      }
    ]);
    expect(fetchCalls).toBe(2);
    expect(requests[1].sessionKey).toBe(requests[0].sessionKey);
    expect(requests[1].internalToolCorrection).toBe(true);
    expect(requests[1].resumeToolResults).toEqual([
      expect.objectContaining({
        callId: `call_sdk_${"6".repeat(32)}_exec`,
        isError: true,
        output: expect.stringContaining("Another tool call in the same batch was rejected")
      }),
      expect.objectContaining({
        callId: `call_sdk_${"7".repeat(32)}_read`,
        isError: true,
        output: expect.stringContaining("read requires a path")
      })
    ]);
  });

  it("retries a streaming transport failure only before client output", async () => {
    let fetchCalls = 0;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-20T07:34:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => {
          fetchCalls += 1;
          if (fetchCalls === 1) throw new TypeError("The socket connection was closed unexpectedly.");
          return new Response([
            JSON.stringify({ type: "text", text: "Recovered" }),
            JSON.stringify({
              type: "done",
              output: { text: "Recovered", toolCalls: [], status: "completed" }
            }),
            ""
          ].join("\n"), {
            headers: { "Content-Type": "application/x-ndjson" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Say recovered" },
        model: { id: "grok-4.6" },
        sessionKey: "streaming-transport-recovery",
        streamEvents: true
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "Recovered" });
    expect(fetchCalls).toBe(2);
  });

  it("does not replay a streaming run after client output", async () => {
    let fetchCalls = 0;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-20T07:34:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => {
          fetchCalls += 1;
          return new Response([
            JSON.stringify({ type: "text", text: "Visible" }),
            JSON.stringify({
              type: "error",
              error: { message: "The socket connection was closed unexpectedly.", code: "UND_ERR_SOCKET" }
            }),
            ""
          ].join("\n"), {
            headers: { "Content-Type": "application/x-ndjson" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Stream then fail" },
        model: { id: "grok-4.6" },
        sessionKey: "streaming-committed-output",
        streamEvents: true
      }
    );

    const iterator = completion.stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: { type: "text", text: "Visible" }, done: false });
    await expect(iterator.next()).rejects.toThrow("socket connection was closed unexpectedly");
    expect(fetchCalls).toBe(1);
  });

  it("returns schema errors to the same pending run until the model corrects the tool call", async () => {
    let fetchCalls = 0;
    let validationCalls = 0;
    const requests: Array<Record<string, any>> = [];
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-19T04:19:28Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          fetchCalls += 1;
          requests.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({
            text: "I will record this in memory.",
            toolCalls: [{
              callId: "call_sdk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_edit",
              name: "edit",
              arguments: {
                path: "memory/2026-08-19.md",
                edits: [{ oldText: "before", newText: "after" }]
              }
            }],
            status: "tool_call"
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Record this incident." },
        model: { id: "grok-4.6" },
        sessionKey: "rejected-tool-must-fail",
        allowToolCall: () => {
          validationCalls += 1;
          return validationCalls <= 2 ? "test schema rejection" : true;
        }
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({
      text: "I will record this in memory.",
      toolCalls: [{ name: "edit" }]
    });
    expect(fetchCalls).toBe(3);
    expect(validationCalls).toBe(3);
    expect(requests[0].resumeToolResults).toBeUndefined();
    expect(requests[1].resumeToolResults).toEqual([expect.objectContaining({
      callId: "call_sdk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_edit",
      isError: true,
      output: expect.stringContaining("Tool call edit was rejected")
    })]);
    expect(requests[2].resumeToolResults).toEqual([expect.objectContaining({
      callId: "call_sdk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_edit",
      isError: true,
      output: expect.stringContaining("Correct the arguments")
    })]);
  });

  it("retries bridge transport failures before any model output", async () => {
    let fetchCalls = 0;
    const completion = await createCursorSdkCompletion(
      {
        CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk"
      } as any,
      {
        now: () => new Date("2026-08-13T00:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => {
          fetchCalls += 1;
          if (fetchCalls < 3) {
            throw new TypeError("The socket connection was closed unexpectedly.");
          }
          return new Response(JSON.stringify({ text: "OK", toolCalls: [], status: "completed" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Say OK" },
        model: { id: "gpt-5.6-sol" },
        sessionKey: "socket-retry"
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "OK" });
    expect(fetchCalls).toBe(3);
  });

  it("does not full-replay a pending-tool conflict", async () => {
    let fetchCalls = 0;
    const requests: Array<Record<string, unknown>> = [];
    const completion = await createCursorSdkCompletion(
      {
        CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk"
      } as any,
      {
        now: () => new Date("2026-08-19T00:04:00Z"),
        randomUUID: (() => {
          let index = 0;
          return () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
        })(),
        fetch: async (_input, init) => {
          fetchCalls += 1;
          requests.push(JSON.parse(String(init?.body)));
          if (fetchCalls === 1) {
            return new Response(JSON.stringify({
              error: {
                message: "Cursor SDK agent is waiting for the previous tool result.",
                code: "cursor_sdk_tool_result_pending"
              }
            }), {
              status: 409,
              headers: { "Content-Type": "application/json" }
            });
          }
          return new Response(JSON.stringify({ text: "Recovered", toolCalls: [], status: "completed" }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Full transcript with completed tool result" },
        incrementalPrompt: { text: "Latest turn only" },
        model: { id: "gpt-5.6-sol" },
        sessionKey: "compacted-session",
        resumeToolResults: undefined
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).rejects.toMatchObject({
      status: 409,
      code: "cursor_sdk_tool_result_pending"
    });
    expect(fetchCalls).toBe(1);
    expect(requests[0].incrementalPrompt).toBe("Latest turn only");
  });

  it("preserves bridge error status from an NDJSON stream", async () => {
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-20T04:43:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => new Response(
          '{"type":"error","error":{"message":"Cursor SDK agent is waiting for the previous tool result.","code":"cursor_sdk_tool_result_pending","status":409}}\n',
          { headers: { "Content-Type": "application/x-ndjson" } }
        )
      },
      "cursor-test-key",
      {
        prompt: { text: "Full transcript" },
        model: { id: "grok-4.6" },
        sessionKey: "stream-error-status",
        resumeToolResults: [{ callId: "old-call", output: "completed" }],
        streamEvents: true
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).rejects.toMatchObject({
      status: 409,
      code: "cursor_sdk_tool_result_pending"
    });
  });

  it("omits replay-only fields when resuming a pending bridge run", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-20T09:30:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({ text: "Resumed", toolCalls: [], status: "completed" });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Full transcript that the pending run already owns" },
        incrementalPrompt: { text: "Latest tool exchange" },
        model: { id: "grok-4.6" },
        sessionKey: "compact-resume-wire",
        workingDirectory: "/tmp/cursor2response-test",
        clientTools: [{
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } }
        }],
        resumeToolResults: [{ callId: "call-read", output: "contents" }]
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "Resumed" });
    expect(requestBody).toMatchObject({
      model: "grok-4.6",
      workingDirectory: "/tmp/cursor2response-test",
      resumeToolResults: [{ callId: "call-read", output: "contents" }]
    });
    expect(requestBody).not.toHaveProperty("prompt");
    expect(requestBody).not.toHaveProperty("incrementalPrompt");
    expect(requestBody).not.toHaveProperty("promptAlreadyPrepared");
    expect(requestBody).not.toHaveProperty("tools");
  });

  it("keeps the follow-up prompt when tool results and new Responses input share a request", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-21T11:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({ text: "Steered", toolCalls: [], status: "completed" });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Full transcript with the aborted result and new user turn" },
        incrementalPrompt: { text: "USER: Use a different approach" },
        model: { id: "grok-4.6" },
        sessionKey: "combined-result-user-turn",
        clientTools: [{
          name: "exec",
          description: "Run a command",
          parameters: { type: "object", properties: { command: { type: "string" } } }
        }],
        resumeToolResults: [{ callId: "call-aborted", output: "aborted" }],
        supersedePendingRun: true,
        supersedingTurnAborted: true,
        supersededToolCallIds: ["call-aborted"]
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "Steered" });
    expect(requestBody).toMatchObject({
      prompt: "Full transcript with the aborted result and new user turn",
      incrementalPrompt: "USER: Use a different approach",
      resumeToolResults: [{ callId: "call-aborted", output: "aborted" }],
      supersedePendingRun: true,
      supersedingTurnAborted: true,
      supersededToolCallIds: ["call-aborted"],
      tools: [expect.objectContaining({ name: "exec" })]
    });
  });

  it("keeps prompt fallback metadata when a superseding turn has no tool result", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-21T12:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({ text: "Follow-up complete", toolCalls: [], status: "completed" });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Full transcript" },
        incrementalPrompt: { text: "New user turn" },
        model: { id: "grok-4.6" },
        sessionKey: "mixed-resume-wire",
        clientTools: [{
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } }
        }],
        resumeToolResults: [],
        supersedePendingRun: true,
        supersedingTurnAborted: false,
        supersededToolCallIds: ["call-read"]
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "Follow-up complete" });
    expect(requestBody).toMatchObject({
      prompt: "Full transcript",
      incrementalPrompt: "New user turn",
      resumeToolResults: [],
      supersedePendingRun: true,
      supersedingTurnAborted: false,
      supersededToolCallIds: ["call-read"],
      tools: [expect.objectContaining({ name: "read" })]
    });
  });

  it("does not full-replay a streaming pending-tool conflict", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const toolCallId = "call_sdk_cccccccccccccccccccccccccccccccc_read";
    const deps = {
      now: () => new Date("2026-08-20T04:43:00Z"),
      randomUUID: () => crypto.randomUUID(),
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(request);
        const event = Array.isArray(request.resumeToolResults) && request.resumeToolResults.length > 0
          ? {
              type: "done",
              output: { text: "Recovered", toolCalls: [], status: "completed" }
            }
          : typeof request.incrementalPrompt === "string"
            ? {
                type: "error",
                error: {
                  message: "Cursor SDK agent is waiting for the previous tool result.",
                  code: "cursor_sdk_tool_result_pending",
                  status: 409
                }
              }
            : {
                type: "done",
                output: {
                  text: "",
                  toolCalls: [{ callId: toolCallId, name: "read", arguments: { path: "TOOLS.md" } }],
                  status: "tool_call"
                }
              };
        return new Response(`${JSON.stringify(event)}\n`, {
          headers: { "Content-Type": "application/x-ndjson" }
        });
      }
    };

    const recoveredTurn = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      deps,
      "cursor-test-key",
      {
        prompt: { text: "Full transcript after compaction" },
        incrementalPrompt: { text: "Latest turn only" },
        model: { id: "grok-4.6" },
        sessionKey: "streaming-compacted-session",
        streamEvents: true
      }
    );
    await expect(collectCursorSdkOutput(recoveredTurn.stream)).rejects.toMatchObject({
      status: 409,
      code: "cursor_sdk_tool_result_pending"
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].incrementalPrompt).toBe("Latest turn only");
  });

  it("does not full-replay an empty turn after submitting tool results", async () => {
    let fetchCalls = 0;
    const requests: Array<Record<string, unknown>> = [];
    const completion = await createCursorSdkCompletion(
      {
        CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk"
      } as any,
      {
        now: () => new Date("2026-08-18T00:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          fetchCalls += 1;
          requests.push(JSON.parse(String(init?.body)));
          const body = fetchCalls === 1
            ? {
                text: "",
                toolCalls: [],
                status: "completed",
                usage: {
                  inputTokens: 100,
                  outputTokens: 1,
                  cacheReadTokens: 90,
                  cacheWriteTokens: 0,
                  totalTokens: 101
                }
              }
            : {
                text: "Recovered",
                toolCalls: [],
                status: "completed",
                usage: {
                  inputTokens: 200,
                  outputTokens: 2,
                  cacheReadTokens: 180,
                  cacheWriteTokens: 0,
                  totalTokens: 202
                }
              };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Say recovered" },
        incrementalPrompt: { text: "Say recovered" },
        model: { id: "gpt-5.6-sol" },
        sessionKey: "empty-turn-retry",
        resumeToolResults: [{ output: "previous result" }]
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({
      text: "",
      usage: {
        inputTokens: 100,
        outputTokens: 1,
        cacheReadTokens: 90,
        totalTokens: 101
      }
    });
    expect(fetchCalls).toBe(1);
    expect(requests[0].prompt).toBeUndefined();
  });

  it("requests a fresh Agent after an empty context-aware turn", async () => {
    let fetchCalls = 0;
    const requests: Array<Record<string, any>> = [];
    const prepared = prepareResponsesRequest({
      model: "grok-4.6",
      input: [{ type: "message", role: "user", content: "Answer once." }]
    }, { id: "grok-4.6" });
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-22T12:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async (_input, init) => {
          fetchCalls += 1;
          requests.push(JSON.parse(String(init?.body)));
          return Response.json(fetchCalls === 1
            ? { text: "", toolCalls: [], status: "completed" }
            : { text: "Recovered", toolCalls: [], status: "completed" });
        }
      },
      "cursor-test-key",
      {
        prompt: prepared.prompt,
        model: prepared.cursorModel,
        sessionKey: "context-aware-empty-turn",
        agentContext: prepared.agentContext
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "Recovered" });
    expect(fetchCalls).toBe(2);
    expect(requests[1]).toMatchObject({
      prompt: prepared.prompt.text,
      fullReplayCause: "empty_turn_recovery"
    });
    expect(requests[1].incrementalPrompt).toBeUndefined();
    expect(requests[1].agentContext).toEqual(requests[0].agentContext);
  });

  it("does not retry transport failures after sending tool results", async () => {
    let fetchCalls = 0;
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-19T05:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => {
          fetchCalls += 1;
          throw new TypeError("The socket connection was closed unexpectedly.");
        }
      },
      "cursor-test-key",
      {
        prompt: { text: "Continue after the tool result" },
        model: { id: "gpt-5.6-sol" },
        sessionKey: "result-transport-failure",
        resumeToolResults: [{ output: "completed" }]
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).rejects.toThrow("socket connection was closed unexpectedly");
    expect(fetchCalls).toBe(1);
  });

  it("recognizes only genuinely empty terminal SDK turns", () => {
    expect(isEmptyCursorSdkTurn([
      { type: "done", finalText: "", toolCalls: [] }
    ])).toBe(true);
    expect(isEmptyCursorSdkTurn([
      { type: "text", text: "answer" },
      { type: "done", finalText: "", toolCalls: [] }
    ])).toBe(false);
    expect(isEmptyCursorSdkTurn([
      { type: "done", finalText: "", toolCalls: [{ name: "read", arguments: {} }] }
    ])).toBe(false);
  });

  it("preserves bridge cache usage in collected output", async () => {
    const usage = {
      inputTokens: 9000,
      outputTokens: 12,
      cacheReadTokens: 8192,
      cacheWriteTokens: 512,
      totalTokens: 9012,
      reasoningTokens: 4
    };
    const completion = await createCursorSdkCompletion(
      { CURSOR_SDK_BRIDGE_URL: "http://bridge.test/sdk" } as any,
      {
        now: () => new Date("2026-08-18T00:00:00Z"),
        randomUUID: () => crypto.randomUUID(),
        fetch: async () => new Response(JSON.stringify({ text: "OK", toolCalls: [], status: "completed", usage }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      },
      "cursor-test-key",
      {
        prompt: { text: "Say OK" },
        model: { id: "grok-4.6[fast=true,effort=high]" },
        sessionKey: "usage-test"
      }
    );

    await expect(collectCursorSdkOutput(completion.stream)).resolves.toMatchObject({ text: "OK", usage });
  });

});
