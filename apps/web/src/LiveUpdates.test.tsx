import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon } from "./test/fake-daemon.ts"
import { rowsOf, textOf } from "./test/queries.ts"

// Live updates: the daemon streams each change to an account, and the open
// dashboard shows it without reloading: the row flashes in its new status
// colour, a notice says what happened, and the sidebar follows. The fake
// daemon streams events the way `GET /api/events` does. The page's clock is
// pinned (timers still run) at 15:00 in Tokyo, the time zone tests run in.

const NOW = Date.parse("2026-11-17T06:00:00Z")

/** `minutes` after the pinned now, as the daemon reports a cooldown's end. */
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

beforeEach(() => {
  // These tests drive the Accounts page, which lives at `/accounts`.
  window.history.replaceState(null, "", "/accounts")
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Work (1, gets new sessions) and Home (2), both Claude and Active. */
const twoAccounts = () =>
  fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", priority: 1 }),
      account({ id: "a2", label: "Home", priority: 2 }),
    ],
    pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
  })

/** Shows the dashboard for `daemon`, once its accounts are on the page. */
const show = async (daemon: FakeDaemon) => {
  // The check comes round rarely, so whatever shows up came by the stream.
  render(
    <App
      fetch={daemon.fetch}
      openEvents={daemon.openEvents}
      checkInterval={60_000}
      reopenDelay={20}
      // A sign-in's status is polled quickly, so it never races a query's timeout.
      loginPollInterval={20}
    />,
  )
  return screen.findByRole("table", { name: "Claude accounts" })
}

const rowOf = (table: HTMLElement, label: string) => {
  const row = within(table).getByText(label).closest("tr")
  if (row === null) throw new Error(`No row for ${label}`)
  return row
}

const statusOf = (table: HTMLElement, label: string) =>
  rowsOf(table).find((row) => row["Account"]?.startsWith(label))?.["Status"]

/** The text of the notice titled `title`. */
const notice = async (title: string) => {
  const region = screen.getByRole("region", { name: "Notifications" })
  return textOf(await within(region).findByRole("dialog", { name: title }))
}

const notices = () =>
  within(screen.getByRole("region", { name: "Notifications" }))
    .queryAllByRole("dialog")
    .map(textOf)

/** Who gets the Claude pool's new sessions, as its header says, without the accounts after. */
const poolLine = () =>
  within(screen.getByRole("region", { name: "Claude" }))
    .getByText(/New sessions go to|No account/)
    .textContent?.replace(/ · then .*$/, "")

describe("a status the daemon changes", () => {
  it("shows a cooldown starting at once: the row flashes amber and a notice says until when", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    daemon.update("a1", { status: "cooling-down", cooldownEndsAt: inMinutes(47) })

    expect(await notice("Work is cooling down")).toBe(
      "Work is cooling down It hit its plan's limit. agent-proxy skips it until 3:47 PM.",
    )
    expect(statusOf(table, "Work")).toBe("Cooling down until 3:47 PM · in 47m")
    expect(rowOf(table, "Work").dataset["flash"]).toBe("cooling-down")
    expect(poolLine()).toBe("New sessions go to Home")
    screen.getByRole("listitem", { name: "Claude: new sessions go to Home" })
  })

  it("shows a cooldown ending: the account is back, and says so", async () => {
    const daemon = fakeDaemon({
      accounts: [
        account({ id: "a1", label: "Work", status: "cooling-down", cooldownEndsAt: inMinutes(1) }),
        account({ id: "a2", label: "Home", priority: 2 }),
      ],
      pools: [{ provider: "claude", newSessionsAccountId: "a2" }],
    })
    const table = await show(daemon)

    daemon.update("a1", { status: "active", cooldownEndsAt: null })

    expect(await notice("Work is back")).toBe(
      "Work is back Its cooldown ended, so it's in the Claude pool again.",
    )
    expect(statusOf(table, "Work")).toBe("Active Never used")
    expect(rowOf(table, "Work").dataset["flash"]).toBe("active")
    expect(poolLine()).toBe("New sessions go to Work")
  })

  it("shows a sign-in expiring: the row flashes red, the sidebar counts it, and a notice says what to do", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)
    const nav = screen.getByRole("navigation", { name: "Dashboard" })

    daemon.update("a2", { status: "needs-sign-in" })

    expect(await notice("Home needs sign-in")).toBe(
      "Home needs sign-in Its sign-in expired, so agent-proxy skips it until you sign in again.",
    )
    expect(statusOf(table, "Home")).toContain("Needs sign-in")
    expect(rowOf(table, "Home").dataset["flash"]).toBe("needs-sign-in")
    within(nav).getByRole("link", { name: "Accounts 1 needs sign-in" })
  })
})

/** The Claude pool's header line, whole. */
const header = () =>
  within(screen.getByRole("region", { name: "Claude" })).getByText(/New sessions go to/).textContent

describe("the order new sessions go in", () => {
  it("follows accounts sharing a priority as they trade places, with no notice or flash", async () => {
    const daemon = fakeDaemon({
      accounts: [
        account({ id: "a1", label: "Work", priority: 1 }),
        account({ id: "a2", label: "Home", priority: 1 }),
      ],
      pools: [{ provider: "claude", newSessionsAccountId: "a1", newSessionsOrder: ["a1", "a2"] }],
    })
    const table = await show(daemon)
    expect(header()).toBe("New sessions go to Work · then Home")

    daemon.setPools([
      { provider: "claude", newSessionsAccountId: "a2", newSessionsOrder: ["a2", "a1"] },
    ])

    await waitFor(() => expect(header()).toBe("New sessions go to Home · then Work"))
    screen.getByRole("listitem", { name: "Claude: new sessions go to Home" })
    expect(rowOf(table, "Home").classList.contains("is-serving")).toBe(true)
    expect(rowOf(table, "Work").dataset["flash"]).toBeUndefined()
    expect(notices()).toEqual([])
  })
})

describe("a change made outside this page", () => {
  it("shows an account disabled from the CLI, with a notice", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    daemon.update("a1", { enabled: false, status: "disabled" })

    expect(await notice("Work was turned off")).toBe(
      "Work was turned off It sits out of the Claude pool and keeps its priority.",
    )
    expect(screen.getByRole("switch", { name: "Work enabled" }).getAttribute("aria-checked")).toBe(
      "false",
    )
    expect(rowOf(table, "Work").dataset["flash"]).toBe("disabled")
    expect(poolLine()).toBe("New sessions go to Home")
  })

  it("shows an account added and one removed, each with a notice", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    daemon.add(account({ id: "a3", label: "Spare" }))
    expect(await notice("Spare was added")).toBe(
      "Spare was added It joins the Claude pool at priority 3.",
    )
    expect(rowOf(table, "Spare").dataset["flash"]).toBe("active")

    daemon.forget("a1")
    expect(await notice("Work was removed")).toBe(
      "Work was removed agent-proxy no longer holds it or its sign-in.",
    )
    await waitFor(() =>
      expect(rowsOf(table).map((row) => row["Account"]?.split(" ")[0])).toEqual(["Home", "Spare"]),
    )
  })

  it("shows a rename with a notice, and a move with none: the order says it", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    daemon.update("a2", { label: "Personal" })
    expect(await notice("Home is now Personal")).toBe(
      "Home is now Personal It was renamed outside this page.",
    )

    daemon.update("a2", { priority: 1 })
    daemon.update("a1", { priority: 2 })
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Personal"))
    expect(rowsOf(table).map((row) => row["Account"]?.split(" ")[0])).toEqual(["Personal", "Work"])
    expect(notices()).toHaveLength(1)
  })
})

describe("an account serving a request", () => {
  it("shows when it was last used, quietly", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    daemon.update("a2", { lastUsedAt: new Date(NOW - 4 * 60_000).toISOString() })

    await waitFor(() =>
      expect(rowsOf(table).find((row) => row["Account"]?.startsWith("Home"))?.["Status"]).toBe(
        "Active Used 4 min ago",
      ),
    )
    expect(notices()).toEqual([])
    expect(rowOf(table, "Home").dataset["flash"]).toBeUndefined()
  })
})

describe("a change made on this page", () => {
  it("shows no notice or flash for it, as the page already shows it", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    fireEvent.click(screen.getByRole("switch", { name: "Work enabled" }))
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Home"))
    // An event the daemon makes meanwhile still shows.
    daemon.update("a2", { status: "needs-sign-in" })
    await notice("Home needs sign-in")

    expect(notices()).toHaveLength(1)
    expect(rowOf(table, "Work").dataset["flash"]).toBeUndefined()
  })

  it("shows no notice or flash for turning off an account that is cooling down", async () => {
    const daemon = fakeDaemon({
      accounts: [
        account({ id: "a1", label: "Work", status: "cooling-down", cooldownEndsAt: inMinutes(30) }),
        account({ id: "a2", label: "Home", priority: 2 }),
      ],
      pools: [{ provider: "claude", newSessionsAccountId: "a2" }],
    })
    const table = await show(daemon)

    fireEvent.click(screen.getByRole("switch", { name: "Work enabled" }))
    await waitFor(() => expect(statusOf(table, "Work")).toBe("Disabled Never used"))
    daemon.update("a2", { status: "needs-sign-in" })
    await notice("Home needs sign-in")

    expect(notices()).toHaveLength(1)
    expect(rowOf(table, "Work").dataset["flash"]).toBeUndefined()
  })

  it("shows no notice for an account its sign-in dialog adds, as the dialog says so", async () => {
    const daemon = twoAccounts()
    daemon.signInAs = { providerAccountId: "acct-lab", email: "lab@example.com", plan: "Pro" }
    // The provider's sign-in page opens in a tab of its own, which the test stands in for.
    vi.spyOn(window, "open").mockImplementation(() => {
      const tab: Window = Object.create(window)
      Object.defineProperty(tab, "opener", { value: window, writable: true })
      return tab
    })
    const table = await show(daemon)

    fireEvent.click(screen.getByRole("button", { name: "Add account" }))
    const pick = await screen.findByRole("dialog", { name: "Add an account" })
    fireEvent.click(within(pick).getByRole("button", { name: "Claude" }))
    const waiting = await screen.findByRole("dialog", { name: "Sign in to Claude" })
    await within(waiting).findByText("Waiting for you to sign in…")
    daemon.redirect()

    await screen.findByRole("dialog", { name: "Claude account added" })
    await waitFor(() => within(table).getByText("lab"))
    expect(notices()).toEqual([])
  })
})

describe("when the event stream drops", () => {
  it("says the daemon can't be reached, then reconnects and shows what changed meanwhile", async () => {
    const daemon = twoAccounts()
    const table = await show(daemon)

    daemon.reachable = false
    expect((await screen.findByRole("status")).textContent).toContain("Can't reach the daemon")

    // A restarted daemon has no cooldowns, and holds what the CLI changed while it was down.
    daemon.accounts = [
      account({ id: "a1", label: "Work", priority: 1, enabled: false, status: "disabled" }),
      account({ id: "a2", label: "Home", priority: 2 }),
    ]
    daemon.pools = [{ provider: "claude", newSessionsAccountId: "a2" }]
    daemon.reachable = true

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
    expect(statusOf(table, "Work")).toBe("Disabled Never used")
    expect(poolLine()).toBe("New sessions go to Home")
    expect(daemon.streams).toBe(1)

    // The new stream brings changes as the old one did.
    daemon.update("a2", { status: "cooling-down", cooldownEndsAt: inMinutes(5) })
    await notice("Home is cooling down")
  })

  it("without a stream, shows what the daemon lists, asking again each time it retries", async () => {
    const daemon = twoAccounts()
    daemon.eventsRefused = true
    const table = await show(daemon)
    expect(screen.queryByRole("status")).toBeNull()

    daemon.accounts = [
      account({ id: "a1", label: "Work", priority: 1, enabled: false, status: "disabled" }),
      account({ id: "a2", label: "Home", priority: 2 }),
    ]
    await waitFor(() => expect(statusOf(table, "Work")).toBe("Disabled Never used"))
  })
})
