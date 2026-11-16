// PROTOTYPE variant A4: the app shell. Icon rail on the left, top bar with the daemon switcher
// breadcrumb, the ⌘K command button, and the daemon's status.

import { useEffect, useRef, useState } from "react"

import { IconCheck, IconCopy, IconSearch } from "../../shared/icons.tsx"
import { poolState } from "../../shared/model.ts"
import type { DashboardState } from "../../shared/store.ts"
import { copyText } from "../a-console/ui.tsx"
import { PAGES } from "../kit/future.tsx"
import { IconGlobe, IconMachine, IconSelector } from "./icons.tsx"
import { NAV_ICON, type NavPage } from "./nav.ts"

export const uptime = (startedAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? "⌘" : "Ctrl "

// -----------------------------------------------------------------------------------------------
// Rail

export function Rail({ s, page, onGo }: { s: DashboardState; page: NavPage; onGo: (p: NavPage) => void }) {
  const signin = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const blocked = (["claude", "codex"] as const).some((p) => poolState(s.accounts, p).kind === "blocked")
  const item = (id: NavPage) => {
    const Icon = NAV_ICON[id]
    const P = PAGES[id]
    const badge = id === "accounts" && s.daemon.running ? (signin > 0 ? String(signin) : blocked ? "dot" : null) : null
    return (
      <button
        key={id}
        type="button"
        className={`vA4-rail-item ${page === id ? "is-active" : ""} ${P.ready ? "" : "is-planned"}`}
        aria-current={page === id ? "page" : undefined}
        aria-label={P.ready ? P.title : `${P.title} (planned)`}
        onClick={() => onGo(id)}
      >
        <Icon size={18} />
        {badge !== null &&
          (badge === "dot" ? (
            <span className="vA4-rail-dot" aria-hidden="true" />
          ) : (
            <span className="vA4-rail-badge" aria-label={`${badge} need sign-in`}>
              {badge}
            </span>
          ))}
        <span className="vA4-tip" role="tooltip">
          {P.title}
          {!P.ready && <em>Planned</em>}
          {id === "accounts" && signin > 0 && <em className="is-red">{signin} needs sign-in</em>}
          {id === "accounts" && signin === 0 && blocked && <em className="is-amber">A pool is waiting</em>}
        </span>
      </button>
    )
  }
  return (
    <nav className="vA4-rail" aria-label="Pages">
      <div className="vA4-rail-logo" title="agent-proxy">
        <span className="vA-logo" aria-hidden="true">
          <span />
          <span />
        </span>
      </div>
      <div className="vA4-rail-group">{(["accounts", "usage", "sessions", "skills"] as const).map(item)}</div>
      <div className="vA4-rail-spacer" />
      <div className="vA4-rail-group">{item("settings")}</div>
    </nav>
  )
}

// -----------------------------------------------------------------------------------------------
// Top bar

export function TopBar(props: { s: DashboardState; now: number; page: NavPage; onPalette: () => void }) {
  const { s, now } = props
  const running = s.daemon.running
  return (
    <header className="vA4-top">
      <div className="vA4-crumbs">
        <DaemonSwitcher s={s} now={now} />
        <span className="vA4-crumb-sep">/</span>
        <span className="vA4-crumb-page">{PAGES[props.page].title}</span>
      </div>
      <button type="button" className="vA4-cmdk-btn" onClick={props.onPalette}>
        <IconSearch size={14} />
        <span>Search or run a command…</span>
        <kbd className="vA4-kbd">{MOD}K</kbd>
      </button>
      <div className="vA4-top-right">
        <div className={`vA4-status ${running ? "is-up" : "is-down"}`} role="status">
          <span className="vA4-status-dot" />
          {running ? (
            <>
              Running <span className="vA4-status-sub">up {uptime(s.daemon.startedAt, now)}</span>
            </>
          ) : (
            "Unreachable"
          )}
        </div>
      </div>
    </header>
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
    const t = setTimeout(() => setCopied(false), 1300)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="vA4-switch-wrap" ref={ref}>
      <button
        type="button"
        className={`vA4-switcher ${open ? "is-open" : ""} ${running ? "is-up" : "is-down"}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="The daemon this dashboard is connected to"
      >
        <span className="vA4-switcher-icon">
          <IconMachine size={14} />
          <span className="vA4-switcher-dot" />
        </span>
        <span className="vA4-switcher-name">This Mac</span>
        <code className="vA4-switcher-addr">{s.daemon.address}</code>
        <IconSelector size={13} />
      </button>
      {open && (
        <div className="vA4-daemon-menu" role="menu">
          <div className="vA4-dm-label">Connected to</div>
          <div className={`vA4-dm-card ${running ? "is-up" : "is-down"}`}>
            <span className="vA4-dm-icon">
              <IconMachine size={16} />
            </span>
            <div className="vA4-dm-body">
              <div className="vA4-dm-title">
                This Mac <span className="vA4-dm-badge">Local</span>
              </div>
              <code>{s.daemon.address}</code>
              <div className="vA4-dm-meta">
                <span className="vA4-status-dot" />
                {running ? `Running · up ${uptime(s.daemon.startedAt, now)} · v${s.daemon.version}` : "Unreachable"}
              </div>
            </div>
            <IconCheck size={15} />
          </div>
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
          <button type="button" role="menuitem" className="vA-menu-item vA4-dm-planned" disabled>
            <span className="vA-menu-icon">
              <IconGlobe size={14} />
            </span>
            Connect to a remote daemon
            <span className="vA4-planned-tag">Planned</span>
          </button>
        </div>
      )}
    </div>
  )
}
