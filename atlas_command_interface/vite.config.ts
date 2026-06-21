import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Worker (wrangler dev, default port 8787) owns /api and /atlas. During
// front-end development Vite serves the React app on 5173 and proxies those
// prefixes to the Worker so the browser keeps a single same-origin surface.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787" },
      "/atlas": { target: "http://localhost:8787", ws: true }
    }
  }
});
