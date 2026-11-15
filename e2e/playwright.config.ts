import { defaultRepo } from "@agent-proxy/sandbox"
import { defineConfig, devices } from "@playwright/test"

const isCI = process.env["CI"] !== undefined
const port = 4173

export default defineConfig({
  testDir: "./web",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun --bun vite preview --port ${port} --strictPort`,
    cwd: defaultRepo.webDir,
    url: `http://localhost:${port}`,
    // Always serve this checkout's build: a server already on the port could be
    // another worktree's, and a pass against it would be cached as this one's.
    reuseExistingServer: false,
  },
})
