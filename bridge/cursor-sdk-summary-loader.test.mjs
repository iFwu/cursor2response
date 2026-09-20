import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CURSOR_SDK_SUMMARY_FILTER_SIGNATURE,
  CURSOR_SDK_SUMMARY_HOOK_MARKER,
  CURSOR_SDK_SUMMARY_HOOK_VERSION,
  resolveCursorSdkLoadContract,
  transformCursorSdkSource
} from "./cursor-sdk-summary-loader.mjs";

describe("Cursor SDK summary loader", () => {
  it("transforms the installed ESM bundle exactly once", () => {
    const contract = resolveCursorSdkLoadContract();
    const source = readFileSync(fileURLToPath(contract.entryUrl), "utf8");
    const transformed = transformCursorSdkSource(source, {
      url: contract.entryUrl,
      expectedUrl: contract.entryUrl,
      packageVersion: contract.packageVersion
    });

    expect(contract.packageVersion).toBe(CURSOR_SDK_SUMMARY_HOOK_VERSION);
    expect(source.split(CURSOR_SDK_SUMMARY_FILTER_SIGNATURE)).toHaveLength(2);
    expect(transformed).not.toContain(CURSOR_SDK_SUMMARY_FILTER_SIGNATURE);
    expect(transformed).toContain(`Symbol.for(${JSON.stringify(CURSOR_SDK_SUMMARY_HOOK_MARKER)})`);
  });

  it.each([
    ["version", { packageVersion: "1.0.28" }],
    ["URL", { url: "file:///tmp/not-cursor-sdk.js" }],
    ["signature", { source: "export const sdk = true;" }],
    ["duplicate signature", { source: `${CURSOR_SDK_SUMMARY_FILTER_SIGNATURE};${CURSOR_SDK_SUMMARY_FILTER_SIGNATURE}` }]
  ])("fails closed on %s drift", (_name, overrides) => {
    const contract = resolveCursorSdkLoadContract();
    const source = overrides.source ?? readFileSync(fileURLToPath(contract.entryUrl), "utf8");
    expect(() => transformCursorSdkSource(source, {
      url: contract.entryUrl,
      expectedUrl: contract.entryUrl,
      packageVersion: contract.packageVersion,
      ...overrides
    })).toThrowError(expect.objectContaining({
      code: "cursor_sdk_summary_hook_contract_mismatch"
    }));
  });

  it("loads the real SDK through the hook in a child process", () => {
    const loaderUrl = new URL("./cursor-sdk-summary-loader.mjs", import.meta.url).href;
    const source = `
      import { register } from "node:module";
      import { CURSOR_SDK_SUMMARY_HOOK_MARKER, resolveCursorSdkLoadContract } from ${JSON.stringify(loaderUrl)};
      const contract = resolveCursorSdkLoadContract();
      register(${JSON.stringify(loaderUrl)}, { parentURL: import.meta.url, data: contract });
      await import(contract.entryUrl);
      const marker = globalThis[Symbol.for(CURSOR_SDK_SUMMARY_HOOK_MARKER)];
      if (marker?.version !== contract.packageVersion || marker?.url !== contract.entryUrl) process.exit(2);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
