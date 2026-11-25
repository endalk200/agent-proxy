import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon, type FakeLimitReset } from "./test/fake-daemon.ts"
import { rowsOf, textOf } from "./test/queries.ts"

// Limit resets on the Accounts page and in the account sheet, against a fake
// daemon API, found by ARIA role and name. The page's clock is pinned (timers
// still run) at 15:00 in Tokyo, the time zone tests run in.

const NOW = Date.parse("2026-11-17T06:00:00Z")
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

beforeEach(() => {
  vi.setSystemTime(NOW)
  window.history.replaceState(null, "", "/accounts")
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A limit reset that refills the 5-hour and weekly windows, expiring in `days`. */
const reset = (
  id: string,
  name: string,
  days: number | null,
  overrides: Partial<FakeLimitReset> = {},
): FakeLimitReset => ({
  id,
  name,
  refills: [
    { id: "five-hour", label: "5-hour" },
    { id: "weekly", label: "Weekly" },
  ],
  grantedAt: null,
  expiresAt: days === null ? null : NOW + days * DAY,
  usableNow: true,
  unavailableReason: null,
  asOf: NOW - 2 * MIN,
  ...overrides,
})

/** Work and Home on Claude, carol on Codex; Work holds two limit resets, carol one. */
const accounts = () => {
  const daemon = fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", plan: "Max 5x" }),
      account({ id: "a2", label: "Home", priority: 2 }),
      account({
        id: "c1",
        provider: "codex",
        providerAccountId: "codex-c1",
        label: "carol",
        plan: "Plus",
      }),
    ],
    pools: [
      { provider: "claude", newSessionsAccountId: "a1" },
      { provider: "codex", newSessionsAccountId: "c1" },
    ],
  })
  daemon.limits = [
    {
      accountId: "a1",
      asOf: NOW - 2 * MIN,
      windows: [
        { id: "five-hour", label: "5-hour", usedPct: 46, resetsAt: NOW + 2 * HOUR, asOf: NOW },
        { id: "weekly", label: "Weekly", usedPct: 55, resetsAt: NOW + 3 * DAY, asOf: NOW },
      ],
      limitResets: [
        reset("full-reset-2611", "Full reset", 23),
        reset("launch-2610-fable", "New model launch: one Fable reset", 112, {
          refills: [{ id: "five-hour", label: "5-hour" }],
        }),
      ],
      canBuyReset: false,
    },
    {
      accountId: "c1",
      asOf: NOW - 2 * MIN,
      windows: [
        { id: "five-hour", label: "5-hour", usedPct: 90, resetsAt: NOW + 2 * HOUR, asOf: NOW },
      ],
      limitResets: [reset("RateLimitResetCredit_50aa", "Full reset", 5)],
      canBuyReset: false,
    },
  ]
  return daemon
}

const show = (daemon: FakeDaemon) =>
  render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} reopenDelay={20} />)

/** The Account cell of each row of `name`'s table, once the limits have loaded. */
const accountCells = async (name: string) => {
  const table = await screen.findByRole("table", { name })
  await waitFor(() => expect(textOf(table)).toContain("resets in"))
  return rowsOf(table).map((row) => row["Account"])
}

/** The limit-resets badge in `name`'s table, by its count's words. */
const badge = (name: string) =>
  within(screen.getByRole("table", { name })).getByText(/limit resets?$/).parentElement

describe("the Accounts tables", () => {
  it("badge each account with how many limit resets it holds, and none when it holds none", async () => {
    show(accounts())
    expect(await accountCells("Claude accounts")).toEqual([
      "Work Max 5x 2 limit resets New sessions work@example.com",
      "Home Pro home@example.com",
    ])
    expect(await accountCells("Codex accounts")).toEqual([
      "carol Plus 1 limit reset New sessions carol@example.com",
    ])
  })

  it("badge an account in the warning tone while one of its limit resets expires within 7 days", async () => {
    const daemon = accounts()
    daemon.limits = daemon.limits.map((limits) =>
      limits.accountId === "a1"
        ? { ...limits, limitResets: [reset("full-reset-2611", "Full reset", 7.5)] }
        : limits,
    )
    show(daemon)
    await accountCells("Codex accounts")
    // carol's expires in 5 days, Work's in 7 and a half.
    expect(badge("Codex accounts")?.dataset["tone"]).toBe("warn")
    expect(badge("Claude accounts")?.dataset["tone"]).toBeUndefined()
  })

  it("leave out a limit reset that has expired", async () => {
    const daemon = accounts()
    daemon.limits = daemon.limits.map((limits) =>
      limits.accountId === "c1"
        ? { ...limits, limitResets: [reset("RateLimitResetCredit_50aa", "Full reset", -0.1)] }
        : limits,
    )
    show(daemon)
    expect(await accountCells("Codex accounts")).toEqual([
      "carol Plus New sessions carol@example.com",
    ])
  })
})

/** Opens `label`'s account sheet from its row, and finds its Limit resets section. */
const resetsIn = async (label: string) => {
  fireEvent.click(await screen.findByRole("button", { name: label }))
  const sheet = await screen.findByRole("dialog", { name: label })
  return within(sheet).findByRole("region", { name: "Limit resets" })
}

/** Each limit reset a section lists, as its text. */
const itemsOf = (section: HTMLElement) =>
  within(within(section).getByRole("list")).getAllByRole("listitem").map(textOf)

describe("the account sheet", () => {
  it("lists each limit reset soonest expiry first, with what it refills and when it expires", async () => {
    const daemon = accounts()
    // Out of order: the page orders them.
    daemon.limits = daemon.limits.map((limits) =>
      limits.accountId === "a1"
        ? { ...limits, limitResets: (limits.limitResets ?? []).toReversed() }
        : limits,
    )
    show(daemon)
    const section = await resetsIn("Work")
    expect(itemsOf(section)).toEqual([
      "Full reset Refills 5-hour and Weekly expires Dec 10 (in 23d 0h) Redeem",
      "New model launch: one Fable reset Refills 5-hour expires Mar 9 (in 112d 0h) Redeem",
    ])
    expect(
      within(section)
        .getAllByRole("button", { name: /^Redeem/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Redeem Full reset", "Redeem New model launch: one Fable reset"])
  })

  it("says when each limit reset was granted, which tells apart two of the same name", async () => {
    const daemon = accounts()
    daemon.limits = daemon.limits.map((limits) =>
      limits.accountId === "a1"
        ? {
            ...limits,
            limitResets: [
              reset("bonus", "Full reset", 5, { grantedAt: NOW - 1 * DAY }),
              reset("earlier", "Full reset", 23, { grantedAt: NOW - 5 * DAY }),
            ],
          }
        : limits,
    )
    show(daemon)
    const section = await resetsIn("Work")
    expect(itemsOf(section)).toEqual([
      "Full reset Refills 5-hour and Weekly granted Nov 16 · expires Nov 22 (in 5d 0h) Redeem",
      "Full reset Refills 5-hour and Weekly granted Nov 12 · expires Dec 10 (in 23d 0h) Redeem",
    ])
    // Each Redeem button is told apart by its dates, and so is the dialog it opens.
    const sooner = within(section).getByRole("button", {
      name: "Redeem Full reset",
      description: "granted Nov 16 · expires Nov 22 (in 5d 0h)",
    })
    fireEvent.click(sooner)
    const dialog = await screen.findByRole("alertdialog", { name: "Redeem Full reset?" })
    expect(textOf(dialog)).toContain("This one was granted Nov 16 and expires Nov 22.")
  })

  it("marks a limit reset that expires within 7 days in the warning tone", async () => {
    show(accounts())
    const section = await resetsIn("carol")
    const expiry = within(section).getByText(/expires/)
    expect(expiry.dataset["tone"]).toBe("warn")
  })

  it("shows why a limit reset can't be redeemed now, in place of its Redeem button", async () => {
    const daemon = accounts()
    daemon.limits = daemon.limits.map((limits) =>
      limits.accountId === "a1"
        ? {
            ...limits,
            limitResets: [
              reset("full-reset-2611", "Full reset", 23, {
                usableNow: false,
                unavailableReason: "Available once a limit is reached.",
              }),
              reset("weekly-2612", "Weekly reset", 30, { usableNow: false }),
            ],
          }
        : limits,
    )
    show(daemon)
    const section = await resetsIn("Work")
    expect(itemsOf(section)).toEqual([
      "Full reset Refills 5-hour and Weekly expires Dec 10 (in 23d 0h) Available once a limit is reached.",
      "Weekly reset Refills 5-hour and Weekly expires Dec 17 (in 30d 0h) Not usable right now",
    ])
    expect(within(section).queryByRole("button", { name: /^Redeem/ })).toBeNull()
  })

  it("says when the account holds no limit reset", async () => {
    show(accounts())
    const section = await resetsIn("Home")
    expect(textOf(section)).toBe("Limit resets None now. New ones show up here by themselves.")
  })
})

/** Presses Redeem on `name` in `section`, and finds the dialog that asks first. */
const askToRedeem = async (section: HTMLElement, name: string) => {
  fireEvent.click(within(section).getByRole("button", { name: `Redeem ${name}` }))
  return screen.findByRole("alertdialog", { name: `Redeem ${name}?` })
}

describe("redeeming a limit reset", () => {
  it("asks first, with how used each window it refills is and that Claude keeps the weekly reset day", async () => {
    const daemon = accounts()
    show(daemon)
    const dialog = await askToRedeem(await resetsIn("Work"), "Full reset")
    expect(textOf(dialog)).toBe(
      "Redeem Full reset? It refills Work's 5-hour and Weekly windows now. Claude keeps this account's weekly reset day. This one expires Dec 10. A redeem can't be undone. 5-hour 46% used Weekly 55% used Cancel Redeem",
    )
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(daemon.redeems).toEqual([])
    // The sheet stays open behind it.
    expect(screen.getByRole("dialog", { name: "Work" })).toBeTruthy()
  })

  it("says for Codex that the weekly refresh moves, and which windows it hasn't read yet", async () => {
    show(accounts())
    const dialog = await askToRedeem(await resetsIn("carol"), "Full reset")
    expect(textOf(dialog)).toBe(
      "Redeem Full reset? It refills carol's 5-hour and Weekly windows now. Codex moves this account's weekly refresh to a week from now. This one expires Nov 22. A redeem can't be undone. 5-hour 90% used Weekly not read yet Cancel Redeem",
    )
  })

  it("redeems on Redeem, says so, and shows one limit reset fewer", async () => {
    const daemon = accounts()
    show(daemon)
    const section = await resetsIn("Work")
    const dialog = await askToRedeem(section, "Full reset")
    fireEvent.click(within(dialog).getByRole("button", { name: "Redeem" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(daemon.redeems).toEqual(["a1 full-reset-2611"])
    expect(textOf(within(section).getByRole("alert"))).toBe(
      "Redeemed Full reset Redeemed. The account's limit windows are read again.",
    )
    expect(itemsOf(section)).toEqual([
      "New model launch: one Fable reset Refills 5-hour expires Mar 9 (in 112d 0h) Redeem",
    ])
    expect(await accountCells("Claude accounts")).toContain(
      "Work Max 5x 1 limit reset New sessions work@example.com",
    )
  })

  it("holds the dialog while the daemon redeems", async () => {
    const daemon = accounts()
    daemon.holdRedeem = true
    show(daemon)
    const dialog = await askToRedeem(await resetsIn("Work"), "Full reset")
    fireEvent.click(within(dialog).getByRole("button", { name: "Redeem" }))
    const busy = await within(dialog).findByRole("button", { name: "Redeeming…" })
    expect(busy.hasAttribute("disabled")).toBe(true)
    daemon.holdRedeem = false
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it.each([
    [
      "refused",
      {
        outcome: "refused",
        reason: "nothing-to-refill",
        message: "Claude refused it: there is nothing to refill yet. Nothing was spent.",
      },
      "Full reset wasn't redeemed Claude refused it: there is nothing to refill yet. Nothing was spent.",
    ],
    [
      "unknown",
      {
        outcome: "unknown",
        message: "Claude didn't answer, so it's not known whether it was spent. Check the list.",
      },
      "Not sure Full reset was redeemed Claude didn't answer, so it's not known whether it was spent. Check the list.",
    ],
    [
      "an error",
      { status: 409, error: "Work needs sign-in before it can redeem a limit reset." },
      "Couldn't redeem Full reset Work needs sign-in before it can redeem a limit reset.",
    ],
  ] as const)(
    "says why when the redeem comes back %s, keeping the limit reset",
    async (_, answer, said) => {
      const daemon = accounts()
      daemon.redeemAnswer = answer
      show(daemon)
      const section = await resetsIn("Work")
      fireEvent.click(
        within(await askToRedeem(section, "Full reset")).getByRole("button", { name: "Redeem" }),
      )
      await waitFor(() => expect(within(section).queryByRole("alert")).not.toBeNull())
      expect(textOf(within(section).getByRole("alert"))).toBe(said)
      expect(itemsOf(section)).toHaveLength(2)
    },
  )

  it("says the outcome is unknown when the redeem gets no answer", async () => {
    const daemon = accounts()
    show(daemon)
    const section = await resetsIn("Work")
    const dialog = await askToRedeem(section, "Full reset")
    daemon.reachable = false
    fireEvent.click(within(dialog).getByRole("button", { name: "Redeem" }))
    await waitFor(() =>
      expect(textOf(within(section).getByRole("alert"))).toBe(
        "Not sure Full reset was redeemed No answer came back from the daemon, so whether it was redeemed is unknown. The list shows it once the daemon answers again: a redeemed one is no longer there.",
      ),
    )
  })
})

describe("live updates", () => {
  it("move the badge and the list as the daemon reports an account's limit resets", async () => {
    const daemon = accounts()
    show(daemon)
    const section = await resetsIn("Work")
    daemon.setLimitResets("a1", [reset("full-reset-2611", "Full reset", 23)])
    await waitFor(() => expect(itemsOf(section)).toHaveLength(1))
    expect(await accountCells("Claude accounts")).toContain(
      "Work Max 5x 1 limit reset New sessions work@example.com",
    )
  })
})

describe("buying a reset", () => {
  it("links a Codex account to Codex's purchase page only when Codex offers it one", async () => {
    const daemon = accounts()
    show(daemon)
    const section = await resetsIn("carol")
    expect(within(section).queryByRole("link", { name: "Buy a reset" })).toBeNull()
    daemon.setLimitResets("c1", [], true)
    const link = await within(section).findByRole("link", { name: "Buy a reset" })
    expect(link.getAttribute("href")).toBe("https://chatgpt.com/codex/purchase/reset")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("never links a Claude account, whatever its limits say", async () => {
    const daemon = accounts()
    daemon.limits = daemon.limits.map((limits) =>
      limits.accountId === "a1" ? { ...limits, canBuyReset: true } : limits,
    )
    show(daemon)
    const section = await resetsIn("Work")
    expect(within(section).queryByRole("link", { name: "Buy a reset" })).toBeNull()
  })
})
