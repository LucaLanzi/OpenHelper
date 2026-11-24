import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the dashboard talks to a local engine on :8740.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8740", changeOrigin: false } } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 800 },
});
