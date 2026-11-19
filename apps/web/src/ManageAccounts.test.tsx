import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { App } from "./App.tsx"
import { account, type FakeDaemon, fakeDaemon } from "./test/fake-daemon.ts"
import { rowsOf } from "./test/queries.ts"

// Managing accounts from the dashboard, against a fake daemon API that
// applies each change the way the daemon does. A change counts as made when
// the daemon holds it and the page shows it.

// These tests drive the Accounts page, which lives at `/accounts`.
beforeEach(() => window.history.replaceState(null, "", "/accounts"))
afterEach(cleanup)

/** Work (1, gets new sessions), Home (2) and Spare (3, disabled), all Claude. */
const threeAccounts = () =>
  fakeDaemon({
    accounts: [
      account({ id: "a1", label: "Work", priority: 1 }),
      account({ id: "a2", label: "Home", priority: 2 }),
      account({ id: "a3", label: "Spare", priority: 3, enabled: false, status: "disabled" }),
    ],
    pools: [{ provider: "claude", newSessionsAccountId: "a1" }],
  })

const show = async (daemon: FakeDaemon) => {
  render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} />)
  return screen.findByRole("table", { name: "Claude accounts" })
}

/** Who gets the Claude pool's new sessions, as its header says, without the accounts after. */
const poolLine = () =>
  within(screen.getByRole("region", { name: "Claude" }))
    .getByText(/New sessions go to|No account/)
    .textContent?.replace(/ · then .*$/, "")

const stored = (daemon: FakeDaemon) =>
  daemon.accounts
    .toSorted((a, b) => a.priority - b.priority)
    .map((a) => `${a.priority} ${a.label}${a.enabled ? "" : " (off)"}`)

const rowOf = (table: HTMLElement, label: string) =>
  within(table).getByText(label).closest("tr") ?? undefined

/** The text of the notice titled `title`. */
const notice = async (title: string) => {
  const region = screen.getByRole("region", { name: "Notifications" })
  const found = await within(region).findByRole("dialog", { name: title })
  return found.textContent
}

const sheet = (name: string) => screen.findByRole("dialog", { name })

const openSheet = async (table: HTMLElement, label: string) => {
  fireEvent.click(within(table).getByRole("button", { name: label }))
  return sheet(label)
}

const priorityIn = (opened: HTMLElement) =>
  within(opened).getByText("Priority").nextElementSibling?.textContent

const labels = (table: HTMLElement) => rowsOf(table).map((row) => row["Account"]?.split(" ")[0])

describe("enabled switch", () => {
  it("disables and enables an account, and the pool moves its new sessions", async () => {
    const daemon = threeAccounts()
    await show(daemon)

    fireEvent.click(screen.getByRole("switch", { name: "Work enabled" }))
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Home"))
    expect(stored(daemon)).toEqual(["1 Work (off)", "2 Home", "3 Spare (off)"])
    expect(screen.getByRole("switch", { name: "Work enabled" }).getAttribute("aria-checked")).toBe(
      "false",
    )

    fireEvent.click(screen.getByRole("switch", { name: "Spare enabled" }))
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Spare enabled" }).getAttribute("aria-checked"),
      ).toBe("true"),
    )
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Work (off)", "2 Home", "3 Spare"]))
    expect(labels(screen.getByRole("table", { name: "Claude accounts" }))).toEqual([
      "Work",
      "Home",
      "Spare",
    ])
  })
})

describe("rename", () => {
  it("renames an account when its label is double-clicked, edited and confirmed with Enter", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.doubleClick(within(table).getByText("Work"))
    const input = within(table).getByRole("textbox", { name: "Label for Work" })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: "  Main  " } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(within(table).queryByRole("textbox")).toBeNull()
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Main"))
    expect(labels(table)).toEqual(["Main", "Home", "Spare"])
    expect(stored(daemon)).toEqual(["1 Main", "2 Home", "3 Spare (off)"])
  })

  it("keeps the label when the edit is cancelled with Escape, left unchanged, or left blank", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.doubleClick(within(table).getByText("Work"))
    const first = within(table).getByRole("textbox", { name: "Label for Work" })
    fireEvent.change(first, { target: { value: "Main" } })
    fireEvent.keyDown(first, { key: "Escape" })

    fireEvent.doubleClick(within(table).getByText("Work"))
    fireEvent.blur(within(table).getByRole("textbox", { name: "Label for Work" }))

    fireEvent.doubleClick(within(table).getByText("Work"))
    const third = within(table).getByRole("textbox", { name: "Label for Work" })
    fireEvent.change(third, { target: { value: "   " } })
    fireEvent.keyDown(third, { key: "Enter" })

    expect(within(table).queryByRole("textbox")).toBeNull()
    expect(labels(table)).toEqual(["Work", "Home", "Spare"])
    expect(daemon.changes).toEqual([])
  })
})

/** Each row as "<priority> <label>", top to bottom. */
const priorities = (table: HTMLElement) =>
  rowsOf(table).map((row) => `${row["Priority"]} ${row["Account"]?.split(" ")[0]}`)

/** The Claude pool's header line, whole. */
const poolText = () =>
  within(screen.getByRole("region", { name: "Claude" })).getByText(/New sessions go to/).textContent

describe("reorder", () => {
  it("steps an account with the arrow keys, sharing the next priority over, then passing it", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    const home = within(table).getByRole("button", { name: "Reorder Home" })
    home.focus()
    fireEvent.keyDown(home, { key: "ArrowUp" })
    expect(priorities(table)).toEqual(["1 Work", "1 Home", "2 Spare"])
    expect(document.activeElement).toBe(home)
    screen.getByText("Home now shares priority 1 with Work.")
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Work", "1 Home", "2 Spare (off)"]))
    await waitFor(() => expect(poolText()).toBe("New sessions go to Work · then Home"))

    fireEvent.keyDown(home, { key: "ArrowUp" })
    expect(priorities(table)).toEqual(["1 Home", "2 Work", "3 Spare"])
    screen.getByText("Home moved to priority 1 of 3.")
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Home"))
    expect(stored(daemon)).toEqual(["1 Home", "2 Work", "3 Spare (off)"])

    // Nothing is past either end.
    fireEvent.keyDown(home, { key: "ArrowUp" })
    fireEvent.keyDown(within(table).getByRole("button", { name: "Reorder Spare" }), {
      key: "ArrowDown",
    })
    expect(daemon.changes).toHaveLength(2)

    fireEvent.keyDown(home, { key: "ArrowDown" })
    fireEvent.keyDown(home, { key: "ArrowDown" })
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Work", "2 Home", "3 Spare (off)"]))
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Work"))
    expect(priorities(table)).toEqual(["1 Work", "2 Home", "3 Spare"])
  })
})

/**
 * Moves a dragged row's pointer over `label`'s row: near its top or bottom,
 * between priorities, or across its middle, onto its priority.
 */
const dragOver = (table: HTMLElement, label: string, where: "top" | "middle" | "bottom") => {
  const row = rowOf(table, label)!
  // happy-dom lays nothing out: each row is 60px tall, 100px down the page.
  row.getBoundingClientRect = () => new DOMRect(0, 100, 800, 60)
  fireEvent.pointerMove(row, { clientY: 100 + { top: 5, middle: 30, bottom: 55 }[where] })
}

/** What the Claude pool's header says while a row is dragged. */
const dropHint = () =>
  within(screen.getByRole("region", { name: "Claude" })).getByText(/^Drop/).textContent

describe("drag to reorder", () => {
  it("moves an account between priorities, or onto one to share it, where it is dropped", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.pointerDown(within(table).getByRole("button", { name: "Reorder Spare" }), {
      button: 0,
      pointerId: 1,
    })
    dragOver(table, "Home", "top")
    expect(dropHint()).toBe("Drop to move to priority 2")
    expect(rowOf(table, "Home")?.classList.contains("is-drop-above")).toBe(true)
    dragOver(table, "Work", "top")
    expect(dropHint()).toBe("Drop to move to priority 1")
    // Rows stay put while dragging; a line marks where the row would land.
    expect(labels(table)).toEqual(["Work", "Home", "Spare"])
    fireEvent.pointerUp(document, { pointerId: 1 })

    await waitFor(() => expect(stored(daemon)).toEqual(["1 Spare (off)", "2 Work", "3 Home"]))
    expect(priorities(table)).toEqual(["1 Spare", "2 Work", "3 Home"])
    expect(poolLine()).toBe("New sessions go to Work")

    fireEvent.pointerDown(within(table).getByRole("button", { name: "Reorder Home" }), {
      button: 0,
      pointerId: 2,
    })
    dragOver(table, "Work", "middle")
    expect(dropHint()).toBe("Drop to share priority 2 with Work")
    expect(rowOf(table, "Work")?.classList.contains("is-drop-share")).toBe(true)
    fireEvent.pointerUp(document, { pointerId: 2 })
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Spare (off)", "2 Work", "2 Home"]))
    expect(priorities(table)).toEqual(["1 Spare", "2 Work", "2 Home"])
    await waitFor(() => expect(poolText()).toBe("New sessions go to Work · then Home"))
  })

  it("does not open the sheet of the row a drag is dropped on", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.pointerDown(within(table).getByRole("button", { name: "Reorder Spare" }), {
      button: 0,
      pointerId: 1,
    })
    dragOver(table, "Home", "middle")
    fireEvent.pointerUp(document, { pointerId: 1 })
    // The browser follows the release with a click on the row now under it.
    fireEvent.click(within(rowOf(table, "Home")!).getByText("home@example.com"))
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Work", "2 Home", "2 Spare (off)"]))
    expect(screen.queryByRole("dialog")).toBeNull()

    // A click of its own still opens it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(within(rowOf(table, "Spare")!).getByText("spare@example.com"))
    expect(await screen.findByRole("dialog", { name: "Spare" })).toBeTruthy()
  })

  it("leaves the order alone when the drag is cancelled with Escape or dropped where it is", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.pointerDown(within(table).getByRole("button", { name: "Reorder Work" }), {
      button: 0,
      pointerId: 1,
    })
    dragOver(table, "Spare", "middle")
    expect(dropHint()).toBe("Drop to share priority 3 with Spare")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(within(table).queryByText(/^Drop/)).toBeNull()
    fireEvent.pointerUp(document, { pointerId: 1 })

    // Onto its own priority, or either side of it, it stays where it is.
    fireEvent.pointerDown(within(table).getByRole("button", { name: "Reorder Home" }), {
      button: 0,
      pointerId: 2,
    })
    for (const [label, where] of [
      ["Home", "middle"],
      ["Home", "top"],
      ["Home", "bottom"],
      ["Work", "bottom"],
      ["Spare", "top"],
    ] as const) {
      dragOver(table, label, where)
      expect(dropHint()).toBe(
        "Drop on an account to share its priority, or between priorities to move",
      )
    }
    fireEvent.pointerUp(document, { pointerId: 2 })

    expect(labels(table)).toEqual(["Work", "Home", "Spare"])
    expect(daemon.changes).toEqual([])
  })
})

/** Opens the ⋯ menu of `label`'s row and picks `item`. */
const pick = async (label: string, item: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${label}` }))
  fireEvent.click(await screen.findByRole("menuitem", { name: item }))
}

describe("row menu", () => {
  it("renames, steps an account up and down, and shares a priority picked from a submenu", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.click(screen.getByRole("button", { name: "Actions for Work" }))
    const menu = await screen.findByRole("menu")
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => `${item.textContent}${item.hasAttribute("data-disabled") ? " (off)" : ""}`),
    ).toEqual([
      "Open details",
      "Rename",
      "Refresh limits",
      "Move up (off)",
      "Move down",
      "Share priority with",
      "Remove…",
    ])
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move down" }))
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Work", "1 Home", "2 Spare (off)"]))

    await pick("Work", "Move down")
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Home"))
    expect(stored(daemon)).toEqual(["1 Home", "2 Work", "3 Spare (off)"])

    // Each priority but its own, by the accounts that hold it.
    await pick("Spare", "Share priority with")
    const submenu = (await screen.findAllByRole("menu")).at(-1)!
    expect(
      within(submenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["1Home (priority 1)", "2Work (priority 2)"])
    fireEvent.click(within(submenu).getByRole("menuitem", { name: "Home (priority 1)" }))
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Home", "1 Spare (off)", "2 Work"]))

    await pick("Home", "Rename")
    const input = await within(table).findByRole("textbox", { name: "Label for Home" })
    fireEvent.change(input, { target: { value: "Personal" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Personal"))
  })
})

describe("remove", () => {
  it("removes an account once the owner confirms, and the next account gets new sessions", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    await pick("Work", "Remove…")
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Work?" })
    expect(confirm.textContent).toContain("work@example.com")
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(daemon.changes).toEqual([])

    await pick("Work", "Remove…")
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Remove Work?" })).getByRole("button", {
        name: "Remove account",
      }),
    )
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(labels(table)).toEqual(["Home", "Spare"])
    expect(poolLine()).toBe("New sessions go to Home")
    expect(stored(daemon)).toEqual(["1 Home", "2 Spare (off)"])
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Accounts" })),
    )
  })
})

describe("when the daemon refuses a change", () => {
  it("says so when the account was removed meanwhile, and stops showing it", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    // Removed from the CLI, behind the dashboard's back.
    daemon.accounts = daemon.accounts.filter((a) => a.id !== "a2")

    fireEvent.click(screen.getByRole("switch", { name: "Home enabled" }))
    expect(await notice("Couldn't disable Home")).toContain(
      "The daemon no longer holds Home. It was removed, perhaps from the CLI.",
    )
    await waitFor(() => expect(labels(table)).toEqual(["Work", "Spare"]))
  })

  it("says so when removing an account that is already gone", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    daemon.accounts = daemon.accounts.filter((a) => a.id !== "a3")

    await pick("Spare", "Remove…")
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Spare?" })
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove account" }))
    expect(await notice("Spare was already removed")).toContain("The daemon no longer holds it")
    await waitFor(() => expect(labels(table)).toEqual(["Work", "Home"]))
  })

  it("puts back what it showed when the daemon can't be reached, and says why", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    daemon.reachable = false

    fireEvent.doubleClick(within(table).getByText("Work"))
    const input = within(table).getByRole("textbox", { name: "Label for Work" })
    fireEvent.change(input, { target: { value: "Main" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(await notice("Couldn't rename Work")).toContain("Can't reach the daemon.")
    expect(labels(table)).toEqual(["Work", "Home", "Spare"])
  })

  it("shows the daemon's own message for any other refusal", async () => {
    const daemon = threeAccounts()
    await show(daemon)
    daemon.rejection = { status: 500, message: "Could not write account a1 to /data." }

    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Work" }), { key: "ArrowDown" })
    expect(await notice("Couldn't move Work")).toContain("Could not write account a1 to /data.")
    await waitFor(() =>
      expect(labels(screen.getByRole("table", { name: "Claude accounts" }))).toEqual([
        "Work",
        "Home",
        "Spare",
      ]),
    )
  })
})

describe("account sheet", () => {
  it("opens from a row with the account's status, priority, details and pool order", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.click(within(table).getByText("home@example.com"))
    const home = await sheet("Home")
    expect(within(home).getByText("Claude pool").textContent).toBe("Claude pool")
    expect(within(home).getByRole("region", { name: "Status" }).textContent).toBe(
      "ActiveReady. Takes new sessions when Work can't.",
    )
    expect(
      within(home)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "ActivityPlanned"])
    const facts = within(home).getByRole("tabpanel", { name: "Overview" })
    expect(
      Object.fromEntries(
        within(facts)
          .getAllByRole("term")
          .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
      ),
    ).toEqual({
      Priority: "2 of 3 in the Claude pool",
      Enabled: "In the pool",
      Plan: "Pro",
      Email: "home@example.com",
      "Last used": "Never",
      Added: "Nov 1, 2026",
    })
    expect(
      within(within(home).getByRole("list", { name: "Claude pool order" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["1WorkActive", "2HomeActive", "3SpareDisabled"])
    within(home).getByRole("button", { name: "Remove…" })
  })

  it("swaps to another row's account, and closes with Escape, handing focus back to the row", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    const open = within(table).getByRole("button", { name: "Work" })
    open.focus()
    fireEvent.click(open)
    const work = await sheet("Work")
    await waitFor(() => expect(work.contains(document.activeElement)).toBe(true))
    expect(open.getAttribute("aria-expanded")).toBe("true")
    expect(within(work).getByRole("region", { name: "Status" }).textContent).toBe(
      "ActiveNew sessionsGets every new Claude session.",
    )

    fireEvent.pointerDown(within(table).getByText("spare@example.com"))
    fireEvent.click(within(table).getByText("spare@example.com"))
    await sheet("Spare")
    expect(screen.getAllByRole("dialog")).toHaveLength(1)

    fireEvent.click(within(table).getByRole("button", { name: "Work" }))
    const again = await sheet("Work")
    fireEvent.keyDown(again, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(within(table).getByRole("button", { name: "Work" }))
    expect(open.getAttribute("aria-expanded")).toBe("false")
  })

  it("closes when the owner clicks outside it, or its close button", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.click(within(table).getByText("work@example.com"))
    await sheet("Work")
    const heading = screen.getByRole("heading", { name: "Accounts", level: 1 })
    fireEvent.pointerDown(heading)
    fireEvent.mouseDown(heading)
    fireEvent.click(heading)
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    fireEvent.click(within(table).getByText("work@example.com"))
    fireEvent.click(within(await sheet("Work")).getByRole("button", { name: "Close details" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})

describe("account sheet controls", () => {
  it("moves, disables, enables and renames the account, and the table and sheet agree", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    const work = await openSheet(table, "Work")

    expect(within(work).getByRole("button", { name: "Move up" }).hasAttribute("disabled")).toBe(
      true,
    )
    fireEvent.click(within(work).getByRole("button", { name: "Move down" }))
    await waitFor(() =>
      expect(priorityIn(work)).toBe("1 of 2 in the Claude pool · shared with Home"),
    )
    await waitFor(() =>
      expect(within(work).getByRole("region", { name: "Status" }).textContent).toBe(
        "ActiveNew sessionsGets new Claude sessions while it has more room left in its limits than Home, at the same priority.",
      ),
    )
    fireEvent.click(within(work).getByRole("button", { name: "Move down" }))
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Home"))
    expect(priorityIn(work)).toBe("2 of 3 in the Claude pool")
    expect(labels(table)).toEqual(["Home", "Work", "Spare"])
    expect(within(work).getByRole("region", { name: "Status" }).textContent).toBe(
      "ActiveReady. Takes new sessions when Home can't.",
    )

    fireEvent.click(within(work).getByRole("switch", { name: "Enabled" }))
    await waitFor(() =>
      expect(within(work).getByRole("region", { name: "Status" }).textContent).toBe(
        "DisabledYou turned it off. It keeps its place in the priority order.Enable",
      ),
    )
    expect(screen.getByRole("switch", { name: "Work enabled" }).getAttribute("aria-checked")).toBe(
      "false",
    )
    expect(stored(daemon)).toEqual(["1 Home", "2 Work (off)", "3 Spare (off)"])

    fireEvent.click(within(work).getByRole("button", { name: "Enable" }))
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Home", "2 Work", "3 Spare (off)"]))

    fireEvent.click(within(work).getByRole("button", { name: "Rename" }))
    const input = within(work).getByRole("textbox", { name: "Label for Work" })
    fireEvent.change(input, { target: { value: "Main" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.getByRole("dialog", { name: "Work" })).toBe(work)
    fireEvent.doubleClick(within(work).getByRole("heading", { name: "Work" }))
    const again = within(work).getByRole("textbox", { name: "Label for Work" })
    fireEvent.change(again, { target: { value: "Main" } })
    fireEvent.keyDown(again, { key: "Enter" })
    await screen.findByRole("dialog", { name: "Main" })
    expect(labels(table)).toEqual(["Home", "Main", "Spare"])
    expect(stored(daemon)).toEqual(["1 Home", "2 Main", "3 Spare (off)"])
  })

  it("removes the account after confirmation, closes, and leaves focus on the page", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    const home = await openSheet(table, "Home")

    fireEvent.click(within(home).getByRole("button", { name: "Remove…" }))
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Home?" })
    expect(confirm.textContent).toContain("new sessions keep going to Work")
    fireEvent.keyDown(confirm, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByRole("dialog", { name: "Home" })).toBe(home)

    fireEvent.click(within(home).getByRole("button", { name: "Remove…" }))
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Remove Home?" })).getByRole("button", {
        name: "Remove account",
      }),
    )
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(labels(table)).toEqual(["Work", "Spare"])
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Accounts" })),
    )
  })

  it("can be read but not changed while the daemon is unreachable", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    const work = await openSheet(table, "Work")
    daemon.reachable = false
    // The page notices on its next poll; a change asks again at once.
    fireEvent.click(screen.getByRole("switch", { name: "Home enabled" }))
    await screen.findByRole("status")

    for (const name of ["Move down", "Rename", "Remove…"]) {
      expect(within(work).getByRole("button", { name }).hasAttribute("disabled")).toBe(true)
    }
    expect(
      within(work).getByRole("switch", { name: "Enabled" }).hasAttribute("data-disabled"),
    ).toBe(true)
    expect(
      within(table).getByRole("button", { name: "Reorder Work" }).hasAttribute("disabled"),
    ).toBe(true)
    expect(screen.getByRole("switch", { name: "Work enabled" }).hasAttribute("data-disabled")).toBe(
      true,
    )
  })
})

describe("review fixes", () => {
  it("gives up on a removal the daemon never answers, so the dialog can be closed", async () => {
    const daemon = threeAccounts()
    render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} requestTimeout={50} />)
    await screen.findByRole("table", { name: "Claude accounts" })

    await pick("Work", "Remove…")
    const confirm = await screen.findByRole("alertdialog", { name: "Remove Work?" })
    daemon.stalled = true
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove account" }))

    expect(await notice("Couldn't remove Work")).toContain("Can't reach the daemon")
    daemon.stalled = false
    const cancel = within(confirm).getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel.hasAttribute("disabled")).toBe(false))
  })

  it("keeps the latest of two quick moves, even when the daemon answers them out of order", async () => {
    const daemon = threeAccounts()
    let patches = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (init?.method === "PATCH" && patches++ === 0) {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      return daemon.fetch(input, init)
    }
    render(<App fetch={fetch} openEvents={daemon.openEvents} />)
    const table = await screen.findByRole("table", { name: "Claude accounts" })

    const spare = within(table).getByRole("button", { name: "Reorder Spare" })
    spare.focus()
    // Into Home's priority, then alone above it.
    fireEvent.keyDown(spare, { key: "ArrowUp" })
    fireEvent.keyDown(spare, { key: "ArrowUp" })

    await waitFor(() => expect(daemon.changes).toHaveLength(2))
    await waitFor(() => expect(stored(daemon)).toEqual(["1 Work", "2 Spare (off)", "3 Home"]))
    await waitFor(() => expect(labels(table)).toEqual(["Work", "Spare", "Home"]))
  })

  it("keeps a double-clicked label's field focused, though the first click opened the sheet", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    // The first click opens the sheet, which focuses itself a frame later;
    // the second click of the double-click lands before that frame.
    fireEvent.click(within(table).getByText("Work"))
    expect(screen.getByRole("dialog", { name: "Work" })).toBeTruthy()
    await Promise.resolve()
    fireEvent.doubleClick(within(table).getByText("Work"))
    const input = within(table).getByRole("textbox", { name: "Label for Work" })
    expect(document.activeElement).toBe(input)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(input)
  })

  it("does not write back a label left untouched while the daemon renamed it", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.doubleClick(within(table).getByText("Work"))
    const input = within(table).getByRole("textbox", { name: "Label for Work" })
    daemon.update("a1", { label: "Main" })
    await waitFor(() => expect(poolLine()).toBe("New sessions go to Main"))
    fireEvent.blur(input)

    expect(daemon.changes).toEqual([])
  })

  it("hands focus back to the label after a rename is confirmed or cancelled from the keyboard", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.doubleClick(within(table).getByText("Home"))
    fireEvent.keyDown(within(table).getByRole("textbox", { name: "Label for Home" }), {
      key: "Escape",
    })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(table).getByRole("button", { name: "Home" })),
    )

    fireEvent.doubleClick(within(table).getByText("Home"))
    const input = within(table).getByRole("textbox", { name: "Label for Home" })
    fireEvent.change(input, { target: { value: "House" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(table).getByRole("button", { name: "House" })),
    )
  })

  it("hands focus back to the sheet's Rename button after a rename is cancelled with Escape", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    const opened = await openSheet(table, "Home")

    fireEvent.click(within(opened).getByRole("button", { name: "Rename" }))
    fireEvent.keyDown(within(opened).getByRole("textbox", { name: "Label for Home" }), {
      key: "Escape",
    })
    await waitFor(() =>
      expect(document.activeElement).toBe(within(opened).getByRole("button", { name: "Rename" })),
    )
  })

  it("keeps the rename field after a very fast double-click, which opens the sheet first", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)
    const label = within(table).getByRole("button", { name: "Work" })

    act(() => {
      fireEvent.click(label, { detail: 1 })
      fireEvent.click(label, { detail: 2 })
      fireEvent.doubleClick(label)
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const input = within(table).getByRole("textbox", { name: "Label for Work" })
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("saves nothing when the browser cancels a drag", async () => {
    const daemon = threeAccounts()
    const table = await show(daemon)

    fireEvent.pointerDown(within(table).getByRole("button", { name: "Reorder Spare" }), {
      button: 0,
      pointerId: 1,
    })
    fireEvent.pointerOver(rowOf(table, "Work")!)
    fireEvent.pointerCancel(document, { pointerId: 1 })

    expect(labels(table)).toEqual(["Work", "Home", "Spare"])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(daemon.changes).toEqual([])
  })
})
