import { expect, type Page, test } from "@playwright/test"

import { type SandboxDaemon, startSandboxDaemon } from "../support/sandbox-daemon.ts"

// The dashboard as the built daemon serves it, the usage dashboard at `/` and
// Accounts at `/accounts`, in a sandbox, with accounts seeded into the
// sandbox's data directory.

let daemon: SandboxDaemon

test.beforeEach(async () => {
  daemon = await startSandboxDaemon()
})

test.afterEach(async () => {
  await daemon.dispose()
})

/** Opens the page at `path`, as a reload or a link would. */
const open = async (page: Page, path = "/accounts") => {
  const response = await page.goto(new URL(path, daemon.address).href)
  expect(response?.status()).toBe(200)
  await expect(page).toHaveTitle("agent-proxy")
}

/** What the page's clipboard holds (the e2e suite type-checks without the DOM library). */
const clipboard = (page: Page) => page.evaluate<string>("navigator.clipboard.readText()")

const seedThree = async () => {
  await daemon.seed({
    id: "aa01",
    label: "Work",
    email: "me@work.example",
    plan: "Max 20x",
    priority: 1,
  })
  await daemon.seed({
    id: "aa02",
    label: "Personal Max",
    email: "me@home.example",
    plan: "Max 5x",
    priority: 2,
    needsSignIn: true,
  })
  await daemon.seed({
    id: "aa03",
    label: "Spare",
    email: "spare@example.com",
    plan: "Pro",
    priority: 3,
    enabled: false,
  })
}

test("shows each pool's accounts with plan, status, priority, limit windows and who gets new sessions", async ({
  page,
}) => {
  await seedThree()
  await open(page)

  const claude = page.getByRole("region", { name: "Claude" })
  await expect(claude.getByText("New sessions go to Work")).toBeVisible()
  const rows = claude.getByRole("table", { name: "Claude accounts" }).getByRole("row")
  await expect(rows).toHaveText([
    /#\s*Account\s*Status\s*5-hour\s*Weekly\s*Enabled/,
    /^1\s*Work\s*Max 20x\s*New sessions\s*me@work\.example\s*Active\s*Never used/,
    /^2\s*Personal Max\s*Max 5x\s*me@home\.example\s*Needs sign-in\s*Sign in again/,
    /^3\s*Spare\s*Pro\s*spare@example\.com\s*Disabled\s*Never used/,
  ])
  await expect(page.getByRole("switch", { name: "Work enabled" })).toBeChecked()
  await expect(page.getByRole("switch", { name: "Spare enabled" })).not.toBeChecked()

  const nav = page.getByRole("navigation", { name: "Dashboard" })
  await expect(nav.getByRole("link", { name: "Accounts 1 needs sign-in" })).toBeVisible()
  await expect(nav.getByRole("listitem", { name: "Claude: new sessions go to Work" })).toBeVisible()
})

test("walks through the first run when the daemon holds no accounts", async ({ page }) => {
  await open(page, "/")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get started")
  const steps = page.getByRole("list", { name: "Get started" })
  await expect(steps.getByRole("heading", { name: "Add an account" })).toBeVisible()
  await expect(steps.getByRole("button", { name: "Add a Claude account" })).toBeVisible()
  await expect(steps.getByRole("button", { name: "Add a Codex account" })).toBeVisible()
  await expect(page.getByRole("table")).toHaveCount(0)
})

test("opens on the usage dashboard at /, with the range in the address", async ({ page }) => {
  await seedThree()
  await open(page, "/?range=30d")

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard")
  const nav = page.getByRole("navigation", { name: "Dashboard" })
  await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page")
  const range = page.getByRole("group", { name: "Range" })
  await expect(range.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true")
  // Nothing went through the proxy in a fresh sandbox.
  await expect(page.getByRole("region", { name: "Requests" })).toContainText("0")
  await expect(page.getByRole("region", { name: "Token trend" })).toContainText(
    "No priced usage in the last 30 days.",
  )
  await expect(
    page.getByRole("region", { name: "Limit windows" }).getByRole("table", {
      name: "Claude limit windows",
    }),
  ).toBeVisible()

  await range.getByRole("button", { name: "Lifetime" }).click()
  await expect(page).toHaveURL(/\/\?range=lifetime$/)
})

test("moves to Accounts from the sidebar, and a reload there stays on Accounts", async ({
  page,
}) => {
  await seedThree()
  await open(page, "/")
  await page
    .getByRole("navigation", { name: "Dashboard" })
    .getByRole("link", { name: /^Accounts/ })
    .click()
  await expect(page).toHaveURL(/\/accounts$/)
  await expect(page.getByRole("table", { name: "Claude accounts" })).toBeVisible()

  await page.reload()
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Accounts")
  await expect(page.getByRole("table", { name: "Claude accounts" })).toBeVisible()
})

test("Connect clients shows the three commands and the proxy key, masked until revealed, and copies them", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  const key = (await daemon.agentProxy(["key"])).trim()
  await seedThree()
  await open(page)

  await page.getByRole("button", { name: "Connect clients" }).click()
  const dialog = page.getByRole("dialog", { name: "Connect clients" })
  await expect(dialog.getByText(/^agent-proxy connect /)).toHaveText([
    "agent-proxy connect claude-code",
    "agent-proxy connect codex",
    "agent-proxy connect opencode",
  ])

  const shown = dialog.getByLabel("Proxy key", { exact: true })
  await expect(shown).toHaveText(`${key.slice(0, 6)}${"•".repeat(16)}${key.slice(-4)}`)
  await dialog.getByRole("button", { name: "Reveal" }).click()
  await expect(shown).toHaveText(key)

  await dialog.getByRole("button", { name: "Copy proxy key" }).click()
  await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible()
  expect(await clipboard(page)).toBe(key)

  await dialog.getByRole("button", { name: "Copy agent-proxy connect opencode" }).click()
  await expect.poll(() => clipboard(page)).toBe("agent-proxy connect opencode")
})

test("says the daemon is unreachable once it stops, and keeps showing what it last reported", async ({
  page,
}) => {
  await seedThree()
  await open(page)
  await expect(page.getByRole("table", { name: "Claude accounts" })).toBeVisible()

  await daemon.agentProxy(["daemon", "stop"])
  await expect(page.getByRole("status")).toContainText("Can't reach the daemon at", {
    timeout: 10_000,
  })
  await expect(page.getByRole("status")).toContainText("This is what it last reported")
  await expect(page.getByRole("table", { name: "Claude accounts" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Actions for Work" })).toBeDisabled()
})

test("Connect clients fits a phone screen, every copy button inside the dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await seedThree()
  await open(page)

  await page.getByRole("button", { name: "Connect clients" }).click()
  const dialog = page.getByRole("dialog", { name: "Connect clients" })
  const frame = await dialog.boundingBox()
  expect(frame).not.toBeNull()
  const copies = dialog.getByRole("button", { name: /^Copy / })
  await expect(copies).toHaveCount(4)
  const boxes = await Promise.all((await copies.all()).map((copy) => copy.boundingBox()))
  for (const box of boxes) {
    expect(box).not.toBeNull()
    if (box === null || frame === null) continue
    expect(box.x).toBeGreaterThanOrEqual(frame.x)
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width)
  }
})
