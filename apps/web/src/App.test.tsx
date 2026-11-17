import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon } from "./test/fake-daemon.ts"

// The dashboard against a fake daemon API, found the way a user (or a screen
// reader) finds things: by ARIA role and accessible name.

afterEach(cleanup)

const show = (daemon: FakeDaemon) => render(<App fetch={daemon.fetch} pollInterval={20} />)

/** The text a cell shows, its pieces separated by single spaces. */
const textOf = (element: Element): string => {
  const pieces: Array<string> = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text) pieces.push(text)
  }
  return pieces.join(" ")
}

/** Each body row of `table` as { column header: cell text }. */
const rowsOf = (table: HTMLElement) => {
  const [head, ...body] = within(table).getAllByRole("row")
  const headers = within(head!)
    .getAllByRole("columnheader")
    .map((th) => th.getAttribute("aria-label") ?? textOf(th))
  return body.map((row) =>
    Object.fromEntries(
      within(row)
        .getAllByRole("cell")
        .map((cell, index) => [headers[index], textOf(cell)]),
    ),
  )
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

describe("accounts page", () => {
  it("shows each pool's accounts in priority order with status, plan, and who gets new sessions", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({
            id: "a3",
            label: "Spare",
            plan: "Pro",
            priority: 3,
            enabled: false,
            status: "disabled",
          }),
          account({
            id: "a1",
            label: "Work",
            email: "me@work.example",
            plan: "Max 20x",
            priority: 1,
            lastUsedAt: minutesAgo(4),
          }),
          account({
            id: "a2",
            label: "Personal Max",
            email: "me@home.example",
            plan: "Max 5x",
            priority: 2,
            status: "needs-sign-in",
          }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
      }),
    )

    const claude = await screen.findByRole("region", { name: "Claude" })
    expect(within(claude).getByText(/New sessions go to/).textContent).toBe(
      "New sessions go to Work",
    )
    expect(rowsOf(within(claude).getByRole("table", { name: "Claude accounts" }))).toEqual([
      {
        Priority: "1",
        Account: "Work New sessions me@work.example",
        Plan: "Max 20x",
        Status: "Active",
        "Last used": "4 min ago",
        Enabled: "",
        Actions: "",
      },
      {
        Priority: "2",
        Account: "Personal Max me@home.example",
        Plan: "Max 5x",
        Status: "Needs sign-in",
        "Last used": "Never",
        Enabled: "",
        Actions: "",
      },
      {
        Priority: "3",
        Account: "Spare spare@example.com",
        Plan: "Pro",
        Status: "Disabled",
        "Last used": "Never",
        Enabled: "",
        Actions: "",
      },
    ])
    expect(
      ["Work", "Personal Max", "Spare"].map((label) =>
        screen.getByRole("switch", { name: `${label} enabled` }).getAttribute("aria-checked"),
      ),
    ).toEqual(["true", "true", "false"])
  })
})

describe("sidebar", () => {
  it("counts accounts that need sign-in and says who gets each pool's new sessions", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({ id: "a1", label: "Work", priority: 1 }),
          account({ id: "a2", label: "Home", priority: 2, status: "needs-sign-in" }),
          account({ id: "a3", label: "Old", priority: 3, status: "needs-sign-in" }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
      }),
    )
    const nav = screen.getByRole("navigation", { name: "Dashboard" })
    expect(
      (await within(nav).findByRole("link", { name: "Accounts 2 need sign-in" })).getAttribute(
        "aria-current",
      ),
    ).toBe("page")
    expect(
      within(within(nav).getByRole("list", { name: "Pools" }))
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Claude: new sessions go to Work"])
  })

  it("shows a pool whose enabled accounts all need sign-in as unavailable, in the strip and its section", async () => {
    show(
      fakeDaemon({
        accounts: [
          account({ id: "a1", label: "Work", status: "needs-sign-in" }),
          account({ id: "a2", label: "Spare", priority: 2, enabled: false, status: "disabled" }),
        ],
        pools: [{ provider: "claude", newSessionsAccountId: null }],
      }),
    )
    const claude = await screen.findByRole("region", { name: "Claude" })
    expect(within(claude).getByText("No account can take new sessions")).toBeDefined()
    expect(within(claude).getByText(/Every enabled Claude account needs sign-in/)).toBeDefined()
    expect(
      screen.getByRole("listitem", { name: "Claude: no account can take new sessions" }),
    ).toBeDefined()
  })

  it("shows a pool whose accounts are all disabled as off", async () => {
    show(
      fakeDaemon({
        accounts: [account({ id: "a1", label: "Work", enabled: false, status: "disabled" })],
        pools: [{ provider: "claude", newSessionsAccountId: null }],
      }),
    )
    const claude = await screen.findByRole("region", { name: "Claude" })
    expect(within(claude).getByText("Every Claude account is disabled")).toBeDefined()
    expect(
      screen.getByRole("listitem", { name: "Claude: every account is disabled" }),
    ).toBeDefined()
    expect(screen.getByRole("link", { name: "Accounts 1" })).toBeDefined()
  })
})

describe("first run", () => {
  it("walks through adding an account and connecting clients while the daemon holds none", async () => {
    show(fakeDaemon())
    const steps = await screen.findByRole("list", { name: "Get started" })
    expect(
      within(steps)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Add an account", "Connect your clients", "Add a fallback"])
    for (const command of [
      "agent-proxy accounts add claude",
      "agent-proxy connect claude-code",
      "agent-proxy connect codex",
      "agent-proxy connect opencode",
    ]) {
      within(steps).getByRole("button", { name: `Copy ${command}` })
    }
    within(steps).getByText("127.0.0.1:8318")
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.queryByRole("list", { name: "Pools" })).toBeNull()
  })
})

describe("when the daemon stops answering", () => {
  it("says so, and keeps showing what it last reported, read-only", async () => {
    const daemon = fakeDaemon({
      accounts: [account({ id: "a1", label: "Work" })],
      pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
    })
    show(daemon)
    await screen.findByRole("table", { name: "Claude accounts" })
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByRole("button", { name: "Actions for Work" }).hasAttribute("disabled")).toBe(
      false,
    )

    daemon.reachable = false
    const banner = await screen.findByRole("status")
    expect(banner.textContent).toContain("Can't reach the daemon at 127.0.0.1:8318.")
    expect(banner.textContent).toContain("This is what it last reported")
    screen.getByRole("table", { name: "Claude accounts" })
    screen.getByRole("listitem", { name: "Claude: new sessions go to Work" })
    expect(screen.getByRole("button", { name: "Actions for Work" }).hasAttribute("disabled")).toBe(
      true,
    )
    screen.getByRole("button", { name: "This Mac Unreachable" })

    daemon.reachable = true
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
    screen.getByRole("button", { name: "This Mac 127.0.0.1:8318" })
  })

  it("treats a daemon that stops answering mid-request as unreachable, and recovers", async () => {
    const daemon = fakeDaemon({
      accounts: [account({ id: "a1", label: "Work" })],
      pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
    })
    render(<App fetch={daemon.fetch} pollInterval={20} requestTimeout={50} />)
    await screen.findByRole("table", { name: "Claude accounts" })

    daemon.stalled = true
    const banner = await screen.findByRole("status")
    expect(banner.textContent).toContain("Can't reach the daemon")
    screen.getByRole("table", { name: "Claude accounts" })

    daemon.stalled = false
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
  })

  it("shows the error the daemon answers with", async () => {
    const daemon = fakeDaemon()
    daemon.refusal = "The daemon API is served to clients on this machine only."
    show(daemon)
    expect((await screen.findByRole("status")).textContent).toBe(
      "The daemon answered with an error. The daemon API is served to clients on this machine only.",
    )
  })

  it("shows only the banner when it never answered", async () => {
    const daemon = fakeDaemon()
    daemon.reachable = false
    show(daemon)
    const banner = await screen.findByRole("status")
    expect(banner.textContent).not.toContain("last reported")
    expect(screen.queryByRole("list", { name: "Get started" })).toBeNull()
  })
})

describe("Connect clients", () => {
  it("lists each client's connect command and the proxy key, masked until revealed, each one copyable", async () => {
    const daemon = fakeDaemon({
      accounts: [account({ id: "a1", label: "Work" })],
      pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
    })
    show(daemon)
    fireEvent.click(screen.getByRole("button", { name: "Connect clients" }))
    const dialog = await screen.findByRole("dialog", { name: "Connect clients" })

    for (const command of [
      "agent-proxy connect claude-code",
      "agent-proxy connect codex",
      "agent-proxy connect opencode",
    ]) {
      within(dialog).getByText(command)
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy agent-proxy connect codex" }))
    await within(dialog).findByRole("button", { name: "Copied" })
    expect(await navigator.clipboard.readText()).toBe("agent-proxy connect codex")

    const key = await within(dialog).findByLabelText("Proxy key", { exact: true })
    expect(key.textContent).toBe("ap-Zx8••••••••••••••••q8Bs")
    expect(dialog.textContent).not.toContain(daemon.key)
    const reveal = within(dialog).getByRole("button", { name: "Reveal" })
    fireEvent.click(reveal)
    expect(key.textContent).toBe(daemon.key)
    expect(reveal.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide" }))
    expect(key.textContent).toBe("ap-Zx8••••••••••••••••q8Bs")

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy proxy key" }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(daemon.key))

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})

describe("daemon switcher", () => {
  it("shows the daemon's address, version and uptime, and copies the address", async () => {
    show(fakeDaemon())
    fireEvent.click(await screen.findByRole("button", { name: "This Mac 127.0.0.1:8318" }))
    const popup = await screen.findByRole("dialog", { name: "Running" })
    expect(within(popup).getByText("Address").nextElementSibling?.textContent).toBe(
      "127.0.0.1:8318",
    )
    expect(within(popup).getByText("Version").nextElementSibling?.textContent).toBe("v0.0.0")
    expect(within(popup).getByText("Uptime").nextElementSibling?.textContent).toBe("1h 30m")
    fireEvent.click(within(popup).getByRole("button", { name: "Copy address" }))
    await within(popup).findByRole("button", { name: "Copied" })
    expect(await navigator.clipboard.readText()).toBe("http://127.0.0.1:8318")
  })
})
