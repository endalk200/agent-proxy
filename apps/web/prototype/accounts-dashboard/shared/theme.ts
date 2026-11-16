// PROTOTYPE: light/dark. Sets data-theme="light"|"dark" on <html>; the dashboard styles off that attribute.
// The choice lives in ?theme= (system when absent) so a screenshot URL reproduces it.

import { useEffect, useState } from "react"

export type ThemeChoice = "system" | "light" | "dark"

const fromUrl = (): ThemeChoice => {
  const t = new URLSearchParams(window.location.search).get("theme")
  return t === "light" || t === "dark" ? t : "system"
}

const media = window.matchMedia("(prefers-color-scheme: dark)")

export const useTheme = (): [ThemeChoice, (t: ThemeChoice) => void] => {
  const [choice, setChoice] = useState<ThemeChoice>(fromUrl)
  const [systemDark, setSystemDark] = useState(media.matches)

  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    media.addEventListener("change", on)
    return () => media.removeEventListener("change", on)
  }, [])

  useEffect(() => {
    const resolved = choice === "system" ? (systemDark ? "dark" : "light") : choice
    document.documentElement.dataset["theme"] = resolved
    document.documentElement.style.colorScheme = resolved
  }, [choice, systemDark])

  const set = (t: ThemeChoice) => {
    const url = new URL(window.location.href)
    if (t === "system") url.searchParams.delete("theme")
    else url.searchParams.set("theme", t)
    window.history.replaceState(null, "", url)
    setChoice(t)
  }
  return [choice, set]
}
