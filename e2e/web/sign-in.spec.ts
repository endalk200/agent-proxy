import { expect, type Locator, type Page, test } from "@playwright/test"
import { Schema } from "effect"

import { type FakeProviders, startFakeProviders } from "../support/fake-providers.ts"
import { type SandboxDaemon, startSandboxDaemon } from "../support/sandbox-daemon.ts"

// Adding accounts and signing in again from the dashboard the built daemon
// serves, in a sandbox, signing in at fake Claude and OpenAI pages through the
// tab the dashboard opens. Each result is checked against what
// `agent-proxy accounts --json` reports.

let providers: FakeProviders
let daemon: SandboxDaemon

/** The Accounts page the daemon serves; the dashboard is at `/`. */
const accountsPage = () => new URL("/accounts", daemon.address).href

test.beforeEach(async () => {
  providers = await startFakeProviders()
  daemon = await startSandboxDaemon({
    env: { AGENT_PROXY_PROVIDER_ENDPOINTS: providers.endpoints },
  })
  await daemon.seed({
    id: "aa01",
    label: "Work",
    email: "me@work.example",
    plan: "Max 20x",
    priority: 1,
  })
})

test.afterEach(async () => {
  await daemon.dispose()
  await providers.close()
})

const Listed = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        label: Schema.String,
        email: Schema.String,
        priority: Schema.Int,
        status: Schema.String,
      }),
    ),
  }),
)

/** The accounts as the daemon holds them, as "claude 1 Work me@work.example active". */
const held = async () => {
  const { accounts } = Schema.decodeSync(Listed)(await daemon.agentProxy(["accounts", "--json"]))
  return accounts
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.priority - b.priority)
    .map((a) => `${a.provider} ${a.priority} ${a.label} ${a.email} ${a.status}`)
}

/** Picks `provider` in the add-account dialog; resolves to the sign-in tab it opens. */
const addAccount = async (page: Page, provider: "Claude" | "Codex") => {
  await page.getByRole("button", { name: "Add account" }).click()
  const tab = page.waitForEvent("popup")
  await page
    .getByRole("dialog", { name: "Add an account" })
    .getByRole("button", { name: provider })
    .click()
  return tab
}

const rowOf = (table: Locator, email: string) => table.getByRole("row").filter({ hasText: email })

test("adds a Claude account through the sign-in tab's redirect, with the label entered", async ({
  page,
}) => {
  await page.goto(accountsPage())
  const tab = await addAccount(page, "Claude")
  const dialog = page.getByRole("dialog", { name: "Sign in to Claude" })
  await expect(dialog.getByText("Waiting for you to sign in…")).toBeVisible()

  await tab.getByRole("link", { name: "Sign in as alice@example.com (Max 20x)" }).click()
  await expect(tab.getByRole("heading", { name: "Signed in to Claude" })).toBeVisible()

  const added = page.getByRole("dialog", { name: "Claude account added" })
  await expect(added).toContainText("alice@example.com")
  await expect(added).toContainText("Max 20x")
  await expect(added).toContainText("priority 2 of 2")
  await added.getByRole("textbox", { name: "Label" }).fill("Personal")
  await added.getByRole("button", { name: "Done" }).click()

  const table = page.getByRole("table", { name: "Claude accounts" })
  await expect(rowOf(table, "alice@example.com")).toContainText("Personal")
  await expect
    .poll(held)
    .toEqual(["claude 1 Work me@work.example active", "claude 2 Personal alice@example.com active"])
})

test("adds a Codex account with a pasted callback URL", async ({ page }) => {
  await page.goto(accountsPage())
  const tab = await addAccount(page, "Codex")
  // Signing in on another machine: this browser's tab is not used.
  await tab.close()
  const dialog = page.getByRole("dialog", { name: "Sign in to Codex" })
  await dialog.getByRole("button", { name: "Paste the callback URL instead" }).click()
  const authorizeUrl = await dialog
    .getByRole("link", { name: "Open sign-in page again" })
    .getAttribute("href")
  const callback = await providers.approve(authorizeUrl ?? "", "carol@example.com")

  await dialog.getByRole("textbox", { name: "Callback URL" }).fill("not a url")
  await dialog.getByRole("button", { name: "Continue" }).click()
  await expect(dialog.getByRole("alert")).toHaveText(
    "That is not a URL. Paste the whole address from the browser's address bar.",
  )
  await dialog.getByRole("textbox", { name: "Callback URL" }).fill(callback)
  await dialog.getByRole("button", { name: "Continue" }).click()

  const added = page.getByRole("dialog", { name: "Codex account added" })
  await expect(added).toContainText("It's the first account in the Codex pool")
  await added.getByRole("textbox", { name: "Label" }).fill("Codex Pro")
  await page.keyboard.press("Enter")

  await expect(page.getByRole("region", { name: "Codex" })).toContainText(
    "New sessions go to Codex Pro",
  )
  await expect
    .poll(held)
    .toEqual(["claude 1 Work me@work.example active", "codex 1 Codex Pro carol@example.com active"])
})

test("signs an account in again, which is Active again in place with no duplicate", async ({
  page,
}) => {
  await daemon.seed({
    id: "aa02",
    label: "Home",
    email: "bob@example.com",
    plan: "Pro",
    priority: 2,
    providerAccountId: "acct-bob:org-bob",
    needsSignIn: true,
  })
  await page.goto(accountsPage())
  const table = page.getByRole("table", { name: "Claude accounts" })
  await expect(rowOf(table, "bob@example.com")).toContainText("Needs sign-in")

  const opening = page.waitForEvent("popup")
  await table.getByRole("button", { name: "Sign in again to Home" }).click()
  const tab = await opening
  await expect(page.getByRole("dialog", { name: "Sign in again to Home" })).toContainText(
    "Sign in as bob@example.com",
  )
  await tab.getByRole("link", { name: "Sign in as bob@example.com (Pro)" }).click()

  const done = page.getByRole("dialog", { name: "Home is signed in again" })
  await expect(done).toContainText("It's back in the Claude pool at priority 2.")
  await done.getByRole("button", { name: "Done" }).click()
  await expect(rowOf(table, "bob@example.com")).toContainText("Active")
  await expect(table.getByRole("row")).toHaveCount(3)
  expect(await held()).toEqual([
    "claude 1 Work me@work.example active",
    "claude 2 Home bob@example.com active",
  ])
})

test("cancelling the dialog cancels the login, so its redirect no longer reaches the daemon", async ({
  page,
}) => {
  await page.goto(accountsPage())
  const tab = await addAccount(page, "Claude")
  const dialog = page.getByRole("dialog", { name: "Sign in to Claude" })
  await expect(dialog.getByText("Waiting for you to sign in…")).toBeVisible()

  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  // The daemon stopped listening for the redirect, so approving now goes nowhere.
  const callback = new URL(await providers.approve(tab.url(), "alice@example.com"))
  await expect
    .poll(() =>
      fetch(callback).then(
        () => "answered",
        () => "refused",
      ),
    )
    .toBe("refused")
  expect(await held()).toEqual(["claude 1 Work me@work.example active"])
})

/** Waits for `locator` to settle inside a 390px-wide screen. */
const insidePhone = async (locator: Locator) => {
  await expect
    .poll(async () => {
      const box = await locator.boundingBox()
      return box !== null && box.x >= 0 && box.x + box.width <= 390
    })
    .toBe(true)
}

test("the sign-in dialog fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(accountsPage())
  await page.getByRole("button", { name: "Add account" }).click()
  const pick = page.getByRole("dialog", { name: "Add an account" })
  await insidePhone(pick)
  await insidePhone(pick.getByRole("button", { name: "Codex" }))

  const opening = page.waitForEvent("popup")
  await pick.getByRole("button", { name: "Claude" }).click()
  await (await opening).close()
  const dialog = page.getByRole("dialog", { name: "Sign in to Claude" })
  await dialog.getByRole("button", { name: "Paste the callback URL instead" }).click()
  await insidePhone(dialog)
  await Promise.all(
    ["Copy sign-in URL", "Continue", "Cancel", "Choose another provider"].map((name) =>
      insidePhone(dialog.getByRole("button", { name })),
    ),
  )
  await insidePhone(dialog.getByRole("textbox", { name: "Callback URL" }))
})
