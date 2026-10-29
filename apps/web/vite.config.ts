import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.REV_API ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Keep the browser's Host header so the server's same-origin check passes.
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/downloads": { target: api, changeOrigin: false },
    },
  },
  build: { chunkSizeWarningLimit: 1000 },
});
