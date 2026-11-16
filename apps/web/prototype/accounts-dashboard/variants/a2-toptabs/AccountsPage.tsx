// PROTOTYPE round 2 variant A2: the Accounts page (per-provider tables), adapted from round 1 Console.
// Clicking an account's name opens its detail page; the ⋯ menu renames, moves, signs in again, removes.

import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react"

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
import { type DashboardState, actions } from "../../shared/store.ts"
import { CommandLine, ProxyKeyRow } from "../a-console/ConnectClients.tsx"
import { Modal, RowMenu, Switch } from "../a-console/ui.tsx"
import { PAGES } from "../kit/future.tsx"

export const clientsFor = (p: Provider) =>
  CLIENTS.filter((c) => c.providers.includes(p))
    .map((c) => c.name)
    .join(" and ")

export function AccountsPage(props: {
  s: DashboardState
  now: number
  onAdd: (p: Provider | undefined) => void
  onReauth: (id: string) => void
  onRemove: (id: string) => void
  onOpen: (id: string) => void
}) {
  const { s, now } = props
  if (s.accounts.length === 0) return <FirstRun onAdd={props.onAdd} address={s.daemon.address} />
  const signin = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  const cooling = s.accounts.filter((a) => a.enabled && a.health.kind === "cooling").length
  return (
    <>
      <div className="vA2-pagehead">
        <div>
          <h1>Accounts</h1>
          <p>{PAGES.accounts.blurb}</p>
        </div>
        <div className="vA2-pagehead-actions">
          <dl className="vA2-kpis">
            <div>
              <dt>Accounts</dt>
              <dd>{s.accounts.length}</dd>
            </div>
            <div>
              <dt>Cooling down</dt>
              <dd className={cooling > 0 ? "is-amber" : ""}>{cooling}</dd>
            </div>
            <div>
              <dt>Needs sign-in</dt>
              <dd className={signin > 0 ? "is-red" : ""}>{signin}</dd>
            </div>
          </dl>
          <button type="button" className="vA-btn vA-btn-primary" onClick={() => props.onAdd(undefined)}>
            <IconPlus size={14} /> Add account
          </button>
        </div>
      </div>
      {PROVIDERS.map((p) => (
        <ProviderSection
          key={p}
          provider={p}
          accounts={s.accounts}
          now={now}
          onAdd={() => props.onAdd(p)}
          onReauth={props.onReauth}
          onRemove={props.onRemove}
          onOpen={props.onOpen}
        />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// First run

function FirstRun({ onAdd, address }: { onAdd: (p: Provider) => void; address: string }) {
  return (
    <div className="vA-first vA2-first">
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
                    <small>Used by {clientsFor(p)}</small>
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

// ---------------------------------------------------------------------------------------------
// Provider section

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
  onOpen: (id: string) => void
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
    <section className={`vA-section vA2-section ${ps.kind === "blocked" ? "is-blocked" : ""}`} aria-labelledby={`vA2-h-${provider}`}>
      <header className="vA-section-head">
        <div className="vA-section-title">
          <ProviderMark provider={provider} size={18} />
          <h2 id={`vA2-h-${provider}`}>{providerName[provider]}</h2>
          <span className="vA-count">{list.length}</span>
        </div>
        <PoolLine ps={ps} now={now} provider={provider} />
        <div className="vA-bar-spacer" />
        {list.length > 0 && (
          <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
            <IconPlus size={13} /> Add {providerName[provider]} account
          </button>
        )}
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
            onOpen={() => props.onOpen(a.id)}
          />
        ))}
        {list.length === 0 && (
          <div className="vA-empty">
            <ProviderMark provider={provider} size={22} />
            <div>
              <b>No {providerName[provider]} accounts yet</b>
              <p>
                {clientsFor(provider)} can't use {providerName[provider]} until you add one.
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
  onOpen: () => void
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
        "vA2-row",
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
          <div className="vA-label">
            <button type="button" className="vA2-namelink" onClick={props.onOpen} title={`Open ${a.label}`}>
              {a.label}
              <IconArrowRight size={13} />
            </button>
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
          { label: "Open details", icon: <IconArrowRight size={14} />, onSelect: props.onOpen },
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

// ---------------------------------------------------------------------------------------------
// Remove confirmation

export function RemoveModal(props: {
  account: Account
  accounts: ReadonlyArray<Account>
  onClose: () => void
  onRemoved: () => void
}) {
  const { account, accounts, onClose } = props
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
              props.onRemoved()
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
