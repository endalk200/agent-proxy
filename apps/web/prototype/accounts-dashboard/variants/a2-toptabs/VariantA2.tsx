// PROTOTYPE round 2 variant A2 — "Top tabs": round 1's Console in a Vercel-style two-tier header.
// Row 1: brand / daemon switcher (room for remote daemons later) … Connect clients.
// Row 2: page tabs with a sliding underline: Overview, Accounts, then the planned pages.
// Accounts open into their own detail page (?page=accounts&account=<id>), where per-account usage will live.

import { useLayoutEffect, useRef, useState } from "react"

import "../a-console/console.css"
import "./toptabs.css"
import { IconCheck, IconChevronDown, IconMonitor, IconPlus, IconPower } from "../../shared/icons.tsx"
import { PROVIDERS, type Provider, poolState } from "../../shared/model.ts"
import { type DashboardState, sim, useDashboard, useNow } from "../../shared/store.ts"
import { AddAccountModal } from "../a-console/AddAccountModal.tsx"
import { ConnectClientsButton } from "../a-console/ConnectClients.tsx"
import { CopyButton } from "../a-console/ui.tsx"
import { FuturePage, PAGES, type PageId } from "../kit/future.tsx"
import { AccountDetail } from "./AccountDetail.tsx"
import { AccountsPage, RemoveModal } from "./AccountsPage.tsx"
import { OverviewPage } from "./OverviewPage.tsx"
import { Popover, type Route, Toasts, uptime, useRoute } from "./bits.tsx"

export const name = "Top tabs"

type Dialog =
  | { kind: "add"; provider: Provider | undefined }
  | { kind: "reauth"; accountId: string }
  | { kind: "remove"; accountId: string }
  | null

const TABS: ReadonlyArray<PageId> = ["overview", "accounts", "usage", "sessions", "skills", "settings"]

export function VariantA2() {
  const s = useDashboard()
  const now = useNow(1000)
  const [route, go] = useRoute()
  const [dialog, setDialog] = useState<Dialog>(null)
  const offline = !s.daemon.running
  const close = () => setDialog(null)
  const removing = dialog?.kind === "remove" ? s.accounts.find((a) => a.id === dialog.accountId) : undefined

  const open = (id: string) => go({ page: "accounts", account: id })
  const add = (provider: Provider | undefined) => setDialog({ kind: "add", provider })
  const reauth = (accountId: string) => setDialog({ kind: "reauth", accountId })
  const remove = (accountId: string) => setDialog({ kind: "remove", accountId })

  return (
    <div className="vA vA2">
      <header className="vA2-header">
        <div className="vA2-top">
          <div className="vA-brand">
            <span className="vA-logo" aria-hidden="true">
              <span />
              <span />
            </span>
            agent-proxy
          </div>
          <Slash />
          <DaemonSwitcher s={s} now={now} />
          <div className="vA-bar-spacer" />
          <ConnectClientsButton />
        </div>
        <Tabs s={s} route={route} go={go} />
      </header>

      {offline && (
        <div className="vA2-offline" role="status">
          <div className="vA2-wrap">
            <IconPower size={15} />
            <span>
              <b>Can't reach the daemon at {s.daemon.address}.</b> Showing what it last reported. Changes are paused until it's
              back.
            </span>
            <button type="button" className="vA-btn vA-btn-ghost vA-btn-xs" onClick={() => sim.setDaemonRunning(true)}>
              Retry
            </button>
          </div>
        </div>
      )}

      <main className="vA2-wrap vA2-main">
        <div
          key={`${route.page}:${route.account ?? ""}`}
          className={`vA-content vA2-page ${offline ? "is-offline" : ""}`}
          aria-disabled={offline}
        >
          {route.page === "overview" && (
            <OverviewPage
              s={s}
              now={now}
              onOpen={open}
              onReauth={reauth}
              onAdd={add}
              onAccounts={() => go({ page: "accounts", account: null })}
            />
          )}
          {route.page === "accounts" && route.account === null && (
            <AccountsPage s={s} now={now} onAdd={add} onReauth={reauth} onRemove={remove} onOpen={open} />
          )}
          {route.page === "accounts" && route.account !== null && (
            <AccountDetail
              s={s}
              now={now}
              id={route.account}
              onBack={() => go({ page: "accounts", account: null })}
              onReauth={reauth}
              onRemove={remove}
            />
          )}
          {route.page !== "overview" && route.page !== "accounts" && (
            <FuturePage
              id={route.page}
              headerExtra={
                route.page === "usage" ? (
                  <button type="button" className="vA-btn vA-btn-ghost" disabled>
                    Last 24 hours <IconChevronDown size={13} />
                  </button>
                ) : undefined
              }
            />
          )}
        </div>
      </main>

      <Toasts events={s.events} />

      {dialog?.kind === "add" && <AddAccountModal provider={dialog.provider} reauthAccountId={undefined} onClose={close} />}
      {dialog?.kind === "reauth" && <AddAccountModal provider={undefined} reauthAccountId={dialog.accountId} onClose={close} />}
      {removing !== undefined && (
        <RemoveModal
          account={removing}
          accounts={s.accounts}
          onClose={close}
          onRemoved={() => {
            close()
            if (route.account === removing.id) go({ page: "accounts", account: null })
          }}
        />
      )}
    </div>
  )
}

function Slash() {
  return (
    <svg className="vA2-slash" width="16" height="24" viewBox="0 0 16 24" aria-hidden="true">
      <path d="M11 3 5 21" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------------------------
// Daemon switcher: the daemon this dashboard talks to. One today; remote daemons later.

function DaemonSwitcher({ s, now }: { s: DashboardState; now: number }) {
  const up = s.daemon.running
  return (
    <Popover
      className="vA2-dmenu"
      trigger={(open, toggle) => (
        <button
          type="button"
          className={`vA2-switcher ${up ? "is-up" : "is-down"} ${open ? "is-open" : ""}`}
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={up ? `Daemon running at ${s.daemon.address}` : `Can't reach the daemon at ${s.daemon.address}`}
        >
          <IconMonitor size={14} />
          <span className="vA2-switcher-name">This Mac</span>
          <span className="vA2-switcher-dot" />
          <code>{s.daemon.address}</code>
          <IconChevronDown size={13} />
        </button>
      )}
    >
      {() => (
        <>
          <div className="vA2-dmenu-head">
            <span className={`vA2-dmenu-icon ${up ? "is-up" : "is-down"}`}>
              <IconMonitor size={16} />
            </span>
            <div>
              <b>This Mac</b>
              <span>{up ? `Running · up ${uptime(s.daemon.startedAt, now)}` : "Unreachable"}</span>
            </div>
          </div>
          <dl className="vA2-dmenu-props">
            <div>
              <dt>Address</dt>
              <dd>
                <code>{s.daemon.address}</code>
                <CopyButton text={`http://${s.daemon.address}`} label="Copy address" />
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>v{s.daemon.version}</dd>
            </div>
          </dl>
          <div className="vA2-dmenu-sep" />
          <div className="vA2-dmenu-label">Daemons</div>
          <div className="vA2-dmenu-item is-current">
            <IconMonitor size={14} />
            <span>This Mac</span>
            <code>{s.daemon.address}</code>
            <IconCheck size={14} />
          </div>
          <div className="vA2-dmenu-item is-planned" aria-disabled="true">
            <IconPlus size={14} />
            <span>Connect to a remote daemon</span>
            <span className="vK-planned">Planned</span>
          </div>
        </>
      )}
    </Popover>
  )
}

// ---------------------------------------------------------------------------------------------
// Tabs with a sliding underline

function Tabs({ s, route, go }: { s: DashboardState; route: Route; go: (r: Route) => void }) {
  const refs = useRef<Partial<Record<PageId, HTMLButtonElement | null>>>({})
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)
  const [hover, setHover] = useState<{ left: number; width: number } | null>(null)

  const signin = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const blocked = PROVIDERS.some((p) => poolState(s.accounts, p).kind === "blocked")

  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[route.page]
      if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [route.page, signin, blocked])

  return (
    <nav className="vA2-tabs" aria-label="Pages" onMouseLeave={() => setHover(null)}>
      <div className="vA2-tabs-inner">
        {hover !== null && <span className="vA2-tab-hover" style={{ left: hover.left, width: hover.width }} />}
        {TABS.map((id) => {
          const p = PAGES[id]
          const current = route.page === id
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[id] = el
              }}
              type="button"
              className={`vA2-tab ${current ? "is-current" : ""} ${p.ready ? "" : "is-planned"}`}
              aria-current={current ? "page" : undefined}
              title={p.ready ? undefined : `${p.title} is planned`}
              onMouseEnter={(e) => setHover({ left: e.currentTarget.offsetLeft, width: e.currentTarget.offsetWidth })}
              onClick={() => go({ page: id, account: null })}
            >
              {p.title}
              {id === "accounts" && signin > 0 && (
                <span className="vA2-tab-badge" aria-label={`${signin} need sign-in`}>
                  {signin}
                </span>
              )}
              {id === "accounts" && signin === 0 && blocked && <span className="vA2-tab-dot" aria-label="A pool is blocked" />}
            </button>
          )
        })}
        {bar !== null && <span className="vA2-tab-bar" style={{ transform: `translateX(${bar.left}px)`, width: bar.width }} />}
      </div>
    </nav>
  )
}
