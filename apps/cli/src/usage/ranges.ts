/**
 * The dashboard's ranges, resolved to whole buckets in the viewer's time
 * zone: a range ends with the bucket that holds now, so the KPIs and the
 * chart always cover the same requests.
 *
 * Bucket boundaries are computed on the viewer's wall clock and then turned
 * back into instants, so a day bucket is a calendar day even across a
 * daylight-saving change, and an hour bucket starts on the hour even in a
 * zone half an hour off UTC.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export type RangeKey = "6h" | "24h" | "7d" | "30d" | "90d" | "lifetime"

/** A range the owner picks; `custom` names calendar days, `YYYY-MM-DD`, both inclusive. */
export type UsageRange =
  | { readonly key: RangeKey }
  | { readonly key: "custom"; readonly from: string; readonly to: string }

/** A range resolved to instants. */
export interface ResolvedRange {
  /** The first bucket's start, epoch milliseconds. */
  readonly from: number
  /** The last bucket's end (exclusive), epoch milliseconds. */
  readonly to: number
  /** The bucket size on the viewer's clock; a day bucket can be 23 or 25 hours long. */
  readonly bucketMs: number
  /** Each bucket's start, oldest first. */
  readonly starts: ReadonlyArray<number>
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** True when `tz` is a time zone this runtime knows. */
export const isTimeZone = (tz: string) => {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

const formatter = (tz: string) => {
  let format = formatters.get(tz)
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    formatters.set(tz, format)
  }
  return format
}

/** The viewer's wall-clock time at instant `t`, as if their clock were UTC. */
const toWall = (t: number, tz: string) => {
  const parts: Record<string, number> = {}
  for (const part of formatter(tz).formatToParts(t)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  const wall = Date.UTC(
    parts["year"] ?? 1970,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  )
  return wall + (((t % 1000) + 1000) % 1000)
}

/**
 * The instant the viewer's clock shows `wall`. A wall time shown twice, as
 * clocks go back, is its first instant; one never shown, as clocks go
 * forward, is the instant the clocks skip past it.
 */
const fromWall = (wall: number, tz: string) => {
  // The zone's offsets half a day either side cover any change near `wall`.
  const candidates = [wall - DAY / 2, wall + DAY / 2].map(
    (probe) => wall - (toWall(probe, tz) - probe),
  )
  const shown = candidates.filter((t) => toWall(t, tz) === wall)
  return shown.length > 0 ? Math.min(...shown) : Math.max(...candidates)
}

const floorTo = (wall: number, size: number) => Math.floor(wall / size) * size

/** `YYYY-MM-DD` as a wall-clock midnight, if it names a real day. */
export const parseDay = (day: string): number | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match === null) return undefined
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return new Date(wall).toISOString().slice(0, 10) === day ? wall : undefined
}

/** The bucket size a custom range of `span` (wall-clock milliseconds) gets. */
const customBucket = (span: number) => (span <= 2 * DAY ? HOUR : span <= 10 * DAY ? 6 * HOUR : DAY)

/**
 * `range` in zone `tz` at `now`. Lifetime starts on the day of `firstAt`, the
 * first recorded request, or today when there is none. A custom range never
 * runs past the bucket that holds now.
 */
export const resolveRange = (
  range: UsageRange,
  now: number,
  tz: string,
  firstAt: number | undefined,
): ResolvedRange => {
  const wallNow = toWall(now, tz)
  const today = floorTo(wallNow, DAY)
  const plan = ((): { readonly from: number; readonly end: number; readonly size: number } => {
    switch (range.key) {
      case "6h": {
        const end = floorTo(wallNow, 15 * MINUTE) + 15 * MINUTE
        return { from: end - 24 * 15 * MINUTE, end, size: 15 * MINUTE }
      }
      case "24h": {
        const end = floorTo(wallNow, HOUR) + HOUR
        return { from: end - 24 * HOUR, end, size: HOUR }
      }
      case "7d":
        return { from: today - 6 * DAY, end: floorTo(wallNow, 3 * HOUR) + 3 * HOUR, size: 3 * HOUR }
      case "30d":
        return { from: today - 29 * DAY, end: today + DAY, size: DAY }
      case "90d":
        return { from: today - 89 * DAY, end: today + DAY, size: DAY }
      case "lifetime":
        return {
          from: Math.min(today, floorTo(toWall(firstAt ?? now, tz), DAY)),
          end: today + DAY,
          size: DAY,
        }
      case "custom": {
        const from = parseDay(range.from) ?? today
        const last = (parseDay(range.to) ?? today) + DAY
        const size = customBucket(last - from)
        const end = Math.max(from + size, Math.min(last, floorTo(wallNow, size) + size))
        return { from, end, size }
      }
    }
  })()
  // A range meant to reach now, whose last bucket a change of clocks makes
  // end before now, runs on, so it always holds the request just made.
  let end = plan.end
  if (plan.end > wallNow) while (fromWall(end, tz) <= now) end += plan.size
  const starts: Array<number> = []
  for (let wall = plan.from; wall < end; wall += plan.size) {
    const start = fromWall(wall, tz)
    // A daylight-saving gap can map two wall times to one instant.
    if (starts.length === 0 || start > (starts.at(-1) ?? 0)) starts.push(start)
  }
  return {
    from: starts[0] ?? fromWall(plan.from, tz),
    to: fromWall(end, tz),
    bucketMs: plan.size,
    starts,
  }
}

/** The index of the bucket in `starts` that holds `t`, or -1 when none does. */
export const bucketIndex = (starts: ReadonlyArray<number>, to: number, t: number) => {
  if (starts.length === 0 || t < (starts[0] ?? 0) || t >= to) return -1
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if ((starts[mid] ?? 0) <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}
