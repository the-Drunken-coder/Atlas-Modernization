import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// During front-end development Vite serves the React app on 5173 and proxies
// only the minimal browser config endpoint to the local Worker on 8787.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787" }
    }
  }
});
