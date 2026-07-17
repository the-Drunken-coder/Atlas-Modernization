import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.ts"],
      thresholds: {
        statements: 90.98,
        branches: 83.8,
        "src/sync-engine.ts": { branches: 86.42 }
      }
    }
  }
});
