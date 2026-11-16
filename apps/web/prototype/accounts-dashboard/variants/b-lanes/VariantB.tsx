// PROTOTYPE variant B ("Lanes"): routing-centric. Each provider's pool is a lane whose hero is
// "new sessions → <account>", over a priority ladder that shows the fall-through order and why
// accounts above the serving one are skipped. Add-account and "Sign in again" use a slide-over drawer.

import { useEffect, useLayoutEffect, useRef, useState } from "react"

import "./lanes.css"
import { type AddFlow, EXAMPLE_CALLBACK, useAddAccountFlow } from "../../shared/addFlow.ts"
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconCopy,
  IconExternal,
  IconGrip,
  IconKey,
  IconLogIn,
  IconPencil,
  IconPlus,
  IconPower,
  IconTerminal,
  IconTrash,
  IconX,
  IconZap,
  ProviderMark,
  providerAccent,
} from "../../shared/icons.tsx"
import {
  type Account,
  CLIENTS,
  PLANS,
  PROVIDERS,
  type PoolState,
  type Provider,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  planShort,
  planTier,
  poolState,
  providerLoginHost,
  providerName,
  statusLabel,
  statusOf,
} from "../../shared/model.ts"
import { type LiveEvent, actions, useDashboard, useNow } from "../../shared/store.ts"

export const name = "Lanes"

// ---------------------------------------------------------------------------------------------
// small helpers

const useCopy = (): [string | null, (key: string, text: string) => void] => {
  const [copied, setCopied] = useState<string | null>(null)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  return [
    copied,
    (key, text) => {
      void navigator.clipboard?.writeText(text).catch(() => {})
      setCopied(key)
      if (t.current !== null) clearTimeout(t.current)
      t.current = setTimeout(() => setCopied(null), 1400)
    },
  ]
}

const uptime = (since: number, now: number) => {
  const m = Math.max(0, Math.floor((now - since) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Move `id` before/after `targetId` in its provider's full priority order. */
const moveRelative = (accounts: ReadonlyArray<Account>, provider: Provider, id: string, targetId: string, after: boolean) => {
  if (id === targetId) return
  const ids = accountsOf(accounts, provider)
    .map((a) => a.id)
    .filter((x) => x !== id)
  let i = ids.indexOf(targetId)
  if (i < 0) return
  if (after) i++
  ids.splice(i, 0, id)
  actions.reorder(provider, ids)
}

const usedText = (ts: number | null, now: number) => (ts === null ? "Never used" : `Last used ${lastUsedText(ts, now)}`)

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

type DrawerReq = { nonce: number; provider?: Provider; reauthAccountId?: string }

// ---------------------------------------------------------------------------------------------

export function VariantB() {
  const s = useDashboard()
  const now = useNow(1000)
  const [drawer, setDrawer] = useState<DrawerReq | null>(null)
  const nonce = useRef(0)
  const open = (r: Omit<DrawerReq, "nonce">) => setDrawer({ ...r, nonce: ++nonce.current })
  const empty = s.accounts.length === 0

  return (
    <div className={`vB ${s.daemon.running ? "" : "vB-down"}`}>
      <div className="vB-glow" aria-hidden="true" />
      <div className="vB-page">
        <header className="vB-top">
          <div className="vB-brand">
            <span className="vB-logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path d="M4 6c6 0 6 6 12 6M4 18c6 0 6-6 12-6h4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="vB-wordmark">agent-proxy</span>
            <span className="vB-crumb">Accounts</span>
          </div>
          {!empty && (
            <button className="vB-btn vB-btn-primary" onClick={() => open({})}>
              <IconPlus size={16} /> Add account
            </button>
          )}
        </header>

        <section className="vB-hero">
          <DaemonCard now={now} />
          <ConnectClients />
        </section>

        {empty ? (
          <FirstRun onAdd={(provider) => open({ provider })} />
        ) : (
          <section className="vB-lanes" key={s.scenario}>
            {PROVIDERS.map((p) => (
              <Lane
                key={p}
                provider={p}
                now={now}
                onAdd={() => open({ provider: p })}
                onSignIn={(id) => open({ reauthAccountId: id })}
              />
            ))}
          </section>
        )}
      </div>

      <LiveToasts events={s.events} />
      {drawer !== null && <Drawer req={drawer} onClose={() => setDrawer(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Header: daemon + connect clients

function DaemonCard({ now }: { now: number }) {
  const { daemon, accounts } = useDashboard()
  const [copied, copy] = useCopy()
  return (
    <div className={`vB-card vB-daemon ${daemon.running ? "is-up" : "is-down"}`}>
      <div className="vB-eyebrow">Daemon</div>
      <div className="vB-daemon-state">
        <span className="vB-beacon" aria-hidden="true">
          <span />
        </span>
        <span>{daemon.running ? "Running" : "Unreachable"}</span>
      </div>
      <button className="vB-addr" onClick={() => copy("addr", `http://${daemon.address}`)} title="Copy address">
        <span>{daemon.address}</span>
        {copied === "addr" ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
      {daemon.running ? (
        <div className="vB-daemon-meta">
          <span>v{daemon.version}</span>
          <span className="vB-dot-sep" />
          <span>up {uptime(daemon.startedAt, now)}</span>
          <span className="vB-dot-sep" />
          <span className="vB-live">
            <span /> live
          </span>
        </div>
      ) : (
        <div className="vB-daemon-down">
          <span className="vB-spinner" aria-hidden="true" />
          <span>
            Can't reach the daemon. Statuses below may be out of date; this page reconnects on its own.
          </span>
        </div>
      )}
      {accounts.length > 0 && (
        <div className="vB-daemon-pools">
          {PROVIDERS.map((p) => {
            const ps = poolState(accounts, p)
            return (
              <div className="vB-daemon-pool" key={p}>
                <ProviderMark provider={p} size={13} />
                {ps.kind === "serving" ? (
                  <span>
                    {providerName[p]} → <b>{ps.account.label}</b>
                  </span>
                ) : ps.kind === "blocked" ? (
                  <span className="warn">
                    {providerName[p]} waiting{ps.nextReset !== null ? ` until ${formatClock(ps.nextReset)}` : ""}
                  </span>
                ) : (
                  <span>
                    {providerName[p]}: {ps.kind === "empty" ? "no accounts" : "every account disabled"}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ConnectClients() {
  const { proxyKey } = useDashboard()
  const [copied, copy] = useCopy()
  const [reveal, setReveal] = useState(false)
  const masked = `${proxyKey.slice(0, 9)}${"•".repeat(14)}${proxyKey.slice(-4)}`
  return (
    <div className="vB-card vB-connect">
      <div className="vB-connect-head">
        <div>
          <div className="vB-eyebrow">Connect clients</div>
          <p className="vB-connect-sub">Run once per client. It points the client at this proxy and gives it the proxy key.</p>
        </div>
        <div className="vB-key">
          <IconKey size={14} />
          <span className="vB-key-label">Proxy key</span>
          <code>{reveal ? proxyKey : masked}</code>
          <button className="vB-link" onClick={() => setReveal(!reveal)}>
            {reveal ? "Hide" : "Reveal"}
          </button>
          <button className="vB-icon-btn" onClick={() => copy("key", proxyKey)} aria-label="Copy proxy key">
            {copied === "key" ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
        </div>
      </div>
      <div className="vB-snippets">
        {CLIENTS.map((c) => (
          <div className="vB-snippet" key={c.id}>
            <div className="vB-snippet-head">
              <span className="vB-snippet-name">
                <IconTerminal size={14} /> {c.name}
              </span>
              <span className="vB-chips">
                {c.providers.map((p) => (
                  <span className="vB-chip" key={p} title={`Uses the ${providerName[p]} pool`}>
                    <ProviderMark provider={p} size={11} /> {providerName[p]}
                  </span>
                ))}
              </span>
            </div>
            <button className="vB-cmd" onClick={() => copy(c.id, c.command)} title="Copy command">
              <span className="vB-cmd-text">
                <span className="vB-prompt">$</span> {c.command}
              </span>
              <span className={`vB-cmd-copy ${copied === c.id ? "done" : ""}`}>
                {copied === c.id ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// First run

function FirstRun({ onAdd }: { onAdd: (p: Provider) => void }) {
  return (
    <section className="vB-card vB-first">
      <div className="vB-first-art" aria-hidden="true">
        {PROVIDERS.map((p) => (
          <div className="vB-first-lane" key={p} style={{ ["--acc" as string]: providerAccent[p] }}>
            <ProviderMark provider={p} size={22} />
            <span className="vB-first-rail" />
            <span className="vB-first-slot" />
            <span className="vB-first-slot" />
            <span className="vB-first-slot" />
          </div>
        ))}
      </div>
      <div className="vB-first-copy">
        <div className="vB-eyebrow">First run</div>
        <h1>Add the accounts you want to share</h1>
        <p>
          Each provider gets a pool. New sessions go to the highest-priority account that isn't cooling down, and fall
          through to the next one when it hits its limit.
        </p>
        <div className="vB-first-actions">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              className="vB-provider-btn"
              style={{ ["--acc" as string]: providerAccent[p] }}
              onClick={() => onAdd(p)}
            >
              <ProviderMark provider={p} size={22} />
              <span>
                <b>Add a {providerName[p]} account</b>
                <small>{PLANS[p].map(planShort).join(" · ")}</small>
              </span>
              <IconPlus size={16} />
            </button>
          ))}
        </div>
        <ol className="vB-steps">
          <li className="on">Add an account</li>
          <li>Connect a client with one command above</li>
          <li>Add more accounts to fall back on</li>
        </ol>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Lane

function Lane(props: { provider: Provider; now: number; onAdd: () => void; onSignIn: (id: string) => void }) {
  const { provider, now, onAdd, onSignIn } = props
  const s = useDashboard()
  const all = accountsOf(s.accounts, provider)
  const ladder = all.filter((a) => a.enabled)
  const off = all.filter((a) => !a.enabled)
  const ps = poolState(s.accounts, provider)
  const servingId = ps.kind === "serving" ? ps.account.id : null
  const clients = CLIENTS.filter((c) => c.providers.includes(provider)).map((c) => c.name)

  // Hand-off caption when the serving account changes.
  const prev = useRef<{ id: string | null; label: string | null }>({ id: servingId, label: ps.kind === "serving" ? ps.account.label : null })
  const [handoff, setHandoff] = useState<{ text: string; n: number } | null>(null)
  useEffect(() => {
    const p = prev.current
    const label = ps.kind === "serving" ? ps.account.label : null
    if (p.id !== servingId) {
      if (p.id !== null || servingId !== null) {
        const text =
          p.label !== null && label !== null
            ? `Handed off: ${p.label} → ${label}`
            : p.label !== null
              ? `${p.label} dropped out. No account left to take over`
              : `${label} picked up new sessions`
        setHandoff({ text, n: Date.now() })
      }
      prev.current = { id: servingId, label }
    }
  }, [servingId, ps])
  useEffect(() => {
    if (handoff === null) return
    const t = setTimeout(() => setHandoff(null), 4500)
    return () => clearTimeout(t)
  }, [handoff])

  return (
    <div className={`vB-lane vB-lane-${provider}`} style={{ ["--acc" as string]: providerAccent[provider] }}>
      <div className="vB-lane-head">
        <span className="vB-lane-mark">
          <ProviderMark provider={provider} size={22} />
        </span>
        <div className="vB-lane-title">
          <h2>{providerName[provider]}</h2>
          <span>
            {all.length === 0
              ? "No accounts"
              : `Pool of ${ladder.length}${off.length > 0 ? ` · ${off.length} disabled` : ""} · used by ${clients.join(", ")}`}
          </span>
        </div>
        <button className="vB-icon-btn vB-lane-add" onClick={onAdd} aria-label={`Add ${providerName[provider]} account`} title={`Add ${providerName[provider]} account`}>
          <IconPlus size={18} />
        </button>
      </div>

      {all.length === 0 ? (
        <div className="vB-lane-empty">
          <span className="vB-lane-empty-icon">
            <ProviderMark provider={provider} size={28} />
          </span>
          <b>No {providerName[provider]} accounts yet</b>
          <p>
            {clients.join(" and ")} can't reach {providerName[provider]} through the proxy until you add one.
          </p>
          <button className="vB-btn vB-btn-soft" onClick={onAdd}>
            <IconPlus size={15} /> Add {providerName[provider]} account
          </button>
        </div>
      ) : (
        <>
          <RoutingCard ps={ps} now={now} handoff={handoff} provider={provider} />
          {ladder.length > 0 && <Ladder provider={provider} ladder={ladder} ps={ps} now={now} onSignIn={onSignIn} />}
          {off.length > 0 && (
            <div className="vB-tray">
              <div className="vB-tray-head">
                <IconPower size={13} /> Off the pool <span>{off.length}</span>
              </div>
              {off.map((a) => (
                <AccountCard key={a.id} a={a} now={now} role="off" onSignIn={onSignIn} provider={provider} ladder={ladder} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function RoutingCard(props: { ps: PoolState; now: number; handoff: { text: string; n: number } | null; provider: Provider }) {
  const { ps, now, handoff, provider } = props
  const caption = handoff && (
    <div className="vB-handoff" key={handoff.n}>
      <IconZap size={13} /> {handoff.text}
    </div>
  )
  if (ps.kind === "serving") {
    const a = ps.account
    return (
      <div className="vB-route is-serving">
        <div className="vB-route-label">New sessions</div>
        <div className="vB-route-main">
          <span className="vB-route-arrow" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="vB-route-target" key={a.id}>
            {a.label}
          </span>
        </div>
        <div className="vB-route-sub">
          {a.plan} · {usedText(a.lastUsedAt, now).toLowerCase()}
        </div>
        {caption}
      </div>
    )
  }
  if (ps.kind === "blocked") {
    return (
      <div className="vB-route is-blocked">
        <div className="vB-route-label">
          <IconClock size={13} /> New sessions are waiting
        </div>
        <div className="vB-route-title">
          {ps.allCooling ? "Every account is cooling down." : "No account can take new sessions."}
        </div>
        <div className="vB-route-sub">
          {ps.nextReset !== null ? (
            <>
              New {providerName[provider]} sessions wait until <b>{formatClock(ps.nextReset)}</b>
              <span className="vB-countdown">{countdown(ps.nextReset, now)}</span>
            </>
          ) : (
            "Sign in again to an account below to get going."
          )}
        </div>
        {caption}
      </div>
    )
  }
  if (ps.kind === "off") {
    return (
      <div className="vB-route is-off">
        <div className="vB-route-label">New sessions</div>
        <div className="vB-route-title">Every account is disabled.</div>
        <div className="vB-route-sub">Turn one on to serve {providerName[provider]} sessions.</div>
        {caption}
      </div>
    )
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Ladder

function Ladder(props: {
  provider: Provider
  ladder: Account[]
  ps: PoolState
  now: number
  onSignIn: (id: string) => void
}) {
  const { provider, ladder, ps, now, onSignIn } = props
  const servingId = ps.kind === "serving" ? ps.account.id : null
  const rows = useRef(new Map<string, HTMLDivElement>())
  const [marker, setMarker] = useState<number | null>(null)
  const [, force] = useState(0)

  useLayoutEffect(() => {
    const el = servingId === null ? undefined : rows.current.get(servingId)
    const top = el === undefined ? null : el.offsetTop + 22
    if (top !== marker) setMarker(top)
  })
  useEffect(() => {
    const on = () => force((n) => n + 1)
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])

  const [drag, setDrag] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const s = useDashboard()
  const servingIndex = servingId === null ? ladder.length : ladder.findIndex((a) => a.id === servingId)
  const nextInLine = ladder.find((a, i) => i > servingIndex && a.health.kind === "active")?.id

  return (
    <div className={`vB-ladder ${servingId === null ? "no-serving" : ""}`}>
      <span className="vB-rail" aria-hidden="true" />
      <span className="vB-rail-flow" aria-hidden="true" style={{ height: marker === null ? 0 : marker - 4 }} />
      {marker !== null && <span className="vB-marker" aria-hidden="true" style={{ top: marker }} />}
      {ladder.map((a, i) => {
        const role: CardRole =
          a.id === servingId ? "serving" : i < servingIndex ? "skipped" : a.id === nextInLine ? "next" : "standby"
        return (
          <div
            key={a.id}
            ref={(el) => {
              if (el === null) rows.current.delete(a.id)
              else rows.current.set(a.id, el)
            }}
            className={`vB-row ${drag === a.id ? "is-dragging" : ""} ${drop?.id === a.id ? (drop.after ? "drop-after" : "drop-before") : ""}`}
            onDragOver={(e) => {
              if (drag === null || drag === a.id) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > r.top + r.height / 2
              if (drop?.id !== a.id || drop.after !== after) setDrop({ id: a.id, after })
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (drag !== null && drop !== null) moveRelative(s.accounts, provider, drag, drop.id, drop.after)
              setDrag(null)
              setDrop(null)
            }}
          >
            <span className={`vB-node ${role === "serving" ? "is-serving" : ""}`}>{a.priority}</span>
            <AccountCard
              a={a}
              now={now}
              role={role}
              provider={provider}
              ladder={ladder}
              onSignIn={onSignIn}
              onDragStart={() => setDrag(a.id)}
              onDragEnd={() => {
                setDrag(null)
                setDrop(null)
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

type CardRole = "serving" | "skipped" | "next" | "standby" | "off"

function AccountCard(props: {
  a: Account
  now: number
  role: CardRole
  provider: Provider
  ladder: Account[]
  onSignIn: (id: string) => void
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const { a, now, role, provider, ladder, onSignIn, onDragStart, onDragEnd } = props
  const s = useDashboard()
  const st = statusOf(a)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(a.label)
  const [confirm, setConfirm] = useState(false)
  const idx = ladder.findIndex((x) => x.id === a.id)
  const above = idx > 0 ? ladder[idx - 1] : undefined
  const below = idx >= 0 && idx < ladder.length - 1 ? ladder[idx + 1] : undefined
  const recent = a.changedAt > 0 && now - a.changedAt < 2200

  const save = () => {
    actions.rename(a.id, draft)
    setEditing(false)
  }

  const reason =
    role === "skipped"
      ? "Skipped"
      : role === "next"
        ? "Next in line"
        : role === "standby"
          ? st.kind === "active"
            ? "Standby"
            : null
          : null

  return (
    <article
      className={`vB-acct role-${role} st-${st.kind} ${confirm ? "is-confirming" : ""}`}
      draggable={role !== "off" && !editing && !confirm}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData("text/plain", a.id)
        onDragStart?.()
      }}
      onDragEnd={onDragEnd}
    >
      {recent && <span className="vB-pulse" key={a.changedAt} aria-hidden="true" />}
      <div className="vB-acct-top">
        {role !== "off" && (
          <span className="vB-grip" title="Drag to change priority" aria-hidden="true">
            <IconGrip size={14} />
          </span>
        )}
        <div className="vB-acct-name">
          {editing ? (
            <input
              className="vB-input vB-rename"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") save()
                if (e.key === "Escape") {
                  setDraft(a.label)
                  setEditing(false)
                }
              }}
              aria-label="Account label"
            />
          ) : (
            <>
              <h3>{a.label}</h3>
              <span className={`vB-plan tier-${planTier(a.plan)}`}>{planShort(a.plan)}</span>
            </>
          )}
        </div>
        <button
          role="switch"
          aria-checked={a.enabled}
          aria-label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`}
          title={a.enabled ? "Enabled: in the pool" : "Disabled: out of the pool"}
          className={`vB-switch ${a.enabled ? "on" : ""}`}
          onClick={() => actions.setEnabled(a.id, !a.enabled)}
        >
          <span />
        </button>
      </div>
      <div className="vB-acct-meta">
        <span>{a.email}</span>
        <span className="vB-dot-sep" />
        <span>{usedText(a.lastUsedAt, now)}</span>
        {role === "off" && (
          <>
            <span className="vB-dot-sep" />
            <span>Priority {a.priority}</span>
          </>
        )}
      </div>
      <div className="vB-acct-bottom">
        <span className={`vB-status st-${st.kind}`} key={`${st.kind}-${a.changedAt}`}>
          <span className="vB-status-dot" />
          {statusLabel(st)}
          {st.kind === "cooling" && (
            <span className="vB-status-extra">
              until {formatClock(st.until)} · {countdown(st.until, now)}
            </span>
          )}
        </span>
        {st.kind === "signin" && (
          <button className="vB-btn vB-btn-xs vB-btn-danger" onClick={() => onSignIn(a.id)}>
            <IconLogIn size={13} /> Sign in again
          </button>
        )}
        {role === "serving" && <span className="vB-serving-tag">Serving new sessions</span>}
        {reason !== null && role !== "serving" && <span className={`vB-reason r-${role}`}>{reason}</span>}
        <span className="vB-acct-tools">
          {role !== "off" && (
            <>
              <button
                className="vB-icon-btn"
                disabled={above === undefined}
                onClick={() => above && moveRelative(s.accounts, provider, a.id, above.id, false)}
                aria-label="Raise priority"
                title="Raise priority"
              >
                <IconChevronUp size={15} />
              </button>
              <button
                className="vB-icon-btn"
                disabled={below === undefined}
                onClick={() => below && moveRelative(s.accounts, provider, a.id, below.id, true)}
                aria-label="Lower priority"
                title="Lower priority"
              >
                <IconChevronDown size={15} />
              </button>
            </>
          )}
          <button
            className="vB-icon-btn"
            onClick={() => {
              setDraft(a.label)
              setEditing(true)
            }}
            aria-label="Rename"
            title="Rename"
          >
            <IconPencil size={14} />
          </button>
          <button className="vB-icon-btn vB-danger-hover" onClick={() => setConfirm(true)} aria-label="Remove" title="Remove">
            <IconTrash size={14} />
          </button>
        </span>
      </div>
      {confirm && (
        <div className="vB-confirm" role="alertdialog" aria-label={`Remove ${a.label}?`}>
          <div>
            <b>Remove {a.label}?</b>
            <span>agent-proxy forgets this account. You can add it again by signing in.</span>
          </div>
          <div className="vB-confirm-actions">
            <button className="vB-btn vB-btn-ghost vB-btn-sm" onClick={() => setConfirm(false)} autoFocus>
              Cancel
            </button>
            <button className="vB-btn vB-btn-danger vB-btn-sm" onClick={() => actions.remove(a.id)}>
              Remove
            </button>
          </div>
        </div>
      )}
    </article>
  )
}

// ---------------------------------------------------------------------------------------------
// Live toasts (daemon-pushed changes only)

function LiveToasts({ events }: { events: ReadonlyArray<LiveEvent> }) {
  const [shown, setShown] = useState<LiveEvent[]>([])
  const last = useRef(events[0]?.id ?? 0)
  useEffect(() => {
    const fresh = events.filter((e) => e.id > last.current && e.live && e.kind !== "used")
    if (events[0] !== undefined) last.current = Math.max(last.current, events[0].id)
    if (fresh.length === 0) return
    setShown((xs) => [...fresh.reverse(), ...xs].slice(0, 3))
    const ids = fresh.map((e) => e.id)
    const t = setTimeout(() => setShown((xs) => xs.filter((x) => !ids.includes(x.id))), 5000)
    return () => clearTimeout(t)
  }, [events])
  return (
    <div className="vB-toasts" aria-live="polite">
      {shown.map((e) => (
        <div className={`vB-toast k-${e.kind}`} key={e.id}>
          {e.provider !== null ? <ProviderMark provider={e.provider} size={16} /> : <IconAlert size={16} />}
          <span>{e.message}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Add-account drawer

function Drawer({ req, onClose }: { req: DrawerReq; onClose: () => void }) {
  const [closing, setClosing] = useState(false)
  const close = () => {
    setClosing(true)
    setTimeout(onClose, 220)
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  })
  return (
    <div className={`vB-drawer-wrap ${closing ? "closing" : ""}`}>
      <div className="vB-backdrop" onClick={close} />
      <aside className="vB-drawer" role="dialog" aria-modal="true" aria-label="Add account">
        <DrawerFlow key={req.nonce} req={req} onClose={close} />
      </aside>
    </div>
  )
}

function DrawerFlow({ req, onClose }: { req: DrawerReq; onClose: () => void }) {
  const opts: { provider?: Provider; reauthAccountId?: string } = {}
  if (req.provider !== undefined) opts.provider = req.provider
  if (req.reauthAccountId !== undefined) opts.reauthAccountId = req.reauthAccountId
  const flow = useAddAccountFlow(opts)
  const s = useDashboard()
  const reauth = flow.reauthAccountId === null ? undefined : s.accounts.find((a) => a.id === flow.reauthAccountId)
  const step = flow.step
  const stepIndex = step.kind === "pick" ? 0 : step.kind === "success" ? 2 : 1

  return (
    <>
      <div className="vB-drawer-head">
        <div>
          <div className="vB-eyebrow">{reauth ? "Sign in again" : "Add account"}</div>
          <h2>
            {reauth
              ? reauth.label
              : step.kind === "pick"
                ? "Choose a provider"
                : step.kind === "success"
                  ? step.reauth
                    ? "Signed in"
                    : "Account added"
                  : `Sign in to ${providerName[step.provider]}`}
          </h2>
        </div>
        <button className="vB-icon-btn" onClick={onClose} aria-label="Close">
          <IconX size={18} />
        </button>
      </div>
      {!reauth && (
        <div className="vB-progress" aria-hidden="true">
          {["Provider", "Sign in", "Done"].map((l, i) => (
            <span key={l} className={i <= stepIndex ? "on" : ""}>
              {l}
            </span>
          ))}
        </div>
      )}
      <div className="vB-drawer-body">
        {step.kind === "pick" && <PickStep flow={flow} />}
        {step.kind === "waiting" && <WaitStep flow={flow} reauthLabel={reauth?.label} />}
        {step.kind === "verifying" && (
          <div className="vB-verify">
            <span className="vB-ring" style={{ ["--acc" as string]: providerAccent[step.provider] }}>
              <ProviderMark provider={step.provider} size={26} />
            </span>
            <b>Finishing sign-in…</b>
            <span>Checking the account's plan with {providerName[step.provider]}.</span>
          </div>
        )}
        {step.kind === "success" && <SuccessStep accountId={step.accountId} reauth={step.reauth} onClose={onClose} onAnother={flow.reset} />}
      </div>
    </>
  )
}

function PickStep({ flow }: { flow: AddFlow }) {
  const s = useDashboard()
  return (
    <div className="vB-pick">
      <p className="vB-muted">Your provider's login opens in a new tab. agent-proxy never sees your password.</p>
      {PROVIDERS.map((p) => {
        const n = accountsOf(s.accounts, p).length
        return (
          <button key={p} className="vB-pick-card" style={{ ["--acc" as string]: providerAccent[p] }} onClick={() => flow.choose(p)}>
            <span className="vB-pick-mark">
              <ProviderMark provider={p} size={28} />
            </span>
            <span className="vB-pick-text">
              <b>{providerName[p]}</b>
              <small>{PLANS[p].join(" · ")}</small>
              <small className="vB-pick-n">{n === 0 ? "No accounts yet" : `${n} in the pool · new one joins at priority ${n + 1}`}</small>
            </span>
            <IconExternal size={16} />
          </button>
        )
      })}
    </div>
  )
}

function WaitStep({ flow, reauthLabel }: { flow: AddFlow; reauthLabel: string | undefined }) {
  const step = flow.step
  const [url, setUrl] = useState("")
  const [copied, copy] = useCopy()
  const [loginUrl] = useState(() => (step.kind === "waiting" ? flow.loginUrl(step.provider) : ""))
  if (step.kind !== "waiting") return null
  const p = step.provider
  return (
    <div className="vB-wait">
      <div className="vB-wait-hero" style={{ ["--acc" as string]: providerAccent[p] }}>
        <span className="vB-ring is-waiting">
          <ProviderMark provider={p} size={26} />
        </span>
        <b>Waiting for you to finish signing in…</b>
        <span>
          {step.popupBlocked ? "Open " : "We opened "}
          <code>{providerLoginHost[p]}</code>
          {step.popupBlocked ? " to sign in" : " in a new tab"}
          {reauthLabel ? ` as ${reauthLabel}` : ""}. Approve there and come back; this updates on its own.
        </span>
        <button className={`vB-btn vB-btn-sm ${step.popupBlocked ? "vB-btn-primary" : "vB-btn-soft"}`} onClick={flow.openLogin}>
          <IconExternal size={14} /> {step.popupBlocked ? `Open ${providerLoginHost[p]}` : "Open it again"}
        </button>
      </div>
      {step.popupBlocked && (
        <div className="vB-notice">
          <IconAlert size={15} />
          <span>Your browser blocked the new tab. Open it again, or paste the callback URL below.</span>
        </div>
      )}
      <div className="vB-paste">
        <div className="vB-paste-head">
          <IconTerminal size={14} /> Signing in on another machine? (headless or SSH)
        </div>
        <ol>
          <li>
            Open this link on any device with a browser.
            <button className="vB-cmd vB-cmd-light" onClick={() => copy("login", loginUrl)} title="Copy link">
              <span className="vB-cmd-text">{loginUrl}</span>
              <span className={`vB-cmd-copy ${copied === "login" ? "done" : ""}`}>
                {copied === "login" ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </span>
            </button>
          </li>
          <li>After you approve, the browser lands on a page that won't load. Copy its address and paste it here.</li>
        </ol>
        <form
          className="vB-paste-form"
          onSubmit={(e) => {
            e.preventDefault()
            flow.pasteCallback(url)
          }}
        >
          <input
            className={`vB-input ${step.pasteError ? "has-error" : ""}`}
            placeholder="http://127.0.0.1:8318/callback?code=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Paste the callback URL"
          />
          <button className="vB-btn vB-btn-primary vB-btn-sm" type="submit" disabled={url.trim() === ""}>
            Continue
          </button>
        </form>
        {step.pasteError && <div className="vB-error">{step.pasteError}</div>}
        <button className="vB-link vB-example" onClick={() => setUrl(EXAMPLE_CALLBACK)}>
          Prototype: fill an example callback URL
        </button>
      </div>
      <button className="vB-link" onClick={flow.back}>
        ← Choose a different provider
      </button>
    </div>
  )
}

function SuccessStep(props: { accountId: string; reauth: boolean; onClose: () => void; onAnother: () => void }) {
  const { accountId, reauth, onClose, onAnother } = props
  const s = useDashboard()
  const a = s.accounts.find((x) => x.id === accountId)
  const [label, setLabel] = useState(a?.label ?? "")
  if (a === undefined) return null
  const ladder = accountsOf(s.accounts, a.provider)
  const ps = poolState(s.accounts, a.provider)
  const serving = ps.kind === "serving" && ps.account.id === a.id
  return (
    <div className="vB-success">
      <div className="vB-success-badge">
        <IconCheck size={26} />
      </div>
      <b className="vB-success-title">{reauth ? `${a.label} is signed in again` : `Signed in as ${a.email}`}</b>
      <div className="vB-success-plan">
        <ProviderMark provider={a.provider} size={14} /> {a.plan}
      </div>
      {!reauth && (
        <label className="vB-field">
          <span>Label</span>
          <input
            className="vB-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => actions.rename(a.id, label)}
            onKeyDown={(e) => {
              if (e.key === "Enter") actions.rename(a.id, label)
            }}
          />
        </label>
      )}
      <div className="vB-mini-ladder">
        <div className="vB-mini-title">
          {providerName[a.provider]} ladder · {serving ? "it gets new sessions now" : `it sits ${ordinal(a.priority)}`}
        </div>
        {ladder.map((x) => (
          <div key={x.id} className={`vB-mini-row ${x.id === a.id ? "is-new" : ""} ${x.enabled ? "" : "is-off"}`}>
            <span className="vB-mini-n">{x.priority}</span>
            <span>{x.id === a.id ? label || x.label : x.label}</span>
            <span className="vB-mini-st">{statusLabel(statusOf(x))}</span>
          </div>
        ))}
      </div>
      <div className="vB-success-actions">
        {!reauth && (
          <button className="vB-btn vB-btn-ghost" onClick={onAnother}>
            Add another
          </button>
        )}
        <button
          className="vB-btn vB-btn-primary"
          onClick={() => {
            actions.rename(a.id, label)
            onClose()
          }}
        >
          Done
        </button>
      </div>
    </div>
  )
}
