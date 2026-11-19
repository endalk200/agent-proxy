import { useSyncExternalStore } from "react"

/**
 * The pages live at paths, `/` the dashboard and `/accounts`, moved between
 * with the History API so a link or a reload lands on the same page. Search
 * params carry view state, such as the usage range, and survive moving
 * between pages.
 */

export type Page = "dashboard" | "accounts"

export const pagePaths: Readonly<Record<Page, string>> = {
  dashboard: "/",
  accounts: "/accounts",
}

const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  window.addEventListener("popstate", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("popstate", listener)
  }
}

const pageOf = (path: string): Page =>
  path.replace(/\/+$/, "") === pagePaths.accounts ? "accounts" : "dashboard"

/** The page the address bar names. */
export const usePage = (): Page => useSyncExternalStore(subscribe, () => pageOf(location.pathname))

/** Moves to `page`, keeping the search params, as a new history entry. */
export const navigate = (page: Page) => {
  if (pageOf(location.pathname) === page) return
  history.pushState(null, "", `${pagePaths[page]}${location.search}`)
  notify()
  window.scrollTo?.(0, 0)
}

/** The props of a link to `page` that moves there without reloading. */
export const pageLink = (page: Page) => ({
  href: `${pagePaths[page]}${location.search}`,
  onClick: (event: React.MouseEvent) => {
    // A modified click opens the page elsewhere, as any link does.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return
    }
    event.preventDefault()
    navigate(page)
  },
})

export const useSearchParam = (name: string): string | null =>
  useSyncExternalStore(subscribe, () => new URLSearchParams(location.search).get(name))

/** Sets search params, or removes those given undefined, replacing the history entry. */
export const setSearchParams = (changes: Readonly<Record<string, string | undefined>>) => {
  const url = new URL(location.href)
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) url.searchParams.delete(key)
    else url.searchParams.set(key, value)
  }
  history.replaceState(history.state, "", url)
  notify()
}
