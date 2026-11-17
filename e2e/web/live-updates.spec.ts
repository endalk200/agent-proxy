import { expect, test } from "@playwright/test"

import { type SandboxDaemon, startSandboxDaemon } from "../support/sandbox-daemon.ts"

// Live updates in the dashboard the built daemon serves, in a sandbox: a
// change made from the CLI shows on the open page without reloading, and the
// page follows the daemon through a restart.

let daemon: SandboxDaemon

test.beforeEach(async () => {
  daemon = await startSandboxDaemon()
  await daemon.seed({
    id: "aa01",
    label: "Work",
    email: "me@work.example",
    plan: "Max 20x",
    priority: 1,
  })
  await daemon.seed({
    id: "aa02",
    label: "Home",
    email: "me@home.example",
    plan: "Max 5x",
    priority: 2,
  })
})

test.afterEach(async () => {
  await daemon.dispose()
})

test("an account disabled from the CLI shows on the open page within a second", async ({
  page,
}) => {
  await page.goto(daemon.address)
  const claude = page.getByRole("region", { name: "Claude" })
  await expect(claude.getByText("New sessions go to Work")).toBeVisible()

  await daemon.agentProxy(["accounts", "disable", "Work"])

  const notices = page.getByRole("region", { name: "Notifications" })
  await expect(notices.getByRole("dialog", { name: "Work was turned off" })).toBeVisible({
    timeout: 1000,
  })
  await expect(page.getByRole("switch", { name: "Work enabled" })).not.toBeChecked({
    timeout: 1000,
  })
  await expect(claude.getByText("New sessions go to Home")).toBeVisible({ timeout: 1000 })
  await expect(claude.getByRole("row").filter({ hasText: "me@work.example" })).toHaveAttribute(
    "data-flash",
    "disabled",
  )
})

test("follows the daemon through a restart", async ({ page }) => {
  await daemon.keepPort()
  await page.goto(daemon.address)
  const claude = page.getByRole("region", { name: "Claude" })
  await expect(claude.getByText("New sessions go to Work")).toBeVisible()

  await daemon.agentProxy(["daemon", "stop"])
  await expect(page.getByRole("status")).toContainText("Can't reach the daemon")

  // While it was down, the CLI could change nothing: the restarted daemon
  // starts from the accounts as they were, and the page reconnects to it.
  await daemon.agentProxy(["daemon", "start"])
  await expect(page.getByRole("status")).toHaveCount(0)

  await daemon.agentProxy(["accounts", "disable", "Work"])
  await expect(claude.getByText("New sessions go to Home")).toBeVisible({ timeout: 1000 })
})
