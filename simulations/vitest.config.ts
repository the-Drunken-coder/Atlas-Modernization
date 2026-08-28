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
      // Bootstrap entry point: `createRoot(...).render(...)` with no branching
      // logic worth asserting, and it cannot run outside a real document.
      exclude: ["src/client/main.tsx"],
      thresholds: {
        perFile: true,
        statements: 50,
        "src/client/App.tsx": { branches: 74.01 },
        "src/client/use-run-session.ts": { branches: 74.01 }
      }
    }
  }
});
