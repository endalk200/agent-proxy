import { expect, type Locator, type Page, test } from "@playwright/test"
import { Schema } from "effect"

import { type SandboxDaemon, startSandboxDaemon } from "../support/sandbox-daemon.ts"

// Managing accounts from the dashboard the built daemon serves, in a sandbox,
// each change checked against what `agent-proxy accounts --json` reports.

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
  await daemon.seed({
    id: "aa03",
    label: "Spare",
    email: "spare@example.com",
    plan: "Pro",
    priority: 3,
    enabled: false,
  })
})

test.afterEach(async () => {
  await daemon.dispose()
})

const Listed = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({ label: Schema.String, priority: Schema.Int, enabled: Schema.Boolean }),
    ),
  }),
)

/** The accounts as the daemon holds them, as "1 Work", "2 Home (off)", … */
const held = async () => {
  const { accounts } = Schema.decodeSync(Listed)(await daemon.agentProxy(["accounts", "--json"]))
  return accounts
    .toSorted((a, b) => a.priority - b.priority)
    .map((a) => `${a.priority} ${a.label}${a.enabled ? "" : " (off)"}`)
}

const rowOf = (table: Locator, email: string) => table.getByRole("row").filter({ hasText: email })

/** Drags `label`'s row by its priority handle and drops it on the row holding `email`. */
const drag = async (page: Page, table: Locator, label: string, email: string) => {
  await table.getByRole("button", { name: `Reorder ${label}` }).hover()
  await page.mouse.down()
  const target = await rowOf(table, email).boundingBox()
  if (target === null) throw new Error(`No row for ${email}`)
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
  await page.mouse.up()
}

test("reorders, toggles, renames and removes accounts, and the sheet follows", async ({ page }) => {
  await page.goto(daemon.address)
  const claude = page.getByRole("region", { name: "Claude" })
  const table = claude.getByRole("table", { name: "Claude accounts" })
  await expect(claude.getByText("New sessions go to Work")).toBeVisible()

  // Drag Home above Work: Home gets new sessions.
  await drag(page, table, "Home", "me@work.example")
  await expect(claude.getByText("New sessions go to Home")).toBeVisible()
  await expect.poll(held).toEqual(["1 Home", "2 Work", "3 Spare (off)"])

  // The keyboard moves Spare up one.
  await table.getByRole("button", { name: "Reorder Spare" }).focus()
  await page.keyboard.press("ArrowUp")
  await expect.poll(held).toEqual(["1 Home", "2 Spare (off)", "3 Work"])
  await expect(table.getByRole("button", { name: "Reorder Spare" })).toBeFocused()

  // Turning Home off sends new sessions to Work, which Spare (off) cannot take.
  await page.getByRole("switch", { name: "Home enabled" }).click()
  await expect(claude.getByText("New sessions go to Work")).toBeVisible()
  await expect.poll(held).toEqual(["1 Home (off)", "2 Spare (off)", "3 Work"])

  // Double-click renames.
  await table.getByRole("button", { name: "Work", exact: true }).dblclick()
  await table.getByRole("textbox", { name: "Label for Work" }).fill("Main")
  await page.keyboard.press("Enter")
  await expect(claude.getByText("New sessions go to Main")).toBeVisible()
  await expect.poll(held).toEqual(["1 Home (off)", "2 Spare (off)", "3 Main"])

  // A row opens the sheet; another row swaps it; Escape closes it and hands
  // focus back to the row.
  await rowOf(table, "spare@example.com").getByText("spare@example.com").click()
  const spare = page.getByRole("dialog", { name: "Spare" })
  await expect(spare.getByText("2 of 3 in the Claude pool")).toBeVisible()
  await rowOf(table, "me@work.example").getByText("me@work.example").click()
  const main = page.getByRole("dialog", { name: "Main" })
  await expect(main.getByRole("region", { name: "Status" })).toContainText(
    "Gets every new Claude session.",
  )
  await expect(page.getByRole("dialog")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(table.getByRole("button", { name: "Main", exact: true })).toBeFocused()

  // The sheet's own controls: enable Spare, then remove it after confirming.
  await table.getByRole("button", { name: "Spare", exact: true }).click()
  await spare.getByRole("switch", { name: "Enabled" }).click()
  await expect(spare.getByRole("region", { name: "Status" })).toContainText("Active")
  await expect(claude.getByText("New sessions go to Spare")).toBeVisible()
  await spare.getByRole("button", { name: "Remove…" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Remove Spare?" })
  await expect(confirm).toContainText("spare@example.com")
  await confirm.getByRole("button", { name: "Remove account" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(rowOf(table, "spare@example.com")).toHaveCount(0)
  await expect(claude.getByText("New sessions go to Main")).toBeVisible()
  await expect.poll(held).toEqual(["1 Home (off)", "2 Main"])
})

/** Waits for `locator` to settle (the sheet slides in) inside the screen's width. */
const insidePhone = async (locator: Locator) => {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox()
      return box !== null && box.x >= 0 && box.x + box.width <= 390
    })
    .toBe(true)
}

test("the account sheet and the remove confirmation fit a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(daemon.address)
  const table = page.getByRole("table", { name: "Claude accounts" })

  await table.getByRole("button", { name: "Home", exact: true }).click()
  const sheet = page.getByRole("dialog", { name: "Home" })
  await insidePhone(sheet)
  await Promise.all(
    ["Close details", "Rename", "Move up", "Move down", "Remove…"].map((name) =>
      insidePhone(sheet.getByRole("button", { name })),
    ),
  )
  await insidePhone(sheet.getByRole("switch", { name: "Enabled" }))

  await sheet.getByRole("button", { name: "Remove…" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Remove Home?" })
  await insidePhone(confirm)
  await insidePhone(confirm.getByRole("button", { name: "Cancel" }))
  await insidePhone(confirm.getByRole("button", { name: "Remove account" }))
})
