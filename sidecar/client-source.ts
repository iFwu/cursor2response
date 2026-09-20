const CODEX_USER_AGENT = /^(?:codex_cli_rs|codex-tui|codex_vscode|codex_vscode_copilot|codex_app|codex_chatgpt_desktop|codex_atlas|codex_exec|codex_sdk_ts)\//;
const CODEX_USER_AGENT_TRAILER = /\((?:codex_cli_rs|codex-tui|codex_vscode|codex_vscode_copilot|codex_app|codex_chatgpt_desktop|codex_atlas|codex_exec|codex_sdk_ts);/;
const SUPERCONDUCTOR_USER_AGENT = /^superconductor\//;
const USER_AGENT_FAMILY = /^([a-z][a-z0-9._-]{0,63})\/[0-9][a-z0-9._+-]{0,31}(?:\s|$)/;
const LINUX_USER_AGENT = /\((?:[^)]*\b(?:linux|ubuntu|debian|fedora|arch|alpine)\b)[^)]*\)/;
const MAC_USER_AGENT = /\((?:[^)]*\b(?:mac os(?: x)?|macos|darwin)\b)[^)]*\)/;

export type ClientSource = "codex" | "openclaw" | "healthcheck" | "superconductor" | `ua:${string}` | "unknown";
export type ClientPlatform = "linux" | "mac" | "unknown";

function extractUserAgentFamily(userAgent: string): ClientSource {
  const family = USER_AGENT_FAMILY.exec(userAgent)?.[1];
  return family ? `ua:${family}` : "unknown";
}

export function inferClientSource(headers: Headers): ClientSource {
  const userAgent = headers.get("user-agent")?.trim().toLowerCase() ?? "";
  if (CODEX_USER_AGENT.test(userAgent) || CODEX_USER_AGENT_TRAILER.test(userAgent)) {
    return "codex";
  }
  if (SUPERCONDUCTOR_USER_AGENT.test(userAgent)) {
    return "superconductor";
  }
  // shortcut: generic OpenAI/JS traffic is OpenClaw while these are the only two clients;
  // add an explicit caller identity when another OpenAI JS client is introduced.
  if (userAgent.startsWith("openai/js ") || userAgent.startsWith("openai/js/")) {
    return "openclaw";
  }
  if (userAgent.startsWith("cursor2response-health/")) {
    return "healthcheck";
  }
  // shortcut: retain only a bounded UA family token; add an explicit identity contract
  // when a caller needs more than a versionless display hint.
  return extractUserAgentFamily(userAgent);
}

export function inferClientPlatform(headers: Headers): ClientPlatform {
  const userAgent = headers.get("user-agent")?.trim().toLowerCase() ?? "";
  if (MAC_USER_AGENT.test(userAgent)) return "mac";
  if (LINUX_USER_AGENT.test(userAgent)) return "linux";
  return "unknown";
}
