import { areaY, barY, defineChart, dot, lineY, ruleY, stack } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react"
import { scaleBand } from "@tanstack/charts/scales/band"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { cn } from "@/lib/utils"

import type { SeriesMetric, UsageSeries } from "./daemon-api.ts"
import {
  axisCompact,
  axisUsd,
  bucketText,
  compact,
  dayText,
  hourText,
  pct,
  usd,
  weekdayText,
} from "./format.ts"

/**
 * The usage charts. TanStack Charts draws the marks, grid and axes; this
 * module keeps what the dashboard promises around them: a model keeps its
 * colour, the trend's columns can be read one by one with the arrow keys, and
 * every chart says in words what it shows. Marks follow the dataviz skill:
 * 2px lines, columns at most 24px wide, a 2px surface gap between stacked
 * segments, a hairline grid, a crosshair or per-column tooltip.
 */

/**
 * Model families that keep a fixed categorical slot (1–6), so a model's
 * colour never depends on its rank or on which other models are in the range.
 * The order puts the models most often seen together in the most distinct
 * slots: Opus red, Sol blue, Sonnet green.
 */
const FAMILIES = ["opus", "sol", "sonnet", "haiku", "fable", "astra"]

/** The categorical slot, 1–8, of model `id`: its family's, or one of the last two by a hash of its id. */
export const modelSlot = (id: string): number => {
  const parts = id.toLowerCase().split(/[^a-z0-9]+/)
  const family = FAMILIES.findIndex((name) => parts.includes(name))
  if (family !== -1) return family + 1
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return FAMILIES.length + 1 + (hash % 2)
}

/**
 * The theme colour of each slot. The theme's red and green sit far apart in
 * the order, so the two adjacent slots most likely to be stacked together are
 * never the pair colour-blind readers confuse most.
 */
const SLOT_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-2)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
]

/** The series that holds every model past the few a chart names. */
export const OTHER = "Other"

/** The colour of model `id`, or the neutral grey of `OTHER`. */
export const seriesColor = (id: string) =>
  id === OTHER ? "var(--chart-other)" : (SLOT_COLORS[modelSlot(id) - 1] ?? "var(--chart-other)")

/** How a series' numbers read: a value, a column's total, and an axis tick. */
export const metricText: Record<
  SeriesMetric,
  {
    readonly value: (n: number) => string
    readonly total: (n: number) => string
    readonly axis: (n: number) => string
  }
> = {
  tokens: { value: compact, total: (n) => `${compact(n)} tokens`, axis: axisCompact },
  cost: { value: usd, total: usd, axis: axisUsd },
}

/**
 * A ref and its element's content box size along `axis`. Before the element
 * is laid out (and where nothing lays it out, as in tests) the size is
 * `fallback`.
 */
function useSize<E extends HTMLElement>(
  axis: "width" | "height",
  fallback: number,
): [RefObject<E | null>, number] {
  const ref = useRef<E>(null)
  const [size, setSize] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    setSize(axis === "width" ? el.clientWidth : el.clientHeight)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setSize(Math.round(entry.contentRect[axis]))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [axis])
  return [ref, size > 0 ? size : fallback]
}

/** A ref and its element's content width, `fallback` until it is laid out. */
export const useWidth = <E extends HTMLElement>(fallback = 480) => useSize<E>("width", fallback)

/** A ref and its element's content height, `fallback` until it is laid out. */
export const useHeight = <E extends HTMLElement>(fallback = 260) => useSize<E>("height", fallback)

/**
 * A tooltip inside a chart, kept within its box: beside the point, on
 * whichever side it fits, and never wider than the chart, wrapping long
 * model names instead of running past the card's edge.
 */
export function ChartTip(props: { x: number; width: number; children: ReactNode; top?: number }) {
  const tip = useRef<HTMLDivElement>(null)
  const [tipWidth, setTipWidth] = useState(0)
  // Its width, measured as it shows and again whenever its text changes it.
  useLayoutEffect(() => {
    const el = tip.current
    if (el === null) return
    setTipWidth(el.offsetWidth)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setTipWidth(el.offsetWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const gap = 12
  const fitsRight = props.x + gap + tipWidth <= props.width
  const left = fitsRight ? props.x + gap : props.x - gap - tipWidth
  return (
    <div
      ref={tip}
      className="pointer-events-none absolute z-10 flex w-max max-w-full min-w-36 flex-col gap-1 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
      role="tooltip"
      style={{
        top: props.top ?? 0,
        left: Math.max(0, Math.min(left, props.width - tipWidth)),
      }}
    >
      {props.children}
    </div>
  )
}

/** A row of a chart tooltip: the mark's swatch, its value, and its name. */
function TipRow(props: { color: string; value: string; name: string }) {
  return (
    <span className="flex items-start gap-2">
      <i className="mt-0.5 size-2.5 shrink-0 rounded-[2px]" style={{ background: props.color }} />
      <b className="font-semibold whitespace-nowrap tabular-nums">{props.value}</b>
      <span className="min-w-0 break-all text-muted-foreground">{props.name}</span>
    </span>
  )
}

/** The chart's text and guides: muted ink, a faint grid, in the page's font. */
const CHART_INK = "text-muted-foreground [&_text]:font-sans"

// ------------------------------------------------------------------ sparkline

interface SparkPoint {
  readonly i: number
  readonly v: number | null
}

export function Sparkline(props: {
  values: ReadonlyArray<number | null>
  times: ReadonlyArray<number>
  bucketMs: number
  format: (value: number) => string
  /** Start the value axis at zero (counts), or fit it to the data (rates). */
  zero: boolean
  height?: number
  label: string
}) {
  const height = props.height ?? 48
  const [ref, width] = useWidth<HTMLDivElement>(240)
  const [hover, setHover] = useState<number | undefined>()
  const { values, zero } = props
  const n = values.length
  const present = values.filter((v): v is number => v !== null)

  const definition = useMemo(() => {
    const points: ReadonlyArray<SparkPoint> = values.map((v, i) => ({ i, v }))
    const shown = points.filter((point) => point.v !== null)
    // An empty spark draws nothing, but its scale still needs a span.
    const known = shown.length === 0 ? [0] : shown.map((point) => point.v ?? 0)
    let lo = zero ? 0 : Math.min(...known)
    let hi = Math.max(...known)
    if (hi === lo) {
      hi += 1
      lo = Math.max(0, lo - 1)
    }
    const last = shown.at(-1)
    return defineChart({
      marks: [
        ...(zero
          ? [
              areaY(points, {
                x: "i",
                y: "v",
                fill: "var(--primary)",
                fillOpacity: 0.14,
              }),
            ]
          : []),
        lineY(points, {
          x: "i",
          y: "v",
          stroke: "var(--primary)",
          strokeWidth: 2,
        }),
        ...(last === undefined
          ? []
          : [dot([last], { x: "i", y: "v", r: 3, fill: "var(--primary)", stroke: "var(--card)" })]),
      ],
      scales: {
        x: { scale: scaleLinear().domain([0, Math.max(1, n - 1)]), axis: false },
        y: { scale: scaleLinear().domain([lo, hi]), axis: false },
      },
      margin: { top: 4, right: 4, bottom: 4, left: 4 },
      // Hover comes from the pointer over every bucket, empty ones included
      // (the chart's own focus skips them), so its focus draws nothing.
      focusRing: false,
      keyboard: false,
    })
  }, [values, zero, n])

  if (n < 2 || present.length === 0) {
    return (
      <div ref={ref} className="relative w-full" style={{ height }}>
        <svg
          width={width}
          height={height}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a drawn chart is one image; <img> cannot hold it
          role="img"
          aria-label={props.label}
        />
      </div>
    )
  }

  const shownValue = hover === undefined ? undefined : values[hover]
  // The plot spans the chart less its 4px margins; bucket i sits at i / (n - 1) of it.
  const plotW = Math.max(1, width - 8)
  const hoverX = hover === undefined ? 0 : 4 + (hover / (n - 1)) * plotW
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left - 4
    setHover(Math.min(n - 1, Math.max(0, Math.round((x / plotW) * (n - 1)))))
  }
  return (
    <div
      ref={ref}
      className={cn("relative w-full", CHART_INK)}
      style={{ height }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(undefined)}
    >
      <Chart
        definition={definition}
        height={height}
        initialWidth={width}
        tabIndex={-1}
        ariaLabel={props.label}
      />
      {hover !== undefined && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 border-l border-dashed border-muted-foreground/60"
          style={{ left: hoverX }}
        />
      )}
      {hover !== undefined && (
        <ChartTip x={hoverX} width={width} top={-44}>
          <b className="font-semibold tabular-nums">
            {shownValue === null || shownValue === undefined ? "—" : props.format(shownValue)}
          </b>
          <span className="text-muted-foreground">
            {bucketText(props.times[hover] ?? 0, props.bucketMs)}
          </span>
        </ChartTip>
      )}
    </div>
  )
}

// ------------------------------------------------------------ stacked columns

const DAY_MS = 86_400_000
const isMidnight = (t: number) => {
  const d = new Date(t)
  return d.getHours() === 0 && d.getMinutes() === 0
}

/**
 * `series` with only its `keep` largest models named and the rest added up
 * as `OTHER`, and the models `OTHER` holds. A single model past `keep` keeps
 * its own name: an `OTHER` of one says less than the model.
 */
export const foldTail = (
  series: UsageSeries,
  keep = 3,
): { readonly series: UsageSeries; readonly others: ReadonlyArray<string> } => {
  if (series.keys.length <= keep + 1) return { series, others: [] }
  const named = series.keys.slice(0, keep)
  const others = series.keys.slice(keep)
  return {
    series: {
      ...series,
      keys: [...named, OTHER],
      buckets: series.buckets.map((bucket) => {
        const values: Record<string, number> = {}
        for (const key of named)
          if (bucket.values[key] !== undefined) values[key] = bucket.values[key]
        const rest = others.reduce((sum, key) => sum + (bucket.values[key] ?? 0), 0)
        if (rest > 0) values[OTHER] = rest
        return { t: bucket.t, values }
      }),
    },
    others,
  }
}

/** The total of each of `series`' buckets. */
export const bucketTotals = (series: UsageSeries): ReadonlyArray<number> =>
  series.buckets.map((bucket) =>
    series.keys.reduce((sum, key) => sum + (bucket.values[key] ?? 0), 0),
  )

/** One stacked segment: a bucket's value for one model. */
interface Segment {
  /** The bucket's index. */
  readonly i: number
  readonly t: number
  readonly key: string
  readonly value: number
}

/** A colour faded toward the card, for the columns not being read. */
const dim = (color: string) => `color-mix(in oklab, ${color} 32%, var(--card))`

/**
 * Tokens or equivalent cost per bucket, stacked by model. Hovering a column,
 * or stepping through them with the arrow keys, shows its tooltip.
 */
export function StackedColumns(props: { series: UsageSeries; height?: number; label: string }) {
  const { series } = props
  const text = metricText[series.metric]
  const height = props.height ?? 260
  const [ref, width] = useWidth<HTMLDivElement>(640)
  const [hover, setHover] = useState<number | undefined>()
  // Each column's centre on screen, as the chart last laid it out.
  const [centres, setCentres] = useState<ReadonlyMap<number, number>>(new Map())
  const n = series.buckets.length
  const totals = bucketTotals(series)

  const definition = useMemo(() => {
    const segments: Array<Segment> = series.buckets.flatMap((bucket, i) => {
      const present = series.keys.filter((key) => (bucket.values[key] ?? 0) > 0)
      // An empty bucket still takes its place on the axis.
      return present.length === 0
        ? [{ i, t: bucket.t, key: series.keys[0] ?? OTHER, value: 0 }]
        : present.map((key) => ({ i, t: bucket.t, key, value: bucket.values[key] ?? 0 }))
    })
    const dayBuckets = series.bucketMs >= DAY_MS
    // Sub-day buckets over several days label only their midnights.
    const midnightsOnly = !dayBuckets && series.buckets.length * series.bucketMs > 2 * DAY_MS
    const candidates = series.buckets
      .map((bucket) => bucket.t)
      .filter((t) => (midnightsOnly ? isMidnight(t) : dayBuckets || new Date(t).getMinutes() === 0))
    return defineChart({
      marks: [
        barY(segments, {
          x: "t",
          y: "value",
          z: "key",
          fill: (segment) =>
            hover === undefined || hover === segment.i
              ? seriesColor(segment.key)
              : dim(seriesColor(segment.key)),
          // Stack in the series' own order, so the tooltip, which lists the
          // keys top to bottom, always matches the segments.
          layout: stack({ order: series.keys }),
          // A 2px gap of card between stacked segments; dropped when columns
          // are too thin to keep a visible fill under it (a long range on a
          // narrow screen).
          stroke: "var(--card)",
          strokeWidth: (width * (1 - BAND_PADDING)) / Math.max(1, n) >= 4 ? 1 : 0,
          maxThickness: 24,
          // The theme's small radius on each column's top, not between segments.
          radius: { end: 3, stack: "outer" },
        }),
        ruleY([0], { stroke: "currentColor", strokeOpacity: 0.35 }),
      ],
      scales: {
        x: {
          scale: () => scaleBand<number>().padding(BAND_PADDING),
          axis: {
            line: false,
            ticks: { values: candidates, size: 0, format: (t: number) => xLabel(t, dayBuckets) },
            tickLabels: { thin: { minGap: 24 } },
          },
        },
        y: {
          scale: scaleLinear,
          nice: 4,
          grid: { stroke: "currentColor", strokeOpacity: 0.12 },
          axis: {
            line: false,
            ticks: { count: 4, size: 0, format: (v: number) => text.axis(v) },
          },
        },
      },
      focus: "group-x",
      focusRing: false,
      keyboard: false,
    })
  }, [series, hover, text, width, n])

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, (h: number | undefined) => number> = {
      ArrowRight: (h) => Math.min(n - 1, (h ?? n - 2) + 1),
      ArrowLeft: (h) => Math.max(0, (h ?? n) - 1),
      Home: () => 0,
      End: () => n - 1,
    }
    const step = keys[event.key]
    if (step === undefined || n === 0) return
    event.preventDefault()
    setHover(step)
  }

  const hovered = hover === undefined ? undefined : series.buckets[hover]
  const rows =
    hovered === undefined
      ? []
      : series.keys.filter((key) => (hovered.values[key] ?? 0) > 0).toReversed()
  const tipX =
    hover === undefined ? 0 : (centres.get(hover) ?? ((hover + 0.5) / Math.max(1, n)) * width)
  return (
    // A chart the arrow keys step through: a focusable group of columns.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={ref}
      className={cn(
        "relative w-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        CHART_INK,
      )}
      style={{ height }}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- no element is a group of chart columns
      role="group"
      aria-label={`${props.label}. Use the arrow keys to read each column.`}
      onKeyDown={onKey}
      onBlur={() => setHover(undefined)}
    >
      <div aria-hidden="true">
        <Chart
          definition={definition}
          height={height}
          initialWidth={width}
          tabIndex={-1}
          ariaLabel={props.label}
          onFocusChange={(point) => setHover(point === null ? undefined : point.datum.i)}
          onRender={(context) => {
            const next = new Map<number, number>()
            for (const point of context.scene.points) {
              const datum = point.datum
              if (typeof datum === "object" && datum !== null && "i" in datum) {
                const i = datum.i
                if (typeof i === "number") next.set(i, point.x)
              }
            }
            setCentres((last) => (sameCentres(last, next) ? last : next))
          }}
        />
      </div>
      {hovered !== undefined && hover !== undefined && (
        <ChartTip x={tipX} width={width} top={8}>
          <b className="text-sm font-semibold tabular-nums">{text.total(totals[hover] ?? 0)}</b>
          <span className="text-muted-foreground">{bucketText(hovered.t, series.bucketMs)}</span>
          {rows.map((key) => (
            <TipRow
              key={key}
              color={seriesColor(key)}
              value={text.value(hovered.values[key] ?? 0)}
              name={key}
            />
          ))}
        </ChartTip>
      )}
      <span className="sr-only" aria-live="polite">
        {hovered === undefined || hover === undefined
          ? ""
          : `${bucketText(hovered.t, series.bucketMs)}: ${text.total(totals[hover] ?? 0)}${rows
              .map((key) => `, ${key} ${text.value(hovered.values[key] ?? 0)}`)
              .join("")}`}
      </span>
    </div>
  )
}

/** The share of each column's slot left empty around it. */
const BAND_PADDING = 0.22

/** Whether two layouts put every column in the same place. */
const sameCentres = (a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>) =>
  a.size === b.size && [...a].every(([i, x]) => b.get(i) === x)

/** A column's axis label: its day for day buckets and midnights, its hour otherwise. */
const xLabel = (t: number, dayBuckets: boolean) =>
  dayBuckets || isMidnight(t) ? dayText(t) : hourText(t)

/**
 * One column per day, as the account sheet shows its last 7 days: the
 * weekday under each, and the day's value on hover. The whole chart is one
 * image named by `label`, which lists every day's value.
 */
export function DayBars(props: {
  days: ReadonlyArray<readonly [number, number]>
  label: string
  format: (value: number) => string
  height?: number
}) {
  const height = props.height ?? 112
  const [ref, width] = useWidth<HTMLDivElement>(380)
  const [hover, setHover] = useState<number | undefined>()
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(
            props.days.map(([t, value], i) => ({ i, t, value })),
            {
              x: "t",
              y: "value",
              fill: (day) =>
                hover === undefined || hover === day.i ? "var(--chart-1)" : dim("var(--chart-1)"),
              maxThickness: 24,
              radius: { end: 3 },
            },
          ),
          ruleY([0], { stroke: "currentColor", strokeOpacity: 0.35 }),
        ],
        scales: {
          x: {
            scale: () => scaleBand<number>().padding(0.3),
            axis: { line: false, ticks: { size: 0, format: (t: number) => weekdayText(t) } },
          },
          y: { scale: scaleLinear, axis: false },
        },
        focus: "group-x",
        focusRing: false,
        keyboard: false,
      }),
    [props.days, hover],
  )
  const hovered = hover === undefined ? undefined : props.days[hover]
  const n = Math.max(1, props.days.length)
  return (
    <div
      ref={ref}
      className={cn("relative w-full", CHART_INK)}
      style={{ height }}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a drawn chart is one image; <img> cannot hold it
      role="img"
      aria-label={props.label}
      onPointerLeave={() => setHover(undefined)}
    >
      <div aria-hidden="true">
        <Chart
          definition={definition}
          height={height}
          initialWidth={width}
          tabIndex={-1}
          ariaLabel={props.label}
          onFocusChange={(point) => setHover(point === null ? undefined : point.datum.i)}
        />
      </div>
      {hovered !== undefined && hover !== undefined && (
        <ChartTip x={((hover + 0.5) / n) * width} width={width} top={-6}>
          <b className="font-semibold tabular-nums">{props.format(hovered[1])}</b>
          <span className="text-muted-foreground">{dayText(hovered[0])}</span>
        </ChartTip>
      )}
    </div>
  )
}

// --------------------------------------------------------------------- bars

/** A thin bar split into parts, 2px apart. */
export function SegBar(props: {
  parts: ReadonlyArray<{ readonly key: string; readonly value: number; readonly color: string }>
  label: string
  height?: number
}) {
  const total = props.parts.reduce((sum, part) => sum + part.value, 0)
  return (
    <div
      className="flex w-full gap-0.5 overflow-hidden rounded-full bg-foreground/10"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a drawn chart is one image; <img> cannot hold it
      role="img"
      aria-label={props.label}
      style={{ height: props.height ?? 8 }}
    >
      {props.parts
        .filter((part) => part.value > 0)
        .map((part) => (
          <span
            key={part.key}
            className="h-full min-w-0.5"
            title={`${part.key}: ${compact(part.value)} (${pct(total === 0 ? 0 : part.value / total)})`}
            style={{ flexGrow: part.value, background: part.color }}
          />
        ))}
    </div>
  )
}

/** A share of a whole, as a short track with a fill. */
export function ShareBar(props: { fraction: number }) {
  return (
    <span
      className="inline-block h-1.5 w-20 overflow-hidden rounded-full bg-foreground/10 align-middle"
      aria-hidden="true"
    >
      <span
        className="block h-full rounded-full bg-foreground/60"
        style={{ width: `${Math.max(props.fraction > 0 ? 1.5 : 0, props.fraction * 100)}%` }}
      />
    </span>
  )
}

/**
 * A legend: a swatch that mirrors the mark, then the model's name; `OTHER`
 * says how many models it holds, and names them on hover.
 */
export function Legend(props: {
  keys: ReadonlyArray<string>
  label: string
  others?: ReadonlyArray<string>
}) {
  const others = props.others ?? []
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" aria-label={props.label}>
      {props.keys.map((key) =>
        key === OTHER && others.length > 0 ? (
          <li key={key} className="flex items-center gap-2" title={others.join(", ")}>
            <i
              className="size-3 shrink-0"
              style={{ background: seriesColor(key) }}
              aria-hidden="true"
            />
            {key}
            <span className="text-muted-foreground">{others.length} models</span>
          </li>
        ) : (
          <li key={key} className="flex items-center gap-2">
            <i
              className="size-3 shrink-0"
              style={{ background: seriesColor(key) }}
              aria-hidden="true"
            />
            {key}
          </li>
        ),
      )}
    </ul>
  )
}
