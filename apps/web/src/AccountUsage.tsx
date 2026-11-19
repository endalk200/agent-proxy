import { useId, useState } from "react"

import { useWidth } from "./charts.tsx"
import { type Account, totalTokens, type UsageRange } from "./daemon-api.ts"
import {
  ago,
  compact,
  count,
  dayText,
  isoDay,
  parseIsoDay,
  pct,
  usd,
  weekdayText,
} from "./format.ts"
import { LimitList, windowColumns } from "./limits.tsx"
import { IconRefresh, Spinner } from "./ui.tsx"
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
    <section className="sheet-block" aria-labelledby={headingId}>
      <div className="sheet-block-head">
        <h3 id={headingId}>Limit windows</h3>
        <span className="sheet-asof">
          {limits?.asOf === null || limits === undefined ? "" : `As of ${ago(limits.asOf, now)}`}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={props.readOnly || refreshing}
          onClick={() => usage.refresh(account.id)}
        >
          {refreshing ? <Spinner size={12} /> : <IconRefresh size={13} />}
          Refresh
        </button>
      </div>
      <LimitList limits={limits} columns={columns} plan={account.plan} now={now} />
    </section>
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
  const [ref, width] = useWidth<HTMLDivElement>(380)
  const [hover, setHover] = useState<number | undefined>()
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
  const max = Math.max(1, ...days.map(([, v]) => v))
  const plotH = 64
  const slot = width / days.length
  const barW = Math.min(24, Math.max(4, slot - 10))
  const hovered = hover === undefined ? undefined : days[hover]
  const unpriced = summary?.unpricedModels.length ?? 0

  return (
    <section className="sheet-block" aria-labelledby={headingId}>
      <div className="sheet-block-head">
        <h3 id={headingId}>Last 7 days through the proxy</h3>
      </div>
      <div className="week-tiles">
        <div>
          <span>Requests</span>
          <b>{summary === undefined ? "—" : count(summary.requests.total)}</b>
          <small>
            {summary === undefined || summary.requests.total === 0
              ? " "
              : `${pct(summary.requests.success / summary.requests.total)} success`}
          </small>
        </div>
        <div>
          <span>Tokens</span>
          <b>{summary === undefined ? "—" : compact(totalTokens(summary.tokens))}</b>
          <small>
            {summary === undefined || summary.cacheHitRate === null
              ? " "
              : `${pct(summary.cacheHitRate)} cache hit rate`}
          </small>
        </div>
        <div>
          <span>Equivalent cost</span>
          <b>{summary === undefined ? "—" : usd(summary.costUsd)}</b>
          <small className={unpriced > 0 ? "is-flag" : ""}>
            {summary === undefined
              ? " "
              : unpriced > 0
                ? `${unpriced} model${unpriced === 1 ? "" : "s"} unpriced`
                : "At API list prices"}
          </small>
        </div>
      </div>
      <div ref={ref} className="week-chart" onPointerLeave={() => setHover(undefined)}>
        <svg
          width={width}
          height={plotH + 18}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a drawn chart is one image; <img> cannot hold it
          role="img"
          aria-label={`Tokens per day: ${days.map(([t, v]) => `${weekdayText(t)} ${compact(v)}`).join(", ")}`}
        >
          <line x1={0} x2={width} y1={plotH + 0.5} y2={plotH + 0.5} className="axis-base" />
          {days.map(([t, v], i) => {
            const h = (v / max) * (plotH - 6)
            const x = i * slot + (slot - barW) / 2
            const r = Math.min(4, h, barW / 2)
            return (
              <g key={t} onPointerEnter={() => setHover(i)}>
                <rect x={i * slot} y={0} width={slot} height={plotH + 18} fill="transparent" />
                {h > 0.5 && (
                  <path
                    d={`M${x},${plotH}V${plotH - h + r}Q${x},${plotH - h} ${x + r},${plotH - h}H${x + barW - r}Q${x + barW},${plotH - h} ${x + barW},${plotH - h + r}V${plotH}Z`}
                    className={`week-bar ${hover !== undefined && hover !== i ? "is-dim" : ""}`}
                  />
                )}
                <text
                  x={i * slot + slot / 2}
                  y={plotH + 14}
                  textAnchor="middle"
                  className="axis-text"
                >
                  {weekdayText(t)}
                </text>
              </g>
            )
          })}
        </svg>
        {hovered !== undefined && hover !== undefined && (
          <div
            className="ctip"
            role="tooltip"
            style={
              hover * slot > width * 0.6
                ? { right: width - hover * slot - slot / 2 + 10, top: -6 }
                : { left: hover * slot + slot / 2 + 10, top: -6 }
            }
          >
            <b>{compact(hovered[1])} tokens</b>
            <span>{dayText(hovered[0])}</span>
          </div>
        )}
      </div>
    </section>
  )
}
