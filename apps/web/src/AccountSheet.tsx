import { Dialog } from "@base-ui/react/dialog"
import { Activity, ChevronDown, ChevronUp, Clock, Pencil, Trash2, X } from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

import {
  type AccountControls,
  LabelInput,
  RENAMING,
  ServingBadge,
  statusTone,
} from "./AccountsPage.tsx"
import { AccountLimitsPanel, AccountWeek } from "./AccountUsage.tsx"
import type { Account, AccountList } from "./daemon-api.ts"
import {
  accountsOf,
  clockText,
  cooldownEnd,
  countdown,
  labelsText,
  lastUsedText,
  ordinal,
  poolState,
  priorityCount,
  providerNames,
  sharingWith,
  statusLabels,
  step,
} from "./model.ts"
import { PlanBadge } from "./RemoveAccount.tsx"
import { LimitResetsPanel } from "./resets.tsx"
import { ProviderMark, Tip } from "./ui.tsx"

/**
 * Where a press outside the sheet leaves it open: on an account row, which
 * swaps the sheet to that account instead, and in the menus, popovers,
 * dialogs, tooltips and notices that float above the page, and in the
 * sidebar's drawer on narrow screens, backdrop included.
 */
const KEEPS_SHEET_OPEN = [
  "[data-account-row]",
  "[data-slot=dropdown-menu-content]",
  "[data-slot=dropdown-menu-sub-content]",
  "[data-slot=popover-content]",
  "[data-slot=tooltip-content]",
  "[data-slot=dialog-content]",
  "[data-slot=alert-dialog-content]",
  "[data-notices]",
  "[data-slot=sidebar][data-mobile=true]",
  "[data-slot=sheet-overlay]",
].join(", ")

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
      if (document.activeElement?.hasAttribute(RENAMING) === true) return
      popup.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  return (
    <Sheet
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
      {/* No backdrop: the sheet is not modal, so the page under it stays usable. */}
      <Dialog.Portal>
        <Dialog.Popup
          ref={popup}
          data-slot="sheet-content"
          className="fixed inset-y-0 right-0 z-40 flex w-(--sheet-w) max-w-full flex-col border-l border-border bg-card text-sm text-card-foreground shadow-2xl outline-none transition duration-200 ease-out data-ending-style:translate-x-8 data-ending-style:opacity-0 data-starting-style:translate-x-8 data-starting-style:opacity-0"
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
    </Sheet>
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
  const sharing = sharingWith(list, account)
  const up = step(pool, account.id, -1)
  const down = step(pool, account.id, 1)
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
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border pr-3 pl-6">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
          <ProviderMark provider={account.provider} size={14} />
          <span>{provider} pool</span>
          <span className="text-border" aria-hidden="true">
            /
          </span>
          <span>{ordinal(account.priority)} priority</span>
        </span>
        <Tip label="Close (Esc)">
          <SheetClose render={<Button variant="ghost" size="icon-sm" />} aria-label="Close details">
            <X />
          </SheetClose>
        </Tip>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 pt-6 pb-10">
        <header className="flex flex-col gap-2">
          {renaming ? (
            <>
              <LabelInput
                account={account}
                className="h-10 text-lg font-semibold md:text-lg"
                onDone={(label, keyboard) => {
                  setRenaming(false)
                  refocusRename.current = keyboard
                  if (label !== undefined) controls.rename(account, label)
                }}
              />
              {/* The sheet keeps its name while the label is edited. */}
              <SheetTitle className="sr-only">{account.label}</SheetTitle>
            </>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <SheetTitle
                className="cursor-text truncate text-xl font-semibold tracking-tight"
                onDoubleClick={() => !readOnly && setRenaming(true)}
              >
                {account.label}
              </SheetTitle>
              <Tip label="Rename">
                <Button
                  ref={renameButton}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label="Rename"
                  disabled={readOnly}
                  onClick={() => setRenaming(true)}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </Tip>
            </div>
          )}
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm text-muted-foreground">{account.email}</span>
            <PlanBadge account={account} />
          </div>
        </header>

        <StatusCard account={account} list={list} controls={controls} now={props.now} />

        <Tabs className="gap-6" defaultValue="overview">
          <TabsList variant="line" className="w-full justify-start border-b border-border pb-1">
            <TabsTrigger className="flex-none px-3" value="overview">
              Overview
            </TabsTrigger>
            <TabsTrigger className="flex-none px-3" value="activity">
              Activity
              <Badge
                variant="outline"
                className="h-4 rounded-md px-1 text-[10px] font-medium text-muted-foreground"
              >
                Planned
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent className="flex flex-col gap-8" value="overview">
            <AccountLimitsPanel account={account} pool={pool} readOnly={readOnly} now={props.now} />
            <LimitResetsPanel account={account} readOnly={readOnly} now={props.now} />
            <AccountWeek account={account} now={props.now} />
            <dl className="flex flex-col border-y border-border">
              <Fact term="Priority">
                <span>
                  <b className="font-semibold">{account.priority}</b> of{" "}
                  {priorityCount(list, account.provider)} in the {provider} pool
                  {sharing.length > 0 && (
                    <span className="text-muted-foreground">{` · shared with ${labelsText(sharing)}`}</span>
                  )}
                </span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <Tip label="Move up">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Move up"
                      disabled={readOnly || up === undefined}
                      onClick={() => up !== undefined && controls.move(account, up)}
                    >
                      <ChevronUp />
                    </Button>
                  </Tip>
                  <Tip label="Move down">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Move down"
                      disabled={readOnly || down === undefined}
                      onClick={() => down !== undefined && controls.move(account, down)}
                    >
                      <ChevronDown />
                    </Button>
                  </Tip>
                </span>
              </Fact>
              <Fact term="Enabled" termId={enabledId}>
                <span className="text-muted-foreground">
                  {account.enabled ? "In the pool" : "Out of the pool"}
                </span>
                <Switch
                  className="ml-auto"
                  checked={account.enabled}
                  disabled={readOnly}
                  aria-labelledby={enabledId}
                  onCheckedChange={(enabled) => controls.setEnabled(account, enabled)}
                />
              </Fact>
              <Fact term="Plan">{account.plan}</Fact>
              <Fact term="Email">{account.email}</Fact>
              <Fact term="Last used">{lastUsedText(account.lastUsedAt, props.now)}</Fact>
              <Fact term="Added">{added.format(Date.parse(account.addedAt))}</Fact>
            </dl>

            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold" id={`${enabledId}-order`}>
                {provider} pool order
              </h3>
              <ol
                className="flex flex-col rounded-lg border border-border"
                aria-labelledby={`${enabledId}-order`}
              >
                {pool.map((member) => {
                  const me = member.id === account.id
                  return (
                    <li
                      key={member.id}
                      className={cn(
                        "flex h-11 items-center gap-3 border-b border-border px-3 last:border-b-0",
                        me && "bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]",
                      )}
                      aria-current={me ? "true" : undefined}
                    >
                      <span className="inline-grid size-6 shrink-0 place-items-center rounded-md border border-border bg-muted text-xs font-semibold tabular-nums">
                        {member.priority}
                      </span>
                      <span className={cn("min-w-0 flex-1 truncate", me && "font-semibold")}>
                        {member.label}
                      </span>
                      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            statusTone[member.status].dot,
                          )}
                          aria-hidden="true"
                        />
                        {statusLabels[member.status]}
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>

            <div className="flex items-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <b className="text-sm font-semibold">Remove account</b>
                <p className="text-xs text-muted-foreground">
                  Signs agent-proxy out of {account.email}. You can add it again later.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={readOnly}
                onClick={() => controls.askRemove(account)}
              >
                <Trash2 />
                Remove…
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="activity">
            <Planned icon={<Activity className="size-5" />}>
              <b className="font-semibold text-foreground">
                Activity for {account.label} is planned.
              </b>{" "}
              Status changes, cooldowns and edits will show up here.
            </Planned>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}

/** One fact about the account: a term, and what it is, with any control for it. */
function Fact(props: { term: string; termId?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-13 items-center gap-4 border-b border-border py-2.5 last:border-b-0">
      <dt id={props.termId} className="w-24 shrink-0 text-muted-foreground">
        {props.term}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center gap-3">{props.children}</dd>
    </div>
  )
}

function Planned({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center text-muted-foreground">
      {icon}
      <p className="max-w-xs text-sm">{children}</p>
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
  // The Active accounts that share its priority, which trade new sessions with it.
  const peers = sharingWith(list, account).filter((other) => other.status === "active")

  const text = (() => {
    switch (account.status) {
      case "active":
        if (serving) {
          return peers.length === 0
            ? `Gets every new ${provider} session.`
            : `Gets new ${provider} sessions while it has more room left in its limits than ${labelsText(peers)}, at the same priority.`
        }
        if (state?.kind !== "serving") return `Ready to take new ${provider} sessions.`
        return state.account.priority === account.priority
          ? `Shares priority ${account.priority} with ${state.account.label}, which has more room left in its limits, so it gets new sessions first.`
          : `Ready. Takes new sessions when ${state.account.label} can't.`
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

  const tone = statusTone[account.status]
  return (
    <section
      className={cn("flex items-start gap-3 border border-border border-l-2 px-4 py-4", tone.badge)}
      aria-label="Status"
    >
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 font-semibold">
          {statusLabels[account.status]}
          {end !== null && (
            <span className="font-normal text-muted-foreground tabular-nums">{`until ${clockText(end, props.now)}`}</span>
          )}
          {serving && <ServingBadge />}
        </div>
        <p className="text-sm text-foreground/80">{text}</p>
      </div>
      {end !== null && (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums">
          <Clock className="size-3.5" />
          {countdown(end, props.now)}
        </span>
      )}
      {account.status === "disabled" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={props.controls.readOnly}
          onClick={() => props.controls.setEnabled(account, true)}
        >
          Enable
        </Button>
      )}
      {account.status === "needs-sign-in" && (
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          disabled={props.controls.readOnly}
          onClick={() => props.controls.signIn({ kind: "again", account })}
        >
          Sign in again
        </Button>
      )}
    </section>
  )
}
