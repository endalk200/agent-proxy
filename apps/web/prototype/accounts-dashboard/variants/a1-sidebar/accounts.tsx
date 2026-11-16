// PROTOTYPE variant A1: the Accounts page body. Adapted from round 1's Console (a-console/VariantA.tsx):
// per-provider tables, drag-to-reorder, inline rename, ⋯ menu. New here: clicking a row opens the
// account sheet, and the open account stays highlighted.

import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react"

import {
  IconAlert,
  IconChevronDown,
  IconChevronRight,
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
import { type LiveEvent, actions } from "../../shared/store.ts"
import { CommandLine, ProxyKeyRow } from "../a-console/ConnectClients.tsx"
import { Modal, RowMenu, Switch } from "../a-console/ui.tsx"

export const clientsFor = (p: Provider) =>
  CLIENTS.filter((c) => c.providers.includes(p))
    .map((c) => c.name)
    .join(" and ")

// -----------------------------------------------------------------------------------------------
// Pool line in a section header

export function PoolLine({ ps, now, provider }: { ps: PoolState; now: number; provider: Provider }) {
  switch (ps.kind) {
    case "serving":
      return (
        <span className="vA1-pool is-ok">
          <span className="vA1-pool-dot" />
          New sessions go to <b>{ps.account.label}</b>
        </span>
      )
    case "blocked":
      return (
        <span className="vA1-pool is-warn">
          <IconAlert size={13} />
          {ps.allCooling ? "Every account is cooling down" : "No account can take new sessions"}
          {ps.nextReset !== null && (
            <span className="vA1-pool-sub">
              · next reset {formatClock(ps.nextReset)} ({countdown(ps.nextReset, now)})
            </span>
          )}
        </span>
      )
    case "off":
      return <span className="vA1-pool is-muted">Every {providerName[provider]} account is disabled</span>
    case "empty":
      return <span className="vA1-pool is-muted">No accounts yet</span>
  }
}

// -----------------------------------------------------------------------------------------------
// Provider section

interface DragState {
  id: string
  from: number
  to: number
  startY: number
  dy: number
  h: number
}

export function ProviderSection(props: {
  provider: Provider
  accounts: ReadonlyArray<Account>
  now: number
  openId: string | null
  onOpen: (id: string) => void
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
    <section className={`vA1-section ${ps.kind === "blocked" ? "is-blocked" : ""}`} aria-labelledby={`vA1-h-${provider}`}>
      <header className="vA1-section-head">
        <div className="vA1-section-title">
          <ProviderMark provider={provider} size={16} />
          <h2 id={`vA1-h-${provider}`}>{providerName[provider]}</h2>
          <span className="vA1-count">{list.length}</span>
        </div>
        <PoolLine ps={ps} now={now} provider={provider} />
        <div className="vA1-spacer" />
        {list.length > 0 && (
          <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
            <IconPlus size={13} /> Add {providerName[provider]} account
          </button>
        )}
      </header>

      {ps.kind === "blocked" && (
        <div className="vA1-blocked">
          <IconClock size={15} />
          <span>
            {ps.allCooling ? (
              <>
                Every account in the {providerName[provider]} pool hit its limit. No account can take new{" "}
                {providerName[provider]} sessions until{" "}
                <b>{ps.nextReset !== null ? formatClock(ps.nextReset) : "a cooldown ends"}</b>.
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

      <div className={`vA-table vA1-table ${drag !== null ? "is-dragging" : ""} ${settling ? "is-settling" : ""}`} role="list">
        {list.length > 0 && (
          <div className="vA-row vA-thead vA1-row" aria-hidden="true">
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
            open={props.openId === a.id}
            now={now}
            editing={editing === a.id}
            onEdit={(on) => setEditing(on ? a.id : null)}
            offset={offsetFor(i, a.id)}
            lifted={drag?.id === a.id}
            onGripDown={(e) => startDrag(e, a.id, i)}
            onGripMove={moveDrag}
            onGripUp={endDrag}
            onOpen={() => props.onOpen(a.id)}
            onReauth={() => props.onReauth(a.id)}
            onRemove={() => props.onRemove(a.id)}
          />
        ))}
        {list.length === 0 && (
          <div className="vA1-empty">
            <span className="vA1-empty-mark">
              <ProviderMark provider={provider} size={18} />
            </span>
            <div>
              <b>No {providerName[provider]} accounts yet</b>
              <p>
                {clientsFor(provider)} can't use {providerName[provider]} until you add one.
              </p>
            </div>
            <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
              <IconPlus size={13} /> Add {providerName[provider]} account
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

const INTERACTIVE = "button, input, a, [role=switch], .vA-menu-wrap"

function AccountRow(props: {
  account: Account
  index: number
  count: number
  serving: boolean
  open: boolean
  now: number
  editing: boolean
  onEdit: (on: boolean) => void
  offset: number
  lifted: boolean
  onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onGripMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onGripUp: () => void
  onOpen: () => void
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
      tabIndex={0}
      aria-label={`${a.label}, ${statusLabel(st)}. Open details`}
      className={[
        "vA-row",
        "vA1-row",
        `is-${st.kind}`,
        props.serving ? "is-serving" : "",
        props.lifted ? "is-lifted" : "",
        props.open ? "is-open" : "",
        flash ? "is-flash" : "",
      ].join(" ")}
      style={props.offset !== 0 ? { transform: `translateY(${props.offset}px)` } : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(INTERACTIVE) !== null) return
        props.onOpen()
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          props.onOpen()
        }
      }}
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
          { label: "Open details", icon: <IconChevronRight size={14} />, onSelect: props.onOpen },
          { label: "Rename", icon: <IconPencil size={14} />, onSelect: () => props.onEdit(true) },
          {
            label: "Move up",
            icon: <IconChevronUp size={14} />,
            onSelect: () => actions.move(a.id, -1),
            disabled: props.index === 0,
            separatorBefore: true,
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

export function RenameInput({ account, onDone, className }: { account: Account; onDone: () => void; className?: string }) {
  const [value, setValue] = useState(account.label)
  const save = () => {
    actions.rename(account.id, value)
    onDone()
  }
  return (
    <input
      className={className ?? "vA-input vA-rename"}
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save()
        else if (e.key === "Escape") {
          e.stopPropagation()
          e.nativeEvent.stopImmediatePropagation()
          onDone()
        }
      }}
      aria-label={`Label for ${account.label}`}
    />
  )
}

// -----------------------------------------------------------------------------------------------
// First run

export function FirstRun({ onAdd, address }: { onAdd: (p: Provider) => void; address: string }) {
  return (
    <div className="vA1-first">
      <ol className="vA1-steps">
        <li className="is-current">
          <div className="vA1-step-num">1</div>
          <div className="vA1-step-body">
            <h3>Add an account</h3>
            <p>
              The daemon at <code>{address}</code> has no accounts yet. Pick a provider and its sign-in page opens in a new tab.
            </p>
            <div className="vA1-picks">
              {(["claude", "codex"] as const).map((p) => (
                <button key={p} type="button" className="vA1-pick" onClick={() => onAdd(p)}>
                  <span className="vA1-pick-mark">
                    <ProviderMark provider={p} size={18} />
                  </span>
                  <span className="vA1-pick-text">
                    <b>{providerName[p]}</b>
                    <small>Used by {clientsFor(p)}</small>
                  </span>
                  <IconPlus size={15} />
                </button>
              ))}
            </div>
          </div>
        </li>
        <li>
          <div className="vA1-step-num">2</div>
          <div className="vA1-step-body">
            <h3>Connect your clients</h3>
            <p>Run one command per client. It points the client at this proxy and gives it the proxy key.</p>
            <div className="vA1-cmds">
              {CLIENTS.map((c) => (
                <div key={c.id} className="vA1-cmd-row">
                  <span className="vA1-cmd-name">{c.name}</span>
                  <CommandLine command={c.command} />
                </div>
              ))}
            </div>
            <div className="vA1-first-key">
              <ProxyKeyRow />
            </div>
          </div>
        </li>
        <li>
          <div className="vA1-step-num">3</div>
          <div className="vA1-step-body">
            <h3>Add a fallback</h3>
            <p>Add a second account to a pool. When the first hits its limit, new sessions move to the next one by priority.</p>
          </div>
        </li>
      </ol>
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Remove confirmation

export function RemoveModal({
  account,
  accounts,
  onClose,
}: {
  account: Account
  accounts: ReadonlyArray<Account>
  onClose: () => void
}) {
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

export const eventTone = (k: LiveEvent["kind"]): "amber" | "red" | "green" | "neutral" =>
  k === "cooldown"
    ? "amber"
    : k === "signin-expired" || k === "daemon-down" || k === "removed"
      ? "red"
      : k === "cooldown-ended" || k === "signed-in" || k === "daemon-up" || k === "added" || k === "enabled"
        ? "green"
        : "neutral"

export const eventTitle = (k: LiveEvent["kind"]): string => {
  switch (k) {
    case "cooldown":
      return "Cooling down"
    case "signin-expired":
      return "Needs sign-in"
    case "cooldown-ended":
      return "Active again"
    case "daemon-down":
      return "Daemon unreachable"
    case "daemon-up":
      return "Daemon running"
    case "signed-in":
      return "Signed in"
    case "used":
      return "Served a request"
    case "added":
      return "Added"
    case "removed":
      return "Removed"
    case "enabled":
      return "Enabled"
    case "disabled":
      return "Disabled"
    case "reordered":
      return "Priority changed"
    case "renamed":
      return "Renamed"
  }
}

export function Toasts({ events }: { events: ReadonlyArray<LiveEvent> }) {
  const [toasts, setToasts] = useState<LiveEvent[]>([])
  const seen = useRef(events[0]?.id ?? 0)
  useEffect(() => {
    const fresh = events.filter((e) => e.id > seen.current && e.live && e.kind !== "used")
    seen.current = Math.max(seen.current, events[0]?.id ?? 0)
    if (fresh.length > 0) setToasts((t) => [...t, ...fresh.reverse()].slice(-4))
  }, [events])
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  return (
    <div className="vA-toasts vA1-toasts" aria-live="polite">
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
    <div className={`vA-toast is-${eventTone(event.kind)}`}>
      <span className="vA-toast-icon">
        {event.provider !== null ? <ProviderMark provider={event.provider} size={15} /> : <IconPower size={14} />}
      </span>
      <div className="vA-toast-body">
        <div className="vA-toast-kind">
          <span className="vA-sdot" />
          {eventTitle(event.kind)}
        </div>
        <div>{event.message}</div>
      </div>
      <button type="button" className="vA-iconbtn" onClick={onDismiss} aria-label="Dismiss">
        <IconX size={13} />
      </button>
    </div>
  )
}
