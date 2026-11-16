// PROTOTYPE variant A4: which pages the rail lists, and their icons.
import type { PageId } from "../kit/future.tsx"
import { IconAccounts, IconSessions, IconSettings, IconSkills, IconUsage } from "./icons.tsx"

export type NavPage = Exclude<PageId, "overview">

/** Rail order. Settings sits at the bottom of the rail; the palette lists it last. */
export const NAV_PAGES: ReadonlyArray<NavPage> = ["accounts", "usage", "sessions", "skills", "settings"]

export const NAV_ICON: Record<NavPage, typeof IconAccounts> = {
  accounts: IconAccounts,
  usage: IconUsage,
  sessions: IconSessions,
  skills: IconSkills,
  settings: IconSettings,
}

export const pageFromUrl = (): NavPage => {
  const p = new URLSearchParams(window.location.search).get("page")
  return NAV_PAGES.some((x) => x === p) ? (p as NavPage) : "accounts"
}

export const writePage = (page: NavPage) => {
  const url = new URL(window.location.href)
  if (page === "accounts") url.searchParams.delete("page")
  else url.searchParams.set("page", page)
  window.history.replaceState(null, "", url)
}
