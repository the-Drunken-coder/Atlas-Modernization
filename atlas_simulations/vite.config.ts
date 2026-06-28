import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, packageRoot, "");
  const simulationPort = env.ATLAS_SIM_PORT || "5180";
  return {
    plugins: [react()],
    build: {
      outDir: "dist/client",
      emptyOutDir: true
    },
    server: {
      port: 5174,
      proxy: {
        "/api": { target: `http://127.0.0.1:${simulationPort}` }
      }
    }
  };
});
