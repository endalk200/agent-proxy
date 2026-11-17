import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { account, callbackUrl, type FakeDaemon, fakeDaemon } from "./test/fake-daemon.ts"
import { rowsOf, textOf } from "./test/queries.ts"

// Adding an account and signing in again from the dashboard, against a fake
// daemon API whose logins wait until the test plays the provider's redirect
// or the dashboard posts a pasted callback URL.

/** The URLs the dashboard opened in new tabs. */
let opened: Array<string> = []

/** Stands in for the browser's new tabs: each records its URL, or, while `blocked`, is refused. */
const tabs = (blocked = false) => {
  opened = []
  vi.spyOn(window, "open").mockImplementation((url) => {
    if (blocked) return null
    opened.push(String(url))
    // A new tab of its own, whose `opener` the dashboard may clear.
    const tab: Window = Object.create(window)
    Object.defineProperty(tab, "opener", { value: window, writable: true })
    return tab
  })
}

beforeEach(() => tabs())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Work (1, gets new sessions) and Home (2), both Claude. */
const twoAccounts = () =>
  fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", priority: 1 }),
      account({ id: "a2", label: "Home", priority: 2 }),
    ],
    pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
  })

const show = (daemon: FakeDaemon) => {
  // Logins are polled quickly so tests stay fast.
  render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} loginPollInterval={20} />)
}

const stored = (daemon: FakeDaemon) =>
  daemon.accounts
    .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.priority - b.priority)
    .map((a) => `${a.provider} ${a.priority} ${a.label} ${a.status}`)

const labels = (table: HTMLElement) => rowsOf(table).map((row) => row["Account"])

/** Work (1, Active) and Home (2, Needs sign-in), both Claude. */
const homeSignedOut = () =>
  fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", priority: 1 }),
      account({
        id: "a2",
        label: "Home",
        priority: 2,
        providerAccountId: "acct-home",
        status: "needs-sign-in",
      }),
    ],
    pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
  })

const statuses = (table: HTMLElement) =>
  rowsOf(table).map((row) => `${row["Account"]}: ${row["Status"]}`)

const waitingFor = async (daemon: FakeDaemon, provider: "Claude" | "Codex") => {
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }))
  const pick = await screen.findByRole("dialog", { name: "Add an account" })
  fireEvent.click(within(pick).getByRole("button", { name: provider }))
  const dialog = await screen.findByRole("dialog", { name: `Sign in to ${provider}` })
  await within(dialog).findByText("Waiting for you to sign in…")
  expect(daemon.logins.at(-1)?.status).toBe("pending")
  return dialog
}

const startClaude = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }))
  const pick = await screen.findByRole("dialog", { name: "Add an account" })
  fireEvent.click(within(pick).getByRole("button", { name: "Claude" }))
  return screen.findByRole("dialog", { name: "Sign in to Claude" })
}

describe("add an account", () => {
  it("adds a Claude account through the provider's redirect, at the bottom of its pool, with the label entered", async () => {
    const daemon = twoAccounts()
    daemon.signInAs = { providerAccountId: "acct-lab", email: "lab@example.com", plan: "Pro" }
    show(daemon)
    const table = await screen.findByRole("table", { name: "Claude accounts" })

    fireEvent.click(screen.getByRole("button", { name: "Add account" }))
    const pick = await screen.findByRole("dialog", { name: "Add an account" })
    fireEvent.click(within(pick).getByRole("button", { name: "Claude" }))

    const waiting = await screen.findByRole("dialog", { name: "Sign in to Claude" })
    await within(waiting).findByText("Waiting for you to sign in…")
    expect(opened).toEqual([daemon.logins[0]?.authorizeUrl])

    daemon.redirect()
    const added = await screen.findByRole("dialog", { name: "Claude account added" })
    expect(textOf(added)).toContain("lab@example.com")
    expect(textOf(added)).toContain("Pro")
    expect(textOf(added)).toContain("priority 3 of 3")
    const label = within(added).getByRole("textbox", { name: "Label" })
    expect(label).toHaveProperty("value", "lab")
    fireEvent.change(label, { target: { value: "  Lab  " } })
    fireEvent.click(within(added).getByRole("button", { name: "Done" }))

    await waitFor(() =>
      expect(labels(table)).toEqual([
        "Work New sessions work@example.com",
        "Home home@example.com",
        "Lab lab@example.com",
      ]),
    )
    expect(stored(daemon)).toEqual([
      "claude 1 Work active",
      "claude 2 Home active",
      "claude 3 Lab active",
    ])
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("adds a Codex account from the first-run guide with a pasted callback URL, after refusing a wrong one", async () => {
    const daemon = fakeDaemon()
    daemon.signInAs = { providerAccountId: "acct-carol", email: "carol@example.com", plan: "Pro" }
    show(daemon)
    const steps = await screen.findByRole("list", { name: "Get started" })

    fireEvent.click(within(steps).getByRole("button", { name: "Add a Codex account" }))
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Codex" })
    await within(dialog).findByText("Waiting for you to sign in…")
    const login = daemon.logins[0]
    if (login === undefined) throw new Error("No login started.")

    fireEvent.click(within(dialog).getByRole("button", { name: "Paste the callback URL instead" }))
    within(dialog).getByText(login.authorizeUrl)
    within(dialog).getByRole("button", { name: "Copy sign-in URL" })
    within(dialog).getByText("http://127.0.0.1:1455/auth/callback")
    const field = within(dialog).getByRole("textbox", { name: "Callback URL" })

    fireEvent.change(field, {
      target: { value: "http://127.0.0.1:1455/auth/callback?code=x&state=another" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }))
    const refusal = await within(dialog).findByRole("alert")
    expect(refusal.textContent).toBe(
      "That URL belongs to another Codex sign-in, not the one in progress.",
    )
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(daemon.logins[0]?.status).toBe("pending")

    fireEvent.change(field, { target: { value: callbackUrl(login) } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }))
    const added = await screen.findByRole("dialog", { name: "Codex account added" })
    expect(textOf(added)).toContain(
      "It's the first account in the Codex pool, so it gets new sessions right away.",
    )
    const label = within(added).getByRole("textbox", { name: "Label" })
    expect(label).toHaveProperty("value", "carol")
    fireEvent.change(label, { target: { value: "Work" } })
    fireEvent.submit(label)

    const table = await screen.findByRole("table", { name: "Codex accounts" })
    await waitFor(() => expect(labels(table)).toEqual(["Work New sessions carol@example.com"]))
    expect(stored(daemon)).toEqual(["codex 1 Work active"])
    expect(opened).toEqual([login.authorizeUrl])
  })
})

describe("adding an account the daemon already holds", () => {
  it("updates it in place, and a disabled one stays disabled", async () => {
    const daemon = fakeDaemon({
      accounts: [
        account({ id: "a1", label: "Work", priority: 1 }),
        account({
          id: "a2",
          label: "Spare",
          priority: 2,
          providerAccountId: "acct-spare",
          enabled: false,
          status: "disabled",
        }),
      ],
      pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
    })
    daemon.signInAs = { providerAccountId: "acct-spare", email: "spare@example.com", plan: "Pro" }
    show(daemon)
    await startClaude()
    daemon.redirect()

    const done = await screen.findByRole("dialog", { name: "Spare is signed in again" })
    expect(textOf(done)).toContain(
      "Its credentials are fresh. It stays disabled, at priority 2, until you enable it.",
    )
    expect(textOf(done)).toContain("Signed in · Disabled")
    expect(within(done).queryByRole("textbox")).toBeNull()
    fireEvent.click(within(done).getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(stored(daemon)).toEqual(["claude 1 Work active", "claude 2 Spare disabled"])
  })
})

describe("sign in again", () => {
  it("signs in again from the account sheet, and the account is Active again in place, with no duplicate", async () => {
    const daemon = homeSignedOut()
    daemon.signInAs = { providerAccountId: "acct-home", email: "home@example.com", plan: "Pro" }
    show(daemon)
    const table = await screen.findByRole("table", { name: "Claude accounts" })

    fireEvent.click(within(table).getByRole("button", { name: "Home" }))
    const sheet = await screen.findByRole("dialog", { name: "Home" })
    const status = within(sheet).getByRole("region", { name: "Status" })
    expect(textOf(status)).not.toContain("agent-proxy accounts add")
    fireEvent.click(within(status).getByRole("button", { name: "Sign in again" }))

    const dialog = await screen.findByRole("dialog", { name: "Sign in again to Home" })
    expect(textOf(dialog)).toContain(
      "Sign in as home@example.com to put it back in the Claude pool.",
    )
    await within(dialog).findByText("Waiting for you to sign in…")
    expect(daemon.logins.map((login) => login.provider)).toEqual(["claude"])
    expect(opened).toEqual([daemon.logins[0]?.authorizeUrl])

    daemon.redirect()
    const done = await screen.findByRole("dialog", { name: "Home is signed in again" })
    expect(textOf(done)).toContain("It's back in the Claude pool at priority 2.")
    expect(within(done).queryByRole("textbox")).toBeNull()
    fireEvent.click(within(done).getByRole("button", { name: "Done" }))

    await waitFor(() => expect(textOf(status)).toContain("Active"))
    expect(statuses(table)).toEqual([
      "Work New sessions work@example.com: Active",
      "Home home@example.com: Active",
    ])
    expect(stored(daemon)).toEqual(["claude 1 Work active", "claude 2 Home active"])
    expect(daemon.changes).toEqual([])
  })

  it("signs a Codex account in again from its row in the table", async () => {
    const daemon = fakeDaemon({
      accounts: [
        account({
          id: "c1",
          label: "Plus",
          provider: "codex",
          providerAccountId: "acct-plus",
          status: "needs-sign-in",
        }),
      ],
      pools: [{ provider: "codex", newSessionsAccountId: null }],
    })
    daemon.signInAs = { providerAccountId: "acct-plus", email: "plus@example.com", plan: "Plus" }
    show(daemon)
    const table = await screen.findByRole("table", { name: "Codex accounts" })
    expect(statuses(table)).toEqual(["Plus plus@example.com: Needs sign-in Sign in again"])

    fireEvent.click(within(table).getByRole("button", { name: "Sign in again to Plus" }))
    const dialog = await screen.findByRole("dialog", { name: "Sign in again to Plus" })
    await within(dialog).findByText("Waiting for you to sign in…")
    expect(daemon.logins.map((login) => login.provider)).toEqual(["codex"])

    daemon.redirect()
    const done = await screen.findByRole("dialog", { name: "Plus is signed in again" })
    fireEvent.click(within(done).getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(statuses(table)).toEqual(["Plus New sessions plus@example.com: Active"]),
    )
    expect(screen.queryByRole("dialog", { name: "Plus" })).toBeNull()
  })

  it("says so when another account signs in instead, which joins the pool as a new account", async () => {
    const daemon = homeSignedOut()
    daemon.signInAs = { providerAccountId: "acct-lab", email: "lab@example.com", plan: "Pro" }
    show(daemon)
    const table = await screen.findByRole("table", { name: "Claude accounts" })

    fireEvent.click(within(table).getByRole("button", { name: "Sign in again to Home" }))
    const dialog = await screen.findByRole("dialog", { name: "Sign in again to Home" })
    await within(dialog).findByText("Waiting for you to sign in…")
    daemon.redirect()

    const added = await screen.findByRole("dialog", { name: "Claude account added" })
    expect(added.textContent).toContain(
      "You signed in as lab@example.com, not home@example.com, so it was added as a new account. Home still needs sign-in.",
    )
    fireEvent.click(within(added).getByRole("button", { name: "Done" }))
    await waitFor(() => expect(rowsOf(table)).toHaveLength(3))
    expect(stored(daemon)).toEqual([
      "claude 1 Work active",
      "claude 2 Home needs-sign-in",
      "claude 3 lab active",
    ])
  })
})

describe("review fixes", () => {
  it("never opens or links a sign-in page that is not http or https", async () => {
    const daemon = twoAccounts()
    daemon.authorizeUrlOverride = "javascript:alert(document.domain)"
    show(daemon)
    const dialog = await startClaude()
    await within(dialog).findByText(/did not give a web address/)
    expect(opened).toEqual([])
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
  })

  it("keeps asking after a login poll stalls, and finishes the sign-in", async () => {
    const daemon = twoAccounts()
    daemon.signInAs = { providerAccountId: "acct-new", email: "new@example.com", plan: "Pro" }
    daemon.stallLoginPolls = 1
    render(
      <App
        fetch={daemon.fetch}
        openEvents={daemon.openEvents}
        loginPollInterval={20}
        requestTimeout={50}
      />,
    )
    await waitingFor(daemon, "Claude")
    daemon.redirect()
    const added = await screen.findByRole("dialog", { name: "Claude account added" })
    expect(textOf(added)).toContain("new@example.com")
  })

  it("moves focus to Done and announces it when an account is signed in again", async () => {
    const daemon = homeSignedOut()
    daemon.signInAs = { providerAccountId: "acct-home", email: "home@example.com", plan: "Pro" }
    show(daemon)
    const table = await screen.findByRole("table", { name: "Claude accounts" })
    fireEvent.click(within(table).getByRole("button", { name: "Sign in again to Home" }))
    const dialog = await screen.findByRole("dialog", { name: "Sign in again to Home" })
    await within(dialog).findByText("Waiting for you to sign in…")
    daemon.redirect()

    const done = await screen.findByRole("dialog", { name: "Home is signed in again" })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(done).getByRole("button", { name: "Done" })),
    )
    expect(within(done).getByRole("status").textContent).toContain("Home is signed in again")
  })

  it("says so when another account already held signs in instead", async () => {
    const daemon = homeSignedOut()
    daemon.signInAs = {
      providerAccountId: "account-a1:org-a1",
      email: "work@example.com",
      plan: "Pro",
    }
    show(daemon)
    const table = await screen.findByRole("table", { name: "Claude accounts" })
    fireEvent.click(within(table).getByRole("button", { name: "Sign in again to Home" }))
    const dialog = await screen.findByRole("dialog", { name: "Sign in again to Home" })
    await within(dialog).findByText("Waiting for you to sign in…")
    daemon.redirect()

    const done = await screen.findByRole("dialog", { name: "Work is signed in again" })
    expect(done.textContent).toContain(
      "You signed in as work@example.com, not home@example.com, so Work was signed in again instead. Home still needs sign-in.",
    )
  })
})

describe("cancelling", () => {
  it("cancels the login in the daemon when Cancel is pressed while it waits", async () => {
    const daemon = twoAccounts()
    show(daemon)
    const dialog = await waitingFor(daemon, "Claude")

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(daemon.logins.map((login) => login.status)).toEqual(["cancelled"]))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(stored(daemon)).toEqual(["claude 1 Work active", "claude 2 Home active"])
  })

  it("cancels the login in the daemon when the dialog is closed with Escape", async () => {
    const daemon = twoAccounts()
    show(daemon)
    const dialog = await waitingFor(daemon, "Codex")

    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(daemon.logins.map((login) => login.status)).toEqual(["cancelled"]))
  })

  it("cancels the login when the owner goes back to choose another provider", async () => {
    const daemon = twoAccounts()
    show(daemon)
    const dialog = await waitingFor(daemon, "Claude")

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose another provider" }))
    const pick = await screen.findByRole("dialog", { name: "Add an account" })
    await waitFor(() => expect(daemon.logins.map((login) => login.status)).toEqual(["cancelled"]))
    fireEvent.click(within(pick).getByRole("button", { name: "Codex" }))
    await screen.findByRole("dialog", { name: "Sign in to Codex" })
    expect(daemon.logins.map((login) => `${login.provider} ${login.status}`)).toEqual([
      "claude cancelled",
      "codex pending",
    ])
  })
})

describe("when a sign-in goes wrong", () => {
  it("shows the daemon's reason when the login cannot start, opens no tab, and tries again", async () => {
    const daemon = twoAccounts()
    daemon.loginRefusal =
      "Could not listen on 127.0.0.1:54545 for the Claude sign-in redirect: port in use"
    show(daemon)
    const dialog = await startClaude()

    const problem = await within(dialog).findByRole("alert")
    expect(textOf(problem)).toBe(
      "Couldn't start the sign-in Could not listen on 127.0.0.1:54545 for the Claude sign-in redirect: port in use",
    )
    expect(opened).toEqual([])

    daemon.loginRefusal = undefined
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }))
    await within(dialog).findByText("Waiting for you to sign in…")
    expect(opened).toEqual([daemon.logins[0]?.authorizeUrl])
  })

  it.each([
    {
      status: "failed" as const,
      error: "Claude did not grant access: The user denied access",
      says: "The sign-in failed Claude did not grant access: The user denied access",
    },
    {
      status: "expired" as const,
      error: undefined,
      says: "The sign-in timed out Nobody finished signing in within 10 minutes, so the daemon stopped waiting.",
    },
    {
      status: "cancelled" as const,
      error: undefined,
      says: "The sign-in was cancelled Another Claude sign-in started, perhaps from the CLI, and took its place.",
    },
  ])("says why when the login ends $status, and starts a new one on Try again", async (ended) => {
    const daemon = twoAccounts()
    show(daemon)
    const dialog = await startClaude()
    await within(dialog).findByText("Waiting for you to sign in…")

    daemon.endLogin(ended.status, ended.error)
    const problem = await within(dialog).findByRole("alert")
    expect(textOf(problem)).toBe(ended.says)

    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }))
    await within(dialog).findByText("Waiting for you to sign in…")
    expect(daemon.logins.map((login) => login.status)).toEqual([ended.status, "pending"])
  })

  it("says so when the daemon no longer knows the login, as after a restart", async () => {
    const daemon = twoAccounts()
    show(daemon)
    const dialog = await startClaude()
    await within(dialog).findByText("Waiting for you to sign in…")

    daemon.logins.splice(0)
    const problem = await within(dialog).findByRole("alert")
    expect(textOf(problem)).toBe(
      "The sign-in was lost The daemon no longer knows it, perhaps because it restarted. Try again.",
    )
  })

  it("offers the sign-in page as a link when the browser blocks the new tab", async () => {
    tabs(true)
    const daemon = twoAccounts()
    show(daemon)
    const dialog = await startClaude()

    const blocked = await within(dialog).findByText("Your browser blocked the new tab.")
    expect(blocked).toBeDefined()
    const link = within(dialog).getByRole("link", { name: "Open sign-in page" })
    expect(link.getAttribute("href")).toBe(daemon.logins[0]?.authorizeUrl)
    expect(link.getAttribute("target")).toBe("_blank")

    daemon.redirect()
    await screen.findByRole("dialog", { name: "Claude account added" })
  })

  it("cancels a login that only finishes starting after the dialog closed, and opens no tab", async () => {
    const daemon = twoAccounts()
    const held = Promise.withResolvers<void>()
    const slowStart: typeof fetch = async (input, init) => {
      if (input === "/api/logins" && init?.method === "POST") await held.promise
      return daemon.fetch(input, init)
    }
    render(<App fetch={slowStart} openEvents={daemon.openEvents} loginPollInterval={20} />)
    const dialog = await startClaude()
    await within(dialog).findByText("Starting sign-in…")

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    held.resolve()
    await waitFor(() => expect(daemon.logins.map((login) => login.status)).toEqual(["cancelled"]))
    expect(opened).toEqual([])
  })
})
