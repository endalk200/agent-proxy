import { Database } from "bun:sqlite"
import { chmodSync } from "node:fs"
import { join } from "node:path"

import { Clock, Context, Data, Effect, Layer } from "effect"

import type { Provider } from "../accounts/account.ts"
import { ensurePrivateDirectory } from "../atomic-file.ts"
import { resolveDataDir } from "../paths.ts"
import { contextSizes, costOf } from "./prices.ts"
import { bucketIndex, resolveRange, type ResolvedRange, type UsageRange } from "./ranges.ts"
import {
  type KnownWindow,
  noTokens,
  type TokenCounts,
  totalTokens,
  type UsageRow,
  type UsageStatus,
  type WindowSource,
} from "./usage.ts"

/**
 * The usage store (ADR-0009): one SQLite file, `usage.sqlite` in the data
 * directory, that the daemon alone opens. It keeps a row per proxied
 * generation request, forever, each account's last-known limit windows, and
 * the name of every account the daemon has held, so usage of an account
 * since removed still says whose it was.
 * Callers record rows and windows and ask range questions; none of them sees
 * SQL, and equivalent cost is computed here at query time, never stored.
 */

export class UsageStoreError extends Data.TaggedError("UsageStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A range question: `range` in the viewer's zone `tz`, about one account or all. */
export interface UsageQuery {
  readonly range: UsageRange
  readonly tz: string
  readonly accountId?: string | undefined
}

export interface RequestCounts {
  readonly total: number
  readonly success: number
  readonly failed: number
  readonly limited: number
  readonly incomplete: number
}

/** `GET /api/usage/summary`: the dashboard's KPI row. */
export interface UsageSummary {
  readonly from: number
  readonly to: number
  readonly requests: RequestCounts
  readonly tokens: TokenCounts
  /** Cache reads over all input; null with no input. */
  readonly cacheHitRate: number | null
  /** Equivalent cost of the priced models only, USD. */
  readonly costUsd: number
  /** Models used in the range that have no price. */
  readonly unpricedModels: ReadonlyArray<string>
  /** About 24 points, each a whole number of chart buckets, oldest first. */
  readonly spark: ReadonlyArray<{
    readonly t: number
    readonly requests: number
    readonly tokens: number
    readonly cacheHitRate: number | null
    readonly costUsd: number
  }>
}

/** What a series measures: total tokens, or equivalent cost in USD. */
export type SeriesMetric = "tokens" | "cost"

/** `GET /api/usage/series?by=model&metric=…`: tokens or equivalent cost per model per bucket. */
export interface UsageSeries {
  readonly from: number
  readonly to: number
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

/** An account as the usage store remembers it: who it is, by the name the owner gave it. */
export interface AccountName {
  readonly id: string
  readonly provider: Provider
  readonly label: string
  readonly email: string
  readonly plan: string
}

/** A `by=account` row's account, as last known; `removedAt` is when it was removed, epoch milliseconds. */
export interface BreakdownAccount extends Omit<AccountName, "id"> {
  readonly removedAt: number | null
}

export interface BreakdownRow {
  /** A model id, or an account id (perhaps of an account since removed). */
  readonly key: string
  readonly requests: RequestCounts
  readonly tokens: TokenCounts
  readonly totalTokens: number
  /** Null when the row is wholly unpriced. */
  readonly costUsd: number | null
  /** True when some, but not all, of the row's tokens are unpriced. */
  readonly partlyUnpriced: boolean
  /** The row's share of every token in the range, 0 to 1. */
  readonly share: number
  /** A `by=account` row's account; null when the daemon never knew its name, and for a `by=model` row. */
  readonly account: BreakdownAccount | null
}

/** `GET /api/usage/breakdown`: rows most tokens first. */
export interface UsageBreakdown {
  readonly from: number
  readonly to: number
  readonly by: BreakdownBy
  readonly rows: ReadonlyArray<BreakdownRow>
}

export class UsageStore extends Context.Service<
  UsageStore,
  {
    readonly record: (row: UsageRow) => Effect.Effect<void, UsageStoreError>
    readonly summary: (query: UsageQuery) => Effect.Effect<UsageSummary, UsageStoreError>
    readonly series: (
      query: UsageQuery,
      metric: SeriesMetric,
    ) => Effect.Effect<UsageSeries, UsageStoreError>
    readonly breakdown: (
      query: UsageQuery,
      by: BreakdownBy,
    ) => Effect.Effect<UsageBreakdown, UsageStoreError>
    /** Every account's last-known limit windows. */
    readonly windows: Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<KnownWindow>>,
      UsageStoreError
    >
    /** Stores `windows` for `accountId`, replacing those with the same ids, and drops `removed`. */
    readonly saveWindows: (
      accountId: string,
      windows: ReadonlyArray<KnownWindow>,
      removed: ReadonlyArray<string>,
    ) => Effect.Effect<void, UsageStoreError>
    /** Forgets `accountId`'s limit windows; its usage rows stay. */
    readonly forgetWindows: (accountId: string) => Effect.Effect<void, UsageStoreError>
    /**
     * Remembers `accounts` as held, by their names in a list of the accounts
     * read from `readAt`. An account removed after `readAt` stays removed,
     * under the name it was removed with: the list was read before it went.
     * An account missing from the list is not taken for removed, as a list
     * can leave out a file it could not read.
     */
    readonly rememberAccounts: (
      accounts: ReadonlyArray<AccountName>,
      readAt: number,
    ) => Effect.Effect<void, UsageStoreError>
    /** Remembers `account` as removed at `now`, under the name it had then. */
    readonly rememberRemoved: (
      account: AccountName,
      now: number,
    ) => Effect.Effect<void, UsageStoreError>
  }
>()("agent-proxy/UsageStore") {
  /** The store in the data directory resolved from the environment, open until the scope closes. */
  static readonly layer = Layer.effect(
    UsageStore,
    Effect.gen(function* () {
      const dataDir = yield* resolveDataDir
      yield* ensurePrivateDirectory(dataDir).pipe(
        Effect.mapError(
          (cause) =>
            new UsageStoreError({
              message: `Could not open ${dataDir}`,
              cause,
            }),
        ),
      )
      const file = join(dataDir, "usage.sqlite")
      return yield* Effect.acquireRelease(
        // Its queries are prepared here too, so a file whose tables are not
        // what its version says fails as one that cannot be opened.
        attempt(`Could not open the usage store ${file}`, () => {
          const db = openDatabase(file)
          try {
            return { db, store: make(db) }
          } catch (cause) {
            db.close()
            throw cause
          }
        }),
        (opened) => Effect.sync(() => opened.db.close()),
      ).pipe(
        Effect.map((opened) => opened.store),
        // Usage is a record of the proxy's work, never a condition of it: a
        // store that cannot be opened leaves the daemon serving without one.
        // Logged as a warning, since `daemon start` takes an error logged
        // during startup for a daemon that could not start.
        Effect.catchTag("UsageStoreError", (error) => {
          const reason = notRecorded(file, error.cause)
          return Effect.logWarning("usage is not recorded").pipe(
            Effect.annotateLogs({ reason }),
            Effect.as(unavailable(reason)),
          )
        }),
      )
    }),
  )
}

/** A database whose schema a newer build wrote: this build does not know its tables. */
class SchemaFromNewerBuild extends Error {
  constructor(readonly version: number) {
    super(`schema version ${version}, newer than this build's ${MIGRATIONS.length}`)
  }
}

/** Why usage is not recorded, when the store at `file` could not be opened because of `cause`. */
const notRecorded = (file: string, cause: unknown) =>
  cause instanceof SchemaFromNewerBuild
    ? `Usage is not recorded: ${file} was written by a newer agent-proxy build (schema version ${cause.version}; this build knows ${MIGRATIONS.length}). Run that build again to record usage; this one leaves the file as it is.`
    : `Usage is not recorded: the usage store ${file} could not be opened (${cause instanceof Error ? cause.message : String(cause)}). The proxy serves without it. To start a new store, stop the daemon, move the file aside, and start it again.`

/**
 * The store for a database the daemon could not open: it records nothing,
 * so no request waits on it or logs about it, and every usage question is
 * answered with `reason`. Limit windows are kept in memory only.
 */
const unavailable = (reason: string) => {
  const refused = Effect.fail(new UsageStoreError({ message: reason }))
  return UsageStore.of({
    record: () => Effect.void,
    summary: () => refused,
    series: () => refused,
    breakdown: () => refused,
    windows: Effect.succeed(new Map()),
    saveWindows: () => Effect.void,
    forgetWindows: () => Effect.void,
    rememberAccounts: () => Effect.void,
    rememberRemoved: () => Effect.void,
  })
}

const attempt = <A>(message: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new UsageStoreError({ message, cause }),
  })

/**
 * Each schema version's step from the one before. A database at version n
 * runs steps n+1 onward, so a new column is a new step, never an edit.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE usage (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     provider TEXT NOT NULL,
     account_id TEXT NOT NULL,
     model TEXT NOT NULL,
     client TEXT NOT NULL,
     session TEXT,
     status TEXT NOT NULL,
     latency_ms INTEGER NOT NULL,
     uncached INTEGER NOT NULL,
     cache_read INTEGER NOT NULL,
     cache_write INTEGER NOT NULL,
     output INTEGER NOT NULL,
     reasoning INTEGER NOT NULL
   );
   CREATE INDEX usage_at ON usage (at);
   CREATE TABLE limit_windows (
     account_id TEXT NOT NULL,
     window_id TEXT NOT NULL,
     used_share REAL NOT NULL,
     resets_at INTEGER NOT NULL,
     as_of INTEGER NOT NULL,
     source TEXT NOT NULL,
     PRIMARY KEY (account_id, window_id)
   );`,
  `ALTER TABLE usage ADD COLUMN cache_write_1h INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     label TEXT NOT NULL,
     email TEXT NOT NULL,
     plan TEXT NOT NULL,
     removed_at INTEGER
   );`,
]

const openDatabase = (file: string) => {
  const db = new Database(file, { create: true, strict: true })
  try {
    chmodSync(file, 0o600)
    // Set first, so a lock another program holds is waited out, even by the switch to WAL.
    db.run("PRAGMA busy_timeout = 5000")
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()
    const from = version?.user_version ?? 0
    // Never migrate down: a newer build would find its own steps undone, run
    // them again, and fail. Its file is left exactly as it is.
    if (from > MIGRATIONS.length) throw new SchemaFromNewerBuild(from)
    db.run("PRAGMA journal_mode = WAL")
    db.transaction(() => {
      for (const [index, step] of MIGRATIONS.entries()) {
        if (index < from) continue
        db.run(step)
      }
      db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
    })()
    return db
  } catch (cause) {
    db.close()
    throw cause
  }
}

/** The slot every range question groups rows by: 15 minutes, which every bucket boundary falls on. */
const SLOT_MS = 15 * 60_000

/**
 * Each row's context band (prices.ts), in SQL: long-context rates apply to a
 * whole request, so a group's tokens can be priced as one sum only when its
 * requests share a band.
 */
const CONTEXT_BAND =
  contextSizes.length === 0
    ? "0"
    : contextSizes.map((size) => `(uncached + cache_read + cache_write > ${size})`).join(" + ")

/** One group of rows from a range scan. */
interface Group {
  readonly slot: number
  readonly model: string
  readonly account_id: string
  readonly status: UsageStatus
  readonly band: number
  readonly n: number
  readonly uncached: number
  readonly cache_read: number
  readonly cache_write: number
  readonly cache_write_1h: number
  readonly output: number
  readonly reasoning: number
}

const groupTokens = (group: Group): TokenCounts => ({
  uncached: group.uncached,
  cacheRead: group.cache_read,
  cacheWrite: group.cache_write,
  cacheWrite1h: group.cache_write_1h,
  output: group.output,
  reasoning: group.reasoning,
})

/** Running sums of requests, tokens and cost, for one row of an answer. */
class Tally {
  requests = { total: 0, success: 0, failed: 0, limited: 0, incomplete: 0 }
  tokens = { ...noTokens }
  costUsd = 0
  pricedTokens = 0
  unpricedTokens = 0

  add(group: Group) {
    this.requests.total += group.n
    this.requests[group.status] += group.n
    const tokens = groupTokens(group)
    this.tokens.uncached += tokens.uncached
    this.tokens.cacheRead += tokens.cacheRead
    this.tokens.cacheWrite += tokens.cacheWrite
    this.tokens.cacheWrite1h += tokens.cacheWrite1h
    this.tokens.output += tokens.output
    this.tokens.reasoning += tokens.reasoning
    const cost = costOf(group.model, tokens, group.band)
    if (cost === undefined) this.unpricedTokens += totalTokens(tokens)
    else {
      this.costUsd += cost
      this.pricedTokens += totalTokens(tokens)
    }
  }

  get total() {
    return totalTokens(this.tokens)
  }

  get cacheHitRate() {
    const input = this.tokens.uncached + this.tokens.cacheRead + this.tokens.cacheWrite
    return input === 0 ? null : this.tokens.cacheRead / input
  }
}

const make = (db: Database) => {
  const insert = db.query(
    `INSERT INTO usage (at, provider, account_id, model, client, session, status, latency_ms,
       uncached, cache_read, cache_write, cache_write_1h, output, reasoning)
     VALUES ($at, $provider, $account, $model, $client, $session, $status, $latency,
       $uncached, $cacheRead, $cacheWrite, $cacheWrite1h, $output, $reasoning)`,
  )
  const firstAll = db.query<{ first: number | null }, []>("SELECT MIN(at) AS first FROM usage")
  const firstOne = db.query<{ first: number | null }, { account: string }>(
    "SELECT MIN(at) AS first FROM usage WHERE account_id = $account",
  )
  const scanAll = db.query<Group, { from: number; to: number }>(
    `SELECT at / ${SLOT_MS} AS slot, model, account_id, status, ${CONTEXT_BAND} AS band,
       COUNT(*) AS n,
       SUM(uncached) AS uncached, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
       SUM(cache_write_1h) AS cache_write_1h,
       SUM(output) AS output, SUM(reasoning) AS reasoning
     FROM usage WHERE at >= $from AND at < $to
     GROUP BY slot, model, account_id, status, band`,
  )
  const scanOne = db.query<Group, { from: number; to: number; account: string }>(
    `SELECT at / ${SLOT_MS} AS slot, model, account_id, status, ${CONTEXT_BAND} AS band,
       COUNT(*) AS n,
       SUM(uncached) AS uncached, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
       SUM(cache_write_1h) AS cache_write_1h,
       SUM(output) AS output, SUM(reasoning) AS reasoning
     FROM usage WHERE at >= $from AND at < $to AND account_id = $account
     GROUP BY slot, model, account_id, status, band`,
  )
  const allWindows = db.query<
    {
      account_id: string
      window_id: string
      used_share: number
      resets_at: number
      as_of: number
      source: WindowSource
    },
    []
  >("SELECT account_id, window_id, used_share, resets_at, as_of, source FROM limit_windows")
  const upsertWindow = db.query(
    `INSERT INTO limit_windows (account_id, window_id, used_share, resets_at, as_of, source)
     VALUES ($account, $id, $used, $resets, $asOf, $source)
     ON CONFLICT (account_id, window_id) DO UPDATE SET
       used_share = excluded.used_share, resets_at = excluded.resets_at,
       as_of = excluded.as_of, source = excluded.source`,
  )
  const deleteWindow = db.query(
    "DELETE FROM limit_windows WHERE account_id = $account AND window_id = $id",
  )
  const deleteWindows = db.query("DELETE FROM limit_windows WHERE account_id = $account")
  const allAccounts = db.query<
    {
      id: string
      provider: Provider
      label: string
      email: string
      plan: string
      removed_at: number | null
    },
    []
  >("SELECT id, provider, label, email, plan, removed_at FROM accounts")
  const upsertHeld = db.query(
    `INSERT INTO accounts (id, provider, label, email, plan, removed_at)
     VALUES ($id, $provider, $label, $email, $plan, NULL)
     ON CONFLICT (id) DO UPDATE SET
       provider = excluded.provider, label = excluded.label, email = excluded.email,
       plan = excluded.plan, removed_at = NULL
     WHERE accounts.removed_at IS NULL OR accounts.removed_at < $readAt`,
  )
  const upsertRemoved = db.query(
    `INSERT INTO accounts (id, provider, label, email, plan, removed_at)
     VALUES ($id, $provider, $label, $email, $plan, $now)
     ON CONFLICT (id) DO UPDATE SET
       provider = excluded.provider, label = excluded.label, email = excluded.email,
       plan = excluded.plan, removed_at = excluded.removed_at`,
  )

  /** `query`'s range resolved now, and every group of rows in it. */
  const scan = (query: UsageQuery) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      attempt("Could not read the usage store", () => {
        const first =
          query.range.key === "lifetime"
            ? ((query.accountId === undefined
                ? firstAll.get()
                : firstOne.get({ account: query.accountId })
              )?.first ?? undefined)
            : undefined
        const range = resolveRange(query.range, now, query.tz, first)
        const groups =
          query.accountId === undefined
            ? scanAll.all({ from: range.from, to: range.to })
            : scanOne.all({
                from: range.from,
                to: range.to,
                account: query.accountId,
              })
        return { range, groups }
      }),
    )

  const inBucket = (range: ResolvedRange, group: Group) =>
    bucketIndex(range.starts, range.to, group.slot * SLOT_MS)

  const record = (row: UsageRow) =>
    attempt("Could not record usage", () => {
      insert.run({
        at: row.at,
        provider: row.provider,
        account: row.accountId,
        model: row.model,
        client: row.client,
        session: row.session ?? null,
        status: row.status,
        latency: Math.max(0, Math.round(row.latencyMs)),
        uncached: row.tokens.uncached,
        cacheRead: row.tokens.cacheRead,
        cacheWrite: row.tokens.cacheWrite,
        cacheWrite1h: row.tokens.cacheWrite1h,
        output: row.tokens.output,
        reasoning: row.tokens.reasoning,
      })
    })

  const summary = (query: UsageQuery) =>
    Effect.map(scan(query), ({ range, groups }): UsageSummary => {
      const all = new Tally()
      const per = Math.max(1, Math.round(range.starts.length / 24))
      const points = Array.from({ length: Math.ceil(range.starts.length / per) }, () => new Tally())
      const unpriced = new Set<string>()
      for (const group of groups) {
        all.add(group)
        if (costOf(group.model, groupTokens(group), group.band) === undefined)
          unpriced.add(group.model)
        const index = inBucket(range, group)
        if (index !== -1) points[Math.floor(index / per)]?.add(group)
      }
      return {
        from: range.from,
        to: range.to,
        requests: all.requests,
        tokens: all.tokens,
        cacheHitRate: all.cacheHitRate,
        costUsd: all.costUsd,
        unpricedModels: [...unpriced].toSorted(),
        spark: points.map((point, index) => ({
          t: range.starts[index * per] ?? range.from,
          requests: point.requests.total,
          tokens: point.total,
          cacheHitRate: point.cacheHitRate,
          costUsd: point.costUsd,
        })),
      }
    })

  const series = (query: UsageQuery, metric: SeriesMetric) =>
    Effect.map(scan(query), ({ range, groups }): UsageSeries => {
      const buckets = range.starts.map((t) => ({
        t,
        values: {} as Record<string, number>,
      }))
      const totals = new Map<string, number>()
      for (const group of groups) {
        const tokens = groupTokens(group)
        const value =
          metric === "tokens" ? totalTokens(tokens) : (costOf(group.model, tokens, group.band) ?? 0)
        if (value === 0) continue
        totals.set(group.model, (totals.get(group.model) ?? 0) + value)
        const bucket = buckets[inBucket(range, group)]
        if (bucket !== undefined)
          bucket.values[group.model] = (bucket.values[group.model] ?? 0) + value
      }
      return {
        from: range.from,
        to: range.to,
        bucketMs: range.bucketMs,
        metric,
        keys: [...totals]
          .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([key]) => key),
        buckets,
      }
    })

  /** Every account the store remembers, by id. */
  const accountNames = () =>
    new Map(
      allAccounts.all().map((row): [string, BreakdownAccount] => [
        row.id,
        {
          provider: row.provider,
          label: row.label,
          email: row.email,
          plan: row.plan,
          removedAt: row.removed_at,
        },
      ]),
    )

  const breakdown = (query: UsageQuery, by: BreakdownBy) =>
    Effect.flatMap(scan(query), ({ range, groups }) =>
      attempt("Could not read the usage store", (): UsageBreakdown => {
        const names = by === "account" ? accountNames() : undefined
        const rows = new Map<string, Tally>()
        let total = 0
        for (const group of groups) {
          const key = by === "model" ? group.model : group.account_id
          let tally = rows.get(key)
          if (tally === undefined) {
            tally = new Tally()
            rows.set(key, tally)
          }
          tally.add(group)
          total += totalTokens(groupTokens(group))
        }
        return {
          from: range.from,
          to: range.to,
          by,
          rows: [...rows]
            .map(([key, tally]): BreakdownRow => {
              const wholly = tally.unpricedTokens > 0 && tally.pricedTokens === 0
              const unpricedOnly =
                wholly || (tally.total === 0 && tally.costUsd === 0 && hasNoPrice(key, by))
              return {
                key,
                requests: tally.requests,
                tokens: tally.tokens,
                totalTokens: tally.total,
                costUsd: unpricedOnly ? null : tally.costUsd,
                partlyUnpriced: tally.unpricedTokens > 0 && tally.pricedTokens > 0,
                share: total === 0 ? 0 : tally.total / total,
                account: names?.get(key) ?? null,
              }
            })
            .toSorted((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key)),
        }
      }),
    )

  const windows = attempt("Could not read the limit windows", () => {
    const byAccount = new Map<string, Array<KnownWindow>>()
    for (const row of allWindows.all()) {
      const list = byAccount.get(row.account_id) ?? []
      list.push({
        id: row.window_id,
        usedShare: row.used_share,
        resetsAt: row.resets_at,
        asOf: row.as_of,
        source: row.source,
      })
      byAccount.set(row.account_id, list)
    }
    return byAccount
  })

  const saveWindows = (
    accountId: string,
    known: ReadonlyArray<KnownWindow>,
    removed: ReadonlyArray<string>,
  ) =>
    attempt("Could not save the limit windows", () => {
      db.transaction(() => {
        for (const window of known) {
          upsertWindow.run({
            account: accountId,
            id: window.id,
            used: window.usedShare,
            resets: window.resetsAt,
            asOf: window.asOf,
            source: window.source,
          })
        }
        for (const id of removed) deleteWindow.run({ account: accountId, id })
      })()
    })

  const forgetWindows = (accountId: string) =>
    attempt("Could not forget the limit windows", () => {
      deleteWindows.run({ account: accountId })
    })

  const rememberAccounts = (accounts: ReadonlyArray<AccountName>, readAt: number) =>
    attempt("Could not remember the accounts", () => {
      db.transaction(() => {
        for (const account of accounts) upsertHeld.run({ ...nameOf(account), readAt })
      })()
    })

  const rememberRemoved = (account: AccountName, now: number) =>
    attempt("Could not remember a removed account", () => {
      upsertRemoved.run({ ...nameOf(account), now })
    })

  return UsageStore.of({
    record,
    summary,
    series,
    breakdown,
    windows,
    saveWindows,
    forgetWindows,
    rememberAccounts,
    rememberRemoved,
  })
}

/** An account's name alone, without whatever else the object carries, such as credentials. */
const nameOf = ({ id, provider, label, email, plan }: AccountName) => ({
  id,
  provider,
  label,
  email,
  plan,
})

/** True when a model row with no tokens is for an unpriced model, so its cost reads as unknown, not zero. */
const hasNoPrice = (key: string, by: BreakdownBy) =>
  by === "model" && costOf(key, noTokens) === undefined
