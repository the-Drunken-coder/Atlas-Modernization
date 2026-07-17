import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.{ts,tsx}"],
      thresholds: {
        statements: 85.35,
        branches: 77.73,
        "src/client/App.tsx": { branches: 74.01 }
      }
    }
  }
});
