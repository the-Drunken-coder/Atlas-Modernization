import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.ts"],
      thresholds: {
        perFile: true,
        statements: 50,
        "src/sync-engine.ts": { branches: 86.42 }
      }
    }
  }
});
