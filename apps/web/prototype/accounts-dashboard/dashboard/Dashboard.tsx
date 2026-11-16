// PROTOTYPE: the dashboard's app shell and Accounts page.
// A full-height sidebar (daemon switcher on top, pages below, Connect clients and Settings at the
// bottom), one page-header pattern for every page, and an account sheet that slides over from the
// right. Planned pages (Usage, Sessions, Skills, Settings) render a placeholder inside the shell.

import { type ReactNode, useEffect, useRef, useState } from "react"

import "./base.css"
import "./shell.css"
import {
  IconCheck,
  IconCopy,
  IconLink,
  IconPlus,
  IconPower,
  IconTerminal,
  ProviderMark,
} from "../shared/icons.tsx"
import { CLIENTS, PROVIDERS, type Provider, poolState, providerName } from "../shared/model.ts"
import { type DashboardState, useDashboard, useNow } from "../shared/store.ts"
import { FirstRun, ProviderSection, RemoveModal, Toasts } from "./accounts.tsx"
import { AddAccountModal } from "./AddAccountModal.tsx"
import { CommandLine, ProxyKeyRow } from "./ConnectClients.tsx"
import { FuturePage, PAGES, type PageId } from "./future.tsx"
import {
  IconChart,
  IconGear,
  IconGlobe,
  IconHistory,
  IconLaptop,
  IconSelector,
  IconSpark,
  IconUsers,
} from "./icons.tsx"
import { AccountSheet } from "./sheet.tsx"
import { Modal, copyText } from "./ui.tsx"

const SHELL_PAGES: ReadonlyArray<PageId> = ["accounts", "usage", "sessions", "skills", "settings"]

const pageFromUrl = (): PageId => {
  const p = new URLSearchParams(window.location.search).get("page")
  return SHELL_PAGES.includes(p as PageId) ? (p as PageId) : "accounts"
}

type Dialog =
  | { kind: "add"; provider: Provider | undefined }
  | { kind: "reauth"; accountId: string }
  | { kind: "remove"; accountId: string }
  | { kind: "connect" }
  | null

export function Dashboard() {
  const s = useDashboard()
  const now = useNow(1000)
  const [page, setPage] = useState<PageId>(pageFromUrl)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const offline = !s.daemon.running
  const close = () => setDialog(null)
  const removing =
    dialog?.kind === "remove" ? s.accounts.find((a) => a.id === dialog.accountId) : undefined
  const open = openId === null ? undefined : s.accounts.find((a) => a.id === openId)

  const go = (p: PageId) => {
    const url = new URL(window.location.href)
    if (p === "accounts") url.searchParams.delete("page")
    else url.searchParams.set("page", p)
    window.history.replaceState(null, "", url)
    setPage(p)
    setOpenId(null)
  }

  return (
    <div className={`ap ap-app ${open !== undefined && page === "accounts" ? "has-sheet" : ""}`}>
      <Sidebar
        s={s}
        now={now}
        page={page}
        onGo={go}
        onConnect={() => setDialog({ kind: "connect" })}
      />

      <main className="app-main">
        <div className="app-page">
          {offline && (
            <div className="ap-offline app-offline" role="status">
              <IconPower size={16} />
              <div>
                <b>Can't reach the daemon at {s.daemon.address}.</b> Is it running? You're looking
                at what it last reported; changes are paused until it answers again.
              </div>
            </div>
          )}

          {page === "accounts" ? (
            <>
              <PageHeader
                title={PAGES.accounts.title}
                blurb={PAGES.accounts.blurb}
                actions={
                  s.accounts.length > 0 ? (
                    <button
                      type="button"
                      className="ap-btn ap-btn-primary"
                      onClick={() => setDialog({ kind: "add", provider: undefined })}
                      disabled={offline}
                    >
                      <IconPlus size={14} /> Add account
                    </button>
                  ) : undefined
                }
              />
              <div className={`ap-content ${offline ? "is-offline" : ""}`} aria-disabled={offline}>
                {s.accounts.length === 0 ? (
                  <FirstRun
                    onAdd={(p) => setDialog({ kind: "add", provider: p })}
                    address={s.daemon.address}
                  />
                ) : (
                  <div className="app-sections">
                    {PROVIDERS.map((p) => (
                      <ProviderSection
                        key={p}
                        provider={p}
                        accounts={s.accounts}
                        now={now}
                        openId={openId}
                        onOpen={(id) => setOpenId(id)}
                        onAdd={() => setDialog({ kind: "add", provider: p })}
                        onReauth={(id) => setDialog({ kind: "reauth", accountId: id })}
                        onRemove={(id) => setDialog({ kind: "remove", accountId: id })}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <FuturePage id={page} />
          )}
        </div>
      </main>

      {open !== undefined && page === "accounts" && (
        <AccountSheet
          key={open.id}
          account={open}
          accounts={s.accounts}
          events={s.events}
          now={now}
          readOnly={offline}
          covered={dialog !== null}
          onClose={() => setOpenId(null)}
          onReauth={() => setDialog({ kind: "reauth", accountId: open.id })}
          onRemove={() => setDialog({ kind: "remove", accountId: open.id })}
        />
      )}

      <Toasts events={s.events} />

      {dialog?.kind === "add" && (
        <AddAccountModal provider={dialog.provider} reauthAccountId={undefined} onClose={close} />
      )}
      {dialog?.kind === "reauth" && (
        <AddAccountModal provider={undefined} reauthAccountId={dialog.accountId} onClose={close} />
      )}
      {removing !== undefined && (
        <RemoveModal account={removing} accounts={s.accounts} onClose={close} />
      )}
      {dialog?.kind === "connect" && <ConnectClientsModal onClose={close} />}
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Page header: the same pattern on every page

function PageHeader({
  title,
  blurb,
  actions,
}: {
  title: string
  blurb: string
  actions?: ReactNode
}) {
  return (
    <header className="app-pagehead">
      <div>
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
      {actions !== undefined && <div className="app-pagehead-actions">{actions}</div>}
    </header>
  )
}

// -----------------------------------------------------------------------------------------------
// Sidebar

const uptime = (startedAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const NAV_ICON: Record<PageId, (p: { size?: number }) => ReactNode> = {
  accounts: IconUsers,
  usage: IconChart,
  sessions: IconHistory,
  skills: IconSpark,
  settings: IconGear,
}

function Sidebar(props: {
  s: DashboardState
  now: number
  page: PageId
  onGo: (p: PageId) => void
  onConnect: () => void
}) {
  const { s, page, onGo } = props
  const signin = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const blocked = PROVIDERS.some((p) => poolState(s.accounts, p).kind === "blocked")

  const item = (id: PageId, extra?: ReactNode) => {
    const Icon = NAV_ICON[id]
    const info = PAGES[id]
    return (
      <button
        key={id}
        type="button"
        className={`app-nav-item ${page === id ? "is-on" : ""} ${info.ready ? "" : "is-planned"}`}
        aria-current={page === id ? "page" : undefined}
        onClick={() => onGo(id)}
      >
        <span className="app-nav-icon">
          <Icon size={15} />
        </span>
        <span className="app-nav-label">{info.title}</span>
        {extra}
        {!info.ready && <span className="app-nav-planned">Planned</span>}
      </button>
    )
  }

  return (
    <nav className="app-side" aria-label="agent-proxy">
      <DaemonSwitcher s={s} now={props.now} />

      <div className="app-nav">
        {item(
          "accounts",
          signin > 0 ? (
            <span
              className="app-nav-badge"
              title={`${signin} account${signin === 1 ? "" : "s"} need${signin === 1 ? "s" : ""} sign-in`}
            >
              {signin}
            </span>
          ) : blocked ? (
            <span className="app-nav-dot" title="A pool can't take new sessions" />
          ) : (
            <span className="app-nav-count">{s.accounts.length > 0 ? s.accounts.length : ""}</span>
          ),
        )}
        {item("usage")}
        {item("sessions")}
        {item("skills")}
      </div>

      <div className="app-side-pools">
        <div className="app-side-heading">Pools</div>
        {PROVIDERS.map((p) => {
          const ps = poolState(s.accounts, p)
          return (
            <div
              key={p}
              className={`app-side-pool is-${ps.kind}`}
              title={`${providerName[p]} pool`}
            >
              <ProviderMark provider={p} size={13} />
              <span className="app-side-pool-name">{providerName[p]}</span>
              <span className="app-side-pool-state">
                {ps.kind === "serving"
                  ? ps.account.label
                  : ps.kind === "blocked"
                    ? "Unavailable"
                    : ps.kind === "off"
                      ? "Off"
                      : "No accounts"}
              </span>
            </div>
          )
        })}
      </div>

      <div className="app-side-foot">
        <button type="button" className="app-nav-item" onClick={props.onConnect}>
          <span className="app-nav-icon">
            <IconLink size={15} />
          </span>
          <span className="app-nav-label">Connect clients</span>
        </button>
        {item("settings")}
      </div>
    </nav>
  )
}

function DaemonSwitcher({ s, now }: { s: DashboardState; now: number }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const running = s.daemon.running
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", down)
    window.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("mousedown", down)
      window.removeEventListener("keydown", key)
    }
  }, [open])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="app-daemon-wrap" ref={ref}>
      <button
        type="button"
        className={`app-daemon ${running ? "is-up" : "is-down"} ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="app-daemon-icon">
          <IconLaptop size={15} />
          <span className="app-daemon-dot" />
        </span>
        <span className="app-daemon-text">
          <span className="app-daemon-name">This Mac</span>
          <span className="app-daemon-addr">{running ? s.daemon.address : "Unreachable"}</span>
        </span>
        <IconSelector size={14} />
      </button>

      {open && (
        <div className="app-daemon-menu" role="menu">
          <div className="app-dm-head">
            <div className="app-dm-status">
              <span className={`app-dm-dot ${running ? "is-up" : "is-down"}`} />
              {running ? "Running" : "Can't reach the daemon"}
            </div>
            <dl>
              <div>
                <dt>Address</dt>
                <dd>
                  <code>{s.daemon.address}</code>
                </dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>v{s.daemon.version}</dd>
              </div>
              {running && (
                <div>
                  <dt>Uptime</dt>
                  <dd>{uptime(s.daemon.startedAt, now)}</dd>
                </div>
              )}
            </dl>
          </div>
          <div className="ap-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="ap-menu-item"
            onClick={() => {
              copyText(`http://${s.daemon.address}`)
              setCopied(true)
            }}
          >
            <span className="ap-menu-icon">
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </span>
            {copied ? "Copied" : "Copy address"}
          </button>
          <div className="ap-menu-sep" />
          <div className="app-dm-label">Daemons</div>
          <button type="button" role="menuitemradio" aria-checked="true" className="ap-menu-item">
            <span className="ap-menu-icon">
              <IconLaptop size={14} />
            </span>
            This Mac
            <span className="app-dm-check">
              <IconCheck size={14} />
            </span>
          </button>
          <button type="button" role="menuitem" className="ap-menu-item" disabled>
            <span className="ap-menu-icon">
              <IconGlobe size={14} />
            </span>
            Connect to a remote daemon
            <span className="app-tag">Planned</span>
          </button>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Connect clients

function ConnectClientsModal({ onClose }: { onClose: () => void }) {
  const s = useDashboard()
  return (
    <Modal
      title="Connect clients"
      subtitle="Run one command per client. It points the client at this proxy and gives it the proxy key."
      icon={
        <span className="app-modal-icon">
          <IconTerminal size={16} />
        </span>
      }
      onClose={onClose}
      width={560}
    >
      <div className="app-connect">
        {CLIENTS.map((c) => (
          <div key={c.id} className="app-connect-row">
            <div className="app-connect-head">
              <b>{c.name}</b>
              <span className="app-connect-pools">
                {c.providers.map((p) => {
                  const ps = poolState(s.accounts, p)
                  return (
                    <span
                      key={p}
                      className={`app-chip is-${ps.kind}`}
                      title={`${providerName[p]} pool`}
                    >
                      <ProviderMark provider={p} size={11} />
                      {providerName[p]} pool
                    </span>
                  )
                })}
              </span>
            </div>
            <CommandLine command={c.command} />
          </div>
        ))}
        <div className="app-connect-key">
          <ProxyKeyRow />
        </div>
      </div>
    </Modal>
  )
}
