// PROTOTYPE round 2 variant A3 — "Data grid".
// A collapsible sidebar shell (daemon switcher on top, pages, Connect clients + Settings at the bottom)
// around one consistent table pattern: a toolbar (search, views, live indicator, primary action),
// a grouped grid with rows that expand inline, and a footer. Usage and Sessions would reuse it.

import { type ReactNode, useEffect, useState } from "react"

import "../a-console/console.css"
import "./grid.css"
import { IconPower } from "../../shared/icons.tsx"
import { PROVIDERS, type Provider, poolState } from "../../shared/model.ts"
import { useDashboard, useNow } from "../../shared/store.ts"
import { AddAccountModal } from "../a-console/AddAccountModal.tsx"
import { FuturePage, PAGES, type PageId } from "../kit/future.tsx"
import { AccountsGrid } from "./Grid.tsx"
import { IconBars, IconGear, IconHistory, IconLayers, IconSidebar, IconUsers } from "./icons.tsx"
import { IconLink } from "../../shared/icons.tsx"
import { ConnectClientsModal, DaemonSwitcher, FirstRun, RemoveModal, Toasts } from "./parts.tsx"

export const name = "Data grid"

type Page = Exclude<PageId, "overview">
const PAGE_IDS: ReadonlyArray<Page> = ["accounts", "usage", "sessions", "skills", "settings"]

const pageFromUrl = (): Page => {
  const p = new URLSearchParams(window.location.search).get("page")
  return PAGE_IDS.includes(p as Page) ? (p as Page) : "accounts"
}

const COLLAPSE_KEY = "vA3-sidebar-collapsed"
const readCollapsed = () => {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1"
  } catch {
    return false
  }
}

type Dialog =
  | { kind: "add"; provider: Provider | undefined }
  | { kind: "reauth"; accountId: string }
  | { kind: "remove"; accountId: string }
  | { kind: "connect" }
  | null

export function VariantA3() {
  const s = useDashboard()
  const now = useNow(1000)
  const [page, setPageState] = useState<Page>(pageFromUrl)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [dialog, setDialog] = useState<Dialog>(null)
  const offline = !s.daemon.running
  const close = () => setDialog(null)

  const setPage = (p: Page) => {
    const url = new URL(window.location.href)
    if (p === "accounts") url.searchParams.delete("page")
    else url.searchParams.set("page", p)
    window.history.replaceState(null, "", url)
    setPageState(p)
    window.scrollTo({ top: 0 })
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0")
    } catch {
      // storage unavailable: the rail just won't remember
    }
  }, [collapsed])

  const signin = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const blocked = PROVIDERS.some((p) => poolState(s.accounts, p).kind === "blocked")
  const removing = dialog?.kind === "remove" ? s.accounts.find((a) => a.id === dialog.accountId) : undefined

  const nav = (id: Page, icon: ReactNode, meta?: ReactNode) => {
    const info = PAGES[id]
    return (
      <button
        type="button"
        className={`vA3-nav ${page === id ? "is-on" : ""} ${info.ready ? "" : "is-planned"}`}
        onClick={() => setPage(id)}
        aria-current={page === id ? "page" : undefined}
        title={collapsed ? `${info.title}${info.ready ? "" : " · planned"}` : info.ready ? undefined : "Planned"}
      >
        <span className="vA3-nav-icon">
          {icon}
          {collapsed && meta !== undefined && <span className="vA3-nav-pip" />}
        </span>
        <span className="vA3-nav-label">{info.title}</span>
        {meta}
      </button>
    )
  }

  return (
    <div className={`vA vA3 ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="vA3-side">
        <DaemonSwitcher s={s} now={now} collapsed={collapsed} />

        <nav className="vA3-navs" aria-label="Pages">
          {nav(
            "accounts",
            <IconUsers size={16} />,
            signin > 0 ? (
              <span className="vA3-badge is-red" title={`${signin} need${signin === 1 ? "s" : ""} sign-in`}>
                {signin}
              </span>
            ) : blocked ? (
              <span className="vA3-badge-dot" title="A pool can't take new sessions" />
            ) : undefined,
          )}
          <div className="vA3-nav-group">Planned</div>
          {nav("usage", <IconBars size={16} />)}
          {nav("sessions", <IconHistory size={16} />)}
          {nav("skills", <IconLayers size={16} />)}
        </nav>

        <div className="vA3-side-spacer" />

        <div className="vA3-navs">
          <button type="button" className="vA3-nav" onClick={() => setDialog({ kind: "connect" })} title={collapsed ? "Connect clients" : undefined}>
            <span className="vA3-nav-icon">
              <IconLink size={16} />
            </span>
            <span className="vA3-nav-label">Connect clients</span>
          </button>
          {nav("settings", <IconGear size={16} />)}
          <button
            type="button"
            className="vA3-nav vA3-collapse"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span className="vA3-nav-icon">
              <IconSidebar size={16} />
            </span>
            <span className="vA3-nav-label">Collapse</span>
          </button>
        </div>
      </aside>

      <main className="vA3-main">
        <div className="vA3-page">
          {offline && (
            <div className="vA-offline vA3-offline" role="status">
              <IconPower size={16} />
              <div>
                <b>Can't reach the daemon at {s.daemon.address}.</b> Is it running? What you see is what it last reported; changes are
                paused until it's back.
              </div>
            </div>
          )}

          {page === "accounts" ? (
            <>
              <div className="vA3-head">
                <div>
                  <div className="vA3-crumb">This Mac</div>
                  <h1>Accounts</h1>
                  <p>{PAGES.accounts.blurb}</p>
                </div>
              </div>
              <div className={`vA-content ${offline ? "is-offline" : ""}`} aria-disabled={offline}>
                {s.accounts.length === 0 ? (
                  <FirstRun address={s.daemon.address} onAdd={(p) => setDialog({ kind: "add", provider: p })} />
                ) : (
                  <AccountsGrid
                    s={s}
                    now={now}
                    offline={offline}
                    onAdd={(p) => setDialog({ kind: "add", provider: p })}
                    onReauth={(id) => setDialog({ kind: "reauth", accountId: id })}
                    onRemove={(id) => setDialog({ kind: "remove", accountId: id })}
                  />
                )}
              </div>
            </>
          ) : (
            <FuturePage id={page} />
          )}
        </div>
      </main>

      <Toasts events={s.events} />

      {dialog?.kind === "add" && <AddAccountModal provider={dialog.provider} reauthAccountId={undefined} onClose={close} />}
      {dialog?.kind === "reauth" && <AddAccountModal provider={undefined} reauthAccountId={dialog.accountId} onClose={close} />}
      {dialog?.kind === "connect" && <ConnectClientsModal onClose={close} />}
      {removing !== undefined && <RemoveModal account={removing} accounts={s.accounts} onClose={close} />}
    </div>
  )
}
