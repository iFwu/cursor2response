export const PRIMARY_MODEL = "auto";

export const GROK_FAST_SUFFIX = "-fast";

const GROK46_DEFAULT_EFFORT = "high";

const EFFORT_ALIASES: Record<string, string | null> = {
  off: null,
  none: null,
  minimal: "low",
  min: "low",
  low: "low",
  medium: "medium",
  mid: "medium",
  high: "high",
  "x-high": "xhigh",
  xhigh: "xhigh",
  extrahigh: "xhigh",
  "extra-high": "xhigh",
  max: "xhigh"
};

export function isGrok46Family(modelId: string): boolean {
  const id = modelId.trim().toLowerCase().replace(/-fast$/, "");
  return id === "grok-4.6" || id.startsWith("grok-4.6") || id === "cursor-grok" || id.startsWith("cursor-grok");
}

export function normalizeGrokEffort(raw: unknown): { kind: "missing" | "omit" | "value"; value?: string } {
  if (typeof raw !== "string" || !raw.trim()) return { kind: "missing" };
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  const collapsed = key.replace(/-/g, "");
  if (Object.prototype.hasOwnProperty.call(EFFORT_ALIASES, key)) {
    const mapped = EFFORT_ALIASES[key];
    return mapped === null ? { kind: "omit" } : { kind: "value", value: mapped };
  }
  if (Object.prototype.hasOwnProperty.call(EFFORT_ALIASES, collapsed)) {
    const mapped = EFFORT_ALIASES[collapsed];
    return mapped === null ? { kind: "omit" } : { kind: "value", value: mapped };
  }
  return { kind: "value", value: key };
}

export function extractRequestEffort(body: unknown): unknown {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const reasoning = record.reasoning && typeof record.reasoning === "object" && !Array.isArray(record.reasoning)
    ? record.reasoning as Record<string, unknown>
    : {};
  const outputConfig = record.output_config && typeof record.output_config === "object" && !Array.isArray(record.output_config)
    ? record.output_config as Record<string, unknown>
    : {};
  return [record.reasoning_effort, reasoning.effort, outputConfig.effort]
    .find((value) => typeof value === "string" && value.trim());
}

function parameterizedModelId(modelId: string, params: Array<{ id: string; value: string }>): string {
  if (!params.length) return modelId;
  return `${modelId}[${params.map((param) => `${param.id}=${param.value}`).join(",")}]`;
}

export function applyCursorModelSelection(
  requestedModel: string,
  body: unknown,
  supportedParameters?: Set<string>
): { id: string } {
  const rawModel = requestedModel.trim() || PRIMARY_MODEL;
  const match = /^([^\[]+?)(?:\[(.*)\])?$/.exec(rawModel);
  let modelId = (match?.[1] || PRIMARY_MODEL).trim();
  if (modelId.toLowerCase() === "default") modelId = "auto";
  const fastSuffix = modelId.toLowerCase().endsWith(GROK_FAST_SUFFIX);
  if (fastSuffix) modelId = modelId.slice(0, -GROK_FAST_SUFFIX.length);

  const params = new Map<string, string>();
  const explicitParams = new Set<string>();
  const rawParams = match?.[2]?.trim();
  if (rawParams) {
    for (const entry of rawParams.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) continue;
      const id = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (id && value) {
        params.set(id, value);
        explicitParams.add(id);
      }
    }
  }

  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const bodyEffort = normalizeGrokEffort(extractRequestEffort(body));
  const grokFamily = isGrok46Family(modelId);

  const serviceTier = typeof record.service_tier === "string" ? record.service_tier.trim().toLowerCase() : "";
  const standardFast = typeof record.fast === "boolean"
    ? record.fast
    : serviceTier === "priority" || serviceTier === "fast"
      ? true
      : undefined;

  if (grokFamily) {
    if (!params.has("fast")) {
      params.set("fast", String(fastSuffix || standardFast === true || record.cursor_fast === true));
    }
    if (bodyEffort.kind === "value" && bodyEffort.value) {
      params.set("effort", bodyEffort.value);
    } else if (bodyEffort.kind === "omit") {
      params.delete("effort");
    } else if (!params.has("effort") && !params.has("reasoning_effort")) {
      params.set("effort", GROK46_DEFAULT_EFFORT);
    }
  } else if (
    bodyEffort.kind === "value"
    && bodyEffort.value
    && supportedParameters?.has("effort")
    && !params.has("effort")
    && !params.has("reasoning_effort")
  ) {
    params.set("effort", bodyEffort.value);
  }

  if (standardFast !== undefined && !params.has("fast") && (grokFamily || supportedParameters?.has("fast"))) {
    params.set("fast", String(standardFast));
  }

  if (typeof record.cursor_fast === "boolean" && !params.has("fast")) {
    params.set("fast", String(record.cursor_fast));
  }
  if (typeof record.cursor_context === "string" && record.cursor_context.trim() && !params.has("context")) {
    params.set("context", record.cursor_context.trim());
  }

  const routerMode = [record.cursor_router_mode, record.optimize_for]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (modelId.toLowerCase() === "auto-smart" && routerMode && !params.has("optimize_for")) {
    params.set("optimize_for", routerMode.trim());
  }

  const customParams = record.cursor_params ?? record.model_params;
  if (Array.isArray(customParams)) {
    for (const item of customParams) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const param = item as Record<string, unknown>;
      if (typeof param.id === "string" && typeof param.value === "string" && param.id.trim() && param.value.trim()) {
        params.set(param.id.trim(), param.value.trim());
        explicitParams.add(param.id.trim());
      }
    }
  } else if (customParams && typeof customParams === "object") {
    for (const [id, value] of Object.entries(customParams as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) {
        params.set(id, value.trim());
        explicitParams.add(id);
      } else if (typeof value === "boolean" || typeof value === "number") {
        params.set(id, String(value));
        explicitParams.add(id);
      }
    }
  }

  for (const id of explicitParams) {
    if (id === "reasoning_effort") {
      if (!params.has("effort")) params.set("effort", params.get(id) ?? "");
      params.delete(id);
    }
  }

  // Body effort wins over a later cursor_params effort= on grok-4.6.
  if (grokFamily && bodyEffort.kind === "value" && bodyEffort.value) {
    params.set("effort", bodyEffort.value);
  } else if (grokFamily && bodyEffort.kind === "omit") {
    params.delete("effort");
  }

  return { id: parameterizedModelId(modelId, Array.from(params, ([id, value]) => ({ id, value }))) };
}
