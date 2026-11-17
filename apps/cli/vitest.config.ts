import { defineConfig } from "vitest/config"

// Times are shown in the owner's time zone. Tests pin one that is not UTC, so
// a time shown in UTC by mistake fails them.
process.env.TZ = "Asia/Tokyo"

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
        },
      },
    ],
  },
})
