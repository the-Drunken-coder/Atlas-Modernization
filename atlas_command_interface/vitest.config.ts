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
          include: ["src/**/*.test.ts", "worker/**/*.test.ts"]
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
    ]
  }
});
