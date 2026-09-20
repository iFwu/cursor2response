export interface Env {
  CURSOR_SDK_BRIDGE_TOKEN?: string;
  CURSOR_SDK_BRIDGE_TIMEOUT_MS?: string;
  CURSOR_SDK_BRIDGE_URL?: string;
}

export interface Deps {
  fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  now: () => Date;
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
}

export type CursorImage =
  | { url: string; dimension?: { width: number; height: number }; uuid?: string }
  | { data: string; mimeType: string; dimension?: { width: number; height: number }; uuid?: string };

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  callId?: string;
  name: string;
  arguments: Record<string, unknown>;
  trajectoryId?: string;
  executionId?: string;
  runId?: string;
  agentId?: string;
}
