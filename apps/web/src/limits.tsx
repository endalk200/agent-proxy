import type { AccountLimits, LimitWindow } from "./daemon-api.ts"
import { age, timeText, until, weekdayText } from "./format.ts"
import { Tip } from "./ui.tsx"

/**
 * Limit windows as the pages draw them: a thin meter of the share used,
 * neutral below 70%, amber from 70%, red from 90% and "Used up" at 100%,
 * with when the window resets. Numbers older than an hour dim, and say when
 * they are from on hover or focus.
 */

/** Numbers older than this are stale. */
export const STALE_MS = 60 * 60_000

export type LimitTone = "ok" | "warn" | "high" | "out"

export const limitTone = (usedPct: number): LimitTone =>
  usedPct >= 100 ? "out" : usedPct >= 90 ? "high" : usedPct >= 70 ? "warn" : "ok"

export const isStale = (window: LimitWindow, now: number) => now - window.asOf > STALE_MS

/** "41%", or "Used up". */
export const usedText = (window: LimitWindow) =>
  window.usedPct >= 100 ? "Used up" : `${Math.floor(window.usedPct)}%`

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

export function Meter(props: { usedPct: number; size?: "sm" | "lg" }) {
  const tone = limitTone(props.usedPct)
  return (
    <span className={`meter is-${tone} ${props.size === "lg" ? "is-lg" : ""}`} aria-hidden="true">
      <span style={{ width: `${Math.min(100, Math.max(0, props.usedPct))}%` }} />
    </span>
  )
}

/** One limit window in a cell: percent left, reset right, a bar under both; "—" when there is none. */
export function LimitCell(props: { window: LimitWindow | undefined; now: number }) {
  const { window, now } = props
  if (window === undefined) return <span className="lim-none">—</span>
  const stale = isStale(window, now)
  const body = (
    <span
      className={`lim is-${limitTone(window.usedPct)} ${stale ? "is-stale" : ""}`}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus shows when stale numbers are from
      tabIndex={stale ? 0 : undefined}
    >
      <span className="lim-pct">{usedText(window)}</span>
      <span className="lim-reset">{resetText(window, now)}</span>
      <Meter usedPct={window.usedPct} />
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
  if (limits === undefined) return <p className="muted limlist-empty">Loading limit windows…</p>
  if (limits.windows.length === 0) {
    return (
      <p className="muted limlist-empty">
        Not read yet. They show once the account serves a request, or after a refresh.
      </p>
    )
  }
  return (
    <ul className="limlist">
      {props.columns.map((column) => {
        const window = limits.windows.find((candidate) => candidate.id === column.id)
        if (window === undefined) {
          return (
            <li key={column.id} className="limlist-none">
              <span className="limlist-name">{column.label}</span>
              <span className="muted">Not on the {props.plan} plan</span>
            </li>
          )
        }
        const stale = isStale(window, now)
        return (
          <li
            key={column.id}
            className={`is-${limitTone(window.usedPct)} ${stale ? "is-stale" : ""}`}
          >
            <div className="limlist-head">
              <span className="limlist-name">{column.label}</span>
              <span className="limlist-pct">
                {window.usedPct >= 100 ? "Used up" : `${Math.floor(window.usedPct)}% used`}
              </span>
            </div>
            <Meter usedPct={window.usedPct} size="lg" />
            <div className="limlist-reset">
              {window.resetsAt <= now
                ? "Resets now"
                : `Resets in ${until(window.resetsAt, now)} · ${resetClock(window.resetsAt, now)}`}
              {stale && <span className="limlist-asof"> · {asOfText(window.asOf, now)}</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
