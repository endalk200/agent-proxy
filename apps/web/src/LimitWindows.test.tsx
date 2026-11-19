import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon, usageRow } from "./test/fake-daemon.ts"
import { rowsOf, textOf } from "./test/queries.ts"

// Limit windows on the Accounts page and in the account sheet, against a
// fake daemon API, found by ARIA role and name. The page's clock is pinned
// (timers still run) at 15:00 in Tokyo, the time zone tests run in.

const NOW = Date.parse("2026-11-17T06:00:00Z")
const MIN = 60_000
const HOUR = 60 * MIN

beforeEach(() => {
  vi.setSystemTime(NOW)
  window.history.replaceState(null, "", "/accounts")
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** Work (cooling down, its 5-hour window used up) and Home on Claude, carol on Codex. */
const accounts = () => {
  const daemon = fakeDaemon({
    accounts: [
      account({
        id: "a1",
        label: "Work",
        plan: "Max 20x",
        status: "cooling-down",
        cooldownEndsAt: new Date(NOW + 47 * MIN).toISOString(),
        lastUsedAt: new Date(NOW - 4 * MIN).toISOString(),
      }),
      account({ id: "a2", label: "Home", priority: 2, plan: "Pro" }),
      account({
        id: "c1",
        provider: "codex",
        providerAccountId: "codex-c1",
        label: "carol",
        plan: "Plus",
      }),
    ],
    pools: [
      { provider: "claude", newSessionsAccountId: "a2" },
      { provider: "codex", newSessionsAccountId: "c1" },
    ],
  })
  daemon.limits = [
    {
      accountId: "a1",
      asOf: NOW - 2 * MIN,
      windows: [
        {
          id: "five-hour",
          label: "5-hour",
          usedPct: 100,
          resetsAt: NOW + 47 * MIN,
          asOf: NOW - 2 * MIN,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 64.5,
          resetsAt: NOW + 74 * HOUR,
          asOf: NOW - 2 * MIN,
        },
        {
          id: "weekly:Fable",
          label: "Fable weekly",
          usedPct: 88,
          resetsAt: NOW + 50 * HOUR,
          asOf: NOW - 2 * MIN,
        },
      ],
    },
    {
      accountId: "c1",
      asOf: NOW - 2 * HOUR,
      windows: [
        {
          id: "five-hour",
          label: "5-hour",
          usedPct: 12,
          resetsAt: NOW + 4 * HOUR,
          asOf: NOW - 2 * HOUR,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 71,
          resetsAt: NOW + 30 * HOUR,
          asOf: NOW - 2 * HOUR,
        },
      ],
    },
  ]
  return daemon
}

const show = (daemon: FakeDaemon) =>
  render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} reopenDelay={20} />)

const table = async (name: string) => {
  const found = await screen.findByRole("table", { name })
  await waitFor(() => expect(textOf(found)).toContain("resets in"))
  return found
}

describe("the Accounts tables", () => {
  it("give each limit window its own column, the pool's tables lined up", async () => {
    show(accounts())
    expect(rowsOf(await table("Claude accounts"))).toEqual([
      {
        Priority: "1",
        Account: "Work Max 20x work@example.com",
        Status: "Cooling down until 3:47 PM · in 47m",
        "5-hour": "Used up resets in 47m",
        Weekly: "64% resets in 3d 2h",
        "Fable weekly": "88% resets in 2d 2h",
        Enabled: "",
        Actions: "",
      },
      {
        Priority: "2",
        Account: "Home Pro New sessions home@example.com",
        Status: "Active Never used",
        "5-hour": "—",
        Weekly: "—",
        "Fable weekly": "—",
        Enabled: "",
        Actions: "",
      },
    ])
    const codex = await table("Codex accounts")
    expect(rowsOf(codex)).toEqual([
      {
        Priority: "1",
        Account: "carol Plus New sessions carol@example.com",
        Status: "Active Never used",
        "5-hour": "12% resets in 4h 0m",
        Weekly: "71% resets in 1d 6h",
        Enabled: "",
        Actions: "",
      },
    ])
    // A spacer stands in for the Fable weekly column, so both tables' columns line up.
    expect(within(codex).getAllByRole("row")[0]?.children).toHaveLength(8)
  })

  it("refreshes every account's limit windows from the page, and one account's from its row menu", async () => {
    const daemon = accounts()
    daemon.providerLimits = {
      a2: [{ id: "five-hour", label: "5-hour", usedPct: 3, resetsAt: NOW + 290 * MIN }],
      c1: [
        { id: "five-hour", label: "5-hour", usedPct: 15, resetsAt: NOW + 4 * HOUR },
        { id: "weekly", label: "Weekly", usedPct: 72, resetsAt: NOW + 30 * HOUR },
      ],
    }
    show(daemon)
    const codex = await table("Codex accounts")

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Codex" })).getByRole("button", {
        name: "Actions for carol",
      }),
    )
    fireEvent.click(await screen.findByRole("menuitem", { name: "Refresh limits" }))
    await waitFor(() => expect(rowsOf(codex)[0]?.["5-hour"]).toBe("15% resets in 4h 0m"))
    expect(daemon.refreshes).toEqual(["c1"])
    expect(rowsOf(await table("Claude accounts"))[1]?.["5-hour"]).toBe("—")

    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }))
    await waitFor(async () =>
      expect(rowsOf(await table("Claude accounts"))[1]?.["5-hour"]).toBe("3% resets in 4h 50m"),
    )
    expect(daemon.refreshes).toEqual(["c1", "all"])
  })

  it("keeps a change the daemon reports while a refresh's answer is on its way", async () => {
    const daemon = accounts()
    daemon.providerLimits = {
      c1: [{ id: "five-hour", label: "5-hour", usedPct: 20, resetsAt: NOW + 4 * HOUR }],
    }
    daemon.holdRefresh = true
    show(daemon)
    const codex = await table("Codex accounts")
    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }))
    await waitFor(() => expect(daemon.refreshes).toEqual(["all"]))
    // A request carol serves meanwhile reports newer numbers.
    daemon.setLimits("c1", [
      { id: "five-hour", label: "5-hour", usedPct: 80, resetsAt: NOW + 4 * HOUR },
    ])
    await waitFor(() => expect(rowsOf(codex)[0]?.["5-hour"]).toBe("80% resets in 4h 0m"))
    daemon.holdRefresh = false
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh limits" }).hasAttribute("disabled")).toBe(
        false,
      ),
    )
    expect(rowsOf(codex)[0]?.["5-hour"]).toBe("80% resets in 4h 0m")
  })

  it("holds the Refresh limits button while the daemon reads, and says why a refresh failed", async () => {
    const daemon = accounts()
    daemon.holdRefresh = true
    show(daemon)
    await table("Claude accounts")
    const refresh = screen.getByRole("button", { name: "Refresh limits" })
    fireEvent.click(refresh)
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(true))
    daemon.holdRefresh = false
    await waitFor(() => expect(refresh.hasAttribute("disabled")).toBe(false))

    daemon.refusal = "The daemon API is served to clients on this machine only."
    fireEvent.click(refresh)
    const notice = await within(screen.getByRole("region", { name: "Notifications" })).findByRole(
      "dialog",
      { name: "Couldn't refresh limits" },
    )
    expect(textOf(notice)).toContain("The daemon API is served to clients on this machine only.")
  })
})

/** Opens `label`'s account sheet from its row. */
const sheet = async (label: string) => {
  fireEvent.click(await screen.findByRole("button", { name: label }))
  return screen.findByRole("dialog", { name: label })
}

describe("the account sheet", () => {
  it("opens on the account's limit windows, larger, with reset times, and refreshes them", async () => {
    const daemon = accounts()
    daemon.providerLimits = {
      a1: [
        { id: "five-hour", label: "5-hour", usedPct: 100, resetsAt: NOW + 47 * MIN },
        { id: "weekly", label: "Weekly", usedPct: 66, resetsAt: NOW + 74 * HOUR },
        { id: "weekly:Fable", label: "Fable weekly", usedPct: 90, resetsAt: NOW + 50 * HOUR },
      ],
    }
    show(daemon)
    await table("Claude accounts")
    const work = await sheet("Work")
    const panel = within(work).getByRole("region", { name: "Limit windows" })
    expect(within(within(panel).getByRole("list")).getAllByRole("listitem").map(textOf)).toEqual([
      "5-hour Used up Resets in 47m · 3:47 PM",
      "Weekly 64% used Resets in 3d 2h · Fri 5:00 PM",
      "Fable weekly 88% used Resets in 2d 2h · Thu 5:00 PM",
    ])
    expect(textOf(panel)).toContain("As of 2 min ago")

    fireEvent.click(within(panel).getByRole("button", { name: "Refresh" }))
    await waitFor(() =>
      expect(within(panel).getAllByRole("listitem").map(textOf)[1]).toBe(
        "Weekly 66% used Resets in 3d 2h · Fri 5:00 PM",
      ),
    )
    expect(daemon.refreshes).toEqual(["a1"])
    expect(textOf(panel)).toContain("As of just now")
  })

  it("says when an account's windows are stale, or not read yet", async () => {
    show(accounts())
    await table("Codex accounts")
    const carol = within(await sheet("carol")).getByRole("region", { name: "Limit windows" })
    expect(within(carol).getAllByRole("listitem").map(textOf)).toEqual([
      "5-hour 12% used Resets in 4h 0m · 7:00 PM · As of 1:00 PM (2 hr ago)",
      "Weekly 71% used Resets in 1d 6h · Wed 9:00 PM · As of 1:00 PM (2 hr ago)",
    ])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "carol" })).toBeNull())

    const home = within(await sheet("Home")).getByRole("region", { name: "Limit windows" })
    expect(textOf(home)).toContain("Not read yet.")
  })

  it("says an account added since the limits were read has not been read yet", async () => {
    const daemon = accounts()
    show(daemon)
    await table("Codex accounts")
    daemon.add(account({ id: "a9", label: "New", plan: "Pro" }))
    const added = within(await sheet("New")).getByRole("region", { name: "Limit windows" })
    expect(textOf(added)).toContain("Not read yet.")
  })

  it("keeps every account's limit windows when one changes while they are being read", async () => {
    const daemon = accounts()
    daemon.holdLimitsRead = true
    show(daemon)
    await screen.findByRole("table", { name: "Codex accounts" })
    // While the first read is on its way, Work's windows change.
    daemon.setLimits("a1", [
      { id: "five-hour", label: "5-hour", usedPct: 30, resetsAt: NOW + 3 * HOUR },
    ])
    daemon.holdLimitsRead = false

    const codex = await table("Codex accounts")
    expect(rowsOf(codex).map((row) => row["Weekly"])).toEqual(["71% resets in 1d 6h"])
    const claude = await table("Claude accounts")
    await waitFor(() =>
      expect(rowsOf(claude).map((row) => row["5-hour"])).toEqual(["30% resets in 3h 0m", "—"]),
    )
  })

  it("shows the account's last 7 days through the proxy", async () => {
    const daemon = accounts()
    daemon.prices = { "claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5 } }
    daemon.usage = [
      usageRow({
        at: NOW - 2 * HOUR,
        accountId: "a1",
        tokens: { uncached: 20_000, cacheRead: 60_000, output: 20_000 },
      }),
      usageRow({ at: NOW - 26 * HOUR, accountId: "a1", tokens: { uncached: 5000, output: 5000 } }),
      usageRow({ at: NOW - 3 * HOUR, accountId: "a1", status: "limited" }),
      usageRow({ at: NOW - 2 * HOUR, accountId: "a2", tokens: { output: 1_000_000 } }),
    ]
    show(daemon)
    await table("Claude accounts")
    const work = await sheet("Work")
    const week = within(work).getByRole("region", { name: "Last 7 days through the proxy" })
    await waitFor(() => expect(textOf(week)).toContain("Requests 3"))
    expect(textOf(week)).toBe(
      "Last 7 days through the proxy Requests 3 66.7% success Tokens 110K 70.6% cache hit rate Equivalent cost $0.78 At API list prices Wed Thu Fri Sat Sun Mon Tue",
    )
    expect(within(week).getByRole("img").getAttribute("aria-label")).toBe(
      "Tokens per day: Wed 0, Thu 0, Fri 0, Sat 0, Sun 0, Mon 10K, Tue 100K",
    )
    expect(daemon.usageCalls).toContain(
      "summary?range=custom&from=2026-11-11&to=2026-11-17&tz=Asia%2FTokyo&account=a1",
    )
  })
})
