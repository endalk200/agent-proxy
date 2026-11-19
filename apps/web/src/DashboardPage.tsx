import { Popover } from "@base-ui/react/popover"
import { type ReactNode, useState } from "react"

import {
  Legend,
  SegBar,
  seriesColor,
  ShareBar,
  Sparkline,
  StackedColumns,
  bucketTotals,
  foldTail,
  metricText,
} from "./charts.tsx"
import {
  type Account,
  type AccountList,
  type BreakdownAccount,
  type BreakdownRow,
  type RangeKey,
  type SeriesMetric,
  totalTokens,
  type UsageRange,
  type UsageSeries,
  type UsageSummary,
} from "./daemon-api.ts"
import {
  ago,
  bucketText,
  compact,
  count,
  dayText,
  isoDay,
  parseIsoDay,
  pct,
  usd,
} from "./format.ts"
import { LimitCell, type WindowColumn, windowColumns } from "./limits.tsx"
import { accountsOf, providerNames, statusLabels } from "./model.ts"
import { pageLink, setSearchParams, useSearchParam } from "./route.ts"
import { IconAlert, IconArrowRight, IconCalendar, ProviderMark, Tip } from "./ui.tsx"
import { rangeKey, type UsageAnswer, useUsage, useUsageQuery } from "./usage.tsx"
import { useNow } from "./useDaemon.ts"

export interface DashboardProps {
  /** Undefined until the daemon first answers. */
  readonly list: AccountList | undefined
  readonly reachable: boolean
  readonly openId: string | undefined
  readonly openAccount: (account: Account) => void
}

/**
 * The usage dashboard at `/`: what went through the proxy over a range the
 * owner picks, and how much of each account's limit windows is used. A row
 * of KPI cards, then the token trend beside models, then limit windows and
 * accounts at full width.
 */
export function DashboardPage(props: DashboardProps) {
  const range = useRange()
  return (
    <>
      <header className="pagehead dash-head">
        <div className="pagehead-text">
          <h1 id="page-title" tabIndex={-1}>
            Dashboard
          </h1>
          <p>What went through the proxy, and how much of each plan's limit windows is used.</p>
        </div>
        <div className="dash-controls">
          <LiveMarker list={props.list} reachable={props.reachable} />
          <RangePicker range={range} />
        </div>
      </header>
      {props.list !== undefined && (
        <div className={`content ${props.reachable ? "" : "is-stale"}`}>
          <CardGrid {...props} list={props.list} range={range} />
        </div>
      )}
    </>
  )
}

// --------------------------------------------------------------- the range

const RANGE_KEYS: ReadonlyArray<RangeKey> = ["6h", "24h", "7d", "30d", "90d", "custom", "lifetime"]
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** The range in the address: `?range=…`, with `from` and `to` for a custom one; 7d otherwise. */
function useRange(): UsageRange {
  const key = useSearchParam("range")
  const from = useSearchParam("from")
  const to = useSearchParam("to")
  if (key === "custom") {
    return from !== null &&
      to !== null &&
      DAY_PATTERN.test(from) &&
      DAY_PATTERN.test(to) &&
      from <= to
      ? { key, from, to }
      : { key: "7d" }
  }
  const known = RANGE_KEYS.find((candidate) => candidate === key)
  return known === undefined || known === "custom" ? { key: "7d" } : { key: known }
}

/** "the last 7 days", "Nov 1 – Nov 12": the range in words. */
const rangeWords = (range: UsageRange): string => {
  switch (range.key) {
    case "6h":
      return "the last 6 hours"
    case "24h":
      return "the last 24 hours"
    case "7d":
      return "the last 7 days"
    case "30d":
      return "the last 30 days"
    case "90d":
      return "the last 90 days"
    case "lifetime":
      return "all time"
    case "custom":
      return range.from === range.to
        ? dayText(parseIsoDay(range.from))
        : `${dayText(parseIsoDay(range.from))} – ${dayText(parseIsoDay(range.to))}`
  }
}

const rangeLabels: Readonly<Record<RangeKey, string>> = {
  "6h": "6h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  custom: "Custom",
  lifetime: "Lifetime",
}

/** Picks a preset range; 7d, the default, leaves the address bare. */
const pickRange = (key: Exclude<RangeKey, "custom">) =>
  setSearchParams({ range: key === "7d" ? undefined : key, from: undefined, to: undefined })

/** The range control: a segmented row of presets, and Custom, which asks for two calendar days. */
function RangePicker(props: { range: UsageRange }) {
  const { range } = props
  const [open, setOpen] = useState(false)
  const today = isoDay(useNow(60_000))
  const [from, setFrom] = useState(range.key === "custom" ? range.from : today)
  const [to, setTo] = useState(range.key === "custom" ? range.to : today)
  const valid = DAY_PATTERN.test(from) && DAY_PATTERN.test(to) && from <= to
  return (
    <fieldset className="range">
      <legend className="sr-only">Range</legend>
      {RANGE_KEYS.map((key) =>
        key === "custom" ? (
          <Popover.Root
            key={key}
            open={open}
            onOpenChange={(next) => {
              if (next && range.key === "custom") {
                setFrom(range.from)
                setTo(range.to)
              }
              setOpen(next)
            }}
          >
            <Popover.Trigger
              className={`range-opt ${range.key === "custom" ? "is-on" : ""}`}
              aria-pressed={range.key === "custom"}
            >
              <IconCalendar size={13} />
              {range.key === "custom" ? rangeWords(range) : rangeLabels.custom}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner className="layer" sideOffset={6} align="end">
                <Popover.Popup className="popover range-pop">
                  <Popover.Title className="range-pop-title">Custom range</Popover.Title>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!valid) return
                      setSearchParams({ range: "custom", from, to })
                      setOpen(false)
                    }}
                  >
                    <div className="range-pop-fields">
                      <label>
                        <span>From</span>
                        <input
                          type="date"
                          className="field-input"
                          value={from}
                          max={to}
                          onChange={(event) => setFrom(event.target.value)}
                        />
                      </label>
                      <label>
                        <span>To</span>
                        <input
                          type="date"
                          className="field-input"
                          value={to}
                          min={from}
                          max={today}
                          onChange={(event) => setTo(event.target.value)}
                        />
                      </label>
                    </div>
                    <p className="range-pop-hint">Whole calendar days, both included.</p>
                    <div className="range-pop-foot">
                      <Popover.Close className="btn btn-sm">Cancel</Popover.Close>
                      <button type="submit" className="btn btn-sm is-primary" disabled={!valid}>
                        Apply
                      </button>
                    </div>
                  </form>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : (
          <button
            key={key}
            type="button"
            aria-pressed={range.key === key}
            className={`range-opt ${range.key === key ? "is-on" : ""}`}
            onClick={() => pickRange(key)}
          >
            {rangeLabels[key]}
          </button>
        ),
      )}
    </fieldset>
  )
}

/** When the last request finished: the latest the stream reported, or the latest an account served. */
function LiveMarker(props: { list: AccountList | undefined; reachable: boolean }) {
  const { lastRecorded } = useUsage()
  const now = useNow(1000)
  const lastUsed = Math.max(
    lastRecorded?.at ?? 0,
    ...(props.list?.accounts.map((account) =>
      account.lastUsedAt === null ? 0 : Date.parse(account.lastUsedAt),
    ) ?? []),
  )
  const seconds = Math.max(0, Math.round((now - lastUsed) / 1000))
  const sub =
    lastUsed === 0
      ? "no requests yet"
      : seconds < 60
        ? `last request ${seconds}s ago`
        : `last request ${ago(lastUsed, now)}`
  return (
    <span className={`live ${props.reachable ? "" : "is-off"}`}>
      <span
        key={lastRecorded?.at ?? 0}
        className={`live-dot ${lastRecorded === undefined ? "" : "is-pulse"}`}
        aria-hidden="true"
      />
      {props.reachable ? "Live" : "Offline"}
      <span className="live-sub">· {sub}</span>
    </span>
  )
}

// --------------------------------------------------------------------- KPIs

/** Token kinds, cheapest per token to dearest: a grey ramp that darkens with price. */
export const TOKEN_KINDS = [
  { key: "uncached", name: "Uncached input", color: "var(--kind-uncached)" },
  { key: "cacheRead", name: "Cache read", color: "var(--kind-cache-read)" },
  { key: "cacheWrite", name: "Cache write", color: "var(--kind-cache-write)" },
  { key: "output", name: "Output", color: "var(--kind-output)" },
] as const

interface Kpi {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly sub: ReactNode
  readonly extra?: ReactNode
  readonly spark: ReadonlyArray<number | null>
  readonly sparkFormat: (value: number) => string
  /** Counts start their axis at zero; rates fit it to the data. */
  readonly zero: boolean
}

/** "1 model unpriced", with which, flagged. */
export function UnpricedFlag(props: { models: ReadonlyArray<string> }) {
  const n = props.models.length
  if (n === 0) return null
  return (
    <Tip
      label={`${props.models.join(", ")} ${n === 1 ? "has" : "have"} no known list price, so ${n === 1 ? "its" : "their"} tokens are left out of this total.`}
    >
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus shows which models */}
      <span className="flag" tabIndex={0}>
        <IconAlert size={12} />
        {n} model{n === 1 ? "" : "s"} unpriced
      </span>
    </Tip>
  )
}

const kpisOf = (summary: UsageSummary): ReadonlyArray<Kpi> => {
  const { requests, tokens } = summary
  const input = tokens.uncached + tokens.cacheRead + tokens.cacheWrite
  const successRate = requests.total === 0 ? null : requests.success / requests.total
  return [
    {
      id: "requests",
      label: "Requests",
      value: count(requests.total),
      sub: (
        <span className="kpi-good">
          <span className="kpi-dot" aria-hidden="true" />
          {successRate === null ? "—" : pct(successRate)} success
        </span>
      ),
      extra: (
        <span className="kpi-fine">
          {count(requests.failed)} failed · {count(requests.limited)} limited ·{" "}
          {count(requests.incomplete)} incomplete
        </span>
      ),
      spark: summary.spark.map((point) => point.requests),
      sparkFormat: (v) => `${count(v)} requests`,
      zero: true,
    },
    {
      id: "tokens",
      label: "Tokens",
      value: compact(totalTokens(tokens)),
      sub: (
        <SegBar
          label="Tokens by kind"
          parts={TOKEN_KINDS.map((kind) => ({
            key: kind.name,
            value: tokens[kind.key],
            color: kind.color,
          }))}
        />
      ),
      extra: (
        <>
          <dl className="kinds">
            {TOKEN_KINDS.map((kind) => (
              <div key={kind.key}>
                <dt>
                  <i style={{ background: kind.color }} aria-hidden="true" />
                  {kind.name}
                </dt>
                <dd>{compact(tokens[kind.key])}</dd>
              </div>
            ))}
          </dl>
          {tokens.reasoning > 0 && (
            <p className="kinds-foot">Output includes {compact(tokens.reasoning)} reasoning</p>
          )}
        </>
      ),
      spark: summary.spark.map((point) => point.tokens),
      sparkFormat: (v) => `${compact(v)} tokens`,
      zero: true,
    },
    {
      id: "cache",
      label: "Cache hit rate",
      value: summary.cacheHitRate === null ? "—" : pct(summary.cacheHitRate),
      sub: (
        <span className="kpi-muted">
          {compact(tokens.cacheRead)} read from cache of {compact(input)} input
        </span>
      ),
      spark: summary.spark.map((point) => point.cacheHitRate),
      sparkFormat: (v) => `${pct(v)} hit rate`,
      zero: false,
    },
    {
      id: "cost",
      label: "Equivalent cost",
      value: usd(summary.costUsd),
      sub: <span className="kpi-muted">At API list prices; your plans are flat.</span>,
      extra:
        summary.unpricedModels.length === 0 ? undefined : (
          <UnpricedFlag models={summary.unpricedModels} />
        ),
      spark: summary.spark.map((point) => point.costUsd),
      sparkFormat: usd,
      zero: true,
    },
  ]
}

function KpiRow(props: { answer: UsageAnswer<UsageSummary>; range: UsageRange }) {
  const summary = props.answer.data
  if (summary === undefined) {
    return (
      <div className="kpi-grid">
        {props.answer.error === undefined ? (
          [0, 1, 2, 3].map((i) => <div key={i} className="card kpi is-skel" />)
        ) : (
          <p className="card dash-error" role="alert">
            Usage isn't available. {props.answer.error}
          </p>
        )}
      </div>
    )
  }
  const times = summary.spark.map((point) => point.t)
  const step = (times[1] ?? 0) - (times[0] ?? 0)
  return (
    <div className="kpi-grid">
      {kpisOf(summary).map((kpi) => (
        <section key={kpi.id} className="card kpi" aria-label={kpi.label}>
          <h2 className="kpi-label">{kpi.label}</h2>
          <div className="kpi-value">{kpi.value}</div>
          <div className="kpi-sub">{kpi.sub}</div>
          {kpi.extra !== undefined && <div className="kpi-extra">{kpi.extra}</div>}
          <div className="kpi-spark">
            <Sparkline
              values={kpi.spark}
              times={times}
              bucketMs={step > 0 ? step : 3_600_000}
              format={kpi.sparkFormat}
              zero={kpi.zero}
              label={`${kpi.label} over ${rangeWords(props.range)}`}
            />
          </div>
        </section>
      ))}
    </div>
  )
}

// ------------------------------------------------------------ shared pieces

/** A breakdown row's equivalent cost: "Unpriced", or the cost with a mark when partly unpriced. */
function CostCell(props: { row: BreakdownRow }) {
  if (props.row.costUsd === null) {
    return (
      <Tip label="No known list price, so these tokens are left out of the equivalent cost.">
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus says why */}
        <span className="unpriced" tabIndex={0}>
          Unpriced
        </span>
      </Tip>
    )
  }
  return (
    <span>
      {usd(props.row.costUsd)}
      {props.row.partlyUnpriced && (
        <Tip label="Some of these tokens are from an unpriced model, left out of the equivalent cost.">
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus says why */}
          <span className="partly" tabIndex={0} aria-label="partly unpriced">
            *
          </span>
        </Tip>
      )}
    </span>
  )
}

function AccountName(props: { account: Account }) {
  const { account } = props
  return (
    <span className={`acct is-${account.status}`}>
      <span className="acct-dot" aria-hidden="true" />
      <span className="acct-label">{account.label}</span>
      <span className="sr-only">, {statusLabels[account.status]}</span>
    </span>
  )
}

/**
 * The name of each account `list` has held while the page was open, as it
 * last held it. A breakdown loaded before an account was renamed and then
 * removed still names it as it was, until usage loads it again; this names
 * it as it was when removed.
 */
function useLastNames(list: AccountList): ReadonlyMap<string, BreakdownAccount> {
  const [names, setNames] = useState<ReadonlyMap<string, BreakdownAccount>>(new Map())
  const [seen, setSeen] = useState<AccountList | undefined>()
  if (seen !== list) {
    setSeen(list)
    setNames((last) => {
      const next = new Map(last)
      for (const { id, provider, label, email, plan } of list.accounts) {
        next.set(id, { provider, label, email, plan, removedAt: null })
      }
      return next
    })
  }
  return names
}

/** An account no longer held, by the name the daemon last knew it by, if it knew one. */
function RemovedAccountName(props: { account: BreakdownRow["account"] }) {
  const { account } = props
  if (account === null) {
    return (
      <span className="acct is-removed">
        <span className="acct-dot" aria-hidden="true" />
        <span className="acct-label">Removed account</span>
      </span>
    )
  }
  return (
    <>
      <ProviderMark provider={account.provider} size={13} />
      <span className="acct is-removed" title={account.email}>
        <span className="acct-dot" aria-hidden="true" />
        <span className="acct-label">{account.label}</span>
        <span className="tag">Removed</span>
      </span>
    </>
  )
}

function CardHead(props: { id: string; title: string; sub: string; children?: ReactNode }) {
  return (
    <header className="card-head">
      <div>
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.sub}</p>
      </div>
      {props.children}
    </header>
  )
}

/** A card's body until its answer comes: a skeleton, or why it can't. */
function Pending(props: { error: string | undefined; short?: boolean }) {
  return props.error === undefined ? (
    <div className={`chart-skel ${props.short === true ? "is-short" : ""}`} />
  ) : (
    <p className="dash-empty">Usage isn't available. {props.error}</p>
  )
}

const bucketWords = (ms: number) =>
  ms >= 86_400_000
    ? "day"
    : ms === 3_600_000
      ? "hour"
      : ms > 3_600_000
        ? `${ms / 3_600_000} hours`
        : `${ms / 60_000} minutes`

// ---------------------------------------------------------------- the grid

/** Keeps the trend's metric in the address; cost, the default, leaves it out. */
const setMetric = (metric: SeriesMetric) =>
  setSearchParams({ metric: metric === "cost" ? undefined : metric })

function CardGrid(props: DashboardProps & { list: AccountList; range: UsageRange }) {
  const { list, range } = props
  const { throttle } = useUsage()
  const key = rangeKey(range)
  const summary = useUsageQuery(
    `summary:${key}`,
    (client, tz) => client.usageSummary({ range, tz }),
    throttle.kpis,
  )
  // The trend in equivalent cost unless the address says tokens.
  const metric: SeriesMetric = useSearchParam("metric") === "tokens" ? "tokens" : "cost"
  const series = useUsageQuery(
    `series:${metric}:${key}`,
    (client, tz) => client.usageSeries({ range, tz }, metric),
    throttle.charts,
  )
  const byModel = useUsageQuery(
    `models:${key}`,
    (client, tz) => client.usageBreakdown({ range, tz }, "model"),
    throttle.charts,
  )
  const byAccount = useUsageQuery(
    `accounts:${key}`,
    (client, tz) => client.usageBreakdown({ range, tz }, "account"),
    throttle.charts,
  )
  const loading = summary.stale || series.stale || byModel.stale || byAccount.stale
  return (
    <div className={`dash ${loading ? "is-loading" : ""}`} aria-busy={loading}>
      <KpiRow answer={summary} range={range} />
      <div className="grid-a">
        <TrendCard answer={series} range={range} metric={metric} setMetric={setMetric} />
        <ModelsCard answer={byModel} range={range} />
      </div>
      <LimitsCard list={list} openAccount={props.openAccount} />
      <AccountsCard
        answer={byAccount}
        range={range}
        list={list}
        openId={props.openId}
        openAccount={props.openAccount}
      />
    </div>
  )
}

function TrendCard(props: {
  answer: UsageAnswer<UsageSeries>
  range: UsageRange
  metric: SeriesMetric
  setMetric: (metric: SeriesMetric) => void
}) {
  const answered = props.answer.data
  const [asTable, setAsTable] = useState(false)
  // The answer on screen, which can be the other metric's while this one loads.
  const metric = answered?.metric ?? props.metric
  const folded = answered === undefined ? undefined : foldTail(answered)
  const series = folded?.series
  return (
    <section className="card card-trend" aria-labelledby="dash-trend">
      <CardHead
        id="dash-trend"
        title="Token trend"
        sub={`${metric === "cost" ? "Equivalent cost" : "Tokens"} per ${series === undefined ? "bucket" : bucketWords(series.bucketMs)} by model, ${rangeWords(props.range)}`}
      >
        <div className="card-tools">
          <Seg
            label="Measure token trend in"
            options={[
              ["cost", "Cost"],
              ["tokens", "Tokens"],
            ]}
            value={props.metric}
            onChange={props.setMetric}
          />
          <Seg
            label="Show token trend as"
            options={[
              ["chart", "Chart"],
              ["table", "Table"],
            ]}
            value={asTable ? "table" : "chart"}
            onChange={(shown) => setAsTable(shown === "table")}
          />
        </div>
      </CardHead>
      {series === undefined ? (
        <Pending error={props.answer.error} />
      ) : series.keys.length === 0 ? (
        <p className="dash-empty is-tall">
          {metric === "cost" ? "No priced usage" : "No tokens"} in {rangeWords(props.range)}.
        </p>
      ) : (
        <>
          <Legend keys={series.keys} others={folded?.others ?? []} label="Models" />
          {asTable ? (
            <TrendTable series={series} />
          ) : (
            <StackedColumns series={series} label="Token trend by model" />
          )}
        </>
      )}
    </section>
  )
}

/** Pressed buttons that pick one of `options`, each a value and its label. */
function Seg<A extends string>(props: {
  label: string
  options: ReadonlyArray<readonly [A, string]>
  value: A
  onChange: (value: A) => void
}) {
  return (
    <fieldset className="seg">
      <legend className="sr-only">{props.label}</legend>
      {props.options.map(([value, text]) => (
        <button
          key={value}
          type="button"
          className={`seg-opt ${props.value === value ? "is-on" : ""}`}
          aria-pressed={props.value === value}
          onClick={() => props.onChange(value)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  )
}

/** The token trend as a table: one row per bucket with any of the metric. */
function TrendTable(props: { series: UsageSeries }) {
  const { series } = props
  const { value } = metricText[series.metric]
  const totals = bucketTotals(series)
  return (
    <div className="trend-table">
      <table className="mini" aria-label="Token trend by model">
        <thead>
          <tr>
            <th scope="col">When</th>
            {series.keys.map((model) => (
              <th key={model} scope="col" className="num">
                {model}
              </th>
            ))}
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {series.buckets.map((bucket, i) =>
            (totals[i] ?? 0) === 0 ? null : (
              <tr key={bucket.t}>
                <th scope="row">{bucketText(bucket.t, series.bucketMs)}</th>
                {series.keys.map((model) => (
                  <td key={model} className="num">
                    {value(bucket.values[model] ?? 0)}
                  </td>
                ))}
                <td className="num">{value(totals[i] ?? 0)}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}

function ModelsCard(props: {
  answer: UsageAnswer<{ readonly rows: ReadonlyArray<BreakdownRow> }>
  range: UsageRange
}) {
  const rows = props.answer.data?.rows
  return (
    <section className="card" aria-labelledby="dash-models">
      <CardHead id="dash-models" title="Models" sub="Tokens, equivalent cost and share" />
      {rows === undefined ? (
        <Pending error={props.answer.error} short />
      ) : rows.length === 0 ? (
        <p className="dash-empty">No requests in {rangeWords(props.range)}.</p>
      ) : (
        <>
          <SegBar
            label="Share of tokens by model"
            height={8}
            parts={rows.map((row) => ({
              key: row.key,
              value: row.totalTokens,
              color: seriesColor(row.key),
            }))}
          />
          <table className="mini" aria-labelledby="dash-models">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="num col-tokens">
                  Tokens
                </th>
                <th scope="col" className="num col-cost">
                  Equivalent cost
                </th>
                <th scope="col" className="num col-share">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <span
                      className="swatch"
                      style={{ background: seriesColor(row.key) }}
                      aria-hidden="true"
                    />
                    {row.key}
                  </th>
                  <td className="num">{compact(row.totalTokens)}</td>
                  <td className="num">
                    <CostCell row={row} />
                  </td>
                  <td className="num col-share">{pct(row.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function LimitsCard(props: { list: AccountList; openAccount: (account: Account) => void }) {
  const { limits } = useUsage()
  const now = useNow(15_000)
  const pools = props.list.pools.map((pool) => {
    const accounts = accountsOf(props.list, pool.provider)
    return {
      provider: pool.provider,
      accounts,
      columns: windowColumns(accounts.map((account) => limits?.get(account.id))),
    }
  })
  const widest = Math.max(0, ...pools.map((pool) => pool.columns.length))
  return (
    <section className="card card-limits" aria-labelledby="dash-limits">
      <CardHead
        id="dash-limits"
        title="Limit windows"
        sub="Share left of each window, and when it resets"
      >
        <a className="linkbtn is-quiet" {...pageLink("accounts")}>
          Accounts <IconArrowRight size={13} />
        </a>
      </CardHead>
      <div className="limpanel">
        {pools.map((pool) => (
          <table
            key={pool.provider}
            className="limpanel-table"
            aria-label={`${providerNames[pool.provider]} limit windows`}
          >
            <colgroup>
              <col className="limpanel-namecol" />
              {Array.from({ length: widest }, (_, i) => (
                <col key={i} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <span className="limpanel-provider">
                    <ProviderMark provider={pool.provider} size={13} />
                    {providerNames[pool.provider]}
                  </span>
                </th>
                {pool.columns.map((column) => (
                  <th key={column.id} scope="col">
                    {column.label}
                  </th>
                ))}
                {Array.from({ length: widest - pool.columns.length }, (_, i) => (
                  <td key={`pad-${i}`} aria-hidden="true" />
                ))}
              </tr>
            </thead>
            <tbody>
              {pool.accounts.map((account) => (
                <LimitRow
                  key={account.id}
                  account={account}
                  columns={pool.columns}
                  pad={widest - pool.columns.length}
                  now={now}
                  openAccount={props.openAccount}
                />
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </section>
  )
}

function LimitRow(props: {
  account: Account
  columns: ReadonlyArray<WindowColumn>
  pad: number
  now: number
  openAccount: (account: Account) => void
}) {
  const { account } = props
  const { limits } = useUsage()
  const windows = limits?.get(account.id)?.windows
  return (
    <tr>
      <th scope="row">
        <button
          type="button"
          className="rowlink"
          data-account-row=""
          data-opens-sheet={account.id}
          onClick={() => props.openAccount(account)}
        >
          <AccountName account={account} />
        </button>
      </th>
      {props.columns.map((column) => (
        <td key={column.id}>
          <LimitCell window={windows?.find((window) => window.id === column.id)} now={props.now} />
        </td>
      ))}
      {Array.from({ length: props.pad }, (_, i) => (
        <td key={`pad-${i}`} aria-hidden="true" />
      ))}
    </tr>
  )
}

function AccountsCard(props: {
  answer: UsageAnswer<{ readonly rows: ReadonlyArray<BreakdownRow> }>
  range: UsageRange
  list: AccountList
  openId: string | undefined
  openAccount: (account: Account) => void
}) {
  const rows = props.answer.data?.rows
  const lastNames = useLastNames(props.list)
  return (
    <section className="card" aria-labelledby="dash-accounts">
      <CardHead
        id="dash-accounts"
        title="Accounts"
        sub={`Usage per account, ${rangeWords(props.range)}`}
      />
      {rows === undefined ? (
        <Pending error={props.answer.error} short />
      ) : rows.length === 0 ? (
        <p className="dash-empty">No requests in {rangeWords(props.range)}.</p>
      ) : (
        <table className="mini" aria-labelledby="dash-accounts">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col" className="num col-req">
                Requests
              </th>
              <th scope="col" className="num col-tokens">
                Tokens
              </th>
              <th scope="col" className="num col-cost">
                Equivalent cost
              </th>
              <th scope="col" className="num col-sharebar">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const account = props.list.accounts.find((held) => held.id === row.key)
              return (
                <tr
                  key={row.key}
                  className={
                    account === undefined
                      ? "is-removed"
                      : `is-link ${props.openId === account.id ? "is-open" : ""}`
                  }
                  data-account-row={account === undefined ? undefined : ""}
                  onClick={account === undefined ? undefined : () => props.openAccount(account)}
                >
                  <th scope="row">
                    {account === undefined ? (
                      <RemovedAccountName account={lastNames.get(row.key) ?? row.account} />
                    ) : (
                      <>
                        <ProviderMark provider={account.provider} size={13} />
                        <button
                          type="button"
                          className="rowlink"
                          data-opens-sheet={account.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            props.openAccount(account)
                          }}
                        >
                          <AccountName account={account} />
                        </button>
                      </>
                    )}
                  </th>
                  <td className="num col-req">{count(row.requests.total)}</td>
                  <td className="num">{compact(row.totalTokens)}</td>
                  <td className="num">
                    <CostCell row={row} />
                  </td>
                  <td className="num col-sharebar">
                    <ShareBar fraction={row.share} />
                    <span className="sharepct">{pct(row.share, 0)}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
