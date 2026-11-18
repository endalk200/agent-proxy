import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { App } from "./App.tsx"
import { fakeDaemon } from "./test/fake-daemon.ts"

// The theme menu in the sidebar, and what it does to the page: `<html
// data-theme>` is what the styles key on, so it stands for the look.

const KEY = "agent-proxy:theme"

/** The OS's light or dark setting, as `matchMedia` reports it. */
class SystemSetting extends EventTarget implements MediaQueryList {
  readonly media = "(prefers-color-scheme: dark)"
  onchange: MediaQueryList["onchange"] = null
  constructor(public matches: boolean) {
    super()
  }
  addListener() {}
  removeListener() {}
}

/** A system setting the test can flip, standing in for the OS's light or dark mode. */
const fakeSystem = (dark: boolean) => {
  const setting = new SystemSetting(dark)
  vi.spyOn(window, "matchMedia").mockReturnValue(setting)
  return {
    set: (next: boolean) => {
      setting.matches = next
      act(() => {
        setting.dispatchEvent(new Event("change"))
      })
    },
  }
}

const theme = () => document.documentElement.dataset["theme"]

const show = () => {
  const daemon = fakeDaemon()
  return render(<App fetch={daemon.fetch} openEvents={daemon.openEvents} />)
}

const choose = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: /^Theme: / }))
  fireEvent.click(await screen.findByRole("menuitemradio", { name }))
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset["theme"]
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("theme", () => {
  it("follows the system until the owner picks one", () => {
    const system = fakeSystem(true)
    show()
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeTruthy()
    expect(theme()).toBe("dark")
    system.set(false)
    expect(theme()).toBe("light")
  })

  it("keeps the picked theme, whatever the system does, and across reloads", async () => {
    const system = fakeSystem(false)
    const { unmount } = show()
    await choose("Dark")
    expect(theme()).toBe("dark")
    expect(localStorage.getItem(KEY)).toBe("dark")
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeTruthy()

    system.set(true)
    system.set(false)
    expect(theme()).toBe("dark")

    unmount()
    show()
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeTruthy()
    expect(theme()).toBe("dark")
  })

  it("marks the current choice in the menu", async () => {
    fakeSystem(false)
    show()
    await choose("Light")
    fireEvent.click(screen.getByRole("button", { name: "Theme: Light" }))
    const checked = await screen.findByRole("menuitemradio", { checked: true })
    expect(checked.textContent).toContain("Light")
  })

  it("goes back to following the system, forgetting the choice", async () => {
    const system = fakeSystem(true)
    localStorage.setItem(KEY, "light")
    show()
    expect(theme()).toBe("light")
    await choose("System")
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(theme()).toBe("dark")
    system.set(false)
    expect(theme()).toBe("light")
  })

  it("picks up a choice made in another tab", () => {
    fakeSystem(false)
    show()
    localStorage.setItem(KEY, "dark")
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "dark" }))
    })
    expect(theme()).toBe("dark")
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeTruthy()
  })
})
