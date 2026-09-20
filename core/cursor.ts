import type { CursorToolCall } from "./types.ts";

export interface CursorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export type CursorTextEvent =
  | { type: "text"; text: string; outputId?: string; executionId?: string; runId?: string; agentId?: string }
  | { type: "reasoning"; text: string; done: boolean; thinkingDurationMs?: number }
  | { type: "tool_call"; toolCall: CursorToolCall }
  | { type: "rejected_tool_call"; toolCall: CursorToolCall; reason?: string }
  | {
      type: "done";
      finalText: string;
      toolCalls: CursorToolCall[];
      usage?: CursorUsage;
      outputId?: string;
      outputType?: "commentary" | "final";
      executionId?: string;
      runId?: string;
      agentId?: string;
    };

export interface CursorCollectedOutput {
  text: string;
  toolCalls: CursorToolCall[];
  usage?: CursorUsage;
  reasoning?: string[];
  outputId?: string;
  outputType?: "commentary" | "final";
  executionId?: string;
  runId?: string;
  agentId?: string;
}
