// PROTOTYPE variant A3: shell pieces (daemon switcher, connect clients, remove, toasts, first run, pool line).
import { useEffect, useRef, useState } from "react"

import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconPlus,
  IconPower,
  IconTerminal,
  IconTrash,
  IconX,
  ProviderMark,
} from "../../shared/icons.tsx"
import {
  type Account,
  CLIENTS,
  type PoolState,
  type Provider,
  countdown,
  formatClock,
  planShort,
  planTier,
  poolOf,
  poolState,
  providerName,
} from "../../shared/model.ts"
import { type DashboardState, type LiveEvent, actions, useDashboard } from "../../shared/store.ts"
import { CommandLine, ProxyKeyRow } from "../a-console/ConnectClients.tsx"
import { Modal, copyText } from "../a-console/ui.tsx"
import { IconLaptop, IconSelector, IconServer } from "./icons.tsx"

export const uptime = (startedAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const clientsFor = (p: Provider) =>
  CLIENTS.filter((c) => c.providers.includes(p))
    .map((c) => c.name)
    .join(" and ")

// -----------------------------------------------------------------------------------------------
// Daemon switcher: "where you're connected". Remote daemons come later.

export function DaemonSwitcher({ s, now, collapsed }: { s: DashboardState; now: number; collapsed: boolean }) {
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
    <div className="vA3-daemon-wrap" ref={ref}>
      <button
        type="button"
        className={`vA3-daemon ${running ? "is-up" : "is-down"} ${open ? "is-open" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={collapsed ? `This Mac · ${s.daemon.address} · ${running ? "Running" : "Unreachable"}` : undefined}
      >
        <span className="vA3-daemon-icon">
          <IconLaptop size={15} />
          <span className="vA3-daemon-dot" />
        </span>
        <span className="vA3-daemon-text">
          <span className="vA3-daemon-name">This Mac</span>
          <span className="vA3-daemon-addr">{running ? s.daemon.address : "Unreachable"}</span>
        </span>
        <IconSelector size={14} className="vA3-daemon-chev" />
      </button>
      {open && (
        <div className="vA3-dmenu" role="dialog" aria-label="Daemon">
          <div className="vA3-dmenu-label">Connected to</div>
          <div className="vA3-dmenu-current">
            <span className="vA3-dmenu-icon">
              <IconLaptop size={16} />
            </span>
            <div>
              <div className="vA3-dmenu-name">This Mac</div>
              <code>{s.daemon.address}</code>
            </div>
            <span className={`vA3-state ${running ? "is-up" : "is-down"}`}>
              <span className="vA-sdot" />
              {running ? "Running" : "Unreachable"}
            </span>
          </div>
          <dl className="vA3-dmenu-facts">
            <div>
              <dt>Version</dt>
              <dd>v{s.daemon.version}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{running ? uptime(s.daemon.startedAt, now) : "—"}</dd>
            </div>
          </dl>
          <div className="vA3-dmenu-sep" />
          <button
            type="button"
            className="vA-menu-item"
            onClick={() => {
              copyText(s.daemon.address)
              setCopied(true)
            }}
          >
            <span className="vA-menu-icon">{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</span>
            {copied ? "Copied" : "Copy address"}
          </button>
          <button type="button" className="vA-menu-item vA3-planned-item" aria-disabled="true" title="Planned: run the daemon on another box and reach it from here">
            <span className="vA-menu-icon">
              <IconServer size={14} />
            </span>
            Connect to a remote daemon
            <span className="vA3-soon">Planned</span>
          </button>
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Connect clients (modal from the sidebar)

export function ConnectClientsModal({ onClose }: { onClose: () => void }) {
  const s = useDashboard()
  return (
    <Modal
      title="Connect clients"
      subtitle="Run one command per client. It points the client at this proxy and gives it the proxy key."
      icon={<IconTerminal size={17} />}
      onClose={onClose}
      width={560}
    >
      <div className="vA3-cc">
        {CLIENTS.map((c) => (
          <div key={c.id} className="vA3-cc-row">
            <div className="vA3-cc-head">
              <b>{c.name}</b>
              <span className="vA3-cc-pools">
                {c.providers.map((p) => {
                  const ps = poolState(s.accounts, p)
                  return (
                    <span key={p} className={`vA3-chip ${ps.kind === "serving" ? "" : "is-warn"}`} title={`${providerName[p]} pool`}>
                      <ProviderMark provider={p} size={12} />
                      {providerName[p]} pool
                    </span>
                  )
                })}
              </span>
            </div>
            <CommandLine command={c.command} />
          </div>
        ))}
        <div className="vA3-cc-key">
          <ProxyKeyRow />
        </div>
      </div>
    </Modal>
  )
}

// -----------------------------------------------------------------------------------------------
// Pool line used in group headers

export function PoolLine({ ps, now, provider }: { ps: PoolState; now: number; provider: Provider }) {
  switch (ps.kind) {
    case "serving":
      return (
        <span className="vA-pool is-ok">
          <span className="vA-dot" /> New sessions → <b>{ps.account.label}</b>
        </span>
      )
    case "blocked":
      return (
        <span className="vA-pool is-warn">
          <IconAlert size={13} />
          {ps.allCooling ? "All accounts cooling down" : "No account can take new sessions"}
          {ps.nextReset !== null && (
            <span className="vA-pool-sub">
              · next reset {formatClock(ps.nextReset)} ({countdown(ps.nextReset, now)})
            </span>
          )}
        </span>
      )
    case "off":
      return <span className="vA-pool is-muted">Pool off · every {providerName[provider]} account is disabled</span>
    case "empty":
      return <span className="vA-pool is-muted">No accounts yet</span>
  }
}

// -----------------------------------------------------------------------------------------------
// Remove confirmation

export function RemoveModal({ account, accounts, onClose }: { account: Account; accounts: ReadonlyArray<Account>; onClose: () => void }) {
  const pool = poolOf(accounts, account.provider)
  const onlyOne = account.enabled && pool.length === 1
  const next = pool.find((a) => a.id !== account.id && a.health.kind === "active")
  const p = providerName[account.provider]
  return (
    <Modal
      title={`Remove ${account.label}?`}
      icon={
        <span className="vA-danger-icon">
          <IconTrash size={17} />
        </span>
      }
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="vA-btn vA-btn-ghost" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className="vA-btn vA-btn-danger"
            onClick={() => {
              actions.remove(account.id)
              onClose()
            }}
          >
            Remove account
          </button>
        </>
      }
    >
      <div className="vA-remove">
        <div className="vA-success-card">
          <ProviderMark provider={account.provider} size={18} />
          <div>
            <div className="vA-success-email">{account.label}</div>
            <div className="vA-muted">{account.email}</div>
          </div>
          <span className="vA-plan" data-tier={planTier(account.plan)}>
            {planShort(account.plan)}
          </span>
        </div>
        <p>
          agent-proxy signs out of <b>{account.email}</b> and forgets this account. Sessions already using it finish; new sessions
          go to {next !== undefined ? <b>{next.label}</b> : `the next account in the ${p} pool`}. You can add it again later.
        </p>
        {onlyOne && (
          <div className="vA-callout is-warn">
            <IconAlert size={16} />
            <div>
              This is the only enabled {p} account. {clientsFor(account.provider)} can't use {p} until you add another.
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// -----------------------------------------------------------------------------------------------
// Toasts for live updates

const toastKind = (k: LiveEvent["kind"]) =>
  k === "cooldown"
    ? "Cooling down"
    : k === "signin-expired"
      ? "Needs sign-in"
      : k === "cooldown-ended"
        ? "Active again"
        : k === "daemon-down"
          ? "Daemon unreachable"
          : k === "daemon-up"
            ? "Daemon running"
            : "Update"

const toastTone = (k: LiveEvent["kind"]) =>
  k === "cooldown" ? "amber" : k === "signin-expired" || k === "daemon-down" ? "red" : "green"

export function Toasts({ events }: { events: ReadonlyArray<LiveEvent> }) {
  const [toasts, setToasts] = useState<LiveEvent[]>([])
  const seen = useRef(events[0]?.id ?? 0)
  useEffect(() => {
    const fresh = events.filter((e) => e.id > seen.current && e.live && e.kind !== "used")
    seen.current = Math.max(seen.current, events[0]?.id ?? 0)
    if (fresh.length > 0) setToasts((t) => [...t, ...fresh.reverse()].slice(-3))
  }, [events])
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  return (
    <div className="vA-toasts vA3-toasts" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} event={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

function Toast({ event, onDismiss }: { event: LiveEvent; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    const t = setTimeout(() => dismissRef.current(), 6000)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className={`vA-toast is-${toastTone(event.kind)}`}>
      <span className="vA-toast-icon">
        {event.provider !== null ? <ProviderMark provider={event.provider} size={15} /> : <IconPower size={14} />}
      </span>
      <div className="vA-toast-body">
        <div className="vA-toast-kind">
          <span className="vA-sdot" />
          {toastKind(event.kind)}
        </div>
        <div>{event.message}</div>
      </div>
      <button type="button" className="vA-iconbtn" onClick={onDismiss} aria-label="Dismiss">
        <IconX size={13} />
      </button>
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// First run: no accounts yet

export function FirstRun({ onAdd, address }: { onAdd: (p: Provider) => void; address: string }) {
  return (
    <div className="vA3-first">
      <div className="vA3-first-top">
        <div className="vA3-first-marks" aria-hidden="true">
          <span>
            <ProviderMark provider="claude" size={22} />
          </span>
          <span>
            <ProviderMark provider="codex" size={22} />
          </span>
        </div>
        <h2>Add your first account</h2>
        <p>
          The daemon at <code className="vA-inline">{address}</code> is running but has no accounts to serve yet. Sign in to a Claude
          or Codex account; its sign-in page opens in a new tab.
        </p>
        <div className="vA3-first-picks">
          {(["claude", "codex"] as const).map((p) => (
            <button key={p} type="button" className="vA3-first-pick" onClick={() => onAdd(p)}>
              <ProviderMark provider={p} size={20} />
              <span>
                <b>Add a {providerName[p]} account</b>
                <small>Used by {clientsFor(p)}</small>
              </span>
              <IconPlus size={15} />
            </button>
          ))}
        </div>
      </div>
      <div className="vA3-first-bottom">
        <div className="vA3-first-step">
          <span className="vA3-step-num">2</span>
          <div>
            <b>Then connect your clients</b>
            <p>One command per client points it at this proxy and gives it the proxy key.</p>
          </div>
        </div>
        <div className="vA3-first-cmds">
          {CLIENTS.map((c) => (
            <div key={c.id} className="vA3-first-cmd">
              <span>{c.name}</span>
              <CommandLine command={c.command} />
            </div>
          ))}
          <div className="vA3-first-key">
            <ProxyKeyRow />
          </div>
        </div>
      </div>
    </div>
  )
}
