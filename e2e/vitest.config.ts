import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "e2e:cli",
    include: ["cli/**/*.test.ts"],
    // Each test spawns the real binary; keep the default per-test timeout generous.
    testTimeout: 30_000,
  },
})
