import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CURSOR_SDK_SUMMARY_HOOK_VERSION = "1.0.31";
export const CURSOR_SDK_SUMMARY_HOOK_MARKER = "cursor2response.cursor-sdk-summary-hook";
export const CURSOR_SDK_SUMMARY_FILTER_SIGNATURE = "function(e){return\"summary\"===e.type||\"summary-started\"===e.type||\"summary-completed\"===e.type}(e)";

export function resolveCursorSdkLoadContract(resolve = (specifier) => import.meta.resolve(specifier)) {
  const entryUrl = resolve("@cursor/sdk");
  if (typeof entryUrl !== "string" || !entryUrl.startsWith("file:")) {
    throw summaryHookContractError(`resolved @cursor/sdk URL is not a file URL: ${String(entryUrl)}`);
  }
  const entryPath = fileURLToPath(entryUrl);
  const packageRoot = path.resolve(path.dirname(entryPath), "..", "..");
  const expectedEntryPath = path.join(packageRoot, "dist", "esm", "index.js");
  if (path.resolve(entryPath) !== expectedEntryPath) {
    throw summaryHookContractError(`resolved @cursor/sdk entry is ${entryPath}, expected ${expectedEntryPath}`);
  }
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    throw summaryHookContractError("could not read @cursor/sdk package metadata", error);
  }
  if (packageJson.name !== "@cursor/sdk" || packageJson.version !== CURSOR_SDK_SUMMARY_HOOK_VERSION) {
    throw summaryHookContractError(
      `loaded ${String(packageJson.name)}@${String(packageJson.version)}, expected @cursor/sdk@${CURSOR_SDK_SUMMARY_HOOK_VERSION}`
    );
  }
  return { entryUrl, packageVersion: packageJson.version };
}

export function transformCursorSdkSource(source, contract) {
  if (
    !contract
    || typeof contract !== "object"
    || typeof contract.url !== "string"
    || typeof contract.expectedUrl !== "string"
    || typeof contract.packageVersion !== "string"
  ) {
    throw summaryHookContractError("source transform contract is incomplete");
  }
  if (contract.packageVersion !== CURSOR_SDK_SUMMARY_HOOK_VERSION) {
    throw summaryHookContractError(
      `loader received @cursor/sdk@${String(contract.packageVersion)}, expected ${CURSOR_SDK_SUMMARY_HOOK_VERSION}`
    );
  }
  if (contract.url !== contract.expectedUrl) {
    throw summaryHookContractError(`loader received ${String(contract.url)}, expected ${String(contract.expectedUrl)}`);
  }
  const text = typeof source === "string" ? source : Buffer.from(source).toString("utf8");
  const count = text.split(CURSOR_SDK_SUMMARY_FILTER_SIGNATURE).length - 1;
  if (count !== 1) {
    throw summaryHookContractError(`summary suppression signature matched ${count} times, expected exactly once`);
  }
  const marker = JSON.stringify({
    version: CURSOR_SDK_SUMMARY_HOOK_VERSION,
    url: contract.expectedUrl
  });
  return `${text.replace(CURSOR_SDK_SUMMARY_FILTER_SIGNATURE, "false")}\n;globalThis[Symbol.for(${JSON.stringify(CURSOR_SDK_SUMMARY_HOOK_MARKER)})]=Object.freeze(${marker});\n`;
}

export function createCursorSdkSummaryHooks(contract) {
  assertLoaderContract(contract);
  return {
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== contract.entryUrl) return loaded;
      if (loaded.format !== "module" || loaded.source === null || loaded.source === undefined) {
        throw summaryHookContractError(`@cursor/sdk ESM loader returned unsupported format ${String(loaded.format)}`);
      }
      return {
        ...loaded,
        source: transformCursorSdkSource(loaded.source, {
          url,
          expectedUrl: contract.entryUrl,
          packageVersion: contract.packageVersion
        })
      };
    }
  };
}

function assertLoaderContract(contract) {
  if (
    !contract
    || typeof contract !== "object"
    || typeof contract.entryUrl !== "string"
    || typeof contract.packageVersion !== "string"
  ) {
    throw summaryHookContractError("loader contract is incomplete");
  }
}

function summaryHookContractError(message, cause) {
  const error = new Error(`Cursor SDK summary hook contract mismatch: ${message}`, { cause });
  error.code = "cursor_sdk_summary_hook_contract_mismatch";
  return error;
}
