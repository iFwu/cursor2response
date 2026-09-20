import { expect, test } from "vitest";

import { inferClientPlatform, inferClientSource } from "./client-source.ts";

test("classifies supported client user-agent families", () => {
  expect(inferClientSource(new Headers({ "user-agent": "codex_cli_rs/0.149.0" }))).toBe("codex");
  expect(inferClientSource(new Headers({
    "user-agent": "superconductor/0.149.1 (Ubuntu 24.4.0; x86_64) unknown (superconductor; 0.1.0)"
  }))).toBe("superconductor");
  expect(inferClientSource(new Headers({ "user-agent": "OpenAI/JS 6.39.1" }))).toBe("openclaw");
  expect(inferClientSource(new Headers({ "user-agent": "cursor2response-health/1.0" }))).toBe("healthcheck");
  expect(inferClientSource(new Headers({ "user-agent": "curl/8.0" }))).toBe("ua:curl");
  expect(inferClientSource(new Headers({ "user-agent": "not-a-user-agent" }))).toBe("unknown");
});

test("classifies the platform from the operating-system segment without retaining it", () => {
  expect(inferClientPlatform(new Headers({
    "user-agent": "codex-tui/0.149.1 (Ubuntu 24.4.0; x86_64) xterm-256color"
  }))).toBe("linux");
  expect(inferClientPlatform(new Headers({
    "user-agent": "codex-tui/0.149.1 (Mac OS 26.5.0; arm64) Superconductor/0.1.0"
  }))).toBe("mac");
  expect(inferClientPlatform(new Headers({ "user-agent": "curl/8.0" }))).toBe("unknown");
});
