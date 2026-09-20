import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["core/**/*.test.ts", "sidecar/**/*.test.ts", "bridge/**/*.test.mjs", "tools/trace-viewer/web/src/**/*.test.ts"],
    testTimeout: 10000
  }
});
