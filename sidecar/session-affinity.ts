export interface SessionAffinityResolution {
  key: string;
  source: string;
  sessionHeaders: string[];
}

const sessionHeaderNames = [
  "session-id",
  "session_id",
  "conversation-id",
  "conversation_id",
  "thread-id",
  "thread_id",
  "x-session-affinity",
  "x-opencode-session-id",
  "x-opencode-session",
  "x-client-request-id"
];

export function resolveSessionAffinity(
  headers: Headers,
  body: unknown,
  generate: () => string
): SessionAffinityResolution {
  const sessionHeaders = sessionHeaderNames.filter((name) => Boolean(headers.get(name)?.trim()));
  for (const name of sessionHeaderNames) {
    const key = headers.get(name)?.trim();
    if (key) return { key, source: `header:${name}`, sessionHeaders };
  }

  if (body && typeof body === "object") {
    const promptCacheKey = (body as { prompt_cache_key?: unknown }).prompt_cache_key;
    if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
      return { key: promptCacheKey.trim(), source: "prompt_cache_key", sessionHeaders };
    }
  }

  return { key: generate(), source: "generated", sessionHeaders };
}
