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
      // Bootstrap entry point: `createRoot(...).render(...)` with no branching
      // logic worth asserting, and it cannot run outside a real document.
      exclude: ["src/app/main.tsx"],
      thresholds: {
        perFile: true,
        // Keep the general floor honest without hiding the two known,
        // explicitly pinned shortfalls from the coverage report.
        "!{src/app/routes.tsx,src/ui/map/rendering/map-editing.ts}": { statements: 50 },
        "src/app/routes.tsx": { statements: 40 },
        "src/ui/map/rendering/map-editing.ts": { statements: 12.72 },
        "src/ui/map/interaction/use-map-reticle-interaction.ts": { branches: 86.25 },
        "src/ui/map/interaction/use-map-reticle-effects.ts": { branches: 86.25 },
        "src/ui/map/interaction/use-map-reticle-pointer.ts": { branches: 86.25 }
      }
    }
  }
});
