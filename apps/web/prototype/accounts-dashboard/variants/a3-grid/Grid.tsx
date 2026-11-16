// PROTOTYPE variant A3: the unified accounts grid. One bordered surface: toolbar, column header,
// provider groups (pool state in the group header), rows that expand inline, footer.
// The same toolbar + grid + footer pattern is meant to carry Usage and Sessions later.

import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react"

import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconGrip,
  IconLogIn,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
  ProviderMark,
} from "../../shared/icons.tsx"
import {
  type Account,
  PROVIDERS,
  type Provider,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  planShort,
  planTier,
  poolState,
  providerName,
  statusLabel,
  statusOf,
} from "../../shared/model.ts"
import { type DashboardState, type LiveEvent, actions } from "../../shared/store.ts"
import { RowMenu, Switch } from "../a-console/ui.tsx"
import { PoolLine, clientsFor } from "./parts.tsx"

type View = "all" | "claude" | "codex" | "attention"

const needsYou = (a: Account) => a.enabled && a.health.kind === "signin"

const isTyping = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable)

export function AccountsGrid(props: {
  s: DashboardState
  now: number
  offline: boolean
  onAdd: (p: Provider | undefined) => void
  onReauth: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { s, now } = props
  const [view, setView] = useState<View>("all")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  // The focus ring shows only while driving with the keyboard; a click selects without it.
  const [ring, setRing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()

  const match = (a: Account) =>
    (q === "" || a.label.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)) && (view !== "attention" || needsYou(a))

  const groups = useMemo(() => {
    const providers = view === "claude" ? (["claude"] as const) : view === "codex" ? (["codex"] as const) : PROVIDERS
    return providers
      .map((p) => ({ provider: p, rows: accountsOf(s.accounts, p).filter(match) }))
      .filter((g) => (q === "" && view !== "attention") || g.rows.length > 0)
  }, [s.accounts, view, q])

  const visibleIds = groups.flatMap((g) => g.rows.map((r) => r.id))
  const visibleKey = visibleIds.join(",")
  const dragEnabled = q === "" && view !== "attention" && !props.offline

  // Keep focus/expansion on rows that still exist and are visible.
  useEffect(() => {
    if (focused !== null && !visibleIds.includes(focused)) setFocused(null)
    if (expanded !== null && !visibleIds.includes(expanded)) setExpanded(null)
  }, [visibleKey])

  // Keyboard: ↑/↓ move the focus ring, Enter expands, Esc collapses, / searches. ←/→ belong to the prototype bar.
  const stateRef = useRef({ visibleIds, focused, expanded })
  stateRef.current = { visibleIds, focused, expanded }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector(".vA-overlay") !== null) return
      const { visibleIds: ids, focused: f, expanded: x } = stateRef.current
      if (isTyping(document.activeElement)) {
        if (e.key === "Escape" && document.activeElement === searchRef.current) searchRef.current?.blur()
        return
      }
      if (e.key === "/") {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if ((document.activeElement as HTMLElement | null)?.classList.contains("vA-grip")) return
        if (ids.length === 0) return
        e.preventDefault()
        const i = f === null ? -1 : ids.indexOf(f)
        const next = e.key === "ArrowDown" ? Math.min(ids.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1)
        const id = ids[next]!
        setFocused(id)
        setRing(true)
        document.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: "nearest" })
      } else if (e.key === "Enter" && f !== null && (document.activeElement === document.body || document.activeElement === null)) {
        e.preventDefault()
        setExpanded(x === f ? null : f)
      } else if (e.key === "Escape") {
        if (x !== null) setExpanded(null)
        else setFocused(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Live indicator: pulses when the daemon pushes an event.
  const latest = s.events[0]
  const [pulse, setPulse] = useState(false)
  const lastSeen = useRef(latest?.id ?? 0)
  useEffect(() => {
    if (latest === undefined || latest.id === lastSeen.current) return
    lastSeen.current = latest.id
    if (!latest.live) return
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 1600)
    return () => clearTimeout(t)
  }, [latest])
  const [mountedAt] = useState(Date.now)
  const updatedAt = latest?.at ?? mountedAt

  const counts = {
    all: s.accounts.length,
    claude: s.accounts.filter((a) => a.provider === "claude").length,
    codex: s.accounts.filter((a) => a.provider === "codex").length,
    attention: s.accounts.filter(needsYou).length,
  }
  const pools = PROVIDERS.filter((p) => s.accounts.some((a) => a.provider === p)).length

  const toggle = (id: string) => {
    setFocused(id)
    setRing(false)
    setExpanded(expanded === id ? null : id)
  }

  return (
    <div className={`vA3-grid ${props.offline ? "is-offline" : ""}`}>
      <div className="vA3-sticky">
        <div className="vA3-toolbar">
          <label className="vA3-search">
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search accounts"
              aria-label="Search accounts by label or email"
            />
            {query !== "" ? (
              <button type="button" className="vA3-search-clear" onClick={() => setQuery("")} aria-label="Clear search">
                <IconX size={12} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </label>
          <div className="vA3-views" role="tablist" aria-label="View">
            {(
              [
                ["all", "All"],
                ["claude", "Claude"],
                ["codex", "Codex"],
                ["attention", "Needs attention"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                className={`${view === id ? "is-on" : ""} ${id === "attention" && counts.attention > 0 ? "is-alert" : ""}`}
                onClick={() => setView(id)}
              >
                {id === "claude" || id === "codex" ? <ProviderMark provider={id} size={12} /> : null}
                {label}
                <span className="vA3-views-count">{counts[id]}</span>
              </button>
            ))}
          </div>
          <div className="vA3-spacer" />
          <span
            className={`vA3-live ${props.offline ? "is-off" : ""} ${pulse ? "is-pulse" : ""}`}
            title={props.offline ? "Not receiving updates" : "Statuses update as the daemon reports them"}
          >
            <span className="vA3-live-dot" />
            {props.offline ? "Offline" : "Live"}
          </span>
          <button type="button" className="vA-btn vA-btn-primary vA-btn-sm" onClick={() => props.onAdd(undefined)} disabled={props.offline}>
            <IconPlus size={13} /> Add account
          </button>
        </div>
        {!dragEnabled && !props.offline && (
          <div className="vA3-hint">
            <span>
              {q !== "" ? (
                <>
                  Showing matches for <b>“{query.trim()}”</b>. Reordering is off while a search is active.
                </>
              ) : (
                <>Only accounts that need sign-in are shown. Switch to All, Claude or Codex to reorder.</>
              )}
            </span>
            <button
              type="button"
              className="vA-linkbtn"
              onClick={() => {
                setQuery("")
                setView("all")
              }}
            >
              Show all
            </button>
          </div>
        )}
        <div className="vA3-thead" aria-hidden="true">
          <span />
          <span>#</span>
          <span>Account</span>
          <span>Plan</span>
          <span>Status</span>
          <span>Last used</span>
          <span>Enabled</span>
          <span />
        </div>
      </div>

      <div className="vA3-body">
        {groups.map((g) => (
          <Group
            key={g.provider}
            provider={g.provider}
            rows={g.rows}
            s={s}
            now={now}
            dragEnabled={dragEnabled}
            expanded={expanded}
            focused={ring ? focused : null}
            onToggle={toggle}
            onAdd={() => props.onAdd(g.provider)}
            onReauth={props.onReauth}
            onRemove={props.onRemove}
            collapseAll={() => setExpanded(null)}
          />
        ))}
        {groups.length === 0 && (
          <div className="vA3-noresults">
            {view === "attention" && q === "" ? (
              <>
                <span className="vA3-noresults-icon is-ok">
                  <IconCheck size={16} />
                </span>
                <b>Nothing needs you</b>
                <span>Every enabled account is signed in.</span>
              </>
            ) : (
              <>
                <span className="vA3-noresults-icon">
                  <IconSearch size={16} />
                </span>
                <b>No accounts match “{query.trim()}”</b>
                <button type="button" className="vA-linkbtn" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="vA3-foot">
        <span>
          {counts.all} {counts.all === 1 ? "account" : "accounts"} · {pools} {pools === 1 ? "pool" : "pools"}
        </span>
        <span className="vA3-foot-sep" />
        <span>{props.offline ? "Daemon unreachable · showing what it last reported" : `Updated ${lastUsedText(updatedAt, now)}`}</span>
        <span className="vA3-spacer" />
        <span className="vA3-foot-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// A provider group: header row with the pool state, then its rows (drag to reorder within the group)

interface DragState {
  id: string
  from: number
  to: number
  startY: number
  dy: number
  h: number
}

function Group(props: {
  provider: Provider
  rows: ReadonlyArray<Account>
  s: DashboardState
  now: number
  dragEnabled: boolean
  expanded: string | null
  focused: string | null
  onToggle: (id: string) => void
  onAdd: () => void
  onReauth: (id: string) => void
  onRemove: (id: string) => void
  collapseAll: () => void
}) {
  const { provider, rows, s, now } = props
  const ps = poolState(s.accounts, provider)
  const servingId = ps.kind === "serving" ? ps.account.id : null
  const all = accountsOf(s.accounts, provider)
  const [editing, setEditing] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [settling, setSettling] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  // Blink the group header when the serving account changes.
  const [blink, setBlink] = useState(false)
  const prevServing = useRef(servingId)
  useEffect(() => {
    if (prevServing.current === servingId) return
    prevServing.current = servingId
    setBlink(true)
    const t = setTimeout(() => setBlink(false), 1800)
    return () => clearTimeout(t)
  }, [servingId])

  const startDrag = (e: ReactPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (e.button !== 0 || !props.dragEnabled) return
    const item = e.currentTarget.closest(".vA3-item")
    if (item === null) return
    props.collapseAll()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id, from: index, to: index, startY: e.clientY, dy: 0, h: (item.querySelector(".vA3-row") ?? item).getBoundingClientRect().height + 1 })
  }
  const moveDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (d === null) return
    const dy = e.clientY - d.startY
    const to = Math.max(0, Math.min(rows.length - 1, d.from + Math.round(dy / d.h)))
    setDrag({ ...d, dy, to })
  }
  const endDrag = () => {
    const d = dragRef.current
    if (d === null) return
    if (d.to !== d.from) {
      const ids = rows.map((a) => a.id).filter((id) => id !== d.id)
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
    <section
      className={`vA3-group ${ps.kind === "blocked" ? "is-blocked" : ""} ${drag !== null ? "is-dragging" : ""} ${settling ? "is-settling" : ""}`}
      aria-label={`${providerName[provider]} accounts`}
    >
      <header className={`vA3-ghead ${blink ? "is-blink" : ""}`}>
        <ProviderMark provider={provider} size={15} />
        <h2>{providerName[provider]}</h2>
        <span className="vA-count">{all.length}</span>
        <span className="vA3-ghead-sep" />
        <PoolLine ps={ps} now={now} provider={provider} />
        <span className="vA3-spacer" />
        <button type="button" className="vA-iconbtn vA3-ghead-add" onClick={props.onAdd} aria-label={`Add ${providerName[provider]} account`} title={`Add ${providerName[provider]} account`}>
          <IconPlus size={15} />
        </button>
      </header>

      {ps.kind === "blocked" && (
        <div className="vA3-gnote">
          <IconClock size={14} />
          <span>
            {ps.allCooling ? (
              <>
                Every {providerName[provider]} account hit its limit. New {providerName[provider]} sessions can't start until{" "}
                <b>{ps.nextReset !== null ? formatClock(ps.nextReset) : "a cooldown ends"}</b>.
              </>
            ) : (
              <>
                Every enabled account is cooling down or needs sign-in.{" "}
                {ps.nextReset !== null ? (
                  <>
                    The first cooldown ends at <b>{formatClock(ps.nextReset)}</b>.
                  </>
                ) : (
                  "Sign in again to recover."
                )}
              </>
            )}
          </span>
        </div>
      )}

      {rows.map((a, i) => (
        <Item
          key={a.id}
          account={a}
          index={i}
          count={all.length}
          serving={a.id === servingId}
          servingLabel={ps.kind === "serving" ? ps.account.label : null}
          s={s}
          now={now}
          expanded={props.expanded === a.id}
          focused={props.focused === a.id}
          editing={editing === a.id}
          onEdit={(on) => setEditing(on ? a.id : null)}
          dragEnabled={props.dragEnabled}
          offset={offsetFor(i, a.id)}
          lifted={drag?.id === a.id}
          onGripDown={(e) => startDrag(e, a.id, i)}
          onGripMove={moveDrag}
          onGripUp={endDrag}
          onToggle={() => props.onToggle(a.id)}
          onReauth={() => props.onReauth(a.id)}
          onRemove={() => props.onRemove(a.id)}
        />
      ))}

      {all.length === 0 && (
        <div className="vA3-gempty">
          <span>
            <b>No {providerName[provider]} accounts yet.</b> {clientsFor(provider)} can't use {providerName[provider]} until you add one.
          </span>
          <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
            <IconPlus size={13} /> Add {providerName[provider]} account
          </button>
        </div>
      )}
    </section>
  )
}

// -----------------------------------------------------------------------------------------------
// A row and its inline detail panel

function Item(props: {
  account: Account
  index: number
  count: number
  serving: boolean
  servingLabel: string | null
  s: DashboardState
  now: number
  expanded: boolean
  focused: boolean
  editing: boolean
  onEdit: (on: boolean) => void
  dragEnabled: boolean
  offset: number
  lifted: boolean
  onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onGripMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onGripUp: () => void
  onToggle: () => void
  onReauth: () => void
  onRemove: () => void
}) {
  const { account: a, now } = props
  const st = statusOf(a)
  const flash = a.changedAt > 0 && now - a.changedAt < 2600
  const usedFlash = a.lastUsedAt !== null && now - a.lastUsedAt < 1800

  return (
    <div
      className={`vA3-item ${props.expanded ? "is-open" : ""} ${props.lifted ? "is-lifted" : ""}`}
      style={props.offset !== 0 ? { transform: `translateY(${props.offset}px)` } : undefined}
    >
      <div
        data-row={a.id}
        className={[
          "vA-row",
          "vA3-row",
          `is-${st.kind}`,
          props.serving ? "is-serving" : "",
          flash ? "is-flash" : "",
          props.focused ? "is-focused" : "",
        ].join(" ")}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, a, [role=switch], .vA-menu-wrap") !== null) return
          props.onToggle()
        }}
        aria-expanded={props.expanded}
      >
        <button
          type="button"
          className="vA-grip"
          disabled={!props.dragEnabled}
          aria-label={`Reorder ${a.label}. Arrow keys move it.`}
          title={props.dragEnabled ? "Drag to change priority" : "Clear the search to reorder"}
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

        <span className={`vA-used ${usedFlash ? "is-fresh" : ""}`} title={a.lastUsedAt === null ? "Never used" : new Date(a.lastUsedAt).toLocaleString()}>
          {lastUsedText(a.lastUsedAt, now)}
        </span>

        <span>
          <Switch checked={a.enabled} onChange={(v) => actions.setEnabled(a.id, v)} label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`} />
        </span>

        <span className="vA3-row-end">
          <RowMenu
            label={`Actions for ${a.label}`}
            items={[
              { label: "Rename", icon: <IconPencil size={14} />, onSelect: () => props.onEdit(true) },
              { label: "Move up", icon: <IconChevronUp size={14} />, onSelect: () => actions.move(a.id, -1), disabled: a.priority === 1 },
              { label: "Move down", icon: <IconChevronDown size={14} />, onSelect: () => actions.move(a.id, 1), disabled: a.priority === props.count },
              ...(st.kind === "signin" ? [{ label: "Sign in again", icon: <IconLogIn size={14} />, onSelect: props.onReauth }] : []),
              { label: "Remove…", icon: <IconTrash size={14} />, onSelect: props.onRemove, danger: true, separatorBefore: true },
            ]}
          />
          <span className="vA3-caret" aria-hidden="true">
            <IconChevronDown size={14} />
          </span>
        </span>
      </div>

      <div className="vA3-detail" inert={!props.expanded}>
        <div className="vA3-detail-clip">
          <Detail {...props} />
        </div>
      </div>
    </div>
  )
}

function Detail(props: {
  account: Account
  count: number
  serving: boolean
  servingLabel: string | null
  s: DashboardState
  now: number
  onReauth: () => void
  onRemove: () => void
}) {
  const { account: a, now, s } = props
  const st = statusOf(a)
  const p = providerName[a.provider]
  const [label, setLabel] = useState(a.label)
  useEffect(() => setLabel(a.label), [a.label])
  const activity = s.events.filter((e) => e.accountId === a.id && e.kind !== "used").slice(0, 4)

  const routing =
    st.kind === "disabled"
      ? "Off. It keeps its place in the order; turn it back on to use it again."
      : st.kind === "signin"
        ? `Skipped until you sign in again.${props.servingLabel !== null ? ` New sessions go to ${props.servingLabel} meanwhile.` : ""}`
        : st.kind === "cooling"
          ? `Skipped until ${formatClock(st.until)} (${countdown(st.until, now)}).${props.servingLabel !== null ? ` New sessions go to ${props.servingLabel} meanwhile.` : ""}`
          : props.serving
            ? `Gets every new ${p} session.`
            : `Standing by. New sessions go to ${props.servingLabel ?? "a higher-priority account"} first.`

  return (
    <div className="vA3-detail-inner">
      <div className="vA3-dgrid">
        <section>
          <h4>Account</h4>
          <dl className="vA3-facts">
            <div>
              <dt>Label</dt>
              <dd>
                <input
                  className="vA-input vA3-dinput"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onBlur={() => actions.rename(a.id, label)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      actions.rename(a.id, label)
                      e.currentTarget.blur()
                    } else if (e.key === "Escape") {
                      setLabel(a.label)
                      e.currentTarget.blur()
                    }
                  }}
                  aria-label="Label"
                />
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{a.email}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>{a.plan}</dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>{lastUsedText(a.addedAt, now)}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h4>Routing</h4>
          <dl className="vA3-facts">
            <div>
              <dt>Priority</dt>
              <dd className="vA3-prio-ctl">
                <span title={`Priority ${a.priority} of ${props.count} in the ${p} pool`}>
                  <b>{a.priority}</b> of {props.count}
                </span>
                <span className="vA3-stepper">
                  <button type="button" onClick={() => actions.move(a.id, -1)} disabled={a.priority === 1} aria-label="Move up" title="Move up">
                    <IconChevronUp size={14} />
                  </button>
                  <button type="button" onClick={() => actions.move(a.id, 1)} disabled={a.priority === props.count} aria-label="Move down" title="Move down">
                    <IconChevronDown size={14} />
                  </button>
                </span>
              </dd>
            </div>
            <div>
              <dt>Use it</dt>
              <dd className="vA3-use">
                <Switch checked={a.enabled} onChange={(v) => actions.setEnabled(a.id, v)} label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`} />
                <span>{a.enabled ? "Enabled" : "Disabled"}</span>
              </dd>
            </div>
          </dl>
          <p className={`vA3-routing is-${st.kind} ${props.serving ? "is-serving" : ""}`}>{routing}</p>
          {st.kind === "signin" && (
            <button type="button" className="vA-btn vA-btn-sm vA-btn-red vA3-reauth" onClick={props.onReauth}>
              <IconLogIn size={13} /> Sign in again
            </button>
          )}
        </section>

        <section>
          <h4>Activity</h4>
          {activity.length === 0 ? (
            <p className="vA3-quiet">No changes since you opened the dashboard.</p>
          ) : (
            <ol className="vA3-activity">
              {activity.map((e) => (
                <li key={e.id} className={`is-${eventTone(e)}`}>
                  <span className="vA3-activity-dot" />
                  <span className="vA3-activity-msg">{e.message}</span>
                  <time>{lastUsedText(e.at, now)}</time>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="vA3-planned">
          <h4>
            Usage <span className="vA3-soon">Planned</span>
          </h4>
          <div className="vA3-spark" aria-hidden="true">
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} style={{ height: `${18 + ((i * 41 + a.priority * 13) % 72)}%` }} />
            ))}
          </div>
          <p className="vA3-quiet">Tokens and requests for this account, and how much of its plan's limit is left.</p>
        </section>
      </div>
      <footer className="vA3-dfoot">
        <span className="vA3-quiet">
          {statusLabel(st)}
          {st.kind === "cooling" ? ` until ${formatClock(st.until)}` : ""} · last used {lastUsedText(a.lastUsedAt, now)}
        </span>
        <span className="vA3-spacer" />
        <button type="button" className="vA-btn vA-btn-sm vA3-remove" onClick={props.onRemove}>
          <IconTrash size={13} /> Remove account…
        </button>
      </footer>
    </div>
  )
}

const eventTone = (e: LiveEvent) =>
  e.kind === "cooldown" ? "amber" : e.kind === "signin-expired" || e.kind === "removed" || e.kind === "disabled" ? "red" : e.kind === "renamed" || e.kind === "reordered" ? "muted" : "green"

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
