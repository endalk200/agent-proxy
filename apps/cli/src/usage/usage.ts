import type { Provider } from "../accounts/account.ts"

/**
 * Usage and limit windows in the daemon's own words (GLOSSARY.md, *Usage*):
 * what one proxied request spent, and what a provider says about an
 * account's limit windows.
 */

/**
 * A request's tokens, as the four disjoint token kinds, plus two parts of
 * them that are never added to a total: `cacheWrite1h`, the part of
 * `cacheWrite` written to Claude's 1-hour cache, which costs more than the
 * 5-minute cache, and `reasoning`, the part of `output` spent thinking.
 */
export interface TokenCounts {
  readonly uncached: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cacheWrite1h: number
  readonly output: number
  readonly reasoning: number
}

export const noTokens: TokenCounts = {
  uncached: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  output: 0,
  reasoning: 0,
}

/** Every token a request spent: the four token kinds. */
export const totalTokens = (tokens: TokenCounts) =>
  tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output

/**
 * How a proxied request ended:
 *
 * - `success`: the provider answered, and the answer reached its final usage event.
 * - `failed`: the provider answered with an error other than a limit, or could not be reached.
 * - `limited`: the answer was a limit, the provider's or the proxy's own (every account cooling down).
 * - `incomplete`: a 2xx answer that ended before its final usage event, such as when the client went away.
 */
export type UsageStatus = "success" | "failed" | "limited" | "incomplete"

/** The client a request came from, as its `User-Agent` and headers say. */
export type ClientName = "claude-code" | "codex" | "opencode" | "other"

/** One proxied generation request, as the usage store keeps it. */
export interface UsageRow {
  /** When the response ended, epoch milliseconds. */
  readonly at: number
  readonly provider: Provider
  /** The account that finally answered. */
  readonly accountId: string
  /** The `model` the client asked for, or `unknown`. */
  readonly model: string
  readonly client: ClientName
  readonly session: string | undefined
  readonly status: UsageStatus
  /** From the request arriving to its response ending. */
  readonly latencyMs: number
  readonly tokens: TokenCounts
}

/** What a provider's answer or usage endpoint says about one limit window. */
export interface ObservedWindow {
  /**
   * `five-hour`, `weekly`, `monthly`, or `weekly:<model>` for a per-model
   * weekly window, such as `weekly:Fable`.
   */
  readonly id: string
  /** The share of the window used, 0 to 1. */
  readonly usedShare: number
  /** When the window resets, epoch milliseconds. */
  readonly resetsAt: number
}

/** Where the daemon learned a limit window. */
export type WindowSource = "header" | "endpoint"

/** A limit window as the daemon last knew it. */
export interface KnownWindow extends ObservedWindow {
  /** When the provider said it, epoch milliseconds. */
  readonly asOf: number
  readonly source: WindowSource
}

const BASE_WINDOWS: Readonly<Record<string, { readonly order: number; readonly label: string }>> = {
  "five-hour": { order: 0, label: "5-hour" },
  weekly: { order: 1, label: "Weekly" },
  monthly: { order: 3, label: "Monthly" },
}

/** The owner's name for window `id`: "5-hour", "Weekly", "Fable weekly", "Monthly". */
export const windowLabel = (id: string) =>
  BASE_WINDOWS[id]?.label ??
  (id.startsWith("weekly:") ? `${id.slice("weekly:".length)} weekly` : id)

/** Orders windows as the dashboard's columns go: 5-hour, Weekly, per-model weeklies, Monthly. */
export const compareWindows = (a: { readonly id: string }, b: { readonly id: string }) =>
  (BASE_WINDOWS[a.id]?.order ?? 2) - (BASE_WINDOWS[b.id]?.order ?? 2) ||
  windowLabel(a.id).localeCompare(windowLabel(b.id))

/**
 * What a provider says about one of an account's limit resets (GLOSSARY.md,
 * *Limit reset*): a single-use grant the owner redeems to refill some of
 * the account's limit windows early.
 */
export interface ObservedReset {
  /** The provider's id for it, which a redeem names. */
  readonly id: string
  /** The provider's name for it, such as "Full reset". */
  readonly name: string
  /** The ids of the windows it refills, such as `five-hour` and `weekly`. */
  readonly refills: ReadonlyArray<string>
  /** When the provider granted it, epoch milliseconds; none when the provider does not say. */
  readonly grantedAt: number | undefined
  /** When it expires unredeemed, epoch milliseconds; none when the provider gives no end. */
  readonly expiresAt: number | undefined
  /** False when the provider says it cannot be redeemed right now. */
  readonly usableNow: boolean
  /** Why it cannot be redeemed right now, in the provider's words. */
  readonly unavailableReason: string | undefined
}

/** What one read says about an account's limit resets. */
export interface ResetsRead {
  readonly resets: ReadonlyArray<ObservedReset>
  /** True when the provider offers the account an instant reset to buy (Codex only). */
  readonly canBuy: boolean
}

/** An account's limit resets as the daemon last knew them. */
export interface KnownResets extends ResetsRead {
  /** When the provider said it, epoch milliseconds. */
  readonly asOf: number
}
