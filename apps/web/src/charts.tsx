import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import type { SeriesMetric, UsageSeries } from "./daemon-api.ts"
import { axisCompact, axisUsd, bucketText, compact, dayText, hourText, pct, usd } from "./format.ts"

/**
 * The usage charts' marks, in plain SVG, following the dataviz skill's specs:
 * 2px lines, columns at most 24px wide with 4px rounded tops and a 2px
 * surface gap between stacked segments, a hairline grid, and a crosshair or
 * per-column tooltip.
 */

/**
 * Model families that keep a fixed categorical slot (1–6), in the palette's
 * order, so a model's colour never depends on its rank or on which other
 * models are in the range.
 */
const FAMILIES = ["opus", "sonnet", "haiku", "fable", "astra", "sol"]

/** The categorical slot, 1–8, of model `id`: its family's, or one of the last two by a hash of its id. */
export const modelSlot = (id: string): number => {
  const parts = id.toLowerCase().split(/[^a-z0-9]+/)
  const family = FAMILIES.findIndex((name) => parts.includes(name))
  if (family !== -1) return family + 1
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return FAMILIES.length + 1 + (hash % 2)
}

/** The series that holds every model past the few a chart names. */
export const OTHER = "Other"

/** The colour of model `id`, or the neutral grey of `OTHER`. */
export const seriesColor = (id: string) =>
  id === OTHER ? "var(--series-other)" : `var(--series-${modelSlot(id)})`

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
 * A ref and its element's content width. Before the element is laid out (and
 * where nothing lays it out, as in tests) the width is `fallback`.
 */
export function useWidth<E extends HTMLElement>(fallback = 480): [RefObject<E | null>, number] {
  const ref = useRef<E>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width > 0 ? width : fallback]
}

/** A tooltip inside a chart, kept within its box. */
export function ChartTip(props: { x: number; width: number; children: ReactNode; top?: number }) {
  const flip = props.x > props.width * 0.62
  return (
    <div
      className="ctip"
      role="tooltip"
      style={{
        top: props.top ?? 0,
        ...(flip ? { right: props.width - props.x + 12 } : { left: props.x + 12 }),
      }}
    >
      {props.children}
    </div>
  )
}

// ------------------------------------------------------------------ sparkline

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
  const height = props.height ?? 34
  const [ref, width] = useWidth<HTMLDivElement>(240)
  const [hover, setHover] = useState<number | undefined>()
  const { values } = props
  const present = values.filter((v): v is number => v !== null)
  const n = values.length
  if (n < 2 || present.length === 0) {
    return (
      <div ref={ref} className="spark" style={{ height }}>
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
  let lo = props.zero ? 0 : Math.min(...present)
  let hi = Math.max(...present)
  if (hi === lo) {
    hi += 1
    lo = Math.max(0, lo - 1)
  }
  const pad = 3
  const x = (i: number) => pad + (i / (n - 1)) * Math.max(1, width - pad * 2)
  const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2)
  let line = ""
  let started = false
  let lastIndex = -1
  values.forEach((v, i) => {
    if (v === null) {
      started = false
      return
    }
    line += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`
    lastIndex = i
    started = true
  })
  const first = values.findIndex((v) => v !== null)
  const area = props.zero
    ? `${line}L${x(lastIndex).toFixed(1)},${height}L${x(first).toFixed(1)},${height}Z`
    : ""
  const last = values[lastIndex]
  const shownValue = hover === undefined ? undefined : values[hover]

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const i = Math.round(
      ((event.clientX - box.left - pad) / Math.max(1, width - pad * 2)) * (n - 1),
    )
    setHover(Math.max(0, Math.min(n - 1, i)))
  }
  return (
    <div ref={ref} className="spark" style={{ height }}>
      <svg
        width={width}
        height={height}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a drawn chart is one image; <img> cannot hold it
        role="img"
        aria-label={props.label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
      >
        {area !== "" && <path d={area} className="spark-area" />}
        <path d={line} className="spark-line" />
        {hover !== undefined && (
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} className="spark-cross" />
        )}
        {hover !== undefined && shownValue !== null && shownValue !== undefined ? (
          <circle cx={x(hover)} cy={y(shownValue)} r={3.5} className="spark-dot" />
        ) : (
          last !== undefined &&
          last !== null && (
            <circle cx={x(lastIndex)} cy={y(last)} r={3.5} className="spark-dot is-now" />
          )
        )}
      </svg>
      {hover !== undefined && (
        <ChartTip x={x(hover)} width={width} top={-30}>
          <b>{shownValue === null || shownValue === undefined ? "—" : props.format(shownValue)}</b>
          <span>{bucketText(props.times[hover] ?? 0, props.bucketMs)}</span>
        </ChartTip>
      )}
    </div>
  )
}

// ------------------------------------------------------------ stacked columns

/** Round ticks from 0 to at least `max`: about four of them. */
const niceTicks = (max: number, target = 4): ReadonlyArray<number> => {
  if (max <= 0) return [0, 1]
  const raw = max / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks = []
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v)
  return ticks
}

/** A column with a 4px rounded top and a square base. */
const topRounded = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

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

/**
 * Tokens or equivalent cost per bucket, stacked by model. Hovering a column,
 * or stepping through them with the arrow keys, shows its tooltip.
 */
export function StackedColumns(props: { series: UsageSeries; height?: number; label: string }) {
  const { series } = props
  const text = metricText[series.metric]
  const plotH = props.height ?? 200
  const axisH = 22
  const left = 44
  const [ref, width] = useWidth<HTMLDivElement>(640)
  const [hover, setHover] = useState<number | undefined>()
  const n = series.buckets.length
  const totals = bucketTotals(series)
  // No floor of 1: a range's cost can be well under a dollar.
  const ticks = niceTicks(Math.max(0, ...totals))
  const top = ticks.at(-1) ?? 1
  const innerW = Math.max(1, width - left - 4)
  const slot = innerW / Math.max(1, n)
  const gap = slot >= 8 ? 2 : 1
  const barW = Math.max(1, Math.min(24, slot - gap))
  const y = (v: number) => 8 + (1 - v / top) * (plotH - 8)
  const dayBuckets = series.bucketMs >= DAY_MS
  // Sub-day buckets over several days label only their midnights.
  const midnightsOnly = !dayBuckets && n * series.bucketMs > 2 * DAY_MS
  const round = series.buckets.flatMap((bucket, i) => {
    const ok = midnightsOnly
      ? isMidnight(bucket.t)
      : dayBuckets || new Date(bucket.t).getMinutes() === 0
    return ok ? [i] : []
  })
  // About one label per 76px.
  const room = Math.max(2, Math.floor(innerW / 76))
  const every = Math.max(1, Math.ceil(round.length / room))
  const labelled = new Set(round.filter((_, k) => k % every === 0))
  const xLabel = (t: number) => (dayBuckets || isMidnight(t) ? dayText(t) : hourText(t))

  const pick = (event: PointerEvent<SVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const i = Math.floor((event.clientX - box.left - left) / slot)
    setHover(i >= 0 && i < n ? i : undefined)
  }
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
  return (
    // A chart the arrow keys step through: a focusable group of columns.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={ref}
      className="cols"
      style={{ height: plotH + axisH }}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- no element is a group of chart columns
      role="group"
      aria-label={`${props.label}. Use the arrow keys to read each column.`}
      onKeyDown={onKey}
      onBlur={() => setHover(undefined)}
    >
      <svg
        width={width}
        height={plotH + axisH}
        aria-hidden="true"
        onPointerMove={pick}
        onPointerLeave={() => setHover(undefined)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={width}
              y1={Math.round(y(tick)) + 0.5}
              y2={Math.round(y(tick)) + 0.5}
              className={tick === 0 ? "axis-base" : "axis-grid"}
            />
            <text x={left - 8} y={y(tick) + 3.5} className="axis-text" textAnchor="end">
              {text.axis(tick)}
            </text>
          </g>
        ))}
        {series.buckets.map((bucket, i) => {
          const x = left + i * slot + (slot - barW) / 2
          let base = y(0)
          const segments = series.keys.filter((key) => (bucket.values[key] ?? 0) > 0)
          return (
            <g key={bucket.t} className={hover !== undefined && hover !== i ? "col is-dim" : "col"}>
              {segments.map((key, k) => {
                const h = y(0) - y(bucket.values[key] ?? 0)
                const yTop = base - h
                base = yTop
                const isTop = k === segments.length - 1
                // A 2px surface gap between stacked segments.
                const drawH = Math.max(0, h - (isTop ? 0 : Math.min(2, h * 0.4)))
                if (drawH < 0.3) return null
                return isTop ? (
                  <path key={key} d={topRounded(x, yTop, barW, drawH)} fill={seriesColor(key)} />
                ) : (
                  <rect
                    key={key}
                    x={x}
                    y={yTop + (h - drawH)}
                    width={barW}
                    height={drawH}
                    fill={seriesColor(key)}
                  />
                )
              })}
            </g>
          )
        })}
        {series.buckets.map((bucket, i) =>
          labelled.has(i) ? (
            <text
              key={bucket.t}
              x={left + i * slot + slot / 2}
              y={plotH + 16}
              className="axis-text"
              textAnchor="middle"
            >
              {xLabel(bucket.t)}
            </text>
          ) : null,
        )}
      </svg>
      {hovered !== undefined && hover !== undefined && (
        <ChartTip x={left + hover * slot + slot / 2} width={width} top={8}>
          <b className="ctip-total">{text.total(totals[hover] ?? 0)}</b>
          <span className="ctip-when">{bucketText(hovered.t, series.bucketMs)}</span>
          {rows.map((key) => (
            <span key={key} className="ctip-row">
              <i style={{ background: seriesColor(key) }} />
              <b>{text.value(hovered.values[key] ?? 0)}</b>
              <span>{key}</span>
            </span>
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

// --------------------------------------------------------------------- bars

/** A thin bar split into parts, 2px apart, its ends rounded. */
export function SegBar(props: {
  parts: ReadonlyArray<{ readonly key: string; readonly value: number; readonly color: string }>
  label: string
  height?: number
}) {
  const total = props.parts.reduce((sum, part) => sum + part.value, 0)
  return (
    <div
      className="segbar"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a drawn chart is one image; <img> cannot hold it
      role="img"
      aria-label={props.label}
      style={{ height: props.height ?? 6 }}
    >
      {props.parts
        .filter((part) => part.value > 0)
        .map((part) => (
          <span
            key={part.key}
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
    <span className="sharebar" aria-hidden="true">
      <span style={{ width: `${Math.max(props.fraction > 0 ? 1.5 : 0, props.fraction * 100)}%` }} />
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
    <ul className="legend" aria-label={props.label}>
      {props.keys.map((key) =>
        key === OTHER && others.length > 0 ? (
          <li key={key} title={others.join(", ")}>
            <i style={{ background: seriesColor(key) }} aria-hidden="true" />
            {key}
            <span className="legend-count">{others.length} models</span>
          </li>
        ) : (
          <li key={key}>
            <i style={{ background: seriesColor(key) }} aria-hidden="true" />
            {key}
          </li>
        ),
      )}
    </ul>
  )
}
