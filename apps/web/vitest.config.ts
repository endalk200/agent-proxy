import { defineConfig, mergeConfig } from "vitest/config"

import viteConfig from "./vite.config.ts"

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: "unit",
      environment: "happy-dom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
)
