import { describe, expect, it } from "vitest";

import { resolveSessionAffinity } from "./session-affinity.ts";

describe("resolveSessionAffinity", () => {
  it("prefers modern Codex session headers and reports every observed source", () => {
    const headers = new Headers({
      "session-id": "modern-session",
      "session_id": "legacy-session",
      "thread-id": "modern-thread",
      "x-client-request-id": "client-request"
    });

    expect(resolveSessionAffinity(headers, { prompt_cache_key: "cache-key" }, () => "generated")).toEqual({
      key: "modern-session",
      source: "header:session-id",
      sessionHeaders: ["session-id", "session_id", "thread-id", "x-client-request-id"]
    });
  });

  it("uses prompt_cache_key only when no explicit session header is present", () => {
    expect(resolveSessionAffinity(new Headers(), { prompt_cache_key: " cache-key " }, () => "generated")).toEqual({
      key: "cache-key",
      source: "prompt_cache_key",
      sessionHeaders: []
    });
  });

  it("generates a fresh session when neither header nor prompt cache key is usable", () => {
    expect(resolveSessionAffinity(new Headers(), { prompt_cache_key: 42 }, () => "generated")).toEqual({
      key: "generated",
      source: "generated",
      sessionHeaders: []
    });
  });
});
