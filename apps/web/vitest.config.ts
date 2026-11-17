import { defineConfig, mergeConfig } from "vitest/config"

import viteConfig from "./vite.config.ts"

// Times are shown in the owner's time zone. Tests pin one that is not UTC, so
// a time shown in UTC by mistake fails them.
process.env["TZ"] = "Asia/Tokyo"

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
