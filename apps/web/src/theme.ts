import { useEffect, useState } from "react"

/** The owner's theme choice: follow the system, or keep one look. */
export type ThemeChoice = "system" | "light" | "dark"

/**
 * Where this browser keeps the choice. A per-browser look, not daemon
 * behaviour, so it stays out of the config file. `index.html` reads the same
 * key before the first paint.
 */
const STORAGE_KEY = "agent-proxy:theme"

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)")

const readChoice = (): ThemeChoice => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    // Storage blocked (private window, site data off): follow the system.
    return "system"
  }
}

const saveChoice = (choice: ThemeChoice) => {
  try {
    if (choice === "system") localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Unsaved, the choice still holds until the page reloads.
  }
}

/** Puts the look `choice` resolves to on `<html data-theme>`, which the styles key on. */
const apply = (choice: ThemeChoice) => {
  const dark = choice === "system" ? systemDark().matches : choice === "dark"
  document.documentElement.dataset["theme"] = dark ? "dark" : "light"
}

/**
 * The theme choice and a setter that saves it. While the choice is System,
 * the page follows the system setting as it changes; a choice made in another
 * tab shows here too.
 */
export function useTheme(): readonly [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(readChoice)

  useEffect(() => {
    apply(choice)
    if (choice !== "system") return
    const query = systemDark()
    const follow = () => apply("system")
    query.addEventListener("change", follow)
    return () => query.removeEventListener("change", follow)
  }, [choice])

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setChoice(readChoice())
    }
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [])

  const choose = (next: ThemeChoice) => {
    saveChoice(next)
    setChoice(next)
  }
  return [choice, choose] as const
}
