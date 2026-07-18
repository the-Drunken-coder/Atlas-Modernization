import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two test projects: pure logic runs under Node, React component/DOM tests run
// under jsdom with the React plugin so JSX and hooks behave like the browser.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"]
        }
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./test/setup.ts"]
        }
      }
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.{ts,tsx}"],
      thresholds: {
        statements: 88.88,
        branches: 81.63,
        "src/ui/map/use-map-reticle-interaction.ts": { branches: 86.25 },
        "src/ui/map/use-map-reticle-effects.ts": { branches: 86.25 },
        "src/ui/map/use-map-reticle-pointer.ts": { branches: 86.25 }
      }
    }
  }
});
