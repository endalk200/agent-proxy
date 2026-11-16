// PROTOTYPE variant A — "Console": a dense, Linear/Vercel-style admin list.
// Slim app bar (daemon pill, Connect clients popover), one bordered table per provider,
// drag-to-reorder priority, inline rename, ⋯ menu, modals for add and remove, toasts for live updates.

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"

import "./console.css"
import {
  IconAlert,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconGrip,
  IconLogIn,
  IconPencil,
  IconPlus,
  IconPower,
  IconTrash,
  IconX,
  ProviderMark,
} from "../../shared/icons.tsx"
import {
  type Account,
  CLIENTS,
  PROVIDERS,
  type PoolState,
  type Provider,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  planShort,
  planTier,
  poolOf,
  poolState,
  providerName,
  statusLabel,
  statusOf,
} from "../../shared/model.ts"
import { type DashboardState, type LiveEvent, actions, useDashboard, useNow } from "../../shared/store.ts"
import { AddAccountModal } from "./AddAccountModal.tsx"
import { CommandLine, ConnectClientsButton, ProxyKeyRow } from "./ConnectClients.tsx"
import { Modal, RowMenu, Switch } from "./ui.tsx"

export const name = "Console"

type Dialog =
  | { kind: "add"; provider: Provider | undefined }
  | { kind: "reauth"; accountId: string }
  | { kind: "remove"; accountId: string }
  | null

export function VariantA() {
  const s = useDashboard()
  const now = useNow(1000)
  const [dialog, setDialog] = useState<Dialog>(null)
  const offline = !s.daemon.running
  const empty = s.accounts.length === 0
  const close = () => setDialog(null)
  const removing = dialog?.kind === "remove" ? s.accounts.find((a) => a.id === dialog.accountId) : undefined

  return (
    <div className="vA">
      <TopBar s={s} now={now} onAdd={() => setDialog({ kind: "add", provider: undefined })} />
      <main className="vA-main">
        {offline && (
          <div className="vA-offline" role="status">
            <IconPower size={16} />
            <div>
              <b>Can't reach the daemon at {s.daemon.address}.</b> Is it running? The accounts below are from the last time it
              answered; changes are paused until it's back.
            </div>
          </div>
        )}
        <div className={`vA-content ${offline ? "is-offline" : ""}`} aria-disabled={offline}>
          {empty ? (
            <FirstRun onAdd={(p) => setDialog({ kind: "add", provider: p })} address={s.daemon.address} />
          ) : (
            <>
              <PageHeader s={s} />
              {PROVIDERS.map((p) => (
                <ProviderSection
                  key={p}
                  provider={p}
                  accounts={s.accounts}
                  now={now}
                  onAdd={() => setDialog({ kind: "add", provider: p })}
                  onReauth={(id) => setDialog({ kind: "reauth", accountId: id })}
                  onRemove={(id) => setDialog({ kind: "remove", accountId: id })}
                />
              ))}
            </>
          )}
        </div>
      </main>

      <Toasts events={s.events} />

      {dialog?.kind === "add" && <AddAccountModal provider={dialog.provider} reauthAccountId={undefined} onClose={close} />}
      {dialog?.kind === "reauth" && <AddAccountModal provider={undefined} reauthAccountId={dialog.accountId} onClose={close} />}
      {removing !== undefined && <RemoveModal account={removing} accounts={s.accounts} onClose={close} />}
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// App bar

const uptime = (startedAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function TopBar({ s, now, onAdd }: { s: DashboardState; now: number; onAdd: () => void }) {
  const running = s.daemon.running
  return (
    <header className="vA-bar">
      <div className="vA-bar-inner">
        <div className="vA-brand">
          <span className="vA-logo" aria-hidden="true">
            <span />
            <span />
          </span>
          agent-proxy
        </div>
        <span className="vA-bar-sep" />
        <div className={`vA-daemon ${running ? "is-up" : "is-down"}`} title={running ? `daemon v${s.daemon.version}` : undefined}>
          <span className="vA-daemon-dot" />
          <span className="vA-daemon-state">{running ? "Running" : "Can't reach the daemon"}</span>
          <code>{s.daemon.address}</code>
          {running && <span className="vA-daemon-up">up {uptime(s.daemon.startedAt, now)}</span>}
        </div>
        <div className="vA-bar-spacer" />
        <ConnectClientsButton />
        <button type="button" className="vA-btn vA-btn-primary" onClick={onAdd} disabled={!running}>
          <IconPlus size={14} /> Add account
        </button>
      </div>
    </header>
  )
}

function PageHeader({ s }: { s: DashboardState }) {
  const total = s.accounts.length
  const attention = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const cooling = s.accounts.filter((a) => a.enabled && a.health.kind === "cooling").length
  return (
    <div className="vA-pagehead">
      <div>
        <h1>Accounts</h1>
        <p>
          Each client spends only its own provider's accounts. Within a pool, the highest-priority account that isn't cooling down
          gets new sessions.
        </p>
      </div>
      <dl className="vA-stats">
        <div>
          <dt>Accounts</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>Cooling down</dt>
          <dd className={cooling > 0 ? "is-amber" : ""}>{cooling}</dd>
        </div>
        <div>
          <dt>Needs sign-in</dt>
          <dd className={attention > 0 ? "is-red" : ""}>{attention}</dd>
        </div>
      </dl>
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// First run

function FirstRun({ onAdd, address }: { onAdd: (p: Provider) => void; address: string }) {
  return (
    <div className="vA-first">
      <div className="vA-first-hero">
        <div className="vA-first-marks" aria-hidden="true">
          <span>
            <ProviderMark provider="claude" size={26} />
          </span>
          <span>
            <ProviderMark provider="codex" size={26} />
          </span>
        </div>
        <h1>Add your first account</h1>
        <p>
          The daemon is running at <code className="vA-inline">{address}</code> but has no accounts to serve yet. Sign in to a
          Claude or Codex account and your clients can start using it.
        </p>
      </div>

      <ol className="vA-steps">
        <li className="is-current">
          <div className="vA-step-num">1</div>
          <div className="vA-step-body">
            <h3>Add an account</h3>
            <p>Its sign-in page opens in a new tab. Add more later and drag them into priority order.</p>
            <div className="vA-first-picks">
              {(["claude", "codex"] as const).map((p) => (
                <button key={p} type="button" className="vA-first-pick" onClick={() => onAdd(p)}>
                  <ProviderMark provider={p} size={20} />
                  <span>
                    <b>Add a {providerName[p]} account</b>
                    <small>Used by {CLIENTS.filter((c) => c.providers.includes(p)).map((c) => c.name).join(" and ")}</small>
                  </span>
                  <IconPlus size={15} />
                </button>
              ))}
            </div>
          </div>
        </li>
        <li>
          <div className="vA-step-num">2</div>
          <div className="vA-step-body">
            <h3>Connect your clients</h3>
            <p>Run one command per client. It points the client at this proxy and gives it the proxy key.</p>
            <div className="vA-first-cmds">
              {CLIENTS.map((c) => (
                <div key={c.id} className="vA-first-cmd">
                  <span className="vA-first-cmd-name">{c.name}</span>
                  <CommandLine command={c.command} />
                </div>
              ))}
            </div>
            <ProxyKeyRow />
          </div>
        </li>
      </ol>
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Provider section

function PoolLine({ ps, now, provider }: { ps: PoolState; now: number; provider: Provider }) {
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
      return <span className="vA-pool is-muted">Every {providerName[provider]} account is disabled</span>
    case "empty":
      return <span className="vA-pool is-muted">No accounts</span>
  }
}

interface DragState {
  id: string
  from: number
  to: number
  startY: number
  dy: number
  h: number
}

function ProviderSection(props: {
  provider: Provider
  accounts: ReadonlyArray<Account>
  now: number
  onAdd: () => void
  onReauth: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { provider, accounts, now } = props
  const list = accountsOf(accounts, provider)
  const ps = poolState(accounts, provider)
  const servingId = ps.kind === "serving" ? ps.account.id : null
  const [editing, setEditing] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [settling, setSettling] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (e.button !== 0) return
    const row = e.currentTarget.closest(".vA-row")
    if (row === null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id, from: index, to: index, startY: e.clientY, dy: 0, h: row.getBoundingClientRect().height })
  }
  const moveDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (d === null) return
    const dy = e.clientY - d.startY
    const to = Math.max(0, Math.min(list.length - 1, d.from + Math.round(dy / d.h)))
    setDrag({ ...d, dy, to })
  }
  const endDrag = () => {
    const d = dragRef.current
    if (d === null) return
    if (d.to !== d.from) {
      const ids = list.map((a) => a.id).filter((id) => id !== d.id)
      ids.splice(d.to, 0, d.id)
      actions.reorder(provider, ids)
    }
    setSettling(true)
    setDrag(null)
    requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)))
  }

  const offsetFor = (index: number, id: string): number => {
    if (drag === null) return 0
    if (id === drag.id) return drag.dy
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.h
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return drag.h
    return 0
  }

  return (
    <section className={`vA-section ${ps.kind === "blocked" ? "is-blocked" : ""}`} aria-labelledby={`vA-h-${provider}`}>
      <header className="vA-section-head">
        <div className="vA-section-title">
          <ProviderMark provider={provider} size={18} />
          <h2 id={`vA-h-${provider}`}>{providerName[provider]}</h2>
          <span className="vA-count">{list.length}</span>
        </div>
        <PoolLine ps={ps} now={now} provider={provider} />
        <div className="vA-bar-spacer" />
        <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
          <IconPlus size={13} /> Add account
        </button>
      </header>

      {ps.kind === "blocked" && (
        <div className="vA-blocked">
          <IconClock size={15} />
          <span>
            {ps.allCooling ? (
              <>
                Every account in the {providerName[provider]} pool hit its limit. No account can take new{" "}
                {providerName[provider]} sessions until {ps.nextReset !== null ? formatClock(ps.nextReset) : "a cooldown ends"}.
              </>
            ) : (
              <>
                Every enabled account is cooling down or needs sign-in.{" "}
                {ps.nextReset !== null ? `The first cooldown ends at ${formatClock(ps.nextReset)}.` : "Sign in again to recover."}
              </>
            )}
          </span>
        </div>
      )}

      <div className={`vA-table ${drag !== null ? "is-dragging" : ""} ${settling ? "is-settling" : ""}`} role="list">
        {list.length > 0 && (
          <div className="vA-row vA-thead" aria-hidden="true">
            <span />
            <span>#</span>
            <span>Account</span>
            <span>Plan</span>
            <span>Status</span>
            <span>Last used</span>
            <span>Enabled</span>
            <span />
          </div>
        )}
        {list.map((a, i) => (
          <AccountRow
            key={a.id}
            account={a}
            index={i}
            count={list.length}
            serving={a.id === servingId}
            now={now}
            editing={editing === a.id}
            onEdit={(on) => setEditing(on ? a.id : null)}
            offset={offsetFor(i, a.id)}
            lifted={drag?.id === a.id}
            onGripDown={(e) => startDrag(e, a.id, i)}
            onGripMove={moveDrag}
            onGripUp={endDrag}
            onReauth={() => props.onReauth(a.id)}
            onRemove={() => props.onRemove(a.id)}
          />
        ))}
        {list.length === 0 && (
          <div className="vA-empty">
            <ProviderMark provider={provider} size={22} />
            <div>
              <b>No {providerName[provider]} accounts yet</b>
              <p>
                {CLIENTS.filter((c) => c.providers.includes(provider))
                  .map((c) => c.name)
                  .join(" and ")}{" "}
                can't use {providerName[provider]} until you add one.
              </p>
            </div>
            <button type="button" className="vA-btn vA-btn-primary vA-btn-sm" onClick={props.onAdd}>
              <IconPlus size={13} /> Add {providerName[provider]} account
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function AccountRow(props: {
  account: Account
  index: number
  count: number
  serving: boolean
  now: number
  editing: boolean
  onEdit: (on: boolean) => void
  offset: number
  lifted: boolean
  onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onGripMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onGripUp: () => void
  onReauth: () => void
  onRemove: () => void
}) {
  const { account: a, now } = props
  const st = statusOf(a)
  const flash = a.changedAt > 0 && now - a.changedAt < 2600
  const usedFlash = a.lastUsedAt !== null && now - a.lastUsedAt < 1800
  return (
    <div
      role="listitem"
      className={[
        "vA-row",
        `is-${st.kind}`,
        props.serving ? "is-serving" : "",
        props.lifted ? "is-lifted" : "",
        flash ? "is-flash" : "",
      ].join(" ")}
      style={props.offset !== 0 ? { transform: `translateY(${props.offset}px)` } : undefined}
    >
      <button
        type="button"
        className="vA-grip"
        aria-label={`Reorder ${a.label}. Arrow keys move it.`}
        title="Drag to change priority"
        onPointerDown={props.onGripDown}
        onPointerMove={props.onGripMove}
        onPointerUp={props.onGripUp}
        onPointerCancel={props.onGripUp}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault()
            actions.move(a.id, -1)
          } else if (e.key === "ArrowDown") {
            e.preventDefault()
            actions.move(a.id, 1)
          }
        }}
      >
        <IconGrip size={14} />
      </button>

      <span className="vA-prio" title={`Priority ${a.priority}`}>
        {a.priority}
      </span>

      <div className="vA-who">
        {props.editing ? (
          <RenameInput account={a} onDone={() => props.onEdit(false)} />
        ) : (
          <div className="vA-label" onDoubleClick={() => props.onEdit(true)} title="Double-click to rename">
            {a.label}
            {props.serving && <span className="vA-serving">New sessions</span>}
          </div>
        )}
        <div className="vA-email">{a.email}</div>
      </div>

      <span>
        <span className="vA-plan" data-tier={planTier(a.plan)} title={a.plan}>
          {planShort(a.plan)}
        </span>
      </span>

      <div className="vA-status">
        <span className="vA-status-main">
          <span className="vA-sdot" />
          {statusLabel(st)}
        </span>
        {st.kind === "cooling" && (
          <span className="vA-status-sub">
            until {formatClock(st.until)} · {countdown(st.until, now)}
          </span>
        )}
        {st.kind === "signin" && (
          <button type="button" className="vA-btn vA-btn-xs vA-btn-red" onClick={props.onReauth}>
            <IconLogIn size={12} /> Sign in again
          </button>
        )}
      </div>

      <span
        className={`vA-used ${usedFlash ? "is-fresh" : ""}`}
        title={a.lastUsedAt === null ? "Never used" : new Date(a.lastUsedAt).toLocaleString()}
      >
        {lastUsedText(a.lastUsedAt, now)}
      </span>

      <span>
        <Switch
          checked={a.enabled}
          onChange={(v) => actions.setEnabled(a.id, v)}
          label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`}
        />
      </span>

      <RowMenu
        label={`Actions for ${a.label}`}
        items={[
          { label: "Rename", icon: <IconPencil size={14} />, onSelect: () => props.onEdit(true) },
          {
            label: "Move up",
            icon: <IconChevronUp size={14} />,
            onSelect: () => actions.move(a.id, -1),
            disabled: props.index === 0,
          },
          {
            label: "Move down",
            icon: <IconChevronDown size={14} />,
            onSelect: () => actions.move(a.id, 1),
            disabled: props.index === props.count - 1,
          },
          ...(st.kind === "signin"
            ? [{ label: "Sign in again", icon: <IconLogIn size={14} />, onSelect: props.onReauth }]
            : []),
          {
            label: "Remove…",
            icon: <IconTrash size={14} />,
            onSelect: props.onRemove,
            danger: true,
            separatorBefore: true,
          },
        ]}
      />
    </div>
  )
}

function RenameInput({ account, onDone }: { account: Account; onDone: () => void }) {
  const [value, setValue] = useState(account.label)
  const save = () => {
    actions.rename(account.id, value)
    onDone()
  }
  return (
    <input
      className="vA-input vA-rename"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save()
        else if (e.key === "Escape") {
          e.stopPropagation()
          onDone()
        }
      }}
      aria-label={`Label for ${account.label}`}
    />
  )
}

// -----------------------------------------------------------------------------------------------
// Remove confirmation

function RemoveModal({ account, accounts, onClose }: { account: Account; accounts: ReadonlyArray<Account>; onClose: () => void }) {
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
              This is the only enabled {p} account. {CLIENTS.filter((c) => c.providers.includes(account.provider)).map((c) => c.name).join(" and ")}{" "}
              can't use {p} until you add another.
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// -----------------------------------------------------------------------------------------------
// Toasts for live updates

const toastTone = (k: LiveEvent["kind"]) =>
  k === "cooldown" ? "amber" : k === "signin-expired" || k === "daemon-down" ? "red" : "green"

function Toasts({ events }: { events: ReadonlyArray<LiveEvent> }) {
  const [toasts, setToasts] = useState<LiveEvent[]>([])
  const seen = useRef(events[0]?.id ?? 0)
  useEffect(() => {
    const fresh = events.filter((e) => e.id > seen.current && e.live && e.kind !== "used")
    seen.current = Math.max(seen.current, events[0]?.id ?? 0)
    if (fresh.length > 0) setToasts((t) => [...t, ...fresh.reverse()].slice(-4))
  }, [events])
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  return (
    <div className="vA-toasts" aria-live="polite">
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
  const tone = toastTone(event.kind)
  return (
    <div className={`vA-toast is-${tone}`}>
      <span className="vA-toast-icon">
        {event.provider !== null ? <ProviderMark provider={event.provider} size={15} /> : <IconPower size={14} />}
      </span>
      <div className="vA-toast-body">
        <div className="vA-toast-kind">
          <span className="vA-sdot" />
          {event.kind === "cooldown"
            ? "Cooling down"
            : event.kind === "signin-expired"
              ? "Needs sign-in"
              : event.kind === "cooldown-ended"
                ? "Active again"
                : event.kind === "daemon-down"
                  ? "Daemon unreachable"
                  : event.kind === "daemon-up"
                    ? "Daemon running"
                    : "Update"}
        </div>
        <div>{event.message}</div>
      </div>
      <button type="button" className="vA-iconbtn" onClick={onDismiss} aria-label="Dismiss">
        <IconX size={13} />
      </button>
    </div>
  )
}
