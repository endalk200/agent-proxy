import { cn } from "@/lib/utils"

import type { AccountLimits, LimitWindow } from "./daemon-api.ts"
import { age, money, timeText, until, weekdayText } from "./format.ts"
import { Tip } from "./ui.tsx"

/**
 * Limit windows as the pages draw them: a thin meter of the share left,
 * green above 50% left, amber from 50%, red below 20% and "Used up" at none
 * left, with when the window resets. Numbers older than an hour dim, and say when
 * they are from on hover or focus.
 */

/** Numbers older than this are stale. */
export const STALE_MS = 60 * 60_000

export type LimitTone = "ok" | "warn" | "high" | "out"

/** The share of a window left, 0 to 100. */
export const leftPct = (usedPct: number) => Math.min(100, Math.max(0, 100 - usedPct))

export const limitTone = (usedPct: number): LimitTone => {
  const left = leftPct(usedPct)
  return left <= 0 ? "out" : left < 20 ? "high" : left <= 50 ? "warn" : "ok"
}

export const isStale = (window: LimitWindow, now: number) => now - window.asOf > STALE_MS

/**
 * "59% left", or "Used up"; a spend limit says its money, "$1.26 of $40",
 * even when used up. Rounds down, so it never claims more room than there
 * is.
 */
export const leftText = (window: LimitWindow) =>
  window.spend !== undefined
    ? `${money(window.spend.used, window.spend.currency)} of ${money(window.spend.limit, window.spend.currency)}`
    : window.usedPct >= 100
      ? "Used up"
      : `${Math.floor(leftPct(window.usedPct))}% left`

/** "resets in 2h 14m". */
export const resetText = (window: LimitWindow, now: number) =>
  window.resetsAt <= now ? "resets now" : `resets in ${until(window.resetsAt, now)}`

/** "As of 1:12 PM (3 hr ago)". */
export const asOfText = (asOf: number, now: number) =>
  `As of ${timeText(asOf)} (${age(asOf, now) === "just now" ? "just now" : `${age(asOf, now)} ago`})`

/** A column of limit windows: one window id, by the label accounts report it with. */
export interface WindowColumn {
  readonly id: string
  readonly label: string
}

/** Every provider has these, so they keep their columns before any account reports them. */
const BASE_COLUMNS: ReadonlyArray<WindowColumn> = [
  { id: "five-hour", label: "5-hour" },
  { id: "weekly", label: "Weekly" },
]

const rank = (id: string) =>
  id === "five-hour"
    ? 0
    : id === "weekly"
      ? 1
      : id.startsWith("weekly:")
        ? 2
        : id === "monthly"
          ? 3
          : 4

/**
 * The columns for accounts' limit windows: 5-hour and Weekly, then each
 * other window id an account reports, ordered 5-hour, Weekly, per-model
 * weeklies by label, Monthly.
 */
export const windowColumns = (
  limits: Iterable<AccountLimits | undefined>,
): ReadonlyArray<WindowColumn> => {
  const labels = new Map(BASE_COLUMNS.map((column) => [column.id, column.label]))
  for (const entry of limits) {
    for (const window of entry?.windows ?? []) labels.set(window.id, window.label)
  }
  return [...labels]
    .map(([id, label]) => ({ id, label }))
    .toSorted((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label))
}

/** The fill colour and the percent's ink for each tone: green with room, amber at half, red near the end. */
const toneFill: Readonly<Record<LimitTone, string>> = {
  ok: "bg-success",
  warn: "bg-warning",
  high: "bg-danger",
  out: "bg-danger",
}
const toneText: Readonly<Record<LimitTone, string>> = {
  ok: "text-foreground",
  warn: "text-warning",
  high: "text-danger",
  out: "text-danger",
}

export function Meter(props: { usedPct: number; size?: "sm" | "lg"; className?: string }) {
  const tone = limitTone(props.usedPct)
  return (
    <span
      className={cn(
        "block w-full overflow-hidden rounded-full bg-foreground/10",
        props.size === "lg" ? "h-2" : "h-1.5",
        // Nothing left draws no fill, so the track itself turns red.
        tone === "out" && "bg-danger/35",
        props.className,
      )}
      data-tone={tone}
      aria-hidden="true"
    >
      <span
        className={cn(
          "block h-full rounded-full transition-[width,background-color] duration-500 ease-out",
          toneFill[tone],
        )}
        style={{ width: `${leftPct(props.usedPct)}%` }}
      />
    </span>
  )
}

/** One limit window in a cell: percent left, reset right, a bar under both; "—" when there is none. */
export function LimitCell(props: { window: LimitWindow | undefined; now: number }) {
  const { window, now } = props
  if (window === undefined) return <span className="text-muted-foreground/60">—</span>
  const stale = isStale(window, now)
  const tone = limitTone(window.usedPct)
  const body = (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5 transition-opacity outline-none",
        stale && "cursor-help opacity-45 hover:opacity-80 focus-visible:opacity-80",
      )}
      data-tone={tone}
      data-stale={stale ? "true" : undefined}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus shows when stale numbers are from
      tabIndex={stale ? 0 : undefined}
    >
      {window.spend === undefined ? (
        <span
          className={cn("text-sm font-semibold whitespace-nowrap tabular-nums", toneText[tone])}
        >
          {leftText(window)}
        </span>
      ) : (
        // The limit wraps under the money spent when the column is narrow.
        <span className="flex flex-wrap items-baseline gap-x-1 tabular-nums">
          <span className={cn("text-sm font-semibold whitespace-nowrap", toneText[tone])}>
            {money(window.spend.used, window.spend.currency)}
          </span>{" "}
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            of {money(window.spend.limit, window.spend.currency)}
          </span>
        </span>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">{resetText(window, now)}</span>
      <Meter usedPct={window.usedPct} className="mt-0.5 basis-full" />
    </span>
  )
  return stale ? <Tip label={asOfText(window.asOf, now)}>{body}</Tip> : body
}

/** "5:14 PM", or "Thu 5:14 PM" a day or more away. */
const resetClock = (at: number, now: number) =>
  at - now >= 86_400_000 ? `${weekdayText(at)} ${timeText(at)}` : timeText(at)

/** An account's limit windows, larger, one row each, as the account sheet shows them. */
export function LimitList(props: {
  limits: AccountLimits | undefined
  columns: ReadonlyArray<WindowColumn>
  plan: string
  now: number
}) {
  const { limits, now } = props
  if (limits === undefined) {
    return <p className="py-2 text-sm text-muted-foreground">Loading limit windows…</p>
  }
  if (limits.windows.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Not read yet. They show once the account serves a request, or after a refresh.
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-5">
      {props.columns.map((column) => {
        const window = limits.windows.find((candidate) => candidate.id === column.id)
        if (window === undefined) {
          return (
            <li key={column.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium">{column.label}</span>
              <span className="text-muted-foreground">Not on the {props.plan} plan</span>
            </li>
          )
        }
        const stale = isStale(window, now)
        const tone = limitTone(window.usedPct)
        return (
          <li
            key={column.id}
            className={cn("flex flex-col gap-2", stale && "opacity-60")}
            data-tone={tone}
            data-stale={stale ? "true" : undefined}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{column.label}</span>
              <span className={cn("text-sm font-semibold tabular-nums", toneText[tone])}>
                {leftText(window)}
              </span>
            </div>
            <Meter usedPct={window.usedPct} size="lg" />
            <div className="text-xs text-muted-foreground tabular-nums">
              {window.resetsAt <= now
                ? "Resets now"
                : `Resets in ${until(window.resetsAt, now)} · ${resetClock(window.resetsAt, now)}`}
              {stale && <span> · {asOfText(window.asOf, now)}</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
