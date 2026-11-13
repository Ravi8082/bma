import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const sharedEntry = fileURLToPath(new URL("../shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@bma/shared": sharedEntry,
    },
  },
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    globalSetup: ["./src/test/globalSetup.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test/**", "src/server.ts"],
    },
  },
});
