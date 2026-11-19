import { Dialog } from "@base-ui/react/dialog"
import { Switch } from "@base-ui/react/switch"
import { Tabs } from "@base-ui/react/tabs"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import { type AccountControls, LabelInput } from "./AccountsPage.tsx"
import { AccountLimitsPanel, AccountWeek } from "./AccountUsage.tsx"
import type { Account, AccountList } from "./daemon-api.ts"
import {
  accountsOf,
  clockText,
  cooldownEnd,
  countdown,
  lastUsedText,
  ordinal,
  planWeight,
  poolState,
  providerNames,
  statusLabels,
} from "./model.ts"
import {
  IconActivity,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconPencil,
  IconTrash,
  IconX,
  ProviderMark,
  Tip,
} from "./ui.tsx"

/**
 * Where a press outside the sheet leaves it open: on an account row, which
 * swaps the sheet to that account instead, and in the menus, tooltips and
 * notices that float above the page.
 */
const KEEPS_SHEET_OPEN = "[data-account-row], .layer, .notices"

/** The element that opened `id`'s sheet, to hand focus back to on close. */
const openerOf = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-opens-sheet="${CSS.escape(id)}"]`)

const added = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

/**
 * The account sheet: one account's status, priority, settings, details and
 * pool, sliding in from the right. It is not modal: the page stays usable,
 * clicking another row swaps the sheet, and clicking elsewhere or Escape
 * closes it, handing focus back to the row that opened it.
 */
export function AccountSheet(props: {
  list: AccountList | undefined
  now: number
  controls: AccountControls
  /** True while a dialog over the page has the owner's attention. */
  covered: boolean
  onClose: () => void
}) {
  const { controls } = props
  const open = props.list?.accounts.find((account) => account.id === controls.openId) ?? undefined
  // The sheet keeps showing its account while it slides out.
  const [shown, setShown] = useState(open)
  if (open !== undefined && open !== shown) setShown(open)
  const account = open ?? shown
  // A press elsewhere lands where it was aimed, so focus goes back to the row
  // only when the sheet closes some other way.
  const [returnFocus, setReturnFocus] = useState(true)
  // Opening focuses the sheet itself, so a screen reader names it before its
  // controls, and no control's tooltip pops up uninvited.
  const popup = useRef<HTMLDivElement>(null)
  const isOpen = open !== undefined
  // A frame after it opens, unless a rename the owner just started in the
  // table has the focus: a double-click's first click opens the sheet, and
  // its second can land before that frame. Deciding when the frame comes,
  // not when the sheet opens, keeps the field focused either way.
  useEffect(() => {
    if (!isOpen) return
    const frame = requestAnimationFrame(() => {
      if (document.activeElement?.classList.contains("who-rename") === true) return
      popup.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  return (
    <Dialog.Root
      open={open !== undefined}
      modal={false}
      onOpenChange={(next, details) => {
        if (next) return
        const target = details.event.target
        const keep =
          props.covered ||
          details.reason === "focus-out" ||
          (details.reason === "outside-press" &&
            target instanceof Element &&
            target.closest(KEEPS_SHEET_OPEN) !== null) ||
          (details.reason === "escape-key" && target instanceof HTMLInputElement)
        if (keep) {
          details.cancel()
          return
        }
        setReturnFocus(details.reason !== "outside-press")
        props.onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          ref={popup}
          className="sheet"
          // The sheet focuses itself (see the effect above), not Base UI,
          // which would decide what to focus before a double-click finishes.
          initialFocus={false}
          finalFocus={
            returnFocus && account !== undefined
              ? () => openerOf(account.id) ?? document.getElementById("page-title")
              : false
          }
        >
          {account !== undefined && props.list !== undefined && (
            <SheetBody
              key={account.id}
              account={account}
              list={props.list}
              now={props.now}
              controls={controls}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SheetBody(props: {
  account: Account
  list: AccountList
  now: number
  controls: AccountControls
}) {
  const { account, list, controls } = props
  const { readOnly } = controls
  const provider = providerNames[account.provider]
  const pool = accountsOf(list, account.provider)
  const [renaming, setRenaming] = useState(false)
  // A rename ended from the keyboard hands focus back to the Rename button.
  const renameButton = useRef<HTMLButtonElement>(null)
  const refocusRename = useRef(false)
  useEffect(() => {
    if (renaming || !refocusRename.current) return
    refocusRename.current = false
    renameButton.current?.focus()
  }, [renaming])
  const enabledId = useId()

  return (
    <>
      <div className="sheet-top">
        <span className="sheet-crumb">
          <ProviderMark provider={account.provider} size={14} />
          <span>{provider} pool</span>
          <span className="sheet-crumb-sep" aria-hidden="true">
            /
          </span>
          <span>{ordinal(account.priority)} priority</span>
        </span>
        <Tip label="Close (Esc)">
          <Dialog.Close className="iconbtn" aria-label="Close details">
            <IconX size={16} />
          </Dialog.Close>
        </Tip>
      </div>

      <div className="sheet-scroll">
        <header className="sheet-head">
          {renaming ? (
            <>
              <LabelInput
                account={account}
                className="sheet-rename"
                onDone={(label, keyboard) => {
                  setRenaming(false)
                  refocusRename.current = keyboard
                  if (label !== undefined) controls.rename(account, label)
                }}
              />
              {/* The sheet keeps its name while the label is edited. */}
              <Dialog.Title className="sr-only">{account.label}</Dialog.Title>
            </>
          ) : (
            <div className="sheet-title-row">
              <Dialog.Title
                className="sheet-title"
                onDoubleClick={() => !readOnly && setRenaming(true)}
              >
                {account.label}
              </Dialog.Title>
              <Tip label="Rename">
                <button
                  ref={renameButton}
                  type="button"
                  className="iconbtn sheet-title-edit"
                  aria-label="Rename"
                  disabled={readOnly}
                  onClick={() => setRenaming(true)}
                >
                  <IconPencil size={13} />
                </button>
              </Tip>
            </div>
          )}
          <div className="sheet-meta">
            <span className="sheet-email">{account.email}</span>
            <span className="plan" data-weight={planWeight(account.provider, account.plan)}>
              {account.plan}
            </span>
          </div>
        </header>

        <StatusCard account={account} list={list} controls={controls} now={props.now} />

        <Tabs.Root className="tabs" defaultValue="overview">
          <Tabs.List className="tabs-list">
            <Tabs.Tab className="tab" value="overview">
              Overview
            </Tabs.Tab>
            <Tabs.Tab className="tab" value="activity">
              Activity<span className="tag">Planned</span>
            </Tabs.Tab>
            <Tabs.Indicator className="tabs-indicator" />
          </Tabs.List>

          <Tabs.Panel className="tab-panel" value="overview">
            <AccountLimitsPanel account={account} pool={pool} readOnly={readOnly} now={props.now} />
            <AccountWeek account={account} now={props.now} />
            <dl className="facts">
              <div>
                <dt>Priority</dt>
                <dd>
                  <span>
                    <b>{account.priority}</b> of {pool.length} in the {provider} pool
                  </span>
                  <span className="stepper">
                    <Tip label="Move up">
                      <button
                        type="button"
                        className="iconbtn"
                        aria-label="Move up"
                        disabled={readOnly || account.priority === 1}
                        onClick={() => controls.move(account, account.priority - 1)}
                      >
                        <IconChevronUp size={14} />
                      </button>
                    </Tip>
                    <Tip label="Move down">
                      <button
                        type="button"
                        className="iconbtn"
                        aria-label="Move down"
                        disabled={readOnly || account.priority === pool.length}
                        onClick={() => controls.move(account, account.priority + 1)}
                      >
                        <IconChevronDown size={14} />
                      </button>
                    </Tip>
                  </span>
                </dd>
              </div>
              <div>
                <dt id={enabledId}>Enabled</dt>
                <dd>
                  <span className="muted">
                    {account.enabled ? "In the pool" : "Out of the pool"}
                  </span>
                  <Switch.Root
                    className="switch"
                    checked={account.enabled}
                    disabled={readOnly}
                    aria-labelledby={enabledId}
                    onCheckedChange={(enabled) => controls.setEnabled(account, enabled)}
                  >
                    <Switch.Thumb className="switch-thumb" />
                  </Switch.Root>
                </dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{account.plan}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{account.email}</dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>{lastUsedText(account.lastUsedAt, props.now)}</dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{added.format(Date.parse(account.addedAt))}</dd>
              </div>
            </dl>

            <div className="order">
              <h3 className="order-title" id={`${enabledId}-order`}>
                {provider} pool order
              </h3>
              <ol aria-labelledby={`${enabledId}-order`}>
                {pool.map((member) => (
                  <li
                    key={member.id}
                    className={`is-${member.status} ${member.id === account.id ? "is-me" : ""}`}
                    aria-current={member.id === account.id ? "true" : undefined}
                  >
                    <span className="order-n">{member.priority}</span>
                    <span className="order-label">{member.label}</span>
                    <span className="order-status">
                      <span className="sdot" aria-hidden="true" />
                      {statusLabels[member.status]}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="danger">
              <div>
                <b>Remove account</b>
                <p>Signs agent-proxy out of {account.email}. You can add it again later.</p>
              </div>
              <button
                type="button"
                className="btn is-danger-ghost"
                disabled={readOnly}
                onClick={() => controls.askRemove(account)}
              >
                <IconTrash size={13} />
                Remove…
              </button>
            </div>
          </Tabs.Panel>

          <Tabs.Panel className="tab-panel" value="activity">
            <Planned icon={<IconActivity size={18} />}>
              <b>Activity for {account.label} is planned.</b> Status changes, cooldowns and edits
              will show up here.
            </Planned>
          </Tabs.Panel>
        </Tabs.Root>
      </div>
    </>
  )
}

function Planned({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="planned">
      {icon}
      <p>{children}</p>
    </div>
  )
}

/** Where the account stands, in a sentence, and what the owner can do about it. */
function StatusCard(props: {
  account: Account
  list: AccountList
  controls: AccountControls
  now: number
}) {
  const { account, list } = props
  const end = cooldownEnd(account)
  const provider = providerNames[account.provider]
  const pool = list.pools.find((candidate) => candidate.provider === account.provider)
  const state = pool === undefined ? undefined : poolState(list, pool)
  const serving = state?.kind === "serving" && state.account.id === account.id

  const text = (() => {
    switch (account.status) {
      case "active":
        if (serving) return `Gets every new ${provider} session.`
        return state?.kind === "serving"
          ? `Ready. Takes new sessions when ${state.account.label} can't.`
          : `Ready to take new ${provider} sessions.`
      case "cooling-down":
        return "It hit its plan's limit. agent-proxy skips it until the limit resets."
      case "needs-sign-in":
        return "Its sign-in expired, so agent-proxy skips it until you sign in again."
      case "disabled":
        return "You turned it off. It keeps its place in the priority order."
      case "unknown":
        return "The daemon reports a status this dashboard does not know. Update agent-proxy."
    }
  })()

  return (
    <section className={`statuscard is-${account.status}`} aria-label="Status">
      <div className="statuscard-main">
        <span className="statuscard-dot" aria-hidden="true" />
        <div className="statuscard-text">
          <div className="statuscard-label">
            {statusLabels[account.status]}
            {end !== null && (
              <span className="statuscard-until">{`until ${clockText(end, props.now)}`}</span>
            )}
            {serving && <span className="serving">New sessions</span>}
          </div>
          <p>{text}</p>
        </div>
        {end !== null && (
          <span className="statuscard-side">
            <IconClock size={13} />
            {countdown(end, props.now)}
          </span>
        )}
        {account.status === "disabled" && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={props.controls.readOnly}
            onClick={() => props.controls.setEnabled(account, true)}
          >
            Enable
          </button>
        )}
        {account.status === "needs-sign-in" && (
          <button
            type="button"
            className="btn btn-sm is-primary"
            disabled={props.controls.readOnly}
            onClick={() => props.controls.signIn({ kind: "again", account })}
          >
            Sign in again
          </button>
        )}
      </div>
    </section>
  )
}
