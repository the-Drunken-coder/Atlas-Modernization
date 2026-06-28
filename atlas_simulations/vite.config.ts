import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, packageRoot, "");
  const simulationPort = portValue(env.ATLAS_SIM_PORT);
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

function portValue(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) return 5180;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("ATLAS_SIM_PORT must be a valid TCP port");
  }
  return parsed;
}
