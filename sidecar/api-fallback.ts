import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CursorSdkContextOverflowError } from "../core/cursor-sdk.ts";
import { HttpError, withCors } from "../core/http.ts";
import type { Deps } from "../core/types.ts";
import type { SessionAffinityResolution } from "./session-affinity.ts";
import { observeFallbackResponse, type FallbackTrace } from "./fallback-trace.ts";
import { guardFallbackStream } from "./fallback-stream.ts";

export const API_FALLBACK_MODEL = "cursor-relay";
export const API_FALLBACK_DISPLAY_NAME = "Cursor Relay";
// Remove the request alias after all clients and gateways migrate to cursor-relay.
const LEGACY_API_FALLBACK_MODEL = "cursor-auto";
// Persistent route identity must survive client-facing renames and alias removal.
const API_FALLBACK_STATE_NAMESPACE = "cursor-auto";

export function isApiFallbackModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized === API_FALLBACK_MODEL || normalized === LEGACY_API_FALLBACK_MODEL;
}

export interface ApiFallbackConfig {
  primaryModel: string;
  responsesUrl: string;
  apiKey: string;
  model: string;
  stateDirectory: string;
  timeoutMs?: number;
  notifyCommand?: string;
}

export function apiFallbackConfig(environment = process.env): ApiFallbackConfig | undefined {
  const primaryModel = environment.C2R_PRIMARY_MODEL?.trim();
  const baseUrl = environment.C2R_FALLBACK_BASE_URL?.trim();
  const apiKey = environment.C2R_FALLBACK_API_KEY?.trim();
  const model = environment.C2R_FALLBACK_MODEL?.trim();
  if (!primaryModel && !baseUrl && !apiKey && !model) return undefined;
  if (!primaryModel || !baseUrl || !apiKey || !model) {
    const missing = Object.entries({ C2R_PRIMARY_MODEL: primaryModel, C2R_FALLBACK_BASE_URL: baseUrl,
      C2R_FALLBACK_API_KEY: apiKey, C2R_FALLBACK_MODEL: model }).filter(([, value]) => !value).map(([name]) => name);
    throw new HttpError(`api-fallback configuration is incomplete: ${missing.join(", ")}.`, 503, "api_fallback_not_configured");
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch {
    throw new HttpError("Invalid api-fallback base URL.", 503, "api_fallback_not_configured");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || isApiFallbackModel(primaryModel.split("[")[0]) || isApiFallbackModel(model)) {
    throw new HttpError("Invalid api-fallback configuration.", 503, "api_fallback_not_configured");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
  const timeoutMs = Number(environment.C2R_FALLBACK_TIMEOUT_MS?.trim() || 180000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000) {
    throw new HttpError("Invalid api-fallback timeout.", 503, "api_fallback_not_configured");
  }
  return {
    primaryModel,
    responsesUrl: url.href,
    apiKey,
    model,
    timeoutMs,
    stateDirectory: environment.C2R_FALLBACK_STATE_DIR?.trim()
      || path.join(environment.XDG_STATE_HOME?.trim() || path.join(homedir(), ".local/state"), "cursor2response", "fallback-routes"),
    notifyCommand: environment.C2R_FALLBACK_NOTIFY_COMMAND?.trim() || undefined
  };
}

export class FallbackRouteStore {
  constructor(private readonly directory: string) {}

  private filename(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid fallback route identity");
    return path.join(this.directory, `${key}.json`);
  }

  async hasFallback(key: string): Promise<boolean> {
    try {
      const state = JSON.parse(await readFile(this.filename(key), "utf8"));
      if (state.version !== 1 || state.route !== "fallback") throw new Error("Invalid fallback route state");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new HttpError("Unable to read api-fallback route state.", 503, "api_fallback_route_state_unavailable");
    }
  }

  async useFallback(key: string, sessionKey: string, requestId: string): Promise<void> {
    const filename = this.filename(key);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({
        version: 1, route: "fallback", since: new Date().toISOString(), sessionKey, requestId
      }), {
        mode: 0o600, flag: "wx"
      });
      await rename(temporary, filename);
    } catch {
      throw new HttpError("Unable to persist api-fallback route state.", 503, "api_fallback_route_state_unavailable");
    }
  }
}

export interface ApiFallbackRequest {
  body: Record<string, unknown>;
  apiKey: string;
  session: SessionAffinityResolution;
  workingDirectory?: string;
  signal: AbortSignal;
  requestId: string;
  clientSource: string;
  clientPlatform: string;
  inputs: Array<{ source: "user" | "tool_result"; content: string; callId?: string }>;
}

export interface FallbackNotice {
  primaryModel: string;
  fallbackModel: string;
  sessionKey: string;
  thisTurn: "recovered" | "marked-only";
  userSnippet?: string;
  requestId?: string;
}

const USER_SNIPPET_CHARS = 40;

export function lastUserSnippet(
  input: unknown,
  maxChars = USER_SNIPPET_CHARS
): string | undefined {
  const inputs = Array.isArray(input) ? input : [input];
  for (let index = inputs.length - 1; index >= 0; index--) {
    const item = inputs[index];
    if (typeof item !== "string" && item?.role !== "user") continue;
    const content = typeof item === "string" ? item : item.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.flatMap((part) => typeof part === "string" ? [part]
        : ["input_text", "text"].includes(part?.type) && typeof part.text === "string" ? [part.text] : []).join("\n")
      : "";
    const snippet = visibleUserSnippet(text, maxChars);
    if (snippet) return snippet;
  }
}

function visibleUserSnippet(content: string, maxChars: number): string | undefined {
  let text = content.replace(/\r\n/g, "\n").trim();
  if (!text || text.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>")) return undefined;
  text = text.replace(/^\[[^\]]*GMT[^\]]*\]\s*Conversation info:[\s\S]*?```[\s\S]*?```\s*/i, "");
  text = text.replace(/^Conversation info:[\s\S]*?```[\s\S]*?```\s*/i, "");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}...` : text;
}

export function fallbackNotifyArgs(notice: FallbackNotice): string[] {
  const args = [
    "--title", `${notice.primaryModel} → ${notice.fallbackModel}${notice.thisTurn === "marked-only" ? "（仅后续）" : ""}`,
    "--level", "warn",
    "--source", "cursor2response",
    "--field", `session=${notice.sessionKey}`
  ];
  if (notice.userSnippet) args.splice(2, 0, "--text", notice.userSnippet);
  if (notice.requestId) args.push("--field", `traceId=${notice.requestId}`);
  return args;
}

export function notifyApiFallback(command: string | undefined, notice: FallbackNotice): void {
  if (!command) return;
  try {
    const child = spawn(command, fallbackNotifyArgs(notice), { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch { /* Notification never changes routing. */ }
}

export class ApiFallbackRoute {
  private readonly key: string;
  private readonly store?: FallbackRouteStore;
  private attemptIndex = 0;

  constructor(
    private readonly config: ApiFallbackConfig,
    private readonly request: ApiFallbackRequest,
    private readonly trace: FallbackTrace,
    private readonly fetchUpstream: Deps["fetch"] = fetch
  ) {
    if (request.body.previous_response_id) {
      throw new HttpError("api-fallback requires complete input history, not previous_response_id.", 400, "unsupported_parameter", "previous_response_id");
    }
    if (typeof request.body.system_prompt === "string") {
      throw new HttpError("api-fallback does not support the SDK-only system_prompt override.", 400, "unsupported_parameter", "system_prompt");
    }
    this.key = createHash("sha256")
      .update(JSON.stringify([request.apiKey, API_FALLBACK_STATE_NAMESPACE, config.primaryModel,
        config.responsesUrl, config.model, request.workingDirectory ?? "", request.session.key]))
      .digest("hex");
    // Generated identities belong to one request, never to durable sticky routing.
    if (request.session.source !== "generated") this.store = new FallbackRouteStore(config.stateDirectory);
  }

  private record(fields: Record<string, unknown>): void {
    try {
      this.trace("trajectory_route_decision", {
        sessionKey: this.request.session.key,
        requestId: this.request.requestId,
        ingressRequestId: this.request.requestId,
        logicalRequestId: this.request.requestId,
        logicalModel: API_FALLBACK_MODEL,
        primaryModel: this.config.primaryModel,
        clientSource: this.request.clientSource,
        clientPlatform: this.request.clientPlatform,
        ...fields
      });
    } catch { /* Routing never depends on trace publication. */ }
  }

  async initialResponse(): Promise<Response | undefined> {
    this.request.signal.throwIfAborted();
    if (await this.store?.hasFallback(this.key)) return this.forward("sticky_fallback", true);
    this.record({ route: "cursor_sdk", routeCause: "primary_first", routeStickyHit: false, attemptIndex: 0 });
    return undefined;
  }

  async recover(error: unknown, outputPublished: boolean): Promise<Response | undefined> {
    if (!(error instanceof CursorSdkContextOverflowError)) return undefined;
    await this.store?.useFallback(this.key, this.request.session.key, this.request.requestId);
    const retrySafe = !outputPublished && error.contextRetrySafe && !this.request.signal.aborted;
    this.record({
      route: "fallback", routeCause: "sdk_context_overflow", outputPublished,
      contextRetrySafe: error.contextRetrySafe, fallbackAttempted: retrySafe,
      fallbackBlockedReason: retrySafe ? undefined : outputPublished ? "output_already_published"
        : this.request.signal.aborted ? "caller_cancelled" : "cleanup_unconfirmed",
      routeStickyHit: false
    });
    if (this.store) notifyApiFallback(this.config.notifyCommand, {
      primaryModel: this.config.primaryModel,
      fallbackModel: this.config.model,
      sessionKey: this.request.session.key,
      thisTurn: retrySafe ? "recovered" : "marked-only",
      userSnippet: lastUserSnippet(this.request.body.input),
      requestId: this.request.requestId
    });
    if (!retrySafe) return undefined;
    this.attemptIndex = 1;
    return this.forward("sdk_context_overflow", false);
  }

  private async forward(routeCause: string, stickyHit: boolean): Promise<Response> {
    this.request.signal.throwIfAborted();
    const requestId = `fallback_${randomUUID()}`;
    const trace: FallbackTrace = (event, fields) => {
      try {
        this.trace(event, {
          sessionKey: this.request.session.key,
          ingressRequestId: this.request.requestId,
          logicalRequestId: this.request.requestId,
          requestId,
          executionId: `execution_${requestId}`,
          agentId: `fallback_${this.key}`,
          clientSource: this.request.clientSource,
          clientPlatform: this.request.clientPlatform,
          route: "fallback", logicalModel: API_FALLBACK_MODEL, upstreamModel: this.config.model,
          model: { id: this.config.model },
          ...fields
        });
      } catch { /* Upstream bytes are independent of diagnostic parsing and writes. */ }
    };
    this.record({ route: "fallback", routeCause, routeStickyHit: stickyHit,
      upstreamModel: this.config.model, attemptIndex: this.attemptIndex });
    trace("trajectory_request", { attemptIndex: this.attemptIndex, requestKind: stickyHit ? "continuation" : "retry",
      decision: "forwarded", sessionSource: this.request.session.source });
    trace("trajectory_execution_started", { source: "responses_upstream" });
    let response: Response;
    try {
      response = await this.fetchUpstream(this.config.responsesUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: this.request.body.stream === true ? "text/event-stream" : "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          session_id: `fallback-${this.key}`
        },
        body: JSON.stringify({ ...this.request.body, model: this.config.model }),
        signal: AbortSignal.any([this.request.signal, AbortSignal.timeout(this.config.timeoutMs ?? 180000)]),
        redirect: "error"
      });
    } catch (error) {
      trace("trajectory_execution_terminal", { status: this.request.signal.aborted ? "cancelled" : "failed",
        errorCode: this.request.signal.aborted ? "cursor_sdk_cancelled" : "api_fallback_transport_failed" });
      if (this.request.signal.aborted) throw error;
      throw new HttpError("api-fallback request failed.", 502, "api_fallback_transport_failed");
    }
    return withCors(observeFallbackResponse(guardFallbackStream(response), trace, this.request.inputs));
  }
}
