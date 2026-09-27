import { describe, expect, test } from "vitest";
import {
  applyCursorModelSelection,
  isGrok46Family,
  normalizeGrokEffort
} from "./cursor-model-selection.ts";

describe("normalizeGrokEffort", () => {
  test("maps OpenClaw aliases onto Cursor suffixes", () => {
    expect(normalizeGrokEffort("low")).toEqual({ kind: "value", value: "low" });
    expect(normalizeGrokEffort("medium")).toEqual({ kind: "value", value: "medium" });
    expect(normalizeGrokEffort("high")).toEqual({ kind: "value", value: "high" });
    expect(normalizeGrokEffort("x-high")).toEqual({ kind: "value", value: "xhigh" });
    expect(normalizeGrokEffort("xhigh")).toEqual({ kind: "value", value: "xhigh" });
    expect(normalizeGrokEffort("max")).toEqual({ kind: "value", value: "xhigh" });
    expect(normalizeGrokEffort("minimal")).toEqual({ kind: "value", value: "low" });
    expect(normalizeGrokEffort("none")).toEqual({ kind: "omit" });
    expect(normalizeGrokEffort("off")).toEqual({ kind: "omit" });
    expect(normalizeGrokEffort("")).toEqual({ kind: "missing" });
  });
});

describe("isGrok46Family", () => {
  test("accepts grok-4.6 and cursor-grok aliases", () => {
    expect(isGrok46Family("grok-4.6")).toBe(true);
    expect(isGrok46Family("cursor-grok")).toBe(true);
    expect(isGrok46Family("cursor-grok-fast")).toBe(true);
    expect(isGrok46Family("cursor-grok-low")).toBe(true);
    expect(isGrok46Family("claude-opus-5")).toBe(false);
  });
});

describe("applyCursorModelSelection", () => {
  test("defaults grok-4.6 to fast=false and effort=high", () => {
    expect(applyCursorModelSelection("grok-4.6", {}).id).toBe("grok-4.6[fast=false,effort=high]");
  });

  test("enables fast for the explicit -fast model variant", () => {
    expect(applyCursorModelSelection("grok-4.6-fast", {}).id).toBe("grok-4.6[fast=true,effort=high]");
  });

  test("honors OpenAI fast request controls over the default", () => {
    expect(applyCursorModelSelection("grok-4.6", { fast: true }).id).toBe("grok-4.6[fast=true,effort=high]");
    expect(applyCursorModelSelection("grok-4.6", { service_tier: "priority" }).id).toBe("grok-4.6[fast=true,effort=high]");
    expect(applyCursorModelSelection("grok-4.6", { cursor_fast: false }).id).toBe("grok-4.6[fast=false,effort=high]");
  });

  test("allows explicit cursor params to override the model default", () => {
    expect(applyCursorModelSelection("grok-4.6", { cursor_params: { fast: true } }).id).toBe("grok-4.6[fast=true,effort=high]");
    expect(applyCursorModelSelection("grok-4.6-fast", { cursor_params: { fast: false } }).id).toBe("grok-4.6[fast=false,effort=high]");
  });

  test("overrides baked model-id effort from reasoning.effort", () => {
    expect(applyCursorModelSelection(
      "grok-4.6[fast=true,effort=high]",
      { reasoning: { effort: "low" } }
    ).id).toBe("grok-4.6[fast=true,effort=low]");
  });

  test("accepts flat reasoning_effort and x-high", () => {
    expect(applyCursorModelSelection(
      "grok-4.6[fast=true]",
      { reasoning_effort: "x-high" }
    ).id).toBe("grok-4.6[fast=true,effort=xhigh]");
  });

  test("omits effort when thinking is off", () => {
    expect(applyCursorModelSelection(
      "grok-4.6[fast=true,effort=high]",
      { reasoning: { effort: "none" } }
    ).id).toBe("grok-4.6[fast=true]");
  });

  test("does not apply body effort to other models without catalog support", () => {
    expect(applyCursorModelSelection(
      "claude-opus-5",
      { reasoning: { effort: "high" } }
    ).id).toBe("claude-opus-5");
  });

  test("applies body effort to other models when catalog lists effort", () => {
    expect(applyCursorModelSelection(
      "claude-opus-5",
      { reasoning: { effort: "high" } },
      new Set(["effort"])
    ).id).toBe("claude-opus-5[effort=high]");
  });

  test("preserves Grok 4.7 catalog parameter names and explicit context selection", () => {
    const parameters = new Set(["reasoning_effort", "context", "fast"]);
    expect(applyCursorModelSelection("grok-4.7", {
      reasoning: { effort: "high" }, cursor_context: "500k", service_tier: "default"
    }, parameters).id).toBe("grok-4.7[reasoning_effort=high,fast=false,context=500k]");
    expect(applyCursorModelSelection("grok-4.7", {
      cursor_params: { reasoning_effort: "low", context: "256k", fast: true }
    }, parameters).id).toBe("grok-4.7[reasoning_effort=low,context=256k,fast=true]");
  });
});
