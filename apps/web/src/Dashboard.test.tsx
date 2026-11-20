import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon, usageRow } from "./test/fake-daemon.ts"
import { tableOf, textOf } from "./test/queries.ts"

// The usage dashboard at `/`, against a fake daemon API, found by ARIA role
// and name. The page's clock is pinned (timers still run) at 15:00 in Tokyo,
// the time zone tests run in.

const NOW = Date.parse("2026-11-17T06:00:00Z")
const HOUR = 3_600_000

beforeEach(() => {
  vi.setSystemTime(NOW)
  window.history.replaceState(null, "", "/")
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const show = (daemon: FakeDaemon, props: { kpis?: number; charts?: number } = {}) =>
  render(
    <App
      fetch={daemon.fetch}
      openEvents={daemon.openEvents}
      reopenDelay={20}
      usageThrottle={{ kpis: props.kpis ?? 1000, charts: props.charts ?? 15_000 }}
    />,
  )

/** Work and Home on Claude, carol on Codex. */
const threeAccounts = () =>
  fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", plan: "Max 20x" }),
      account({ id: "a2", label: "Home", priority: 2, plan: "Max 5x" }),
      account({
        id: "c1",
        provider: "codex",
        providerAccountId: "codex-c1",
        label: "carol",
        plan: "Pro",
      }),
    ],
    pools: [
      { provider: "claude", newSessionsAccountId: "a1" },
      { provider: "codex", newSessionsAccountId: "c1" },
    ],
  })

const nav = () => screen.getByRole("navigation", { name: "Dashboard" })

describe("pages", () => {
  it("opens on the dashboard, the first sidebar item, and moves to Accounts keeping the range", async () => {
    window.history.replaceState(null, "", "/?range=30d")
    show(threeAccounts())

    await within(nav()).findByRole("link", { name: "Accounts 3" })
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Dashboard")
    const links = within(nav()).getAllByRole("link")
    expect(links.map(textOf)).toEqual(["Dashboard", "Accounts 3"])
    expect(links[0]?.getAttribute("aria-current")).toBe("page")
    expect(links[1]?.getAttribute("aria-current")).toBeNull()

    fireEvent.click(within(nav()).getByRole("link", { name: "Accounts 3" }))
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Accounts")
    expect(`${location.pathname}${location.search}`).toBe("/accounts?range=30d")
    await screen.findByRole("table", { name: "Claude accounts" })
    expect(
      within(nav()).getByRole("link", { name: "Accounts 3" }).getAttribute("aria-current"),
    ).toBe("page")

    fireEvent.click(within(nav()).getByRole("link", { name: "Dashboard" }))
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Dashboard")
    expect(`${location.pathname}${location.search}`).toBe("/?range=30d")
  })

  it("opens on Accounts at /accounts", async () => {
    window.history.replaceState(null, "", "/accounts")
    show(threeAccounts())
    await screen.findByRole("table", { name: "Codex accounts" })
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Accounts")
  })

  it("shows the first-run guide under Get started while the daemon holds no accounts", async () => {
    show(fakeDaemon())
    await screen.findByRole("list", { name: "Get started" })
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Get started")
    expect(screen.queryByRole("region", { name: "Requests" })).toBeNull()
  })
})

const OPUS = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

/** Four requests in the last day, one of them failed, and one older than a week. */
const withUsage = () => {
  const daemon = threeAccounts()
  daemon.prices = { "claude-opus-5-5": OPUS }
  daemon.usage = [
    usageRow({
      at: NOW - 2 * HOUR,
      accountId: "a1",
      tokens: { uncached: 1000, cacheRead: 9000, output: 2000, reasoning: 500 },
    }),
    usageRow({
      at: NOW - 5 * HOUR,
      accountId: "a2",
      tokens: { uncached: 1_000_000, cacheRead: 3_000_000, cacheWrite: 200_000, output: 400_000 },
    }),
    usageRow({
      at: NOW - 20 * HOUR,
      provider: "codex",
      accountId: "c1",
      model: "gpt-6.1-sol",
      client: "codex",
      tokens: { uncached: 50_000, cacheRead: 150_000, output: 20_000, reasoning: 8000 },
    }),
    usageRow({ at: NOW - 1 * HOUR, accountId: "a1", status: "failed" }),
    usageRow({ at: NOW - 8 * 24 * HOUR, accountId: "a1", tokens: { output: 999_999 } }),
  ]
  return daemon
}

const kpi = async (name: string) => textOf(await screen.findByRole("region", { name }))

describe("the KPIs", () => {
  it("add up the last 7 days by default: requests, tokens by kind, cache hit rate and equivalent cost", async () => {
    const daemon = withUsage()
    show(daemon)

    expect(await kpi("Requests")).toBe(
      "Requests 4 75.0% success 1 failed · 0 limited · 0 incomplete",
    )
    expect(await kpi("Tokens")).toBe(
      "Tokens 4.83M Uncached input 1.05M Cache read 3.16M Cache write 200K Output 422K Output includes 8,500 reasoning",
    )
    expect(await kpi("Cache hit rate")).toBe(
      "Cache hit rate 71.6% 3.16M read from cache of 4.41M input",
    )
    expect(await kpi("Equivalent cost")).toBe(
      "Equivalent cost $17.81 At API list prices; your plans are flat. 1 model unpriced",
    )
    for (const name of ["Requests", "Tokens", "Cache hit rate", "Equivalent cost"]) {
      within(screen.getByRole("region", { name })).getByRole("img", {
        name: `${name} over the last 7 days`,
      })
    }
    expect(daemon.usageCalls).toContain("summary?range=7d&tz=Asia%2FTokyo")
  })

  it("show dashes, not zeros dressed as rates, when nothing went through the proxy", async () => {
    show(threeAccounts())
    expect(await kpi("Requests")).toBe("Requests 0 — success 0 failed · 0 limited · 0 incomplete")
    expect(await kpi("Cache hit rate")).toBe("Cache hit rate — 0 read from cache of 0 input")
    expect(await kpi("Equivalent cost")).toBe(
      "Equivalent cost $0.00 At API list prices; your plans are flat.",
    )
  })
})

const range = () => screen.getByRole("group", { name: "Range" })
const pressed = (name: string) =>
  within(range()).getByRole("button", { name }).getAttribute("aria-pressed")

describe("the range", () => {
  it("is 7d by default, kept in the address when another is picked, and asked of the daemon", async () => {
    const daemon = withUsage()
    show(daemon)
    await kpi("Requests")
    const options = within(range()).getAllByRole("button")
    expect(options.map(textOf)).toEqual(["6h", "24h", "7d", "30d", "90d", "Custom", "Lifetime"])
    expect(pressed("7d")).toBe("true")

    fireEvent.click(within(range()).getByRole("button", { name: "Lifetime" }))
    expect(location.search).toBe("?range=lifetime")
    await waitFor(async () => expect(await kpi("Requests")).toMatch(/^Requests 5 /))
    expect(daemon.usageCalls).toContain("summary?range=lifetime&tz=Asia%2FTokyo")

    fireEvent.click(within(range()).getByRole("button", { name: "6h" }))
    await waitFor(async () => expect(await kpi("Requests")).toMatch(/^Requests 3 /))

    fireEvent.click(within(range()).getByRole("button", { name: "7d" }))
    expect(location.search).toBe("")
  })

  it("opens on the range in the address", async () => {
    window.history.replaceState(null, "", "/?range=24h")
    const daemon = withUsage()
    show(daemon)
    expect(await kpi("Requests")).toMatch(/^Requests 4 /)
    expect(pressed("24h")).toBe("true")
    expect(daemon.usageCalls).toContain("summary?range=24h&tz=Asia%2FTokyo")
  })

  it("takes a custom range of two calendar days", async () => {
    const daemon = withUsage()
    show(daemon)
    await kpi("Requests")
    fireEvent.click(within(range()).getByRole("button", { name: "Custom" }))
    const popup = await screen.findByRole("dialog", { name: "Custom range" })
    fireEvent.change(within(popup).getByLabelText("From"), { target: { value: "2026-11-09" } })
    fireEvent.change(within(popup).getByLabelText("To"), { target: { value: "2026-11-10" } })
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }))

    expect(location.search).toBe("?range=custom&from=2026-11-09&to=2026-11-10")
    await waitFor(async () => expect(await kpi("Requests")).toMatch(/^Requests 1 /))
    expect(daemon.usageCalls).toContain(
      "summary?range=custom&from=2026-11-09&to=2026-11-10&tz=Asia%2FTokyo",
    )
    expect(pressed("Nov 9 – Nov 10")).toBe("true")
  })
})

const card = (name: string) => screen.getByRole("region", { name })
const findCard = (name: string) => screen.findByRole("region", { name })

describe("the token trend", () => {
  it("shows equivalent cost by default, priced models only, and tokens when switched, kept in the address", async () => {
    const daemon = withUsage()
    show(daemon)
    const trend = await screen.findByRole("region", { name: "Token trend" })
    expect(textOf(within(trend).getByRole("heading"))).toBe("Token trend")
    await within(trend).findByText("Equivalent cost per 3 hours by model, the last 7 days")
    const metric = within(trend).getByRole("group", { name: "Measure token trend in" })
    expect(within(metric).getByRole("button", { name: "Cost" }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    // gpt-6.1-sol has no price, so it has no cost to show.
    expect(
      within(within(trend).getByRole("list", { name: "Models" }))
        .getAllByRole("listitem")
        .map(textOf),
    ).toEqual(["claude-opus-5-5"])
    expect(daemon.usageCalls).toContain("series?range=7d&tz=Asia%2FTokyo&by=model&metric=cost")

    const chart = within(trend).getByRole("group", { name: /^Token trend by model/ })
    chart.focus()
    fireEvent.keyDown(chart, { key: "ArrowLeft" })
    fireEvent.keyDown(chart, { key: "ArrowLeft" })
    // 1000 uncached at $5, 9000 cache read at $0.50 and 2000 output at $25 per million: $0.0595.
    expect(textOf(within(trend).getByRole("tooltip"))).toBe(
      "$0.06 Nov 17, 12:00 PM – 3:00 PM $0.06 claude-opus-5-5",
    )

    fireEvent.click(within(trend).getByRole("button", { name: "Table" }))
    expect(tableOf(within(trend).getByRole("table", { name: "Token trend by model" }))).toEqual([
      { When: "Nov 17, 9:00 AM – 12:00 PM", "claude-opus-5-5": "$17.75", Total: "$17.75" },
      { When: "Nov 17, 12:00 PM – 3:00 PM", "claude-opus-5-5": "$0.06", Total: "$0.06" },
    ])

    fireEvent.click(within(metric).getByRole("button", { name: "Tokens" }))
    expect(location.search).toBe("?metric=tokens")
    await within(trend).findByText("Tokens per 3 hours by model, the last 7 days")
    expect(daemon.usageCalls).toContain("series?range=7d&tz=Asia%2FTokyo&by=model&metric=tokens")
    fireEvent.click(within(metric).getByRole("button", { name: "Cost" }))
    expect(location.search).toBe("")
  })

  it("stacks each bucket's tokens by model, with a legend, a tooltip per column from the keyboard, and a table", async () => {
    window.history.replaceState(null, "", "/?metric=tokens")
    show(withUsage())
    const trend = await screen.findByRole("region", { name: "Token trend" })
    await within(trend).findByText("Tokens per 3 hours by model, the last 7 days")
    expect(
      within(within(trend).getByRole("list", { name: "Models" }))
        .getAllByRole("listitem")
        .map(textOf),
    ).toEqual(["claude-opus-5-5", "gpt-6.1-sol"])

    const chart = within(trend).getByRole("group", { name: /^Token trend by model/ })
    chart.focus()
    fireEvent.keyDown(chart, { key: "ArrowLeft" })
    // The newest bucket, 3:00 PM – 6:00 PM, had only the failed request.
    expect(textOf(within(trend).getByRole("tooltip"))).toBe("0 tokens Nov 17, 3:00 PM – 6:00 PM")
    fireEvent.keyDown(chart, { key: "ArrowLeft" })
    expect(textOf(within(trend).getByRole("tooltip"))).toBe(
      "12K tokens Nov 17, 12:00 PM – 3:00 PM 12K claude-opus-5-5",
    )
    for (let step = 0; step < 6; step++) fireEvent.keyDown(chart, { key: "ArrowLeft" })
    // 7:00 PM yesterday is in the 6:00 PM – 9:00 PM bucket.
    expect(textOf(within(trend).getByRole("tooltip"))).toBe(
      "220K tokens Nov 16, 6:00 PM – 9:00 PM 220K gpt-6.1-sol",
    )
    fireEvent.blur(chart)
    expect(within(trend).queryByRole("tooltip")).toBeNull()

    fireEvent.click(within(trend).getByRole("button", { name: "Table" }))
    expect(tableOf(within(trend).getByRole("table", { name: "Token trend by model" }))).toEqual([
      {
        When: "Nov 16, 6:00 PM – 9:00 PM",
        "claude-opus-5-5": "0",
        "gpt-6.1-sol": "220K",
        Total: "220K",
      },
      {
        When: "Nov 17, 9:00 AM – 12:00 PM",
        "claude-opus-5-5": "4.6M",
        "gpt-6.1-sol": "0",
        Total: "4.6M",
      },
      {
        When: "Nov 17, 12:00 PM – 3:00 PM",
        "claude-opus-5-5": "12K",
        "gpt-6.1-sol": "0",
        Total: "12K",
      },
    ])
  })

  it("names the three largest models and adds the rest up as Other, once Other holds two or more", async () => {
    window.history.replaceState(null, "", "/?metric=tokens")
    const daemon = threeAccounts()
    const models = ["model-a", "model-b", "model-c", "model-d", "model-e"]
    daemon.usage = models.map((model, i) =>
      usageRow({ at: NOW - 2 * HOUR, model, tokens: { output: (5 - i) * 1000 } }),
    )
    show(daemon)
    const trend = await screen.findByRole("region", { name: "Token trend" })
    const legend = await within(trend).findByRole("list", { name: "Models" })
    expect(within(legend).getAllByRole("listitem").map(textOf)).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "Other 2 models",
    ])
    expect(within(legend).getByText("Other").closest("li")?.getAttribute("title")).toBe(
      "model-d, model-e",
    )
    fireEvent.click(within(trend).getByRole("button", { name: "Table" }))
    expect(tableOf(within(trend).getByRole("table", { name: "Token trend by model" }))).toEqual([
      {
        When: "Nov 17, 12:00 PM – 3:00 PM",
        "model-a": "5,000",
        "model-b": "4,000",
        "model-c": "3,000",
        Other: "3,000",
        Total: "15K",
      },
    ])
  })

  it("names a fourth model rather than calling it Other", async () => {
    window.history.replaceState(null, "", "/?metric=tokens")
    const daemon = threeAccounts()
    daemon.usage = ["model-a", "model-b", "model-c", "model-d"].map((model) =>
      usageRow({ at: NOW - 2 * HOUR, model, tokens: { output: 1000 } }),
    )
    show(daemon)
    const trend = await screen.findByRole("region", { name: "Token trend" })
    const legend = await within(trend).findByRole("list", { name: "Models" })
    expect(within(legend).getAllByRole("listitem").map(textOf)).toEqual([
      "model-a",
      "model-b",
      "model-c",
      "model-d",
    ])
  })

  it("says so when nothing priced, or no tokens, went through the proxy in the range", async () => {
    show(threeAccounts())
    const trend = await screen.findByRole("region", { name: "Token trend" })
    expect(await within(trend).findByText("No priced usage in the last 7 days.")).toBeDefined()
    fireEvent.click(within(trend).getByRole("button", { name: "Tokens" }))
    expect(await within(trend).findByText("No tokens in the last 7 days.")).toBeDefined()
  })
})

describe("the breakdowns", () => {
  it("list each model's tokens, equivalent cost and share, an unpriced one marked Unpriced", async () => {
    show(withUsage())
    await within(await findCard("Models")).findByRole("table")
    expect(tableOf(within(card("Models")).getByRole("table"))).toEqual([
      { Model: "claude-opus-5-5", Tokens: "4.61M", "Equivalent cost": "$17.81", Share: "95.4%" },
      { Model: "gpt-6.1-sol", Tokens: "220K", "Equivalent cost": "Unpriced", Share: "4.6%" },
    ])
  })

  it("list each account's requests, tokens, equivalent cost and share, a removed one by its last name", async () => {
    const daemon = withUsage()
    daemon.usage.push(
      usageRow({ at: NOW - 3 * HOUR, accountId: "gone", tokens: { uncached: 100, output: 100 } }),
      usageRow({ at: NOW - 3 * HOUR, accountId: "lost", tokens: { uncached: 50, output: 50 } }),
    )
    daemon.formerAccounts.push({
      id: "gone",
      provider: "claude",
      label: "Old work",
      email: "old@example.com",
      plan: "Max",
      removedAt: NOW - HOUR,
    })
    show(daemon)
    await within(await findCard("Accounts")).findByRole("table")
    expect(tableOf(within(card("Accounts")).getByRole("table"))).toEqual([
      {
        Account: "Home , Active",
        Requests: "1",
        Tokens: "4.6M",
        "Equivalent cost": "$17.75",
        Share: "95%",
      },
      {
        Account: "carol , Active",
        Requests: "1",
        Tokens: "220K",
        "Equivalent cost": "Unpriced",
        Share: "5%",
      },
      {
        Account: "Work , Active",
        Requests: "2",
        Tokens: "12K",
        "Equivalent cost": "$0.06",
        Share: "<1%",
      },
      {
        Account: "Old work Removed",
        Requests: "1",
        Tokens: "200",
        "Equivalent cost": "<$0.01",
        Share: "<1%",
      },
      {
        Account: "Removed account",
        Requests: "1",
        Tokens: "100",
        "Equivalent cost": "<$0.01",
        Share: "<1%",
      },
    ])

    fireEvent.click(within(card("Accounts")).getByRole("button", { name: /^carol/ }))
    await screen.findByRole("dialog", { name: "carol" })
  })

  it("name an account renamed and then removed by its last name, without waiting for new usage", async () => {
    const daemon = withUsage()
    show(daemon)
    const accounts = await findCard("Accounts")
    await within(accounts).findByRole("button", { name: /^Work/ })
    daemon.update("a1", { label: "Office" })
    await within(accounts).findByRole("button", { name: /^Office/ })
    daemon.forget("a1")
    await waitFor(() =>
      expect(
        tableOf(within(card("Accounts")).getByRole("table")).map((row) => row["Account"]),
      ).toContain("Office Removed"),
    )
  })
})

const MIN = 60_000

/** Work with a Fable weekly window, Home used up and three hours stale, carol on Codex's two. */
const withLimits = (daemon: FakeDaemon) => {
  daemon.limits = [
    {
      accountId: "a1",
      asOf: NOW - 2 * MIN,
      windows: [
        // Out of order: the page orders them.
        {
          id: "weekly:Fable",
          label: "Fable weekly",
          usedPct: 92.4,
          resetsAt: NOW + 50 * HOUR,
          asOf: NOW - 2 * MIN,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 71,
          resetsAt: NOW + 74 * HOUR,
          asOf: NOW - 2 * MIN,
        },
        {
          id: "five-hour",
          label: "5-hour",
          usedPct: 41.8,
          resetsAt: NOW + 134 * MIN,
          asOf: NOW - 2 * MIN,
        },
      ],
    },
    {
      accountId: "a2",
      asOf: NOW - 3 * HOUR,
      windows: [
        {
          id: "five-hour",
          label: "5-hour",
          usedPct: 100,
          resetsAt: NOW + 47 * MIN,
          asOf: NOW - 3 * HOUR,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 35,
          resetsAt: NOW + 30 * HOUR,
          asOf: NOW - 3 * HOUR,
        },
      ],
    },
    {
      accountId: "c1",
      asOf: NOW - MIN,
      windows: [
        {
          id: "five-hour",
          label: "5-hour",
          usedPct: 12,
          resetsAt: NOW + 4 * HOUR,
          asOf: NOW - MIN,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 50,
          resetsAt: NOW + 6 * 24 * HOUR,
          asOf: NOW - MIN,
        },
      ],
    },
  ]
  return daemon
}

describe("the limit windows", () => {
  it("show every account's windows in one table, a column for each window any account reports, — where an account has none and a blank where its provider has no such window", async () => {
    show(withLimits(threeAccounts()))
    const limits = await findCard("Limit windows")
    const table = within(limits).getByRole("table", { name: "Limit windows" })
    await waitFor(() => expect(tableOf(table)[0]?.["5-hour"]).toBe("58% left resets in 2h 14m"))
    expect(tableOf(table)).toEqual([
      {
        Account: "Work , Active",
        "5-hour": "58% left resets in 2h 14m",
        Weekly: "29% left resets in 3d 2h",
        "Fable weekly": "7% left resets in 2d 2h",
      },
      {
        Account: "Home , Active",
        "5-hour": "Used up resets in 47m",
        Weekly: "65% left resets in 1d 6h",
        "Fable weekly": "—",
      },
      {
        Account: "carol , Active",
        "5-hour": "88% left resets in 4h 0m",
        Weekly: "50% left resets in 6d 0h",
        // Codex has no Fable weekly window: blank, not "not read yet".
        "Fable weekly": "",
      },
    ])
  })

  it("dim numbers older than an hour, and say when they are from on focus", async () => {
    show(withLimits(threeAccounts()))
    const limits = await findCard("Limit windows")
    const used = await within(limits).findByText("Used up")
    const cell = used.parentElement
    if (cell === null) throw new Error("No cell")
    expect(cell.tabIndex).toBe(0)
    cell.focus()
    await screen.findByText("As of 12:00 PM (3 hr ago)")
    // Fresh numbers take no stop in the tab order.
    expect(within(limits).getByText("58% left").parentElement?.tabIndex).toBe(-1)
  })

  it("link to Accounts", async () => {
    show(withLimits(threeAccounts()))
    fireEvent.click(within(await findCard("Limit windows")).getByRole("link", { name: "Accounts" }))
    expect(location.pathname).toBe("/accounts")
    await screen.findByRole("table", { name: "Claude accounts" })
  })
})

const live = () => textOf(screen.getByText(/^(Live|Offline)$/))

describe("live updates", () => {
  it("refetch the KPIs within about a second of a request finishing, once for a burst, and the charts later", async () => {
    const daemon = withUsage()
    show(daemon)
    expect(await kpi("Requests")).toMatch(/^Requests 4 /)
    const models = await within(await findCard("Models")).findByRole("table")
    const summaries = () => daemon.usageCalls.filter((call) => call.startsWith("summary")).length
    const before = summaries()

    for (let i = 0; i < 3; i++) {
      daemon.record(
        usageRow({ at: NOW, accountId: "a1", tokens: { uncached: 10_000, output: 1000 } }),
      )
    }
    await waitFor(async () => expect(await kpi("Requests")).toMatch(/^Requests 7 /), {
      timeout: 2500,
    })
    expect(summaries()).toBe(before + 1)
    // Breakdowns wait up to 15 seconds after their last load.
    expect(tableOf(models)[0]?.["Tokens"]).toBe("4.61M")
  })

  it("show new KPIs while requests keep finishing, though each answer takes longer than the throttle", async () => {
    const daemon = withUsage()
    daemon.usageDelayMs = 80
    show(daemon, { kpis: 20 })
    expect(await kpi("Requests")).toMatch(/^Requests 4 /)
    let moved = false
    for (let i = 0; i < 15 && !moved; i++) {
      daemon.record(usageRow({ at: NOW, accountId: "a1", tokens: { uncached: 10 } }))
      // oxlint-disable-next-line no-await-in-loop -- requests finish one after another
      await new Promise((resolve) => setTimeout(resolve, 30))
      // oxlint-disable-next-line no-await-in-loop -- read between requests
      moved = !(await kpi("Requests")).startsWith("Requests 4 ")
    }
    expect(moved).toBe(true)
  })

  it("refetch the charts and breakdowns too, at their own pace", async () => {
    const daemon = withUsage()
    show(daemon, { kpis: 50, charts: 300 })
    await within(await findCard("Models")).findByRole("table")
    daemon.record(usageRow({ at: NOW, accountId: "a1", tokens: { uncached: 1_000_000 } }))
    await waitFor(() =>
      expect(tableOf(within(card("Models")).getByRole("table"))[0]?.["Tokens"]).toBe("5.61M"),
    )
  })

  it("move the limit bars as the daemon reports new numbers", async () => {
    const daemon = withLimits(threeAccounts())
    show(daemon)
    const claude = within(await findCard("Limit windows")).getByRole("table", {
      name: "Limit windows",
    })
    await waitFor(() => expect(tableOf(claude)[0]?.["5-hour"]).toBe("58% left resets in 2h 14m"))
    daemon.setLimits("a1", [
      { id: "five-hour", label: "5-hour", usedPct: 44, resetsAt: NOW + 134 * MIN },
      { id: "weekly", label: "Weekly", usedPct: 72, resetsAt: NOW + 74 * HOUR },
    ])
    await waitFor(() => expect(tableOf(claude)[0]?.["5-hour"]).toBe("56% left resets in 2h 14m"))
    // No account reports a Fable weekly window any more, so its column goes.
    expect(Object.keys(tableOf(claude)[0] ?? {})).toEqual(["Account", "5-hour", "Weekly"])
  })

  it("say how long ago the last request finished", async () => {
    const daemon = threeAccounts()
    show(daemon)
    await kpi("Requests")
    expect(live()).toBe("Live · no requests yet")
    daemon.record(usageRow({ at: NOW - 4000, accountId: "a1" }))
    await waitFor(() => expect(live()).toBe("Live · last request 4s ago"))
    daemon.reachable = false
    await waitFor(() => expect(live()).toBe("Offline · last request 4s ago"))
  })
})
