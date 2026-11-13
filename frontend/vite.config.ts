import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@bma/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/health": "http://localhost:4000",
      "/simulator": "http://localhost:4000",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
