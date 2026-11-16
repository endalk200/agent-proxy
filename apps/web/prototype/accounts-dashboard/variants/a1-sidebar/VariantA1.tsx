// PROTOTYPE round 2 variant A1 — "Sidebar": round 1's Console inside a Linear-style app shell.
// Full-height sidebar (daemon switcher on top, pages below, Connect clients and Settings at the
// bottom), one page-header pattern for every page, and an account sheet that slides over from the
// right. Planned pages (Usage, Sessions, Skills, Settings) render the kit placeholder in the shell.

import { type ReactNode, useEffect, useRef, useState } from "react"

import "../a-console/console.css"
import "./sidebar.css"
import { IconCheck, IconCopy, IconLink, IconPlus, IconPower, IconTerminal, ProviderMark } from "../../shared/icons.tsx"
import { CLIENTS, PROVIDERS, type Provider, poolState, providerName } from "../../shared/model.ts"
import { type DashboardState, useDashboard, useNow } from "../../shared/store.ts"
import { AddAccountModal } from "../a-console/AddAccountModal.tsx"
import { CommandLine, ProxyKeyRow } from "../a-console/ConnectClients.tsx"
import { Modal, copyText } from "../a-console/ui.tsx"
import { FuturePage, PAGES, type PageId } from "../kit/future.tsx"
import { FirstRun, ProviderSection, RemoveModal, Toasts } from "./accounts.tsx"
import { IconChart, IconGear, IconGlobe, IconHistory, IconLaptop, IconSelector, IconSpark, IconUsers } from "./icons.tsx"
import { AccountSheet } from "./sheet.tsx"

export const name = "Sidebar"

type ShellPage = Exclude<PageId, "overview">
const SHELL_PAGES: ReadonlyArray<ShellPage> = ["accounts", "usage", "sessions", "skills", "settings"]

const pageFromUrl = (): ShellPage => {
  const p = new URLSearchParams(window.location.search).get("page")
  return SHELL_PAGES.includes(p as ShellPage) ? (p as ShellPage) : "accounts"
}

type Dialog =
  | { kind: "add"; provider: Provider | undefined }
  | { kind: "reauth"; accountId: string }
  | { kind: "remove"; accountId: string }
  | { kind: "connect" }
  | null

export function VariantA1() {
  const s = useDashboard()
  const now = useNow(1000)
  const [page, setPage] = useState<ShellPage>(pageFromUrl)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const offline = !s.daemon.running
  const close = () => setDialog(null)
  const removing = dialog?.kind === "remove" ? s.accounts.find((a) => a.id === dialog.accountId) : undefined
  const open = openId === null ? undefined : s.accounts.find((a) => a.id === openId)

  const go = (p: ShellPage) => {
    const url = new URL(window.location.href)
    if (p === "accounts") url.searchParams.delete("page")
    else url.searchParams.set("page", p)
    window.history.replaceState(null, "", url)
    setPage(p)
    setOpenId(null)
  }

  return (
    <div className="vA vA1">
      <Sidebar s={s} now={now} page={page} onGo={go} onConnect={() => setDialog({ kind: "connect" })} />

      <main className="vA1-main">
        <div className="vA1-page">
          {offline && (
            <div className="vA-offline vA1-offline" role="status">
              <IconPower size={16} />
              <div>
                <b>Can't reach the daemon at {s.daemon.address}.</b> Is it running? You're looking at what it last reported;
                changes are paused until it answers again.
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
                      className="vA-btn vA-btn-primary"
                      onClick={() => setDialog({ kind: "add", provider: undefined })}
                      disabled={offline}
                    >
                      <IconPlus size={14} /> Add account
                    </button>
                  ) : undefined
                }
              />
              <div className={`vA-content ${offline ? "is-offline" : ""}`} aria-disabled={offline}>
                {s.accounts.length === 0 ? (
                  <FirstRun onAdd={(p) => setDialog({ kind: "add", provider: p })} address={s.daemon.address} />
                ) : (
                  <div className="vA1-sections">
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

      {dialog?.kind === "add" && <AddAccountModal provider={dialog.provider} reauthAccountId={undefined} onClose={close} />}
      {dialog?.kind === "reauth" && <AddAccountModal provider={undefined} reauthAccountId={dialog.accountId} onClose={close} />}
      {removing !== undefined && <RemoveModal account={removing} accounts={s.accounts} onClose={close} />}
      {dialog?.kind === "connect" && <ConnectClientsModal onClose={close} />}
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Page header: the same pattern on every page

function PageHeader({ title, blurb, actions }: { title: string; blurb: string; actions?: ReactNode }) {
  return (
    <header className="vA1-pagehead">
      <div>
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
      {actions !== undefined && <div className="vA1-pagehead-actions">{actions}</div>}
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

const NAV_ICON: Record<ShellPage, (p: { size?: number }) => ReactNode> = {
  accounts: IconUsers,
  usage: IconChart,
  sessions: IconHistory,
  skills: IconSpark,
  settings: IconGear,
}

function Sidebar(props: {
  s: DashboardState
  now: number
  page: ShellPage
  onGo: (p: ShellPage) => void
  onConnect: () => void
}) {
  const { s, page, onGo } = props
  const signin = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const blocked = PROVIDERS.some((p) => poolState(s.accounts, p).kind === "blocked")

  const item = (id: ShellPage, extra?: ReactNode) => {
    const Icon = NAV_ICON[id]
    const info = PAGES[id]
    return (
      <button
        key={id}
        type="button"
        className={`vA1-nav-item ${page === id ? "is-on" : ""} ${info.ready ? "" : "is-planned"}`}
        aria-current={page === id ? "page" : undefined}
        onClick={() => onGo(id)}
      >
        <span className="vA1-nav-icon">
          <Icon size={15} />
        </span>
        <span className="vA1-nav-label">{info.title}</span>
        {extra}
        {!info.ready && <span className="vA1-nav-planned">Planned</span>}
      </button>
    )
  }

  return (
    <nav className="vA1-side" aria-label="agent-proxy">
      <DaemonSwitcher s={s} now={props.now} />

      <div className="vA1-nav">
        {item(
          "accounts",
          signin > 0 ? (
            <span className="vA1-nav-badge" title={`${signin} account${signin === 1 ? "" : "s"} need${signin === 1 ? "s" : ""} sign-in`}>
              {signin}
            </span>
          ) : blocked ? (
            <span className="vA1-nav-dot" title="A pool can't take new sessions" />
          ) : (
            <span className="vA1-nav-count">{s.accounts.length > 0 ? s.accounts.length : ""}</span>
          ),
        )}
        {item("usage")}
        {item("sessions")}
        {item("skills")}
      </div>

      <div className="vA1-side-pools">
        <div className="vA1-side-heading">Pools</div>
        {PROVIDERS.map((p) => {
          const ps = poolState(s.accounts, p)
          return (
            <div key={p} className={`vA1-side-pool is-${ps.kind}`} title={`${providerName[p]} pool`}>
              <ProviderMark provider={p} size={13} />
              <span className="vA1-side-pool-name">{providerName[p]}</span>
              <span className="vA1-side-pool-state">
                {ps.kind === "serving"
                  ? ps.account.label
                  : ps.kind === "blocked"
                    ? "Waiting"
                    : ps.kind === "off"
                      ? "Off"
                      : "No accounts"}
              </span>
            </div>
          )
        })}
      </div>

      <div className="vA1-side-foot">
        <button type="button" className="vA1-nav-item" onClick={props.onConnect}>
          <span className="vA1-nav-icon">
            <IconLink size={15} />
          </span>
          <span className="vA1-nav-label">Connect clients</span>
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
    <div className="vA1-daemon-wrap" ref={ref}>
      <button
        type="button"
        className={`vA1-daemon ${running ? "is-up" : "is-down"} ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="vA1-daemon-icon">
          <IconLaptop size={15} />
          <span className="vA1-daemon-dot" />
        </span>
        <span className="vA1-daemon-text">
          <span className="vA1-daemon-name">This Mac</span>
          <span className="vA1-daemon-addr">{running ? s.daemon.address : "Unreachable"}</span>
        </span>
        <IconSelector size={14} />
      </button>

      {open && (
        <div className="vA1-daemon-menu" role="menu">
          <div className="vA1-dm-head">
            <div className="vA1-dm-status">
              <span className={`vA1-dm-dot ${running ? "is-up" : "is-down"}`} />
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
          <div className="vA-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="vA-menu-item"
            onClick={() => {
              copyText(`http://${s.daemon.address}`)
              setCopied(true)
            }}
          >
            <span className="vA-menu-icon">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</span>
            {copied ? "Copied" : "Copy address"}
          </button>
          <div className="vA-menu-sep" />
          <div className="vA1-dm-label">Daemons</div>
          <button type="button" role="menuitemradio" aria-checked="true" className="vA-menu-item">
            <span className="vA-menu-icon">
              <IconLaptop size={14} />
            </span>
            This Mac
            <span className="vA1-dm-check">
              <IconCheck size={14} />
            </span>
          </button>
          <button type="button" role="menuitem" className="vA-menu-item" disabled>
            <span className="vA-menu-icon">
              <IconGlobe size={14} />
            </span>
            Connect to a remote daemon
            <span className="vA1-tag">Planned</span>
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
        <span className="vA1-modal-icon">
          <IconTerminal size={16} />
        </span>
      }
      onClose={onClose}
      width={560}
    >
      <div className="vA1-connect">
        {CLIENTS.map((c) => (
          <div key={c.id} className="vA1-connect-row">
            <div className="vA1-connect-head">
              <b>{c.name}</b>
              <span className="vA1-connect-pools">
                {c.providers.map((p) => {
                  const ps = poolState(s.accounts, p)
                  return (
                    <span key={p} className={`vA1-chip is-${ps.kind}`} title={`${providerName[p]} pool`}>
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
        <div className="vA1-connect-key">
          <ProxyKeyRow />
        </div>
      </div>
    </Modal>
  )
}
