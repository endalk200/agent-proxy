// PROTOTYPE variant A4: the accounts tables (adapted from round 1 Console). Rows are selectable:
// clicking one opens the inspector at the top of the right-hand context column.

import { type MouseEvent, type PointerEvent as ReactPointerEvent, useRef, useState } from "react"

import {
  IconAlert,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconGrip,
  IconLogIn,
  IconPencil,
  IconPlus,
  IconTrash,
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
import { actions } from "../../shared/store.ts"
import { Modal, RowMenu, Switch } from "../a-console/ui.tsx"

export const clientsFor = (p: Provider) =>
  CLIENTS.filter((c) => c.providers.includes(p))
    .map((c) => c.name)
    .join(" and ")

// -----------------------------------------------------------------------------------------------

export function PoolLine({ ps, now, provider }: { ps: PoolState; now: number; provider: Provider }) {
  switch (ps.kind) {
    case "serving":
      return (
        <span className="vA4-poolline is-ok">
          <span className="vA4-dot" /> New sessions <IconArrowRight size={12} /> <b>{ps.account.label}</b>
        </span>
      )
    case "blocked":
      return (
        <span className="vA4-poolline is-warn">
          <IconAlert size={13} />
          {ps.allCooling ? "Every account is cooling down" : "No account can take new sessions"}
          {ps.nextReset !== null && (
            <span className="vA4-poolline-sub">
              · next reset {formatClock(ps.nextReset)} ({countdown(ps.nextReset, now)})
            </span>
          )}
        </span>
      )
    case "off":
      return <span className="vA4-poolline is-muted">Every {providerName[provider]} account is disabled</span>
    case "empty":
      return <span className="vA4-poolline is-muted">No accounts yet</span>
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

export function ProviderSection(props: {
  provider: Provider
  accounts: ReadonlyArray<Account>
  now: number
  selectedId: string | null
  editingId: string | null
  onEdit: (id: string | null) => void
  onSelect: (id: string) => void
  onAdd: () => void
  onReauth: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { provider, accounts, now } = props
  const list = accountsOf(accounts, provider)
  const ps = poolState(accounts, provider)
  const servingId = ps.kind === "serving" ? ps.account.id : null
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
    <section className={`vA4-section ${ps.kind === "blocked" ? "is-blocked" : ""}`} aria-labelledby={`vA4-h-${provider}`}>
      <header className="vA4-section-head">
        <div className="vA4-section-title">
          <span className="vA4-section-mark">
            <ProviderMark provider={provider} size={16} />
          </span>
          <h2 id={`vA4-h-${provider}`}>{providerName[provider]}</h2>
          <span className="vA4-count">{list.length}</span>
        </div>
        <PoolLine ps={ps} now={now} provider={provider} />
        <span className="vA4-spacer" />
        {list.length > 0 && (
          <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
            <IconPlus size={13} /> Add
          </button>
        )}
      </header>

      {ps.kind === "blocked" && (
        <div className="vA4-blocked">
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
                {ps.nextReset !== null ? (
                  <>
                    Every enabled account is cooling down or needs sign-in. The first cooldown ends at{" "}
                    <b>{formatClock(ps.nextReset)}</b>.
                  </>
                ) : (
                  <>
                    Every enabled {providerName[provider]} account needs sign-in. Sign in again to put one back in the pool.
                  </>
                )}
              </>
            )}
          </span>
        </div>
      )}

      <div className={`vA-table vA4-table ${drag !== null ? "is-dragging" : ""} ${settling ? "is-settling" : ""}`} role="list">
        {list.length > 0 && (
          <div className="vA-row vA-thead" aria-hidden="true">
            <span />
            <span>#</span>
            <span>Account</span>
            <span>Plan</span>
            <span>Status</span>
            <span>Last used</span>
            <span>On</span>
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
            selected={a.id === props.selectedId}
            now={now}
            editing={props.editingId === a.id}
            onEdit={(on) => props.onEdit(on ? a.id : null)}
            onSelect={() => props.onSelect(a.id)}
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
          <div className="vA4-empty">
            <span className="vA4-empty-mark">
              <ProviderMark provider={provider} size={20} />
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

const isInteractive = (e: MouseEvent) =>
  (e.target as HTMLElement).closest("button, input, a, [role=switch], .vA-menu") !== null

function AccountRow(props: {
  account: Account
  index: number
  count: number
  serving: boolean
  selected: boolean
  now: number
  editing: boolean
  onEdit: (on: boolean) => void
  onSelect: () => void
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
      data-account={a.id}
      aria-current={props.selected ? "true" : undefined}
      className={[
        "vA-row",
        `is-${st.kind}`,
        props.serving ? "is-serving" : "",
        props.lifted ? "is-lifted" : "",
        props.selected ? "is-selected" : "",
        flash ? "is-flash" : "",
      ].join(" ")}
      style={props.offset !== 0 ? { transform: `translateY(${props.offset}px)` } : undefined}
      onClick={(e) => {
        if (!isInteractive(e)) props.onSelect()
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
            <span className="vA4-label-text">{a.label}</span>
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
          ...(st.kind === "signin" ? [{ label: "Sign in again", icon: <IconLogIn size={14} />, onSelect: props.onReauth }] : []),
          { label: "Remove…", icon: <IconTrash size={14} />, onSelect: props.onRemove, danger: true, separatorBefore: true },
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
      className={`vA-input vA-rename ${className ?? ""}`}
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

export function FirstRun({ onAdd, address }: { onAdd: (p: Provider) => void; address: string }) {
  return (
    <div className="vA4-first">
      <div className="vA4-first-marks" aria-hidden="true">
        <span>
          <ProviderMark provider="claude" size={24} />
        </span>
        <span>
          <ProviderMark provider="codex" size={24} />
        </span>
      </div>
      <h2>Add your first account</h2>
      <p>
        The daemon is running at <code className="vA-inline">{address}</code> with nothing to serve yet. Sign in to a Claude or
        Codex account and your clients can start using it.
      </p>
      <div className="vA4-first-picks">
        {(["claude", "codex"] as const).map((p) => (
          <button key={p} type="button" className="vA4-first-pick" onClick={() => onAdd(p)}>
            <span className="vA4-first-pick-mark">
              <ProviderMark provider={p} size={20} />
            </span>
            <span>
              <b>Add a {providerName[p]} account</b>
              <small>Used by {clientsFor(p)}</small>
            </span>
            <IconPlus size={15} />
          </button>
        ))}
      </div>
      <div className="vA4-first-next">
        <span className="vA4-first-num">2</span>
        Then run a <b>Connect clients</b> command, in the panel on the right, once per client.
      </div>
    </div>
  )
}
