/**
 * The daemon API as the dashboard reads it: the JSON shapes it relies on and
 * one function per route. The dashboard is served by the daemon, so every
 * path is relative to the page's own origin.
 *
 * Answers are checked by hand rather than with Effect Schema, which would
 * double the size of the page for a few small shapes.
 */

export type Provider = "claude" | "codex"

/**
 * Where an account stands with its pool (see GLOSSARY.md). `unknown` stands
 * for a status a newer daemon reports that this dashboard does not know.
 */
export type AccountStatus = "active" | "cooling-down" | "needs-sign-in" | "disabled" | "unknown"

export interface Account {
  readonly id: string
  readonly provider: Provider
  readonly label: string
  readonly email: string
  readonly plan: string
  /** The account's place in its pool: 1 gets new sessions first. */
  readonly priority: number
  readonly enabled: boolean
  readonly status: AccountStatus
  /** When a `cooling-down` account's cooldown ends, as an ISO 8601 timestamp. */
  readonly cooldownEndsAt: string | null
  readonly addedAt: string
  readonly lastUsedAt: string | null
}

/** The settings the owner changes on an account; each one left out stays as it is. */
export interface AccountSettings {
  readonly label?: string
  /**
   * A priority in the account's pool, 1 first, which it then holds alone: the
   * accounts from that priority down move down one.
   */
  readonly priority?: number
  /** Another account in the pool, by id, whose priority it then shares; not with `priority`. */
  readonly sharePriorityWith?: string
  readonly enabled?: boolean
}

export interface Pool {
  readonly provider: Provider
  /** The account a new session goes to now, or null when none in the pool is Active. */
  readonly newSessionsAccountId: string | null
  /**
   * Every Active account, in the order new sessions go to them now: by
   * priority, then the most room left in their limits. The first is
   * `newSessionsAccountId`.
   */
  readonly newSessionsOrder: ReadonlyArray<string>
}

/** `GET /api/accounts`: every account, and a pool for each provider that has one. */
export interface AccountList {
  readonly accounts: ReadonlyArray<Account>
  readonly pools: ReadonlyArray<Pool>
}

/** `GET /api/daemon`. */
export interface DaemonInfo {
  readonly address: string
  readonly version: string
  /** The build it runs, `abc1234`, `abc1234-dirty` or `source`; missing from a daemon older than builds. */
  readonly build: string | undefined
  readonly startedAt: string
}

/**
 * Where a login stands: waiting for the owner to sign in (`pending`), or
 * finished, whether it added or updated an account (`succeeded`) or not.
 */
export type LoginStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired"

/** A login the daemon runs to add an account or sign in to one again (ADR-0007). */
export interface Login {
  readonly id: string
  readonly provider: Provider
  /** The provider's sign-in page, to open in a browser. */
  readonly authorizeUrl: string
  readonly status: LoginStatus
  /** Why a `failed` login failed. */
  readonly error?: string
  /** The account a `succeeded` login added or updated. */
  readonly account?: Account
  /** True when a `succeeded` login added a new account, false when it updated one. */
  readonly created?: boolean
}

/** Why a call to the daemon failed. */
export type DaemonFailure =
  /** Nothing answered: the daemon is stopped, or the network is down. */
  | { readonly kind: "unreachable" }
  /**
   * The daemon answered with an error (`status` is its HTTP status), or with
   * something the dashboard cannot read.
   */
  | { readonly kind: "error"; readonly message: string; readonly status?: number }

export class DaemonCallError extends Error {
  constructor(readonly failure: DaemonFailure) {
    super(failure.kind === "unreachable" ? "The daemon is unreachable." : failure.message)
  }
}

/**
 * A change to one account, from `GET /api/events`, with every pool as it is
 * after it. `status-changed` and `settings-changed` carry the account as it
 * was before in `previous`; `used` says only when it last served a request.
 */
export type AccountEvent =
  | {
      readonly type: "added" | "removed" | "used"
      readonly account: Account
      readonly pools: ReadonlyArray<Pool>
    }
  | {
      readonly type: "status-changed" | "settings-changed"
      readonly account: Account
      readonly previous: Account
      readonly pools: ReadonlyArray<Pool>
    }

/**
 * The pools changed and no account did, from `GET /api/events`: accounts
 * sharing a priority traded places in the order new sessions go in.
 */
export interface PoolsChanged {
  readonly type: "pools-changed"
  readonly pools: ReadonlyArray<Pool>
}

/** A message on the daemon's event stream: the accounts as they are when it opens, then each change. */
export type StreamMessage =
  | { readonly type: "snapshot"; readonly list: AccountList }
  | AccountEvent
  | PoolsChanged
  | UsageEvent

// --------------------------------------------------------------------- usage

/**
 * The four disjoint token kinds, plus two parts of them not added to totals:
 * the cache write to Claude's 1-hour cache, and reasoning, part of output.
 */
export interface TokenCounts {
  readonly uncached: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** The part of `cacheWrite` written to the 1-hour cache. */
  readonly cacheWrite1h: number
  readonly output: number
  readonly reasoning: number
}

/** Every token a request spent: the four token kinds, reasoning being part of output. */
export const totalTokens = (tokens: TokenCounts): number =>
  tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output

export interface RequestCounts {
  readonly total: number
  readonly success: number
  readonly failed: number
  readonly limited: number
  readonly incomplete: number
}

export type UsageStatus = "success" | "failed" | "limited" | "incomplete"
export type ClientName = "claude-code" | "codex" | "opencode" | "other"

/** A range the owner picks; `custom` carries calendar days, `YYYY-MM-DD`, both inclusive. */
export type UsageRange =
  | { readonly key: "6h" | "24h" | "7d" | "30d" | "90d" | "lifetime" }
  | { readonly key: "custom"; readonly from: string; readonly to: string }

export type RangeKey = UsageRange["key"]

/** What every `/api/usage/*` route answers about. */
export interface UsageQuery {
  readonly range: UsageRange
  /** The viewer's IANA time zone: calendar days and day buckets follow it. */
  readonly tz: string
  /** Narrows every number to one account. */
  readonly accountId?: string
}

/** One point of the KPI sparklines: a whole number of chart buckets. */
export interface SparkPoint {
  readonly t: number
  readonly requests: number
  readonly tokens: number
  readonly cacheHitRate: number | null
  readonly costUsd: number
}

/** `GET /api/usage/summary`. */
export interface UsageSummary {
  /** The range resolved to whole buckets, epoch ms; `to` is the end of the current bucket. */
  readonly from: number
  readonly to: number
  readonly requests: RequestCounts
  readonly tokens: TokenCounts
  /** cache read ÷ all input; null with no input. */
  readonly cacheHitRate: number | null
  /** Equivalent cost of the priced models, at API list prices. */
  readonly costUsd: number
  readonly unpricedModels: ReadonlyArray<string>
  readonly spark: ReadonlyArray<SparkPoint>
}

/** What a series measures: total tokens, or equivalent cost in USD. */
export type SeriesMetric = "tokens" | "cost"

/** `GET /api/usage/series?by=model&metric=…`: tokens or equivalent cost per bucket, split by model. */
export interface UsageSeries {
  readonly from: number
  readonly to: number
  /** Nominal; a day bucket follows calendar days, so read each bucket's `t`. */
  readonly bucketMs: number
  readonly metric: SeriesMetric
  /** Models with some of `metric` in the range, the most first; an unpriced model has no cost. */
  readonly keys: ReadonlyArray<string>
  readonly buckets: ReadonlyArray<{
    readonly t: number
    readonly values: Readonly<Record<string, number>>
  }>
}

export type BreakdownBy = "model" | "account"

/** A breakdown row's account, as the daemon last knew it. */
export interface BreakdownAccount {
  readonly provider: Provider
  readonly label: string
  readonly email: string
  readonly plan: string
  /** When it was removed, epoch milliseconds; null while it is held. */
  readonly removedAt: number | null
}

export interface BreakdownRow {
  /** A model id, or an account id, possibly a removed account's. */
  readonly key: string
  readonly requests: RequestCounts
  readonly tokens: TokenCounts
  readonly totalTokens: number
  /** Null when wholly unpriced. */
  readonly costUsd: number | null
  readonly partlyUnpriced: boolean
  /** Share of all tokens in the range, 0–1. */
  readonly share: number
  /** A `by=account` row's account; null when the daemon never knew its name, and for a `by=model` row. */
  readonly account: BreakdownAccount | null
}

/** `GET /api/usage/breakdown`. */
export interface UsageBreakdown {
  readonly from: number
  readonly to: number
  readonly by: BreakdownBy
  /** Most tokens first. */
  readonly rows: ReadonlyArray<BreakdownRow>
}

/** One limit window of an account, as its provider last reported it. */
export interface LimitWindow {
  /** `five-hour`, `weekly`, `monthly`, or `weekly:<Model>` for a per-model weekly window. */
  readonly id: string
  readonly label: string
  /** Share used, 0–100. */
  readonly usedPct: number
  readonly resetsAt: number
  readonly asOf: number
}

/**
 * A limit reset an account holds: a single-use refill of some of its limit
 * windows, which the owner redeems (see GLOSSARY.md).
 */
export interface LimitReset {
  /** The provider's id for it. */
  readonly id: string
  /** The provider's name for it, such as "Full reset". */
  readonly name: string
  /** The limit windows it refills. */
  readonly refills: ReadonlyArray<{ readonly id: string; readonly label: string }>
  /** When the provider granted it, epoch milliseconds; null when the provider does not say. */
  readonly grantedAt: number | null
  /** When it expires unredeemed, epoch milliseconds; null when it does not. */
  readonly expiresAt: number | null
  /** False while the provider won't let it be redeemed, saying why in `unavailableReason`. */
  readonly usableNow: boolean
  readonly unavailableReason: string | null
  readonly asOf: number
}

/** `GET /api/limits`: one per account the daemon holds. */
export interface AccountLimits {
  readonly accountId: string
  /** The newest window's `asOf`; null when never observed. */
  readonly asOf: number | null
  readonly windows: ReadonlyArray<LimitWindow>
  /** Its limit resets, soonest expiry first. */
  readonly limitResets: ReadonlyArray<LimitReset>
  /** True when its provider offers it an instant reset to buy (Codex only). */
  readonly canBuyReset: boolean
}

/** Why a provider refused a redeem; nothing was spent. */
export type RedeemRefusal =
  | "nothing-to-refill"
  | "already-redeemed"
  | "cooldown"
  | "ineligible"
  | "unavailable"
  | "rejected"

/**
 * `POST /api/accounts/:id/limit-resets/:resetId/redeem`: how the redeem went,
 * in the daemon's plain words, and the account's limits read again after it.
 */
export type RedeemResult =
  | {
      readonly outcome: "redeemed" | "unknown"
      readonly message: string
      readonly limits: AccountLimits
    }
  | {
      readonly outcome: "refused"
      readonly reason: RedeemRefusal
      readonly message: string
      readonly limits: AccountLimits
    }

/** A request the proxy finished, as `usage-recorded` reports it. */
export interface UsageRecord {
  readonly at: number
  readonly provider: Provider
  readonly accountId: string
  readonly model: string
  readonly client: ClientName
  readonly status: UsageStatus
  readonly tokens: TokenCounts
}

export type UsageEvent =
  | { readonly type: "usage-recorded"; readonly usage: UsageRecord }
  | { readonly type: "limits-changed"; readonly limits: AccountLimits }

/** What the dashboard does as its event stream opens, carries a message, or fails. */
export interface StreamHandlers {
  readonly message: (message: StreamMessage) => void
  /**
   * The stream failed. `closed` is true when it will not reconnect by
   * itself, as when the daemon refused it; otherwise it is reconnecting.
   */
  readonly error: (closed: boolean) => void
}

/** Opens an event stream at `url` that reports its raw `data`; the browser's EventSource by default. */
export type OpenEventStream = (
  url: string,
  handlers: {
    readonly data: (data: string) => void
    readonly error: (closed: boolean) => void
  },
) => { readonly close: () => void }

export interface DaemonClient {
  readonly accounts: (signal?: AbortSignal) => Promise<AccountList>
  /**
   * `GET /api/events`: subscribes to account changes until the returned
   * function is called. A message this dashboard cannot read is skipped.
   */
  readonly events: (handlers: StreamHandlers) => () => void
  readonly daemon: (signal?: AbortSignal) => Promise<DaemonInfo>
  readonly key: () => Promise<string>
  /** `PATCH /api/accounts/:id`. */
  readonly updateAccount: (id: string, settings: AccountSettings) => Promise<Account>
  /** `DELETE /api/accounts/:id`. */
  readonly removeAccount: (id: string) => Promise<Account>
  /** `POST /api/logins`: starts a login, listening for the provider's redirect. */
  readonly startLogin: (provider: Provider) => Promise<Login>
  /** `GET /api/logins/:id`. */
  readonly login: (id: string, signal?: AbortSignal) => Promise<Login>
  /** `POST /api/logins/:id/callback`: finishes a login with a pasted callback URL. */
  readonly submitCallback: (id: string, url: string) => Promise<Login>
  /** `DELETE /api/logins/:id`: cancels a waiting login. */
  readonly cancelLogin: (id: string) => Promise<Login>
  /** `GET /api/usage/summary`. */
  readonly usageSummary: (query: UsageQuery) => Promise<UsageSummary>
  /** `GET /api/usage/series?by=model&metric=…`, tokens when `metric` is left out. */
  readonly usageSeries: (query: UsageQuery, metric?: SeriesMetric) => Promise<UsageSeries>
  /** `GET /api/usage/breakdown?by=…`. */
  readonly usageBreakdown: (query: UsageQuery, by: BreakdownBy) => Promise<UsageBreakdown>
  /** `GET /api/limits`. */
  readonly limits: () => Promise<ReadonlyArray<AccountLimits>>
  /** `POST /api/limits/refresh`: reads fresh limit windows for one account, or all; answers every account's. */
  readonly refreshLimits: (accountId?: string) => Promise<ReadonlyArray<AccountLimits>>
  /** `POST /api/accounts/:id/limit-resets/:resetId/redeem`: redeems one of the account's limit resets. */
  readonly redeemReset: (accountId: string, resetId: string) => Promise<RedeemResult>
}

// ------------------------------------------------------------------ decoding

class Unreadable extends Error {}

type Json = Readonly<Record<string, unknown>>

const object = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Unreadable()
  return Object.fromEntries(Object.entries(value))
}
const array = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Unreadable()
  return value
}
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Unreadable()
  return value
}
const nullableString = (value: unknown): string | null => (value === null ? null : string(value))
const oneOf = <A extends string>(options: ReadonlyArray<A>, value: unknown): A => {
  const found = options.find((option) => option === value)
  if (found === undefined) throw new Unreadable()
  return found
}
const PROVIDERS: ReadonlyArray<Provider> = ["claude", "codex"]
const STATUSES: ReadonlyArray<AccountStatus> = [
  "active",
  "cooling-down",
  "needs-sign-in",
  "disabled",
]
const LOGIN_STATUSES: ReadonlyArray<LoginStatus> = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]

const decodeAccount = (value: unknown): Account => {
  const json = object(value)
  if (typeof json["priority"] !== "number" || typeof json["enabled"] !== "boolean") {
    throw new Unreadable()
  }
  return {
    id: string(json["id"]),
    provider: oneOf(PROVIDERS, json["provider"]),
    label: string(json["label"]),
    email: string(json["email"]),
    plan: string(json["plan"]),
    priority: json["priority"],
    enabled: json["enabled"],
    // One account in a status this dashboard does not know leaves the rest readable.
    status: STATUSES.find((status) => status === json["status"]) ?? "unknown",
    // A daemon from before cooldowns does not send it.
    cooldownEndsAt:
      json["cooldownEndsAt"] === undefined ? null : nullableString(json["cooldownEndsAt"]),
    addedAt: string(json["addedAt"]),
    lastUsedAt: nullableString(json["lastUsedAt"]),
  }
}

const decodePools = (value: unknown): ReadonlyArray<Pool> =>
  array(value).map((pool) => {
    const fields = object(pool)
    const newSessionsAccountId = nullableString(fields["newSessionsAccountId"])
    return {
      provider: oneOf(PROVIDERS, fields["provider"]),
      newSessionsAccountId,
      // A daemon from before shared priorities names only the first.
      newSessionsOrder:
        fields["newSessionsOrder"] === undefined
          ? newSessionsAccountId === null
            ? []
            : [newSessionsAccountId]
          : array(fields["newSessionsOrder"]).map(string),
    }
  })

const decodeAccountList = (value: unknown): AccountList => {
  const json = object(value)
  return { accounts: array(json["accounts"]).map(decodeAccount), pools: decodePools(json["pools"]) }
}

const number = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Unreadable()
  return value
}
const nullableNumber = (value: unknown): number | null => (value === null ? null : number(value))
const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Unreadable()
  return value
}
const USAGE_STATUSES: ReadonlyArray<UsageStatus> = ["success", "failed", "limited", "incomplete"]
const CLIENT_NAMES: ReadonlyArray<ClientName> = ["claude-code", "codex", "opencode", "other"]

const decodeTokens = (value: unknown): TokenCounts => {
  const json = object(value)
  return {
    uncached: number(json["uncached"]),
    cacheRead: number(json["cacheRead"]),
    cacheWrite: number(json["cacheWrite"]),
    cacheWrite1h: number(json["cacheWrite1h"]),
    output: number(json["output"]),
    reasoning: number(json["reasoning"]),
  }
}

const decodeRequests = (value: unknown): RequestCounts => {
  const json = object(value)
  return {
    total: number(json["total"]),
    success: number(json["success"]),
    failed: number(json["failed"]),
    limited: number(json["limited"]),
    incomplete: number(json["incomplete"]),
  }
}

const decodeSummary = (value: unknown): UsageSummary => {
  const json = object(value)
  return {
    from: number(json["from"]),
    to: number(json["to"]),
    requests: decodeRequests(json["requests"]),
    tokens: decodeTokens(json["tokens"]),
    cacheHitRate: nullableNumber(json["cacheHitRate"]),
    costUsd: number(json["costUsd"]),
    unpricedModels: array(json["unpricedModels"]).map(string),
    spark: array(json["spark"]).map((point) => {
      const fields = object(point)
      return {
        t: number(fields["t"]),
        requests: number(fields["requests"]),
        tokens: number(fields["tokens"]),
        cacheHitRate: nullableNumber(fields["cacheHitRate"]),
        costUsd: number(fields["costUsd"]),
      }
    }),
  }
}

const decodeSeries = (value: unknown): UsageSeries => {
  const json = object(value)
  return {
    from: number(json["from"]),
    to: number(json["to"]),
    bucketMs: number(json["bucketMs"]),
    metric: oneOf(["tokens", "cost"], json["metric"]),
    keys: array(json["keys"]).map(string),
    buckets: array(json["buckets"]).map((bucket) => {
      const fields = object(bucket)
      return {
        t: number(fields["t"]),
        values: Object.fromEntries(
          Object.entries(object(fields["values"])).map(([key, v]) => [key, number(v)]),
        ),
      }
    }),
  }
}

const decodeBreakdownAccount = (value: unknown): BreakdownAccount => {
  const json = object(value)
  return {
    provider: oneOf(["claude", "codex"] as const, json["provider"]),
    label: string(json["label"]),
    email: string(json["email"]),
    plan: string(json["plan"]),
    removedAt: nullableNumber(json["removedAt"]),
  }
}

const decodeBreakdown = (value: unknown): UsageBreakdown => {
  const json = object(value)
  return {
    from: number(json["from"]),
    to: number(json["to"]),
    by: oneOf(["model", "account"] as const, json["by"]),
    rows: array(json["rows"]).map((row) => {
      const fields = object(row)
      return {
        key: string(fields["key"]),
        requests: decodeRequests(fields["requests"]),
        tokens: decodeTokens(fields["tokens"]),
        totalTokens: number(fields["totalTokens"]),
        costUsd: nullableNumber(fields["costUsd"]),
        partlyUnpriced: boolean(fields["partlyUnpriced"]),
        share: number(fields["share"]),
        account:
          fields["account"] === undefined || fields["account"] === null
            ? null
            : decodeBreakdownAccount(fields["account"]),
      }
    }),
  }
}

const decodeLimitReset = (value: unknown): LimitReset => {
  const json = object(value)
  return {
    id: string(json["id"]),
    name: string(json["name"]),
    refills: array(json["refills"]).map((window) => {
      const fields = object(window)
      return { id: string(fields["id"]), label: string(fields["label"]) }
    }),
    // A daemon from before grant dates sends none.
    grantedAt: json["grantedAt"] === undefined ? null : nullableNumber(json["grantedAt"]),
    expiresAt: nullableNumber(json["expiresAt"]),
    usableNow: boolean(json["usableNow"]),
    unavailableReason:
      json["unavailableReason"] === undefined ? null : nullableString(json["unavailableReason"]),
    asOf: number(json["asOf"]),
  }
}

/** Soonest expiry first; one that never expires last. */
const bySoonestExpiry = (a: LimitReset, b: LimitReset) =>
  (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)

const decodeAccountLimits = (value: unknown): AccountLimits => {
  const json = object(value)
  return {
    // A daemon from before limit resets sends neither.
    limitResets:
      json["limitResets"] === undefined
        ? []
        : array(json["limitResets"]).map(decodeLimitReset).toSorted(bySoonestExpiry),
    canBuyReset: json["canBuyReset"] === undefined ? false : boolean(json["canBuyReset"]),
    accountId: string(json["accountId"]),
    asOf: nullableNumber(json["asOf"]),
    windows: array(json["windows"]).map((window) => {
      const fields = object(window)
      return {
        id: string(fields["id"]),
        label: string(fields["label"]),
        usedPct: number(fields["usedPct"]),
        resetsAt: number(fields["resetsAt"]),
        asOf: number(fields["asOf"]),
      }
    }),
  }
}

const decodeLimits = (value: unknown): ReadonlyArray<AccountLimits> =>
  array(value).map(decodeAccountLimits)

const REFUSALS: ReadonlyArray<RedeemRefusal> = [
  "nothing-to-refill",
  "already-redeemed",
  "cooldown",
  "ineligible",
  "unavailable",
  "rejected",
]

const decodeRedeem = (value: unknown): RedeemResult => {
  const json = object(value)
  const message = string(json["message"])
  const limits = decodeAccountLimits(json["limits"])
  const outcome = oneOf(["redeemed", "refused", "unknown"] as const, json["outcome"])
  return outcome === "refused"
    ? {
        outcome,
        // A refusal a newer daemon names still spent nothing.
        reason: REFUSALS.find((reason) => reason === json["reason"]) ?? "rejected",
        message,
        limits,
      }
    : { outcome, message, limits }
}

const decodeUsageRecord = (value: unknown): UsageRecord => {
  const json = object(value)
  return {
    at: number(json["at"]),
    provider: oneOf(PROVIDERS, json["provider"]),
    accountId: string(json["accountId"]),
    model: string(json["model"]),
    // A client a newer daemon names counts as another client.
    client: CLIENT_NAMES.find((name) => name === json["client"]) ?? "other",
    status: oneOf(USAGE_STATUSES, json["status"]),
    tokens: decodeTokens(json["tokens"]),
  }
}

const decodeStreamMessage = (value: unknown): StreamMessage => {
  const json = object(value)
  const pools = () => decodePools(json["pools"])
  switch (json["type"]) {
    case "usage-recorded":
      return { type: "usage-recorded", usage: decodeUsageRecord(json["usage"]) }
    case "limits-changed":
      return { type: "limits-changed", limits: decodeAccountLimits(json["limits"]) }
    case "snapshot":
      return { type: "snapshot", list: decodeAccountList(json) }
    case "pools-changed":
      return { type: "pools-changed", pools: pools() }
    case "added":
    case "removed":
    case "used":
      return { type: json["type"], account: decodeAccount(json["account"]), pools: pools() }
    case "status-changed":
    case "settings-changed":
      return {
        type: json["type"],
        account: decodeAccount(json["account"]),
        previous: decodeAccount(json["previous"]),
        pools: pools(),
      }
    default:
      throw new Unreadable()
  }
}

const decodeDaemonInfo = (value: unknown): DaemonInfo => {
  const json = object(value)
  return {
    address: string(json["address"]),
    version: string(json["version"]),
    build: json["build"] === undefined ? undefined : string(json["build"]),
    startedAt: string(json["startedAt"]),
  }
}

const decodeKey = (value: unknown): string => string(object(value)["key"])

const decodeLogin = (value: unknown): Login => {
  const json = object(value)
  const created = json["created"]
  if (created !== undefined && typeof created !== "boolean") throw new Unreadable()
  return {
    id: string(json["id"]),
    provider: oneOf(PROVIDERS, json["provider"]),
    authorizeUrl: string(json["authorizeUrl"]),
    status: oneOf(LOGIN_STATUSES, json["status"]),
    ...(json["error"] === undefined ? {} : { error: string(json["error"]) }),
    ...(json["account"] === undefined ? {} : { account: decodeAccount(json["account"]) }),
    ...(created === undefined ? {} : { created }),
  }
}

const errorMessage = (value: unknown): string | undefined => {
  try {
    return string(object(value)["error"])
  } catch {
    return undefined
  }
}

// -------------------------------------------------------------------- client

/** The query string of a `/api/usage/*` call. */
const usageParams = (query: UsageQuery, extra: Readonly<Record<string, string>> = {}) => {
  const params = new URLSearchParams({ range: query.range.key })
  if (query.range.key === "custom") {
    params.set("from", query.range.from)
    params.set("to", query.range.to)
  }
  params.set("tz", query.tz)
  if (query.accountId !== undefined) params.set("account", query.accountId)
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  return params.toString()
}

const accountPath = (id: string) => `/api/accounts/${encodeURIComponent(id)}`
const loginPath = (id: string) => `/api/logins/${encodeURIComponent(id)}`

/** The browser's EventSource, which reconnects by itself after a dropped connection. */
export const browserEventStream: OpenEventStream = (url, handlers) => {
  const source = new EventSource(url)
  source.addEventListener("message", (event: MessageEvent<unknown>) =>
    handlers.data(String(event.data)),
  )
  source.addEventListener("error", () => handlers.error(source.readyState === EventSource.CLOSED))
  return { close: () => source.close() }
}

/**
 * How long a redeem may go unanswered before it counts as unanswered: longer
 * than the daemon's own worst case, two 30-second attempts and a re-read of
 * the account, after any redeem already running.
 */
const REDEEM_TIMEOUT_MS = 150_000

export const createDaemonClient = (
  fetchImpl: typeof fetch,
  openEvents: OpenEventStream = browserEventStream,
  /** How long a change may go unanswered before it counts as the daemon being unreachable. */
  mutationTimeout = 10_000,
): DaemonClient => {
  /** A signal that aborts after `mutationTimeout`: no change waits on the daemon forever. */
  const deadline = (timeout = mutationTimeout) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), timeout)
    return controller.signal
  }
  const call = async <A>(
    path: string,
    decode: (body: unknown) => A,
    options: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<A> => {
    const { method = "GET", signal } = options
    let response: Response
    try {
      response = await fetchImpl(path, {
        method,
        headers:
          options.body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      throw new DaemonCallError({ kind: "unreachable" })
    }
    const body: unknown = await response.json().catch(() => undefined)
    // A body cut off by the deadline is a daemon that stopped answering.
    if (signal?.aborted === true) throw new DaemonCallError({ kind: "unreachable" })
    if (!response.ok) {
      const message =
        errorMessage(body) ?? `The daemon answered ${method} ${path} with HTTP ${response.status}.`
      throw new DaemonCallError({ kind: "error", message, status: response.status })
    }
    try {
      return decode(body)
    } catch {
      throw new DaemonCallError({
        kind: "error",
        message: `The daemon's answer to ${method} ${path} is not what this dashboard expects.`,
      })
    }
  }

  return {
    accounts: (signal) => call("/api/accounts", decodeAccountList, { signal }),
    events: (handlers) => {
      const stream = openEvents("/api/events", {
        data: (data) => {
          let message: StreamMessage
          try {
            message = decodeStreamMessage(JSON.parse(data))
          } catch {
            return
          }
          handlers.message(message)
        },
        error: handlers.error,
      })
      return stream.close
    },
    daemon: (signal) => call("/api/daemon", decodeDaemonInfo, { signal }),
    key: () => call("/api/key", decodeKey),
    updateAccount: (id, settings) =>
      call(accountPath(id), decodeAccount, {
        method: "PATCH",
        body: settings,
        signal: deadline(),
      }),
    removeAccount: (id) =>
      call(accountPath(id), decodeAccount, { method: "DELETE", signal: deadline() }),
    startLogin: (provider) =>
      call("/api/logins", decodeLogin, { method: "POST", body: { provider } }),
    login: (id, signal) => call(loginPath(id), decodeLogin, { signal }),
    submitCallback: (id, url) =>
      call(`${loginPath(id)}/callback`, decodeLogin, { method: "POST", body: { url } }),
    cancelLogin: (id) => call(loginPath(id), decodeLogin, { method: "DELETE" }),
    usageSummary: (query) => call(`/api/usage/summary?${usageParams(query)}`, decodeSummary),
    usageSeries: (query, metric = "tokens") =>
      call(`/api/usage/series?${usageParams(query, { by: "model", metric })}`, decodeSeries),
    usageBreakdown: (query, by) =>
      call(`/api/usage/breakdown?${usageParams(query, { by })}`, decodeBreakdown),
    limits: () => call("/api/limits", decodeLimits),
    refreshLimits: (accountId) =>
      call("/api/limits/refresh", decodeLimits, {
        method: "POST",
        body: accountId === undefined ? {} : { accountId },
      }),
    redeemReset: (accountId, resetId) =>
      call(
        `${accountPath(accountId)}/limit-resets/${encodeURIComponent(resetId)}/redeem`,
        decodeRedeem,
        // The daemon asks the provider, may ask once more, then reads the account again.
        { method: "POST", signal: deadline(REDEEM_TIMEOUT_MS) },
      ),
  }
}
