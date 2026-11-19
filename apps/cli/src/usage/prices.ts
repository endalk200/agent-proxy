import { priceTable } from "./price-table.ts"
import type { TokenCounts } from "./usage.ts"

/**
 * Equivalent cost (GLOSSARY.md): what usage would have cost at the
 * provider's API list prices, from a snapshot of models.dev committed in
 * `price-table.ts`. It is never stored, so fixing a price corrects history.
 */

/** Rates in USD per million tokens. A missing cache rate falls back to `input`. */
export interface Rates {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  /** The 5-minute cache's write rate. */
  readonly cacheWrite?: number
}

/**
 * A model's price: its base rates, and the long-context rates that replace
 * them for a whole request whose input (uncached, cache read and cache write)
 * is over `over` tokens.
 */
export interface Price extends Rates {
  readonly tiers?: ReadonlyArray<Rates & { readonly over: number }>
}

/** `model`'s price: by its id, or by its id without a date suffix such as `-20250929`. */
const priceOf = (model: string): Price | undefined =>
  priceTable[model] ?? priceTable[model.replace(/-\d{8}$/, "")]

/**
 * Every input size a long-context tier starts above, ascending. A request's
 * context band is how many of them its input is over, so requests in one
 * band are priced alike, and their tokens can be priced as one sum.
 */
export const contextSizes: ReadonlyArray<number> = [
  ...new Set(
    Object.values(priceTable).flatMap((price) => price.tiers?.map((tier) => tier.over) ?? []),
  ),
].toSorted((a, b) => a - b)

/** The rates for requests in context band `band`: the largest tier their input is over, or the base. */
const ratesFor = (price: Price, band: number): Rates => {
  let rates: Rates = price
  let over = -1
  for (const tier of price.tiers ?? []) {
    if (band > contextSizes.indexOf(tier.over) && tier.over > over) {
      rates = tier
      over = tier.over
    }
  }
  return rates
}

/** What a write to Claude's 1-hour cache costs, as a multiple of the input price. */
const HOUR_CACHE_WRITE = 2

/**
 * The equivalent cost of `tokens` spent on `model`, in USD, or none when
 * `model` is unpriced. `tokens` may sum many requests, all in context band `band`.
 */
export const costOf = (model: string, tokens: TokenCounts, band = 0): number | undefined => {
  const price = priceOf(model)
  if (price === undefined) return undefined
  const rates = ratesFor(price, band)
  return (
    (tokens.uncached * rates.input +
      tokens.cacheRead * (rates.cacheRead ?? rates.input) +
      (tokens.cacheWrite - tokens.cacheWrite1h) * (rates.cacheWrite ?? rates.input) +
      tokens.cacheWrite1h * rates.input * HOUR_CACHE_WRITE +
      tokens.output * rates.output) /
    1_000_000
  )
}
