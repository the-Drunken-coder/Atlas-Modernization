import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { renderSecurityHeaders } from "./src/app/security-headers.js";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: "atlas-security-headers",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "_headers", source: renderSecurityHeaders(loadEnv(mode, process.cwd(), "")) });
      }
    }
  ],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
}));
