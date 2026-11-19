import { RefreshCw } from "lucide-react"
import { type ReactNode, useId } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { DayBars } from "./charts.tsx"
import { type Account, totalTokens, type UsageRange } from "./daemon-api.ts"
import { ago, compact, count, isoDay, parseIsoDay, pct, usd, weekdayText } from "./format.ts"
import { LimitList, windowColumns } from "./limits.tsx"
import { Spinner } from "./ui.tsx"
import { isRefreshing, rangeKey, useUsage, useUsageQuery } from "./usage.tsx"

/**
 * The account sheet's usage panels: the account's limit windows, larger,
 * with a Refresh button, and its last 7 days through the proxy.
 */

/** The account's limit windows, its pool's columns, and a Refresh button. */
export function AccountLimitsPanel(props: {
  account: Account
  /** Every account in its pool, whose windows decide the columns. */
  pool: ReadonlyArray<Account>
  readOnly: boolean
  now: number
}) {
  const { account, now } = props
  const usage = useUsage()
  // Once the limits are read, an account they leave out, such as one just
  // added, has simply never been read.
  const limits =
    usage.limits === undefined
      ? undefined
      : (usage.limits.get(account.id) ?? { accountId: account.id, asOf: null, windows: [] })
  const columns = windowColumns(props.pool.map((member) => usage.limits?.get(member.id)))
  const refreshing = isRefreshing(usage, account.id)
  const headingId = useId()
  return (
    <Block headingId={headingId}>
      <BlockHead>
        <h3 id={headingId} className="text-sm font-semibold">
          Limit windows
        </h3>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {limits?.asOf === null || limits === undefined ? "" : `As of ${ago(limits.asOf, now)}`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.readOnly || refreshing}
          onClick={() => usage.refresh(account.id)}
        >
          {refreshing ? <Spinner size={13} /> : <RefreshCw />}
          Refresh
        </Button>
      </BlockHead>
      <LimitList limits={limits} columns={columns} plan={account.plan} now={now} />
    </Block>
  )
}

/** A titled block of the account sheet. */
function Block(props: { headingId: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby={props.headingId}>
      {props.children}
    </section>
  )
}

function BlockHead(props: { children: ReactNode }) {
  return <div className="flex min-h-8 items-center gap-3">{props.children}</div>
}

/** One figure of the week: a label, its value, and a line under it. */
function Tile(props: { label: string; value: string; sub: string; flag?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-background/40 px-4 py-3">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <b className="text-xl font-semibold tracking-tight tabular-nums">{props.value}</b>
      <small
        className={cn(
          "min-h-4 text-xs text-pretty text-muted-foreground tabular-nums",
          props.flag === true && "font-medium text-warning",
        )}
      >
        {props.sub}
      </small>
    </div>
  )
}

/** The last 7 calendar days, today included. */
const lastWeek = (now: number): UsageRange & { readonly key: "custom" } => {
  const today = new Date(now)
  return {
    key: "custom",
    from: isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6).getTime()),
    to: isoDay(now),
  }
}

/** The account's last 7 days through the proxy: requests, tokens, equivalent cost, and tokens per day. */
export function AccountWeek(props: { account: Account; now: number }) {
  const { account } = props
  const { throttle } = useUsage()
  const range = lastWeek(props.now)
  const key = `${rangeKey(range)}:${account.id}`
  const summary = useUsageQuery(
    `sheet-summary:${key}`,
    (client, tz) => client.usageSummary({ range, tz, accountId: account.id }),
    throttle.kpis,
  ).data
  const series = useUsageQuery(
    `sheet-series:${key}`,
    (client, tz) => client.usageSeries({ range, tz, accountId: account.id }),
    throttle.charts,
  ).data
  const headingId = useId()

  // Every day of the range, its buckets' tokens added up.
  const totals = new Map<string, number>()
  for (const bucket of series?.buckets ?? []) {
    const day = isoDay(bucket.t)
    const tokens = Object.values(bucket.values).reduce((sum, v) => sum + v, 0)
    totals.set(day, (totals.get(day) ?? 0) + tokens)
  }
  const days: ReadonlyArray<readonly [number, number]> = Array.from({ length: 7 }, (_, i) => {
    const start = parseIsoDay(range.from)
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return [d.getTime(), totals.get(isoDay(d.getTime())) ?? 0] as const
  })
  const unpriced = summary?.unpricedModels.length ?? 0

  return (
    <Block headingId={headingId}>
      <BlockHead>
        <h3 id={headingId} className="text-sm font-semibold">
          Last 7 days through the proxy
        </h3>
      </BlockHead>
      <div className="grid grid-cols-3 gap-3">
        <Tile
          label="Requests"
          value={summary === undefined ? "—" : count(summary.requests.total)}
          sub={
            summary === undefined || summary.requests.total === 0
              ? " "
              : `${pct(summary.requests.success / summary.requests.total)} success`
          }
        />
        <Tile
          label="Tokens"
          value={summary === undefined ? "—" : compact(totalTokens(summary.tokens))}
          sub={
            summary === undefined || summary.cacheHitRate === null
              ? " "
              : `${pct(summary.cacheHitRate)} cache hit rate`
          }
        />
        <Tile
          label="Equivalent cost"
          value={summary === undefined ? "—" : usd(summary.costUsd)}
          flag={unpriced > 0}
          sub={
            summary === undefined
              ? " "
              : unpriced > 0
                ? `${unpriced} model${unpriced === 1 ? "" : "s"} unpriced`
                : "At API list prices"
          }
        />
      </div>
      <DayBars
        days={days}
        label={`Tokens per day: ${days.map(([t, v]) => `${weekdayText(t)} ${compact(v)}`).join(", ")}`}
        format={(v) => `${compact(v)} tokens`}
      />
    </Block>
  )
}
