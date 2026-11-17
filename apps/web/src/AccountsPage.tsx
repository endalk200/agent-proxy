import { Menu } from "@base-ui/react/menu"
import { Switch } from "@base-ui/react/switch"
import { useEffect, useState } from "react"

import { CommandLine, ProxyKeyRow } from "./ConnectClients.tsx"
import type { Account, AccountList, DaemonClient, Pool, Provider } from "./daemon-api.ts"
import {
  accountsOf,
  clients,
  clientsOf,
  lastUsedText,
  planWeight,
  type PoolState,
  poolState,
  providerNames,
  statusLabels,
} from "./model.ts"
import type { SignInRequest } from "./SignIn.tsx"
import {
  IconAlert,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconGrip,
  IconMore,
  IconPencil,
  IconTrash,
  ProviderMark,
  Tip,
} from "./ui.tsx"

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
  /** Moves `account` to `priority` in its pool, 1 first. */
  readonly move: (account: Account, priority: number) => void
  /** Asks the owner to confirm removing `account`. */
  readonly askRemove: (account: Account) => void
  /** Opens the sign-in dialog, to add an account or sign in again to one. */
  readonly signIn: (request: SignInRequest) => void
}

/** A row's own controls, where a click does not open the sheet. */
const ROW_CONTROLS = "button, input, a, [role=switch], [role=menu]"

/** A row being dragged: account `id`, shown at index `to` of its pool. */
interface Drag {
  readonly id: string
  readonly to: number
}

/** `pool` with the dragged account moved to where the drag shows it. */
const dragOrder = (pool: ReadonlyArray<Account>, drag: Drag): ReadonlyArray<Account> => {
  const dragged = pool.find((account) => account.id === drag.id)
  if (dragged === undefined) return pool
  const others = pool.filter((account) => account !== dragged)
  return [...others.slice(0, drag.to), dragged, ...others.slice(drag.to)]
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
  if (list.accounts.length === 0) {
    return <FirstRun address={props.address} client={props.client} controls={props.controls} />
  }
  return (
    <div className="sections">
      <p className="sr-only" id={REORDER_HINT}>
        Drag, or press the up and down arrow keys, to change its priority.
      </p>
      {list.pools.map((pool) => (
        <PoolSection
          key={pool.provider}
          list={list}
          pool={pool}
          now={props.now}
          controls={props.controls}
        />
      ))}
    </div>
  )
}

function PoolLine({ state, provider }: { state: PoolState; provider: Provider }) {
  switch (state.kind) {
    case "serving":
      return (
        <p className="pool-line is-ok">
          <span className="pool-dot" aria-hidden="true" />
          New sessions go to <b>{state.account.label}</b>
        </p>
      )
    case "blocked":
      return (
        <p className="pool-line is-warn">
          <IconAlert size={13} />
          No account can take new sessions
        </p>
      )
    case "off":
      return (
        <p className="pool-line is-muted">Every {providerNames[provider]} account is disabled</p>
      )
  }
}

function PoolSection(props: {
  list: AccountList
  pool: Pool
  now: number
  controls: AccountControls
}) {
  const { provider } = props.pool
  const name = providerNames[provider]
  const pool = accountsOf(props.list, provider)
  const [drag, setDrag] = useState<Drag | undefined>()
  const accounts = drag === undefined ? pool : dragOrder(pool, drag)
  const { move } = props.controls

  // While a row is dragged, the pointer may be released anywhere, and Escape
  // puts the row back.
  useEffect(() => {
    if (drag === undefined) return
    const drop = () => {
      setDrag(undefined)
      const from = pool.findIndex((account) => account.id === drag.id)
      const dragged = pool[from]
      if (dragged !== undefined && from !== drag.to) move(dragged, drag.to + 1)
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrag(undefined)
    }
    document.addEventListener("pointerup", drop)
    document.addEventListener("pointercancel", drop)
    document.addEventListener("keydown", cancel)
    return () => {
      document.removeEventListener("pointerup", drop)
      document.removeEventListener("pointercancel", drop)
      document.removeEventListener("keydown", cancel)
    }
  }, [drag, pool, move])

  const state = poolState(props.list, props.pool)
  const servingId = state.kind === "serving" ? state.account.id : undefined
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
        <PoolLine state={state} provider={provider} />
      </header>

      {state.kind === "blocked" && (
        <div className="callout is-warn">
          <IconAlert size={15} />
          <span>
            Every enabled {name} account needs sign-in, so {clientsOf(provider)} get an error until
            you sign one in again.
          </span>
        </div>
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
              <th scope="col">Account</th>
              <th scope="col" className="col-plan">
                Plan
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="col-used">
                Last used
              </th>
              <th scope="col" className="col-enabled">
                Enabled
              </th>
              <th scope="col" aria-label="Actions" className="col-menu" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account, index) => (
              <AccountRow
                key={account.id}
                account={account}
                place={index + 1}
                lifted={drag?.id === account.id}
                onDragStart={() => setDrag({ id: account.id, to: index })}
                onDragOver={() =>
                  drag !== undefined && drag.to !== index && setDrag({ ...drag, to: index })
                }
                serving={account.id === servingId}
                count={accounts.length}
                now={props.now}
                controls={props.controls}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AccountRow(props: {
  account: Account
  /** Where the row shows in its pool: its priority, or where a drag would put it. */
  place: number
  lifted: boolean
  onDragStart: () => void
  onDragOver: () => void
  serving: boolean
  count: number
  now: number
  controls: AccountControls
}) {
  const { account, controls } = props
  const { readOnly } = controls
  const [renaming, setRenaming] = useState(false)
  const open = controls.openId === account.id
  return (
    // A click anywhere on the row that is not one of its controls opens the
    // account's sheet, as the label's button does from the keyboard.
    <tr
      className={`row is-${account.status} ${props.serving ? "is-serving" : ""} ${props.lifted ? "is-lifted" : ""} ${open ? "is-open" : ""}`}
      data-account-row=""
      onPointerOver={props.onDragOver}
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
            const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0
            if (step === 0) return
            event.preventDefault()
            const priority = account.priority + step
            if (priority >= 1 && priority <= props.count) controls.move(account, priority)
          }}
        >
          <span className="grip-dots" aria-hidden="true">
            <IconGrip size={14} />
          </span>
          <span className="prio">{props.place}</span>
        </button>
      </td>
      <td className="col-who">
        {renaming ? (
          <LabelInput
            account={account}
            className="who-rename"
            onDone={(label) => {
              setRenaming(false)
              if (label !== undefined) controls.rename(account, label)
            }}
          />
        ) : (
          <button
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
        {props.serving && (
          <>
            {" "}
            <span className="serving">New sessions</span>
          </>
        )}
        <span className="who-email">{account.email}</span>
      </td>
      <td className="col-plan">
        <span className="plan" data-weight={planWeight(account.provider, account.plan)}>
          {account.plan}
        </span>
      </td>
      <td>
        <span className="status">
          <span className="sdot" aria-hidden="true" />
          {statusLabels[account.status]}
        </span>
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
      <td className="col-used">
        <span className="used">{lastUsedText(account.lastUsedAt, props.now)}</span>
      </td>
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
          count={props.count}
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
  onDone: (label: string | undefined) => void
}) {
  const [value, setValue] = useState(props.account.label)
  const [done, setDone] = useState(false)
  const finish = (keep: boolean) => {
    if (done) return
    setDone(true)
    const label = value.trim()
    props.onDone(keep && label !== "" && label !== props.account.label ? label : undefined)
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
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          finish(true)
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          finish(false)
        }
      }}
    />
  )
}

/** The row's ⋯ menu. */
function RowMenu(props: {
  account: Account
  count: number
  controls: AccountControls
  onRename: () => void
}) {
  const { account, controls } = props
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
      label: "Move up",
      icon: <IconChevronUp size={14} />,
      separatorBefore: true,
      disabled: account.priority === 1,
      onClick: () => controls.move(account, account.priority - 1),
    },
    {
      label: "Move down",
      icon: <IconChevronDown size={14} />,
      disabled: account.priority === props.count,
      onClick: () => controls.move(account, account.priority + 1),
    },
    {
      label: "Remove…",
      icon: <IconTrash size={14} />,
      separatorBefore: true,
      danger: true,
      onClick: () => controls.askRemove(account),
    },
  ]
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
                  className={`menu-item ${item.danger === true ? "is-danger" : ""}`}
                  disabled={item.disabled === true}
                  onClick={item.onClick}
                >
                  <span className="menu-icon">{item.icon}</span>
                  {item.label}
                </Menu.Item>
              </div>
            ))}
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
