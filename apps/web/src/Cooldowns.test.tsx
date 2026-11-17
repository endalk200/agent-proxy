import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon } from "./test/fake-daemon.ts"
import { rowsOf, textOf } from "./test/queries.ts"

// Accounts cooling down, against a fake daemon API, found by ARIA role and
// name. The page's clock is pinned (timers still run) at 15:00 in Tokyo, the
// time zone the tests run in, so reset times read as fixed local times.

const NOW = Date.parse("2026-11-17T06:00:00Z")

/** `minutes` after the pinned now, as the daemon reports a cooldown's end. */
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

beforeEach(() => {
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const show = (daemon: FakeDaemon) =>
  render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} />)

const claudeTable = async () =>
  within(await screen.findByRole("region", { name: "Claude" })).getByRole("table", {
    name: "Claude accounts",
  })

describe("an account cooling down", () => {
  it("shows Cooling down with its reset time and a countdown that ticks", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({
            id: "a1",
            label: "Work",
            status: "cooling-down",
            cooldownEndsAt: inMinutes(47),
          }),
          account({ id: "a2", label: "Home", priority: 2 }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: "a2" }],
      }),
    )

    expect(rowsOf(await claudeTable()).map((row) => row["Status"])).toEqual([
      "Cooling down until 3:47 PM · in 47m",
      "Active",
    ])
    vi.setSystemTime(NOW + 60_000)
    await waitFor(
      async () =>
        expect(rowsOf(await claudeTable())[0]?.["Status"]).toBe(
          "Cooling down until 3:47 PM · in 46m",
        ),
      { timeout: 2500 },
    )
  })

  it("shows its reset on another day with the date", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({
            id: "a1",
            label: "Work",
            status: "cooling-down",
            cooldownEndsAt: "2026-11-20T01:30:00Z",
          }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: null }],
      }),
    )

    expect(rowsOf(await claudeTable())[0]?.["Status"]).toBe(
      "Cooling down until Nov 20, 10:30 AM · in 2d 19h",
    )
  })

  it("says in the account sheet why it sits out and when it is back", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({
            id: "a1",
            label: "Work",
            status: "cooling-down",
            cooldownEndsAt: inMinutes(72),
          }),
          account({ id: "a2", label: "Home", priority: 2 }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: "a2" }],
      }),
    )

    fireEvent.click(await screen.findByRole("button", { name: "Work" }))
    const sheet = await screen.findByRole("dialog", { name: "Work" })
    expect(textOf(within(sheet).getByRole("region", { name: "Status" }))).toBe(
      "Cooling down until 4:12 PM It hit its plan's limit. agent-proxy skips it until the limit resets. in 1h 12m",
    )
    const order = within(sheet).getByRole("list", { name: "Claude pool order" })
    expect(textOf(order)).toContain("Work Cooling down")
  })
})

/** A Claude pool whose every account is cooling down; Home is back first. */
const allCooling = () =>
  fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", status: "cooling-down", cooldownEndsAt: inMinutes(72) }),
      account({
        id: "a2",
        label: "Home",
        priority: 2,
        status: "cooling-down",
        cooldownEndsAt: inMinutes(18),
      }),
    ],
    pools: [{ provider: "claude", newSessionsAccountId: null }],
  })

describe("a pool whose every account is cooling down", () => {
  it("says in its header when the first cooldown ends", async () => {
    show(allCooling())

    const claude = await screen.findByRole("region", { name: "Claude" })
    expect(textOf(within(claude).getByText(/No account can take new sessions/))).toBe(
      "No account can take new sessions · next reset 3:18 PM (in 18m)",
    )
    expect(textOf(within(claude).getByRole("note"))).toBe(
      "Every account in the Claude pool hit its plan's limit. Claude Code and opencode get Claude sessions again when the first cooldown ends, at 3:18 PM.",
    )
  })

  it("says in the sidebar's pool strip when the pool is back", async () => {
    show(allCooling())

    const pools = await screen.findByRole("list", { name: "Pools" })
    const claude = within(pools).getByRole("listitem", {
      name: "Claude: no account can take new sessions until 3:18 PM",
    })
    expect(textOf(claude)).toBe("Claude Back in 18m")
  })

  it("with some accounts needing sign-in instead, says either fixes it", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({ id: "a1", label: "Work", status: "needs-sign-in" }),
          account({
            id: "a2",
            label: "Home",
            priority: 2,
            status: "cooling-down",
            cooldownEndsAt: inMinutes(18),
          }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: null }],
      }),
    )

    const claude = await screen.findByRole("region", { name: "Claude" })
    expect(textOf(within(claude).getByRole("note"))).toBe(
      "Every enabled Claude account is cooling down or needs sign-in. Sign one in again, or wait for the first cooldown to end at 3:18 PM.",
    )
  })
})

describe("a status this dashboard does not know", () => {
  it("shows the account as Unknown and the rest of the list as usual", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({ id: "a1", label: "Work", status: "paused" }),
          account({ id: "a2", label: "Home", priority: 2 }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: "a2" }],
      }),
    )

    expect(rowsOf(await claudeTable()).map((row) => row["Status"])).toEqual(["Unknown", "Active"])
  })
})
