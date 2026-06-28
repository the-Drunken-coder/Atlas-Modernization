import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { loadConfig } from "./src/server/config.js";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const VITE_PORT = 5174;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, packageRoot, "ATLAS_SIM_");
  const simulationPort = loadConfig({ env, packageRoot }).port;
  if (simulationPort === VITE_PORT) {
    throw new Error("ATLAS_SIM_PORT must differ from the Vite dev server port 5174");
  }
  return {
    plugins: [react()],
    build: {
      outDir: "dist/client",
      emptyOutDir: true
    },
    server: {
      port: VITE_PORT,
      strictPort: true,
      proxy: {
        "/api": { target: `http://127.0.0.1:${simulationPort}` }
      }
    }
  };
});
