/** Number and time formats for usage and limit windows. */

const full = new Intl.NumberFormat("en-US")

/** 1,284 below 10,000; then 12.9K, 412M, 1.24B. */
export const compact = (n: number): string => {
  const abs = Math.abs(n)
  if (abs < 10_000) return full.format(Math.round(n))
  const [div, suffix] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : ([1e3, "K"] as const)
  const v = n / div
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2
  return `${v.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")}${suffix}`
}

/** For an axis: 0, 20M, 40M, never more than one decimal. */
export const axisCompact = (n: number): string => {
  if (n === 0) return "0"
  const abs = Math.abs(n)
  const [div, suffix] =
    abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""]
  const v = n / div
  return `${Number.isInteger(v) ? v : v.toFixed(1)}${suffix}`
}

const usdSignificant = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 3,
  useGrouping: false,
})

/**
 * For a cost axis: $0, $0.0000001, $0.025, $0.10, $7.50, $250, $1.5K; cents
 * always in pairs, and never an exponent, so a tick above zero never reads $0.
 */
export const axisUsd = (n: number): string => {
  if (n >= 1000) return `$${axisCompact(n)}`
  if (Number.isInteger(n)) return `$${n}`
  const [whole, fraction = ""] = usdSignificant.format(n).split(".")
  return `$${whole}.${fraction.padEnd(2, "0")}`
}

export const count = (n: number): string => full.format(Math.round(n))

const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
})
const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** $12,840 from $10,000 up; $1,284.50 and $0.42 below; "<$0.01" for a sliver. */
export const usd = (n: number): string =>
  n >= 10_000 ? usd0.format(n) : n > 0 && n < 0.005 ? "<$0.01" : usd2.format(n)

/**
 * "$1.26", or "$40" for a whole amount, in `currency`, an ISO 4217 code;
 * "1.26 XYZ" for a code the browser does not know.
 */
export const money = (n: number, currency: string): string => {
  const whole = Number.isInteger(n)
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
    }).format(n)
  } catch {
    return `${whole ? n : n.toFixed(2)} ${currency}`
  }
}

/** "95.8%" with one digit, "96%" with none; "<0.1%" or "<1%" for a sliver. */
export const pct = (fraction: number, digits = 1): string => {
  const smallest = 10 ** -digits
  if (fraction > 0 && fraction * 100 < smallest / 2) return `<${smallest}%`
  return `${(fraction * 100).toFixed(digits)}%`
}

/** Formats in the viewer's locale and time zone, with plain spaces. */
const local = (options: Intl.DateTimeFormatOptions) => {
  const format = new Intl.DateTimeFormat(undefined, options)
  return (t: number) => format.format(t).replaceAll(" ", " ")
}

export const timeText = local({ hour: "numeric", minute: "2-digit" })
export const hourText = local({ hour: "numeric" })
export const dayText = local({ month: "short", day: "numeric" })
export const weekdayText = local({ weekday: "short" })

const DAY_MS = 86_400_000

/** A bucket for a tooltip: "Nov 18, 2:00 PM – 3:00 PM", or "Tue, Nov 18" for a day. */
export const bucketText = (t: number, bucketMs: number): string =>
  bucketMs >= DAY_MS
    ? `${weekdayText(t)}, ${dayText(t)}`
    : `${dayText(t)}, ${timeText(t)} – ${timeText(t + bucketMs)}`

/** "2h 14m", "3d 5h", "12m", "40s": how long until `at`. */
export const until = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "just now", "4 min", "3 hr 5 min", "7 hr": how long ago `at` was, without "ago". */
export const age = (at: number, now: number): string => {
  const seconds = Math.max(0, (now - at) / 1000)
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) return `${Math.floor(hours / 24)} days`
  const rest = minutes % 60
  return rest === 0 || hours >= 6 ? `${hours} hr` : `${hours} hr ${rest} min`
}

/** "just now", "4 min ago". */
export const ago = (at: number, now: number): string => {
  const text = age(at, now)
  return text === "just now" ? text : `${text} ago`
}

/** `YYYY-MM-DD` for the local calendar day `t` falls in. */
export const isoDay = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Local midnight of `YYYY-MM-DD`. */
export const parseIsoDay = (day: string): number => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime()
}
