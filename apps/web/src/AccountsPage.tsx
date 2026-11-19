import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Ellipsis,
  GripVertical,
  Link,
  Pencil,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

import { CommandLine, ProxyKeyRow } from "./ConnectClients.tsx"
import type {
  Account,
  AccountList,
  AccountStatus,
  DaemonClient,
  Pool,
  Provider,
} from "./daemon-api.ts"
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
  type PoolState,
  poolState,
  providerNames,
  statusLabels,
  step,
} from "./model.ts"
import { PlanBadge } from "./RemoveAccount.tsx"
import type { SignInRequest } from "./SignIn.tsx"
import { ProviderMark, Tip } from "./ui.tsx"
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

/** Limit window columns: off when the pool's card is narrow (a phone), where a row is priority, account, status and actions. */
const WIDE = "@max-[40rem]/pool:hidden"
/** The Enabled column: off unless the card is wide, as when the account sheet takes the page's right side. */
const ENABLED = "@max-[60rem]/pool:hidden"
/** The blank columns that line a pool's windows up with a wider pool's: dropped with Enabled. */
const PAD = "@max-[60rem]/pool:hidden"

/** A row's own controls, where a click does not open the sheet. */
const ROW_CONTROLS = "button, input, a, [role=switch], [role=menu]"

/** Marks the field an account's label is edited in, so the sheet leaves focus in it. */
export const RENAMING = "data-renaming"

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

/** How a row shows where a drag would land by it. */
interface DropMark {
  /** A line above or below the row, between priorities, or the row outlined as one of the priority it would share. */
  readonly kind: "above" | "below" | "share"
  /** For "share": the row is the first, or the last, of that priority. */
  readonly first: boolean
  readonly last: boolean
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

/** Each status's colour, as the status badge, its dot and a row's flash show it. */
export const statusTone: Readonly<
  Record<AccountStatus, { readonly badge: string; readonly dot: string; readonly color: string }>
> = {
  active: {
    badge: "border-success/30 bg-success/10 text-success",
    dot: "bg-success",
    color: "--success",
  },
  "cooling-down": {
    badge: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
    color: "--warning",
  },
  "needs-sign-in": {
    badge: "border-danger/35 bg-danger/10 text-danger",
    dot: "bg-danger",
    color: "--danger",
  },
  disabled: {
    badge: "border-border bg-transparent text-muted-foreground",
    dot: "bg-transparent ring-1 ring-muted-foreground ring-inset",
    color: "--muted-foreground",
  },
  unknown: {
    badge: "border-border bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
    color: "--muted-foreground",
  },
}

/** An account's status, as a badge with a coloured dot. */
export function StatusBadge(props: { status: AccountStatus; className?: string }) {
  const tone = statusTone[props.status]
  return (
    <Badge
      variant="outline"
      className={cn("h-6 gap-1.5 rounded-md px-2 font-medium", tone.badge, props.className)}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
      {statusLabels[props.status]}
    </Badge>
  )
}

/** The badge on the account new sessions go to. */
export function ServingBadge() {
  return (
    <Badge className="h-5 rounded-md border-success/30 bg-success/15 px-1.5 text-[11px] font-semibold text-success">
      New sessions
    </Badge>
  )
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
    <div className="flex flex-col gap-6">
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
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
          New sessions go to <b className="font-semibold text-foreground">{state.account.label}</b>
          {props.then.length > 0 && " "}
          {props.then.length > 0 && (
            <span>{`· then ${props.then.map((account) => account.label).join(", ")}`}</span>
          )}
        </p>
      )
    case "blocked":
      return (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm font-medium text-warning [&_svg]:size-3.5">
          <TriangleAlert aria-hidden="true" />
          No account can take new sessions
          {state.nextReset !== null && (
            <span className="font-normal text-muted-foreground">
              {`· next reset ${clockText(state.nextReset, props.now)} (${countdown(state.nextReset, props.now)})`}
            </span>
          )}
        </p>
      )
    case "off":
      return (
        <p className="text-sm text-muted-foreground">
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
    <div
      className="mx-6 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-warning"
      role="note"
    >
      {nextReset === null ? <TriangleAlert aria-hidden="true" /> : <Clock aria-hidden="true" />}
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
  const head = "h-11 px-4 text-xs font-medium text-muted-foreground @max-[40rem]/pool:px-2.5"
  return (
    <section aria-labelledby={headingId}>
      <Card className="@container/pool gap-5 py-0 pt-6 shadow-sm">
        <CardHeader className="gap-1.5">
          <CardTitle className="flex items-center gap-2.5 text-base font-semibold">
            <ProviderMark provider={provider} size={18} />
            <h2 id={headingId}>{name}</h2>
            <span className="inline-grid h-5 min-w-5 place-items-center rounded-sm border border-border bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
              {accounts.length}
              <span className="sr-only"> {accounts.length === 1 ? "account" : "accounts"}</span>
            </span>
          </CardTitle>
          <CardDescription>
            {drag === undefined ? (
              <PoolLine state={state} provider={provider} then={then} now={props.now} />
            ) : (
              <p className="text-sm font-medium text-accent" aria-hidden="true">
                {dropText(levels, drag)}
              </p>
            )}
          </CardDescription>
        </CardHeader>

        {state.kind === "blocked" && (
          <BlockedCallout state={state} provider={provider} now={props.now} />
        )}

        <CardContent className="px-0">
          <Table
            className={cn(
              "table-fixed border-t border-border",
              drag !== undefined && "cursor-grabbing select-none [&_*]:cursor-grabbing!",
            )}
            aria-label={`${name} accounts`}
          >
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead
                  scope="col"
                  aria-label="Priority"
                  className={cn(head, "w-14 pl-6 @max-[40rem]/pool:w-11 @max-[40rem]/pool:pl-4")}
                >
                  #
                </TableHead>
                <TableHead scope="col" className={cn(head, "@min-[40rem]/pool:w-[26%]")}>
                  Account
                </TableHead>
                <TableHead scope="col" className={cn(head, "w-32 @min-[40rem]/pool:w-40")}>
                  Status
                </TableHead>
                {props.columns.map((column) => (
                  <TableHead key={column.id} scope="col" className={cn(head, WIDE)}>
                    {column.label}
                  </TableHead>
                ))}
                {Array.from({ length: props.widest - props.columns.length }, (_, i) => (
                  <TableHead key={`pad-${i}`} aria-hidden="true" className={cn(head, PAD)} />
                ))}
                <TableHead scope="col" className={cn(head, ENABLED, "w-24")}>
                  Enabled
                </TableHead>
                <TableHead
                  scope="col"
                  aria-label="Actions"
                  className={cn(head, "w-16 pr-6 @max-[40rem]/pool:w-11 @max-[40rem]/pool:pr-3")}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {levels.flatMap((level, at) =>
                level.map((account, index) => {
                  const first = index === 0
                  const last = index === level.length - 1
                  const drop: DropMark | undefined =
                    target === undefined
                      ? undefined
                      : target.kind === "share"
                        ? target.level === at
                          ? { kind: "share", first, last }
                          : undefined
                        : target.gap === at && first
                          ? { kind: "above", first, last }
                          : target.gap === at + 1 && last && at === levels.length - 1
                            ? { kind: "below", first, last }
                            : undefined
                  return (
                    <AccountRow
                      key={account.id}
                      account={account}
                      pool={accounts}
                      level={{ first, last, shared: level.length > 1 }}
                      drop={drop}
                      dragging={drag !== undefined}
                      lifted={drag?.id === account.id}
                      onDragStart={() => setDrag({ id: account.id, drop: undefined })}
                      onDragOver={
                        drag === undefined
                          ? undefined
                          : (offset) => {
                              const next: Drop =
                                offset < GAP_EDGE && first
                                  ? { kind: "gap", gap: at }
                                  : offset > 1 - GAP_EDGE && last
                                    ? { kind: "gap", gap: at + 1 }
                                    : { kind: "share", level: at }
                              if (dropKey(next) !== dropKey(drag.drop)) {
                                setDrag({ ...drag, drop: next })
                              }
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
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  )
}

/** When a cooling-down account is back: "until 3:47 PM · in 47m". */
function CooldownEnd(props: { account: Account; now: number }) {
  const end = cooldownEnd(props.account)
  if (end === null) return null
  return (
    <StatusSub>{`until ${clockText(end, props.now)} · ${countdown(end, props.now)}`}</StatusSub>
  )
}

function StatusSub(props: { children: ReactNode }) {
  return (
    <span className="mt-1 block text-xs whitespace-normal text-muted-foreground tabular-nums">
      {props.children}
    </span>
  )
}

/**
 * Flashes a row the daemon just changed in its new status's colour: a tint
 * with an edge on the left, fading out. A new `turn` replays it.
 */
function useFlash(row: React.RefObject<HTMLTableRowElement | null>, flash: Flash | undefined) {
  const status = flash?.status
  const turn = flash?.turn
  useEffect(() => {
    const el = row.current
    if (el === null || status === undefined || turn === undefined) return
    const cells = [...el.cells]
    if (cells.some((cell) => typeof cell.animate !== "function")) return
    const color = getComputedStyle(el).getPropertyValue(statusTone[status].color).trim()
    const soft = `color-mix(in oklch, ${color === "" ? "currentColor" : color} 16%, transparent)`
    // With reduced motion the tint holds steady for the flash, then goes, without fading.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const animations = cells.map((cell, index) => {
      const tinted = {
        backgroundColor: soft,
        boxShadow: index === 0 ? `inset 3px 0 0 ${color}` : "none",
      }
      return cell.animate(
        still
          ? [
              { ...tinted, offset: 0 },
              { ...tinted, offset: 1 },
            ]
          : [
              { ...tinted, offset: 0 },
              { ...tinted, offset: 0.45 },
              { backgroundColor: "transparent", boxShadow: "none", offset: 1 },
            ],
        { duration: 2600, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      )
    })
    // A replaced flash is cancelled, which settles its `finished` as aborted.
    for (const animation of animations) void animation.finished.catch(() => undefined)
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [row, status, turn])
}

function AccountRow(props: {
  account: Account
  /** Its pool, highest priority first. */
  pool: ReadonlyArray<Account>
  /** Where the row sits among the accounts of its priority. */
  level: { readonly first: boolean; readonly last: boolean; readonly shared: boolean }
  /** How the row shows where a drag would land, if it lands by this row. */
  drop: DropMark | undefined
  /** True while any row of the pool is dragged. */
  dragging: boolean
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
  const { account, controls, level, drop } = props
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
  const row = useRef<HTMLTableRowElement>(null)
  useFlash(row, flash)
  const disabled = account.status === "disabled"
  const cell = "px-4 py-3.5 @max-[40rem]/pool:px-2.5"
  // Where a drag would land: a line between priorities, or the priority it
  // would share, outlined in the accent.
  const dropShadow =
    drop === undefined
      ? undefined
      : drop.kind === "above"
        ? "*:shadow-[inset_0_2px_0_var(--accent)]"
        : drop.kind === "below"
          ? "*:shadow-[inset_0_-2px_0_var(--accent)]"
          : cn(
              "bg-accent/10! *:first:shadow-[inset_2px_0_0_var(--accent)]",
              drop.first && drop.last
                ? "*:shadow-[inset_0_1.5px_0_var(--accent),inset_0_-1.5px_0_var(--accent)] *:first:shadow-[inset_0_1.5px_0_var(--accent),inset_0_-1.5px_0_var(--accent),inset_2px_0_0_var(--accent)]"
                : drop.first
                  ? "*:shadow-[inset_0_1.5px_0_var(--accent)] *:first:shadow-[inset_0_1.5px_0_var(--accent),inset_2px_0_0_var(--accent)]"
                  : drop.last
                    ? "*:shadow-[inset_0_-1.5px_0_var(--accent)] *:first:shadow-[inset_0_-1.5px_0_var(--accent),inset_2px_0_0_var(--accent)]"
                    : undefined,
            )
  return (
    // A click anywhere on the row that is not one of its controls opens the
    // account's sheet, as the label's button does from the keyboard.
    <TableRow
      ref={row}
      className={cn(
        "group/row h-16 cursor-pointer border-border",
        // Accounts sharing a priority: no line runs between their rows.
        level.shared && !level.last && "border-b-transparent",
        open && "bg-accent/10 *:first:shadow-[inset_2px_0_0_var(--accent)] hover:bg-accent/10",
        props.dragging && "hover:bg-transparent",
        props.lifted && "bg-muted! *:not-first:opacity-45",
        dropShadow,
      )}
      data-account-row=""
      data-status={account.status}
      data-priority={account.priority}
      data-serving={props.serving ? "" : undefined}
      data-open={open ? "" : undefined}
      data-drop={drop?.kind}
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
      <TableCell className={cn(cell, "relative pl-6 @max-[40rem]/pool:pl-4")}>
        {/* Accounts that share a priority hang their badges on one rail. */}
        {level.shared && !level.last && (
          <span
            className="pointer-events-none absolute top-[calc(50%+12px)] bottom-[calc(-50%+12px)] left-[calc(1.5rem+11.5px)] border-l-[1.5px] border-border"
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          className="group/grip relative inline-grid cursor-grab touch-none place-items-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default"
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
          <span
            className={cn(
              "absolute top-1/2 right-[calc(100%+2px)] -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity group-focus-visible/grip:opacity-100 group-hover/row:group-enabled/grip:opacity-100",
              props.lifted && "opacity-100",
            )}
            aria-hidden="true"
          >
            <GripVertical className="size-3.5" />
          </span>
          <span
            className={cn(
              "inline-grid size-6 place-items-center rounded-md border text-xs font-semibold tabular-nums transition-colors",
              props.serving
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-muted text-foreground group-hover/grip:group-enabled/grip:border-muted-foreground",
              disabled && "opacity-75",
            )}
          >
            {account.priority}
          </span>
        </button>
      </TableCell>
      <TableCell className={cn(cell, "overflow-hidden", disabled && "opacity-75")}>
        {/* Badges wrap under the label when the column is narrow, never squeezing it out. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {renaming ? (
            <LabelInput
              account={account}
              className="h-8 max-w-60 font-medium"
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
              className="min-w-0 truncate text-left font-semibold underline-offset-4 outline-none hover:underline hover:decoration-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
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
          <PlanBadge account={account} />
          {props.serving && (
            <>
              {" "}
              <ServingBadge />
            </>
          )}
        </div>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{account.email}</span>
      </TableCell>
      <TableCell className={cell}>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={account.status} />
          {account.status === "needs-sign-in" && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="border-danger/40 hover:border-danger/60 hover:bg-danger/10"
              aria-label={`Sign in again to ${account.label}`}
              disabled={readOnly}
              onClick={() => controls.signIn({ kind: "again", account })}
            >
              Sign in again
            </Button>
          )}
        </div>
        <CooldownEnd account={account} now={props.now} />
        {(account.status === "active" || account.status === "disabled") && (
          <StatusSub>
            {account.lastUsedAt === null
              ? "Never used"
              : `Used ${lastUsedText(account.lastUsedAt, props.now)}`}
          </StatusSub>
        )}
      </TableCell>
      {props.columns.map((column) => (
        <TableCell
          key={column.id}
          className={cn(
            cell,
            WIDE,
            "overflow-hidden pr-6 whitespace-normal",
            refreshing && "animate-pulse",
          )}
        >
          <LimitCell window={windows?.find((window) => window.id === column.id)} now={props.now} />
        </TableCell>
      ))}
      {Array.from({ length: props.pad }, (_, i) => (
        <TableCell key={`pad-${i}`} aria-hidden="true" className={cn(cell, PAD)} />
      ))}
      <TableCell className={cn(cell, ENABLED)}>
        <Switch
          checked={account.enabled}
          onCheckedChange={(enabled) => controls.setEnabled(account, enabled)}
          disabled={readOnly}
          aria-label={`${account.label} enabled`}
        />
      </TableCell>
      <TableCell className={cn(cell, "pr-6 text-right @max-[40rem]/pool:pr-3")}>
        <RowMenu
          account={account}
          pool={props.pool}
          controls={controls}
          onRename={() => setRenaming(true)}
        />
      </TableCell>
    </TableRow>
  )
}

/**
 * An account's label being edited. Enter or leaving the field keeps the new
 * label; Escape, an unchanged label or a blank one keeps the old. `onDone`
 * gets the new label, trimmed, or nothing when the old one stays.
 */
export function LabelInput(props: {
  account: Account
  className?: string
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
    <Input
      className={props.className}
      {...{ [RENAMING]: "" }}
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
      icon: <ChevronRight />,
      onClick: () => controls.open(account),
    },
    {
      label: "Rename",
      icon: <Pencil />,
      onClick: () => setRenaming(true),
    },
    {
      label: "Refresh limits",
      icon: <RefreshCw />,
      disabled: isRefreshing(usage, account.id),
      onClick: () => usage.refresh(account.id),
    },
    {
      label: "Move up",
      icon: <ChevronUp />,
      separatorBefore: true,
      disabled: up === undefined,
      onClick: () => up !== undefined && controls.move(account, up),
    },
    {
      label: "Move down",
      icon: <ChevronDown />,
      disabled: down === undefined,
      onClick: () => down !== undefined && controls.move(account, down),
    },
  ]
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) setRenaming(false)
      }}
      onOpenChangeComplete={(open) => {
        if (!open && renaming) props.onRename()
      }}
    >
      <Tip label="Actions">
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          aria-label={`Actions for ${account.label}`}
          disabled={controls.readOnly}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent className="w-56" align="end" finalFocus={!renaming}>
        {items.map((item) => (
          <div key={item.label}>
            {item.separatorBefore === true && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled={item.disabled === true} onClick={item.onClick}>
              <span className="text-muted-foreground">{item.icon}</span>
              {item.label}
            </DropdownMenuItem>
          </div>
        ))}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={partners.length === 0}>
            <span className="text-muted-foreground">
              <Link />
            </span>
            Share priority with
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {partners.map(({ level, first }) => (
              <DropdownMenuItem
                key={first.id}
                onClick={() => controls.move(account, { sharePriorityWith: first.id })}
              >
                <span
                  className="inline-grid size-5 shrink-0 place-items-center rounded-sm border border-border bg-muted text-[11px] font-semibold tabular-nums"
                  aria-hidden="true"
                >
                  {first.priority}
                </span>
                {level.map((other) => other.label).join(", ")}
                <span className="sr-only">{` (priority ${first.priority})`}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => controls.askRemove(account)}>
          <Trash2 />
          Remove…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One step of the first-run guide. */
function Step(props: { n: number; current?: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-5">
      <span
        className={cn(
          "inline-grid size-8 shrink-0 place-items-center rounded-md border text-sm font-semibold tabular-nums",
          props.current === true
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-muted text-muted-foreground",
        )}
        aria-hidden="true"
      >
        {props.n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.children}
      </div>
    </li>
  )
}

/** The guided empty state, shown while the daemon holds no accounts. */
function FirstRun(props: { address: string; client: DaemonClient; controls: AccountControls }) {
  const { address, client, controls } = props
  return (
    <Card className="mx-auto w-full max-w-3xl shadow-sm">
      <CardContent className="px-8 py-2">
        <ol className="flex flex-col gap-8" aria-label="Get started">
          <Step n={1} current title="Add an account">
            <p className="text-sm text-muted-foreground">
              The daemon at <code className="text-foreground">{address}</code> has no accounts yet.
              Sign in to a Claude or Codex account in your browser, and it joins that provider's
              pool.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["claude", "codex"] as const).map((provider) => (
                <Button
                  key={provider}
                  type="button"
                  variant="outline"
                  disabled={controls.readOnly}
                  onClick={() => controls.signIn({ kind: "add", provider })}
                >
                  <ProviderMark provider={provider} size={14} />
                  Add a {providerNames[provider]} account
                </Button>
              ))}
            </div>
          </Step>
          <Step n={2} title="Connect your clients">
            <p className="text-sm text-muted-foreground">
              Run one command per client. It points the client at this proxy and has it fetch the
              proxy key.
            </p>
            <div className="mt-2 flex flex-col gap-3">
              {clients.map((connectable) => (
                <div key={connectable.command} className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {connectable.name}
                  </span>
                  <CommandLine command={connectable.command} />
                </div>
              ))}
            </div>
            <div className="mt-2">
              <ProxyKeyRow client={client} />
            </div>
          </Step>
          <Step n={3} title="Add a fallback">
            <p className="text-sm text-muted-foreground">
              Add a second account to a pool. When the first hits its limit, new sessions move to
              the next one by priority.
            </p>
          </Step>
        </ol>
      </CardContent>
    </Card>
  )
}
