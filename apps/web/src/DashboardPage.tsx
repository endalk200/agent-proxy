import { ArrowRight, CalendarDays, TriangleAlert } from "lucide-react"
import { type ReactNode, useState } from "react"

import { PageContent, PageHeader } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

import {
  Legend,
  SegBar,
  seriesColor,
  ShareBar,
  Sparkline,
  StackedColumns,
  useHeight,
  bucketTotals,
  foldTail,
  metricText,
} from "./charts.tsx"
import {
  type Account,
  type AccountList,
  type AccountStatus,
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
import { ProviderMark, Tip } from "./ui.tsx"
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
      <PageHeader
        title="Dashboard"
        description="What went through the proxy, and how much of each plan's limit windows is used."
        actions={
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
            <LiveMarker list={props.list} reachable={props.reachable} />
            {/* On the narrowest phones the presets scroll within their own box, not the page. */}
            <div className="-m-1 max-w-full overflow-x-auto p-1">
              <RangePicker range={range} />
            </div>
          </div>
        }
      />
      {props.list !== undefined && (
        <PageContent stale={!props.reachable}>
          <CardGrid {...props} list={props.list} range={range} />
        </PageContent>
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
    <ToggleGroup
      aria-label="Range"
      variant="outline"
      size="sm"
      spacing={0}
      value={[range.key]}
      onValueChange={(next) => {
        const key = RANGE_KEYS.find((candidate) => next.includes(candidate))
        if (key !== undefined && key !== "custom") pickRange(key)
      }}
      className="bg-card"
    >
      {RANGE_KEYS.map((key) =>
        key === "custom" ? (
          <Popover
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
            <PopoverTrigger render={<ToggleGroupItem value="custom" className="gap-1.5 px-3" />}>
              <CalendarDays />
              {range.key === "custom" ? rangeWords(range) : rangeLabels.custom}
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={8} className="w-80 gap-5 p-5">
              <PopoverHeader>
                <PopoverTitle className="text-base">Custom range</PopoverTitle>
                <PopoverDescription>Whole calendar days, both included.</PopoverDescription>
              </PopoverHeader>
              <form
                className="flex flex-col gap-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!valid) return
                  setSearchParams({ range: "custom", from, to })
                  setOpen(false)
                }}
              >
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="range-from">From</Label>
                    <Input
                      id="range-from"
                      type="date"
                      value={from}
                      max={to}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="range-to">To</Label>
                    <Input
                      id="range-to"
                      type="date"
                      value={to}
                      min={from}
                      max={today}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!valid}>
                    Apply
                  </Button>
                </div>
              </form>
            </PopoverContent>
          </Popover>
        ) : (
          <ToggleGroupItem key={key} value={key} className="px-3">
            {rangeLabels[key]}
          </ToggleGroupItem>
        ),
      )}
    </ToggleGroup>
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
    <span className="inline-flex items-center gap-2 text-sm font-medium whitespace-nowrap">
      <span className="relative flex size-2" aria-hidden="true">
        {props.reachable && lastRecorded !== undefined && (
          // A ring that spreads once each time a request finishes.
          <span
            key={lastRecorded.at}
            className="absolute inset-0 animate-ping bg-success [animation-iteration-count:1] motion-reduce:hidden"
          />
        )}
        <span
          className={cn("relative size-2", props.reachable ? "bg-success" : "bg-muted-foreground")}
        />
      </span>
      {props.reachable ? "Live" : "Offline"}
      <span className="font-normal text-muted-foreground tabular-nums">· {sub}</span>
    </span>
  )
}

// --------------------------------------------------------------------- KPIs

/** Token kinds, cheapest per token to dearest: on the dark surface, dearer kinds stand out more. */
export const TOKEN_KINDS = [
  { key: "uncached", name: "Uncached input", color: "oklch(0.52 0 0)" },
  { key: "cacheRead", name: "Cache read", color: "oklch(0.4 0 0)" },
  { key: "cacheWrite", name: "Cache write", color: "oklch(0.66 0 0)" },
  { key: "output", name: "Output", color: "oklch(0.9 0 0)" },
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
      <Badge variant="destructive" className="cursor-help" tabIndex={0}>
        <TriangleAlert />
        {n} model{n === 1 ? "" : "s"} unpriced
      </Badge>
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
        <span className="inline-flex items-center gap-2 font-medium tabular-nums">
          <span className="size-2 rounded-full bg-success" aria-hidden="true" />
          {successRate === null ? "—" : pct(successRate)} success
        </span>
      ),
      extra: (
        <span className="text-xs text-muted-foreground tabular-nums">
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
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
            {TOKEN_KINDS.map((kind) => (
              <div key={kind.key} className="flex min-w-0 flex-col gap-0.5">
                <dt className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <i
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: kind.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{kind.name}</span>
                </dt>
                <dd className="pl-3.5 text-sm font-medium tabular-nums">
                  {compact(tokens[kind.key])}
                </dd>
              </div>
            ))}
          </dl>
          {tokens.reasoning > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Output includes {compact(tokens.reasoning)} reasoning
            </p>
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
        <span className="text-muted-foreground">
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
      sub: <span className="text-muted-foreground">At API list prices; your plans are flat.</span>,
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

const KPI_GRID = "grid gap-6 sm:grid-cols-2 xl:grid-cols-4"

function KpiRow(props: { answer: UsageAnswer<UsageSummary>; range: UsageRange }) {
  const summary = props.answer.data
  if (summary === undefined) {
    return props.answer.error === undefined ? (
      <div className={KPI_GRID}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-56 rounded-xl ring-1 ring-border" />
        ))}
      </div>
    ) : (
      <Card role="alert" className="px-6 text-muted-foreground">
        Usage isn't available. {props.answer.error}
      </Card>
    )
  }
  const times = summary.spark.map((point) => point.t)
  const step = (times[1] ?? 0) - (times[0] ?? 0)
  return (
    <div className={KPI_GRID}>
      {kpisOf(summary).map((kpi) => (
        <section key={kpi.id} aria-label={kpi.label} className="min-w-0">
          <Card className="h-full gap-0">
            <CardContent className="flex h-full flex-col gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">{kpi.label}</h2>
              <div className="text-3xl leading-none font-semibold tracking-tight tabular-nums">
                {kpi.value}
              </div>
              <div className="min-h-5 text-sm">{kpi.sub}</div>
              {kpi.extra !== undefined && <div className="min-w-0">{kpi.extra}</div>}
              <div className="mt-auto pt-3">
                <Sparkline
                  values={kpi.spark}
                  times={times}
                  bucketMs={step > 0 ? step : 3_600_000}
                  format={kpi.sparkFormat}
                  zero={kpi.zero}
                  label={`${kpi.label} over ${rangeWords(props.range)}`}
                />
              </div>
            </CardContent>
          </Card>
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
        <span
          className="cursor-help text-muted-foreground underline decoration-dotted underline-offset-4"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus says why
          tabIndex={0}
        >
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
          <span
            className="ml-0.5 cursor-help text-warning"
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus says why
            tabIndex={0}
            aria-label="partly unpriced"
          >
            *
          </span>
        </Tip>
      )}
    </span>
  )
}

/** An account's status as a small square: green serving, amber cooling, red signed out, hollow off. */
const statusDot: Readonly<Record<AccountStatus | "removed", string>> = {
  active: "bg-success",
  "cooling-down": "bg-warning",
  "needs-sign-in": "bg-danger",
  disabled: "ring-1 ring-inset ring-muted-foreground",
  unknown: "ring-1 ring-inset ring-muted-foreground",
  removed: "ring-1 ring-inset ring-muted-foreground",
}

function AccountName(props: { account: Account }) {
  const { account } = props
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <span
        className={cn("size-2 shrink-0 rounded-full", statusDot[account.status])}
        aria-hidden="true"
      />
      <span className="truncate font-medium group-hover/rowlink:underline group-hover/rowlink:underline-offset-4">
        {account.label}
      </span>
      <span className="sr-only">, {statusLabels[account.status]}</span>
    </span>
  )
}

/** A button that opens an account's sheet, drawn as the account's name. */
function RowLink(props: {
  account: Account
  onOpen: (event: React.MouseEvent) => void
  withRowMarker?: boolean
}) {
  return (
    <button
      type="button"
      className="group/rowlink inline-flex min-w-0 cursor-pointer items-center rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-account-row={props.withRowMarker === true ? "" : undefined}
      data-opens-sheet={props.account.id}
      onClick={props.onOpen}
    >
      <AccountName account={props.account} />
    </button>
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
      <span className="inline-flex items-center gap-2.5 text-muted-foreground italic">
        <span
          className={cn("size-2 shrink-0 rounded-full", statusDot.removed)}
          aria-hidden="true"
        />
        <span>Removed account</span>
      </span>
    )
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5" title={account.email}>
      <ProviderMark provider={account.provider} size={14} />
      <span className={cn("size-2 shrink-0 rounded-full", statusDot.removed)} aria-hidden="true" />
      <span className="truncate text-muted-foreground italic">{account.label}</span>
      <Badge variant="outline" className="text-muted-foreground">
        Removed
      </Badge>
    </span>
  )
}

/**
 * A dashboard card: a region named by its title, with a line under the title
 * and the card's tools on the right.
 */
function DashCard(props: {
  id: string
  title: string
  sub: string
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={props.id} className={cn("min-w-0", props.className)}>
      <Card className="h-full">
        <CardHeader className="max-sm:grid-cols-1">
          <CardTitle>
            <h2 id={props.id} className="text-base font-semibold">
              {props.title}
            </h2>
          </CardTitle>
          <CardDescription>{props.sub}</CardDescription>
          {props.action !== undefined && (
            // Below sm the actions drop under the title, so it keeps its width.
            <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:mt-3 max-sm:justify-self-start">
              {props.action}
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-5">{props.children}</CardContent>
      </Card>
    </section>
  )
}

/** A card's body until its answer comes: a skeleton, or why it can't. */
function Pending(props: { error: string | undefined; short?: boolean }) {
  return props.error === undefined ? (
    <Skeleton className={props.short === true ? "h-40" : "h-72"} />
  ) : (
    <Empty>Usage isn't available. {props.error}</Empty>
  )
}

/** A card with nothing to show, saying why. */
function Empty(props: { children: ReactNode; tall?: boolean }) {
  return (
    <p
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground",
        props.tall === true ? "min-h-72" : "min-h-32",
      )}
    >
      {props.children}
    </p>
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

/** A numeric column's cells: right-aligned, figures that line up. */
const NUM = "text-right tabular-nums"
/** Roomy rows, the outer cells flush with the card's padding. */
const CELL = "h-12 px-3 first:pl-0 last:pr-0"
const HEAD =
  "h-10 px-3 text-xs font-medium tracking-wide text-muted-foreground uppercase first:pl-0 last:pr-0"

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
    <div
      className={cn("flex flex-col gap-6 transition-opacity", loading && "opacity-75")}
      aria-busy={loading}
    >
      <KpiRow answer={summary} range={range} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
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
    <DashCard
      id="dash-trend"
      title="Token trend"
      sub={`${metric === "cost" ? "Equivalent cost" : "Tokens"} per ${series === undefined ? "bucket" : bucketWords(series.bucketMs)} by model, ${rangeWords(props.range)}`}
      action={
        <div className="flex flex-wrap justify-end gap-2">
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
      }
    >
      {series === undefined ? (
        <Pending error={props.answer.error} />
      ) : series.keys.length === 0 ? (
        <Empty tall>
          {metric === "cost" ? "No priced usage" : "No tokens"} in {rangeWords(props.range)}.
        </Empty>
      ) : (
        <>
          <Legend keys={series.keys} others={folded?.others ?? []} label="Models" />
          {asTable ? <TrendTable series={series} /> : <TrendChart series={series} />}
        </>
      )}
    </DashCard>
  )
}

/**
 * The trend's columns, as tall as the card lets them be: beside Models the
 * card grows to Models' height, and the chart fills it rather than leaving a
 * gap. The chart sits in an absolute box so its own height never feeds back
 * into the card's.
 */
function TrendChart(props: { series: UsageSeries }) {
  const [ref, height] = useHeight<HTMLDivElement>(288)
  return (
    <div ref={ref} className="relative min-h-72 flex-1">
      <div className="absolute inset-0">
        <StackedColumns series={props.series} height={height} label="Token trend by model" />
      </div>
    </div>
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
    <ToggleGroup
      aria-label={props.label}
      variant="outline"
      size="sm"
      spacing={0}
      value={[props.value]}
      onValueChange={(next) => {
        const picked = props.options.find(([value]) => next.includes(value))
        if (picked !== undefined) props.onChange(picked[0])
      }}
    >
      {props.options.map(([value, text]) => (
        <ToggleGroupItem key={value} value={value} className="px-3">
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** The token trend as a table: one row per bucket with any of the metric. */
function TrendTable(props: { series: UsageSeries }) {
  const { series } = props
  const { value } = metricText[series.metric]
  const totals = bucketTotals(series)
  return (
    <div className="max-h-80 overflow-y-auto">
      <Table aria-label="Token trend by model">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={HEAD}>
              When
            </TableHead>
            {series.keys.map((model) => (
              <TableHead key={model} scope="col" className={cn(HEAD, NUM, "normal-case")}>
                {model}
              </TableHead>
            ))}
            <TableHead scope="col" className={cn(HEAD, NUM)}>
              Total
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.buckets.map((bucket, i) =>
            (totals[i] ?? 0) === 0 ? null : (
              <TableRow key={bucket.t}>
                <TableHead scope="row" className={cn(CELL, "font-normal")}>
                  {bucketText(bucket.t, series.bucketMs)}
                </TableHead>
                {series.keys.map((model) => (
                  <TableCell key={model} className={cn(CELL, NUM)}>
                    {value(bucket.values[model] ?? 0)}
                  </TableCell>
                ))}
                <TableCell className={cn(CELL, NUM, "font-medium")}>
                  {value(totals[i] ?? 0)}
                </TableCell>
              </TableRow>
            ),
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function ModelsCard(props: {
  answer: UsageAnswer<{ readonly rows: ReadonlyArray<BreakdownRow> }>
  range: UsageRange
}) {
  const rows = props.answer.data?.rows
  return (
    <DashCard id="dash-models" title="Models" sub="Tokens, equivalent cost and share">
      {rows === undefined ? (
        <Pending error={props.answer.error} short />
      ) : rows.length === 0 ? (
        <Empty>No requests in {rangeWords(props.range)}.</Empty>
      ) : (
        <>
          <SegBar
            label="Share of tokens by model"
            height={10}
            parts={rows.map((row) => ({
              key: row.key,
              value: row.totalTokens,
              color: seriesColor(row.key),
            }))}
          />
          <Table aria-labelledby="dash-models">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={HEAD}>
                  Model
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, NUM)}>
                  Tokens
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, NUM)}>
                  Equivalent cost
                </TableHead>
                <TableHead scope="col" className={cn(HEAD, NUM)}>
                  Share
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableHead scope="row" className={cn(CELL, "max-w-56")}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="size-2.5 shrink-0"
                        style={{ background: seriesColor(row.key) }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{row.key}</span>
                    </span>
                  </TableHead>
                  <TableCell className={cn(CELL, NUM)}>{compact(row.totalTokens)}</TableCell>
                  <TableCell className={cn(CELL, NUM)}>
                    <CostCell row={row} />
                  </TableCell>
                  <TableCell className={cn(CELL, NUM, "text-muted-foreground")}>
                    {pct(row.share)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </DashCard>
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
    <DashCard
      id="dash-limits"
      title="Limit windows"
      sub="Share left of each window, and when it resets"
      action={
        <a className={buttonVariants({ variant: "ghost", size: "sm" })} {...pageLink("accounts")}>
          Accounts <ArrowRight />
        </a>
      }
    >
      <div className="flex flex-col gap-8">
        {pools.map((pool) => (
          <Table
            key={pool.provider}
            className="min-w-[36rem] table-fixed"
            aria-label={`${providerNames[pool.provider]} limit windows`}
          >
            <colgroup>
              <col className="w-36 md:w-56" />
              {Array.from({ length: widest }, (_, i) => (
                <col key={i} />
              ))}
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(HEAD, "normal-case")}>
                  <span className="inline-flex items-center gap-2 text-sm font-semibold tracking-normal text-foreground">
                    <ProviderMark provider={pool.provider} size={15} />
                    {providerNames[pool.provider]}
                  </span>
                </TableHead>
                {pool.columns.map((column) => (
                  <TableHead key={column.id} scope="col" className={cn(HEAD, "pr-8")}>
                    {column.label}
                  </TableHead>
                ))}
                {Array.from({ length: widest - pool.columns.length }, (_, i) => (
                  <td key={`pad-${i}`} aria-hidden="true" />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
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
            </TableBody>
          </Table>
        ))}
      </div>
    </DashCard>
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
    <TableRow className="hover:bg-transparent">
      <TableHead scope="row" className="h-16 px-3 pl-0">
        <RowLink account={account} withRowMarker onOpen={() => props.openAccount(account)} />
      </TableHead>
      {props.columns.map((column) => (
        <TableCell key={column.id} className="h-16 px-3 pr-8 whitespace-normal">
          <LimitCell window={windows?.find((window) => window.id === column.id)} now={props.now} />
        </TableCell>
      ))}
      {Array.from({ length: props.pad }, (_, i) => (
        <td key={`pad-${i}`} aria-hidden="true" />
      ))}
    </TableRow>
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
    <DashCard
      id="dash-accounts"
      title="Accounts"
      sub={`Usage per account, ${rangeWords(props.range)}`}
    >
      {rows === undefined ? (
        <Pending error={props.answer.error} short />
      ) : rows.length === 0 ? (
        <Empty>No requests in {rangeWords(props.range)}.</Empty>
      ) : (
        <Table aria-labelledby="dash-accounts">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={HEAD}>
                Account
              </TableHead>
              <TableHead scope="col" className={cn(HEAD, NUM)}>
                Requests
              </TableHead>
              <TableHead scope="col" className={cn(HEAD, NUM)}>
                Tokens
              </TableHead>
              <TableHead scope="col" className={cn(HEAD, NUM)}>
                Equivalent cost
              </TableHead>
              <TableHead scope="col" className={cn(HEAD, NUM, "w-40")}>
                Share
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const account = props.list.accounts.find((held) => held.id === row.key)
              return (
                <TableRow
                  key={row.key}
                  className={cn(account !== undefined && "cursor-pointer")}
                  data-state={
                    account !== undefined && props.openId === account.id ? "selected" : undefined
                  }
                  data-account-row={account === undefined ? undefined : ""}
                  onClick={account === undefined ? undefined : () => props.openAccount(account)}
                >
                  <TableHead scope="row" className={CELL}>
                    {account === undefined ? (
                      <RemovedAccountName account={lastNames.get(row.key) ?? row.account} />
                    ) : (
                      <span className="inline-flex min-w-0 items-center gap-2.5">
                        <ProviderMark provider={account.provider} size={14} />
                        <RowLink
                          account={account}
                          onOpen={(event) => {
                            event.stopPropagation()
                            props.openAccount(account)
                          }}
                        />
                      </span>
                    )}
                  </TableHead>
                  <TableCell className={cn(CELL, NUM)}>{count(row.requests.total)}</TableCell>
                  <TableCell className={cn(CELL, NUM)}>{compact(row.totalTokens)}</TableCell>
                  <TableCell className={cn(CELL, NUM)}>
                    <CostCell row={row} />
                  </TableCell>
                  <TableCell className={cn(CELL, NUM)}>
                    <span className="inline-flex items-center justify-end gap-3">
                      <ShareBar fraction={row.share} />
                      <span className="w-9 text-muted-foreground">{pct(row.share, 0)}</span>
                    </span>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </DashCard>
  )
}
