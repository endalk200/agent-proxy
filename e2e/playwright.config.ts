import { defineConfig, devices } from "@playwright/test"

const isCI = process.env["CI"] !== undefined

// Each test starts the built daemon in its own sandbox and opens the
// dashboard it serves (see support/sandbox-daemon.ts), so there is no shared
// web server here.
export default defineConfig({
  testDir: "./web",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
