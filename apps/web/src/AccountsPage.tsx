import { Menu } from "@base-ui/react/menu"
import { Switch } from "@base-ui/react/switch"
import { useEffect, useRef, useState } from "react"

import { CommandLine, ProxyKeyRow } from "./ConnectClients.tsx"
import type { Account, AccountList, DaemonClient, Pool, Provider } from "./daemon-api.ts"
import { LimitCell, type WindowColumn, windowColumns } from "./limits.tsx"
import type { Flash } from "./LiveUpdates.ts"
import {
  accountsOf,
  clients,
  clientsOf,
  clockText,
  cooldownEnd,
  countdown,
  lastUsedText,
  levelsOf,
  type Placement,
  planWeight,
  type PoolState,
  poolState,
  providerNames,
  statusLabels,
  step,
} from "./model.ts"
import type { SignInRequest } from "./SignIn.tsx"
import {
  IconAlert,
  IconChevronDown,
  IconClock,
  IconChevronRight,
  IconChevronUp,
  IconGrip,
  IconMore,
  IconLink,
  IconPencil,
  IconRefresh,
  IconTrash,
  ProviderMark,
  Tip,
} from "./ui.tsx"
import { isRefreshing, useUsage } from "./usage.tsx"

const REORDER_HINT = "reorder-hint"

/** What the accounts page and the account sheet let the owner do. */
export interface AccountControls {
  /** True while the daemon is unreachable: nothing can be changed. */
  readonly readOnly: boolean
  /** The account whose sheet is open. */
  readonly openId: string | undefined
  readonly open: (account: Account) => void
  readonly setEnabled: (account: Account, enabled: boolean) => void
  readonly rename: (account: Account, label: string) => void
  /** Moves `account` within its pool, to a priority of its own or one it shares. */
  readonly move: (account: Account, placement: Placement) => void
  /** Asks the owner to confirm removing `account`. */
  readonly askRemove: (account: Account) => void
  /** Rows flashing because their account just changed, by account id. */
  readonly flashes: ReadonlyMap<string, Flash>
  /** Opens the sign-in dialog, to add an account or sign in again to one. */
  readonly signIn: (request: SignInRequest) => void
}

/** A row's own controls, where a click does not open the sheet. */
const ROW_CONTROLS = "button, input, a, [role=switch], [role=menu]"

/** Stops a click before it reaches the page, such as the one that ends a drag. */
const swallowClick = (event: MouseEvent) => event.stopPropagation()

/**
 * Where a dragged row would land, by the pool's priorities as shown: onto
 * the accounts of priority `level + 1`, sharing it, or into the gap before
 * priority `gap + 1` (after the last when `gap` is the number of priorities),
 * holding a priority alone.
 */
type Drop =
  | { readonly kind: "share"; readonly level: number }
  | { readonly kind: "gap"; readonly gap: number }

/** A row being dragged: account `id`, and where it would land now, if anywhere yet. */
interface Drag {
  readonly id: string
  readonly drop: Drop | undefined
}

/** A drop as a string, to tell whether the pointer moved to another one. */
const dropKey = (drop: Drop | undefined) =>
  drop === undefined ? "" : drop.kind === "share" ? `share:${drop.level}` : `gap:${drop.gap}`

/** The share of a row's height, at its top and bottom, that drops between priorities rather than onto one. */
const GAP_EDGE = 0.3

/** What dropping account `id` at `drop` asks the daemon for; undefined when it would change nothing. */
const placementOf = (
  levels: ReadonlyArray<ReadonlyArray<Account>>,
  id: string,
  drop: Drop,
): Placement | undefined => {
  const from = levels.findIndex((level) => level.some((account) => account.id === id))
  const alone = levels[from]?.length === 1
  if (drop.kind === "share") {
    if (drop.level === from) return undefined
    const partner = levels[drop.level]?.find((account) => account.id !== id)
    return partner === undefined ? undefined : { sharePriorityWith: partner.id }
  }
  // Either side of the priority it holds alone is where it already is.
  if (alone && (drop.gap === from || drop.gap === from + 1)) return undefined
  const above = drop.gap - (alone && from < drop.gap ? 1 : 0)
  return { priority: above + 1 }
}

/** What a drop would do, in words, for the pool's header while a row is dragged. */
const dropText = (levels: ReadonlyArray<ReadonlyArray<Account>>, drag: Drag): string => {
  const placement = drag.drop === undefined ? undefined : placementOf(levels, drag.id, drag.drop)
  if (placement === undefined) {
    return "Drop on an account to share its priority, or between priorities to move"
  }
  if ("priority" in placement) return `Drop to move to priority ${placement.priority}`
  const level = levels.findIndex((accounts) =>
    accounts.some((account) => account.id === placement.sharePriorityWith),
  )
  const partners = (levels[level] ?? []).filter((account) => account.id !== drag.id)
  return `Drop to share priority ${level + 1} with ${partners.map((account) => account.label).join(", ")}`
}

/** The accounts page body: one table per pool, or the first-run guide. */
export function AccountsPage(props: {
  list: AccountList
  now: number
  address: string
  client: DaemonClient
  controls: AccountControls
}) {
  const { list } = props
  const { limits } = useUsage()
  if (list.accounts.length === 0) {
    return <FirstRun address={props.address} client={props.client} controls={props.controls} />
  }
  // Each pool's limit-window columns, and room for the most any pool has, so
  // the pools' tables line up.
  const columns = new Map(
    list.pools.map((pool) => [
      pool.provider,
      windowColumns(accountsOf(list, pool.provider).map((account) => limits?.get(account.id))),
    ]),
  )
  const widest = Math.max(0, ...[...columns.values()].map((pool) => pool.length))
  return (
    <div className="sections">
      <p className="sr-only" id={REORDER_HINT}>
        Drag, or press the up and down arrow keys, to change its priority. Each arrow key press
        either shares the next priority over or moves past it.
      </p>
      {list.pools.map((pool) => (
        <PoolSection
          key={pool.provider}
          list={list}
          pool={pool}
          columns={columns.get(pool.provider) ?? []}
          widest={widest}
          now={props.now}
          controls={props.controls}
        />
      ))}
    </div>
  )
}

function PoolLine(props: {
  state: PoolState
  provider: Provider
  /** The Active accounts after the one new sessions go to, in the order they would. */
  then: ReadonlyArray<Account>
  now: number
}) {
  const { state } = props
  switch (state.kind) {
    case "serving":
      return (
        <p className="pool-line is-ok">
          <span className="pool-dot" aria-hidden="true" />
          New sessions go to <b>{state.account.label}</b>
          {props.then.length > 0 && " "}
          {props.then.length > 0 && (
            <span className="pool-line-sub">
              {`· then ${props.then.map((account) => account.label).join(", ")}`}
            </span>
          )}
        </p>
      )
    case "blocked":
      return (
        <p className="pool-line is-warn">
          <IconAlert size={13} />
          No account can take new sessions
          {state.nextReset !== null && (
            <span className="pool-line-sub">
              {`· next reset ${clockText(state.nextReset, props.now)} (${countdown(state.nextReset, props.now)})`}
            </span>
          )}
        </p>
      )
    case "off":
      return (
        <p className="pool-line is-muted">
          Every {providerNames[props.provider]} account is disabled
        </p>
      )
  }
}

/** Why a blocked pool takes no new sessions, and what ends that. */
function BlockedCallout(props: {
  state: Extract<PoolState, { kind: "blocked" }>
  provider: Provider
  now: number
}) {
  const name = providerNames[props.provider]
  const { nextReset } = props.state
  const text =
    nextReset === null
      ? `Every enabled ${name} account needs sign-in, so ${clientsOf(props.provider)} get an error until you sign one in again.`
      : props.state.allCooling
        ? `Every account in the ${name} pool hit its plan's limit. ${clientsOf(props.provider)} get ${name} sessions again when the first cooldown ends, at ${clockText(nextReset, props.now)}.`
        : `Every enabled ${name} account is cooling down or needs sign-in. Sign one in again, or wait for the first cooldown to end at ${clockText(nextReset, props.now)}.`
  return (
    <div className="callout is-warn" role="note">
      {nextReset === null ? <IconAlert size={15} /> : <IconClock size={15} />}
      <span>{text}</span>
    </div>
  )
}

function PoolSection(props: {
  list: AccountList
  pool: Pool
  columns: ReadonlyArray<WindowColumn>
  /** The most limit-window columns any pool has. */
  widest: number
  now: number
  controls: AccountControls
}) {
  const { provider } = props.pool
  const name = providerNames[provider]
  const accounts = accountsOf(props.list, provider)
  const levels = levelsOf(accounts)
  const [drag, setDrag] = useState<Drag | undefined>()
  const { move } = props.controls

  // While a row is dragged, the pointer may be released anywhere, and Escape
  // puts the row back.
  useEffect(() => {
    if (drag === undefined) return
    const drop = () => {
      setDrag(undefined)
      // The browser follows the release with a click on the row now under
      // the pointer, which is no request to open that row's sheet.
      document.addEventListener("click", swallowClick, { capture: true, once: true })
      setTimeout(() => document.removeEventListener("click", swallowClick, { capture: true }), 0)
      const dragged = accounts.find((account) => account.id === drag.id)
      const placement =
        drag.drop === undefined ? undefined : placementOf(levels, drag.id, drag.drop)
      if (dragged !== undefined && placement !== undefined) move(dragged, placement)
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrag(undefined)
    }
    // A drag the browser cancels (a touch taken over by scrolling, say) saves nothing.
    const abandon = () => setDrag(undefined)
    document.addEventListener("pointerup", drop)
    document.addEventListener("pointercancel", abandon)
    document.addEventListener("keydown", cancel)
    return () => {
      document.removeEventListener("pointerup", drop)
      document.removeEventListener("pointercancel", abandon)
      document.removeEventListener("keydown", cancel)
    }
  }, [drag, accounts, levels, move])

  const state = poolState(props.list, props.pool)
  const servingId = state.kind === "serving" ? state.account.id : undefined
  const then = props.pool.newSessionsOrder.slice(1).flatMap((id) => {
    const account = accounts.find((candidate) => candidate.id === id)
    return account === undefined ? [] : [account]
  })
  // Where the drag would land, marked only when landing there changes something.
  const target =
    drag?.drop !== undefined && placementOf(levels, drag.id, drag.drop) !== undefined
      ? drag.drop
      : undefined
  const headingId = `pool-${provider}`
  return (
    <section className="section" aria-labelledby={headingId}>
      <header className="section-head">
        <div className="section-title">
          <ProviderMark provider={provider} size={16} />
          <h2 id={headingId}>{name}</h2>
          <span className="count">
            {accounts.length}
            <span className="sr-only"> {accounts.length === 1 ? "account" : "accounts"}</span>
          </span>
        </div>
        {drag === undefined ? (
          <PoolLine state={state} provider={provider} then={then} now={props.now} />
        ) : (
          <p className="pool-line is-drag" aria-hidden="true">
            {dropText(levels, drag)}
          </p>
        )}
      </header>

      {state.kind === "blocked" && (
        <BlockedCallout state={state} provider={provider} now={props.now} />
      )}

      <div className="table-wrap">
        <table
          className={`accounts ${drag === undefined ? "" : "is-dragging"}`}
          aria-label={`${name} accounts`}
        >
          <thead>
            <tr>
              <th scope="col" aria-label="Priority" className="col-prio">
                #
              </th>
              <th scope="col" className="col-who">
                Account
              </th>
              <th scope="col" className="col-status">
                Status
              </th>
              {props.columns.map((column) => (
                <th key={column.id} scope="col" className="col-lim">
                  {column.label}
                </th>
              ))}
              {Array.from({ length: props.widest - props.columns.length }, (_, i) => (
                <th key={`pad-${i}`} aria-hidden="true" className="col-lim-pad" />
              ))}
              <th scope="col" className="col-enabled">
                Enabled
              </th>
              <th scope="col" aria-label="Actions" className="col-menu" />
            </tr>
          </thead>
          <tbody>
            {levels.flatMap((level, at) =>
              level.map((account, index) => {
                const first = index === 0
                const last = index === level.length - 1
                const dropClass =
                  target === undefined
                    ? undefined
                    : target.kind === "share"
                      ? target.level === at
                        ? `is-drop-share${first ? " is-drop-first" : ""}${last ? " is-drop-last" : ""}`
                        : undefined
                      : target.gap === at && first
                        ? "is-drop-above"
                        : target.gap === at + 1 && last && at === levels.length - 1
                          ? "is-drop-below"
                          : undefined
                return (
                  <AccountRow
                    key={account.id}
                    account={account}
                    pool={accounts}
                    level={{ first, last, shared: level.length > 1 }}
                    dropClass={dropClass}
                    lifted={drag?.id === account.id}
                    onDragStart={() => setDrag({ id: account.id, drop: undefined })}
                    onDragOver={
                      drag === undefined
                        ? undefined
                        : (offset) => {
                            const drop: Drop =
                              offset < GAP_EDGE && first
                                ? { kind: "gap", gap: at }
                                : offset > 1 - GAP_EDGE && last
                                  ? { kind: "gap", gap: at + 1 }
                                  : { kind: "share", level: at }
                            if (dropKey(drop) !== dropKey(drag.drop)) setDrag({ ...drag, drop })
                          }
                    }
                    serving={account.id === servingId}
                    columns={props.columns}
                    pad={props.widest - props.columns.length}
                    now={props.now}
                    controls={props.controls}
                  />
                )
              }),
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** When a cooling-down account is back: "until 3:47 PM · in 47m". */
function CooldownEnd(props: { account: Account; now: number }) {
  const end = cooldownEnd(props.account)
  if (end === null) return null
  return (
    <span className="status-sub">
      {`until ${clockText(end, props.now)} · ${countdown(end, props.now)}`}
    </span>
  )
}

function AccountRow(props: {
  account: Account
  /** Its pool, highest priority first. */
  pool: ReadonlyArray<Account>
  /** Where the row sits among the accounts of its priority. */
  level: { readonly first: boolean; readonly last: boolean; readonly shared: boolean }
  /** How the row shows where a drag would land, if it lands by this row. */
  dropClass: string | undefined
  lifted: boolean
  onDragStart: () => void
  /** While a row is dragged: the pointer is over this row, `offset` down it, 0 to 1. */
  onDragOver: ((offset: number) => void) | undefined
  serving: boolean
  columns: ReadonlyArray<WindowColumn>
  /** Spacer cells after the windows, so the pools' tables line up. */
  pad: number
  now: number
  controls: AccountControls
}) {
  const { account, controls } = props
  const { readOnly } = controls
  const usage = useUsage()
  const windows = usage.limits?.get(account.id)?.windows
  const refreshing = isRefreshing(usage, account.id)
  const [renaming, setRenaming] = useState(false)
  // A rename ended from the keyboard hands focus back to the label's button.
  const nameButton = useRef<HTMLButtonElement>(null)
  const refocusName = useRef(false)
  useEffect(() => {
    if (renaming || !refocusName.current) return
    refocusName.current = false
    nameButton.current?.focus()
  }, [renaming])
  const open = controls.openId === account.id
  const flash = controls.flashes.get(account.id)
  return (
    // A click anywhere on the row that is not one of its controls opens the
    // account's sheet, as the label's button does from the keyboard.
    <tr
      className={[
        "row",
        `is-${account.status}`,
        props.serving ? "is-serving" : "",
        props.lifted ? "is-lifted" : "",
        open ? "is-open" : "",
        props.level.shared ? "is-shared" : "",
        props.level.first ? "is-level-first" : "",
        props.level.last ? "is-level-last" : "",
        props.dropClass ?? "",
      ]
        .filter((name) => name !== "")
        .join(" ")}
      data-account-row=""
      data-priority={account.priority}
      data-flash={flash?.status}
      data-flash-turn={flash?.turn}
      onPointerMove={(event) => {
        if (props.onDragOver === undefined) return
        const box = event.currentTarget.getBoundingClientRect()
        props.onDragOver(box.height === 0 ? 0.5 : (event.clientY - box.top) / box.height)
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest(ROW_CONTROLS) !== null) return
        controls.open(account)
      }}
    >
      <td className="col-prio">
        <button
          type="button"
          className="grip"
          aria-label={`Reorder ${account.label}`}
          aria-describedby={REORDER_HINT}
          disabled={readOnly}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            // A touch is captured by the element it starts on; release it, so
            // the rows it passes over hear it.
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            props.onDragStart()
          }}
          onKeyDown={(event) => {
            const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0
            if (direction === 0) return
            event.preventDefault()
            const placement = step(props.pool, account.id, direction)
            if (placement !== undefined) controls.move(account, placement)
          }}
        >
          <span className="grip-dots" aria-hidden="true">
            <IconGrip size={14} />
          </span>
          <span className="prio">{account.priority}</span>
        </button>
      </td>
      <td className="col-who">
        {renaming ? (
          <LabelInput
            account={account}
            className="who-rename"
            onDone={(label, keyboard) => {
              setRenaming(false)
              refocusName.current = keyboard
              if (label !== undefined) controls.rename(account, label)
            }}
          />
        ) : (
          <button
            ref={nameButton}
            type="button"
            className="who-name"
            data-opens-sheet={account.id}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={readOnly ? undefined : "Double-click to rename"}
            onClick={() => controls.open(account)}
            onDoubleClick={() => !readOnly && setRenaming(true)}
          >
            {account.label}
          </button>
        )}
        <span className="plan plan-inline" data-weight={planWeight(account.provider, account.plan)}>
          {account.plan}
        </span>
        {props.serving && (
          <>
            {" "}
            <span className="serving">New sessions</span>
          </>
        )}
        <span className="who-email">{account.email}</span>
      </td>
      <td className="col-status">
        <span className="status">
          <span className="sdot" aria-hidden="true" />
          {statusLabels[account.status]}
        </span>
        <CooldownEnd account={account} now={props.now} />
        {(account.status === "active" || account.status === "disabled") && (
          <span className="status-sub">
            {account.lastUsedAt === null
              ? "Never used"
              : `Used ${lastUsedText(account.lastUsedAt, props.now)}`}
          </span>
        )}
        {account.status === "needs-sign-in" && (
          <button
            type="button"
            className="status-action"
            aria-label={`Sign in again to ${account.label}`}
            disabled={readOnly}
            onClick={() => controls.signIn({ kind: "again", account })}
          >
            Sign in again
          </button>
        )}
      </td>
      {props.columns.map((column) => (
        <td key={column.id} className={`col-lim ${refreshing ? "is-refreshing" : ""}`}>
          <LimitCell window={windows?.find((window) => window.id === column.id)} now={props.now} />
        </td>
      ))}
      {Array.from({ length: props.pad }, (_, i) => (
        <td key={`pad-${i}`} aria-hidden="true" className="col-lim-pad" />
      ))}
      <td className="col-enabled">
        <Switch.Root
          className="switch"
          checked={account.enabled}
          onCheckedChange={(enabled) => controls.setEnabled(account, enabled)}
          disabled={readOnly}
          aria-label={`${account.label} enabled`}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </td>
      <td className="col-menu">
        <RowMenu
          account={account}
          pool={props.pool}
          controls={controls}
          onRename={() => setRenaming(true)}
        />
      </td>
    </tr>
  )
}

/**
 * An account's label being edited. Enter or leaving the field keeps the new
 * label; Escape, an unchanged label or a blank one keeps the old. `onDone`
 * gets the new label, trimmed, or nothing when the old one stays.
 */
export function LabelInput(props: {
  account: Account
  className: string
  /** `keyboard` is true when Enter or Escape ended the edit, so focus can go back to where it was. */
  onDone: (label: string | undefined, keyboard: boolean) => void
}) {
  // Undefined until the owner types: an untouched field follows the account's
  // label as it changes, and leaving it writes nothing.
  const [draft, setDraft] = useState<string | undefined>()
  const value = draft ?? props.account.label
  const [done, setDone] = useState(false)
  const finish = (keep: boolean, keyboard: boolean) => {
    if (done) return
    setDone(true)
    const label = draft?.trim()
    props.onDone(
      keep && label !== undefined && label !== "" && label !== props.account.label
        ? label
        : undefined,
      keyboard,
    )
  }
  return (
    <input
      className={`input ${props.className}`}
      value={value}
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- it appears because the owner asked to rename
      autoFocus
      maxLength={80}
      spellCheck={false}
      aria-label={`Label for ${props.account.label}`}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true, false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          finish(true, true)
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          finish(false, true)
        }
      }}
    />
  )
}

/** The row's ⋯ menu. */
function RowMenu(props: {
  account: Account
  /** Its pool, highest priority first. */
  pool: ReadonlyArray<Account>
  controls: AccountControls
  onRename: () => void
}) {
  const { account, controls } = props
  const up = step(props.pool, account.id, -1)
  const down = step(props.pool, account.id, 1)
  // Each account it could share a priority with, one per priority but its own.
  const partners = levelsOf(props.pool)
    .filter((level) => level.every((other) => other.priority !== account.priority))
    .flatMap((level) => level.slice(0, 1).map((first) => ({ level, first })))
  const usage = useUsage()
  // Rename waits for the menu to close, so the menu hands focus to the label's
  // field rather than taking it back.
  const [renaming, setRenaming] = useState(false)
  const items = [
    {
      label: "Open details",
      icon: <IconChevronRight size={14} />,
      onClick: () => controls.open(account),
    },
    {
      label: "Rename",
      icon: <IconPencil size={14} />,
      onClick: () => setRenaming(true),
    },
    {
      label: "Refresh limits",
      icon: <IconRefresh size={14} />,
      disabled: isRefreshing(usage, account.id),
      onClick: () => usage.refresh(account.id),
    },
    {
      label: "Move up",
      icon: <IconChevronUp size={14} />,
      separatorBefore: true,
      disabled: up === undefined,
      onClick: () => up !== undefined && controls.move(account, up),
    },
    {
      label: "Move down",
      icon: <IconChevronDown size={14} />,
      disabled: down === undefined,
      onClick: () => down !== undefined && controls.move(account, down),
    },
  ]
  const remove = {
    label: "Remove…",
    icon: <IconTrash size={14} />,
    onClick: () => controls.askRemove(account),
  }
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) setRenaming(false)
      }}
      onOpenChangeComplete={(open) => {
        if (!open && renaming) props.onRename()
      }}
    >
      <Tip label="Actions">
        <Menu.Trigger
          className="iconbtn"
          aria-label={`Actions for ${account.label}`}
          disabled={controls.readOnly}
        >
          <IconMore size={16} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        <Menu.Positioner className="layer" sideOffset={4} align="end">
          <Menu.Popup className="menu" finalFocus={!renaming}>
            {items.map((item) => (
              <div key={item.label} className="menu-group">
                {item.separatorBefore === true && <Menu.Separator className="menu-sep" />}
                <Menu.Item
                  className="menu-item"
                  disabled={item.disabled === true}
                  onClick={item.onClick}
                >
                  <span className="menu-icon">{item.icon}</span>
                  {item.label}
                </Menu.Item>
              </div>
            ))}
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className="menu-item" disabled={partners.length === 0}>
                <span className="menu-icon">
                  <IconLink size={14} />
                </span>
                Share priority with
                <span className="menu-chevron" aria-hidden="true">
                  <IconChevronRight size={13} />
                </span>
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner className="layer" sideOffset={2} alignOffset={-4}>
                  <Menu.Popup className="menu">
                    {partners.map(({ level, first }) => (
                      <Menu.Item
                        key={first.id}
                        className="menu-item"
                        onClick={() => controls.move(account, { sharePriorityWith: first.id })}
                      >
                        <span className="menu-prio" aria-hidden="true">
                          {first.priority}
                        </span>
                        {level.map((other) => other.label).join(", ")}
                        <span className="sr-only">{` (priority ${first.priority})`}</span>
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            <Menu.Separator className="menu-sep" />
            <Menu.Item className="menu-item is-danger" onClick={remove.onClick}>
              <span className="menu-icon">{remove.icon}</span>
              {remove.label}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** The guided empty state, shown while the daemon holds no accounts. */
function FirstRun(props: { address: string; client: DaemonClient; controls: AccountControls }) {
  const { address, client, controls } = props
  return (
    <ol className="steps" aria-label="Get started">
      <li className="is-current">
        <span className="step-num" aria-hidden="true">
          1
        </span>
        <div className="step-body">
          <h2>Add an account</h2>
          <p>
            The daemon at <code>{address}</code> has no accounts yet. Sign in to a Claude or Codex
            account in your browser, and it joins that provider's pool.
          </p>
          <div className="step-actions">
            {(["claude", "codex"] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                className="btn"
                disabled={controls.readOnly}
                onClick={() => controls.signIn({ kind: "add", provider })}
              >
                <ProviderMark provider={provider} size={14} />
                Add a {providerNames[provider]} account
              </button>
            ))}
          </div>
        </div>
      </li>
      <li>
        <span className="step-num" aria-hidden="true">
          2
        </span>
        <div className="step-body">
          <h2>Connect your clients</h2>
          <p>
            Run one command per client. It points the client at this proxy and has it fetch the
            proxy key.
          </p>
          <div className="step-cmds">
            {clients.map((connectable) => (
              <div key={connectable.command} className="step-cmd">
                <span className="step-cmd-name">{connectable.name}</span>
                <CommandLine command={connectable.command} />
              </div>
            ))}
          </div>
          <div className="step-key">
            <ProxyKeyRow client={client} />
          </div>
        </div>
      </li>
      <li>
        <span className="step-num" aria-hidden="true">
          3
        </span>
        <div className="step-body">
          <h2>Add a fallback</h2>
          <p>
            Add a second account to a pool. When the first hits its limit, new sessions move to the
            next one by priority.
          </p>
        </div>
      </li>
    </ol>
  )
}
