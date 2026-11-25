import { Clock, Context, Effect, Layer, PubSub, type Scope } from "effect"

import { UsageStore } from "./store.ts"
import {
  compareWindows,
  type KnownResets,
  type KnownWindow,
  type ObservedWindow,
  type ResetsRead,
  type Spend,
  type WindowSource,
  windowLabel,
} from "./usage.ts"

/**
 * Each account's limit windows as the daemon last knew them, from two
 * sources: the headers of every proxied answer, and the provider's usage
 * endpoint. Per window, the newer "as of" wins, whatever its source. The
 * windows live in memory for the router and the daemon API, and in the
 * usage store, so a restarted daemon starts from what it knew.
 *
 * Each account's limit resets are kept beside its windows, from the same
 * usage endpoint reads. A read replaces them all; one that could not say
 * leaves them as they were. A reset whose expiry has passed is no longer
 * reported.
 */

/** One limit reset of an account, as the daemon API reports it. */
export interface LimitResetView {
  readonly id: string
  readonly name: string
  /** The windows it refills, by id and the owner's name for each. */
  readonly refills: ReadonlyArray<{ readonly id: string; readonly label: string }>
  /** When the provider granted it, epoch milliseconds; null when the provider does not say. */
  readonly grantedAt: number | null
  /** When it expires unredeemed, epoch milliseconds; null when the provider gives no end. */
  readonly expiresAt: number | null
  readonly usableNow: boolean
  /** Why it cannot be redeemed right now, in the provider's words; null when it can. */
  readonly unavailableReason: string | null
  /** When the provider said it, epoch milliseconds. */
  readonly asOf: number
}

/** A spend limit's money, as the daemon API reports it: 1.26 of 40 USD. */
export interface SpendView {
  readonly used: number
  readonly limit: number
  /** The ISO 4217 code, such as `USD`. */
  readonly currency: string
}

/** `spend` in the currency's major units. */
const spendView = (spend: Spend): SpendView => {
  const scale = 10 ** spend.exponent
  return {
    used: spend.usedMinor / scale,
    limit: spend.limitMinor / scale,
    currency: spend.currency,
  }
}

/** One account's limit windows, as the daemon API reports them. */
export interface AccountLimits {
  readonly accountId: string
  /** When the newest window was observed, epoch milliseconds; null when none ever was. */
  readonly asOf: number | null
  readonly windows: ReadonlyArray<{
    readonly id: string
    readonly label: string
    /** The share used, 0 to 100. */
    readonly usedPct: number
    readonly resetsAt: number
    readonly asOf: number
    /** For a spend limit only: the money spent and the most allowed, in the currency's major units. */
    readonly spend?: SpendView | undefined
  }>
  /** Its limit resets that have not expired, the soonest to expire first. */
  readonly limitResets: ReadonlyArray<LimitResetView>
  /** True when its provider offers it an instant reset to buy, in the browser. */
  readonly canBuyReset: boolean
}

/** `windows` and `resets` as the daemon API reports them for `accountId` at `now`. */
const toAccountLimits = (
  accountId: string,
  windows: ReadonlyArray<KnownWindow>,
  resets: KnownResets | undefined,
  now: number,
): AccountLimits => ({
  accountId,
  asOf: windows.length === 0 ? null : Math.max(...windows.map((window) => window.asOf)),
  windows: windows.toSorted(compareWindows).map((window) => ({
    id: window.id,
    label: windowLabel(window.id),
    usedPct: Math.round(window.usedShare * 1000) / 10,
    resetsAt: window.resetsAt,
    asOf: window.asOf,
    spend: window.spend === undefined ? undefined : spendView(window.spend),
  })),
  limitResets: (resets?.resets ?? [])
    .filter((reset) => reset.expiresAt === undefined || reset.expiresAt > now)
    .toSorted(
      (a, b) =>
        (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.name.localeCompare(b.name),
    )
    .map((reset) => ({
      id: reset.id,
      name: reset.name,
      refills: reset.refills
        .map((id) => ({ id }))
        .toSorted(compareWindows)
        .map(({ id }) => ({ id, label: windowLabel(id) })),
      grantedAt: reset.grantedAt ?? null,
      expiresAt: reset.expiresAt ?? null,
      usableNow: reset.usableNow,
      unavailableReason: reset.unavailableReason ?? null,
      asOf: resets?.asOf ?? now,
    })),
  canBuyReset: resets?.canBuy ?? false,
})

/** True when `a` and `b` say the same about an account's limit resets, whenever they were said. */
const sameResets = (a: ResetsRead | undefined, b: ResetsRead) =>
  a !== undefined && a.canBuy === b.canBuy && JSON.stringify(a.resets) === JSON.stringify(b.resets)

/**
 * How often an answer that only confirms a window's numbers moves its "as
 * of": every proxied answer carries the headers, and writing and announcing
 * each one would change nothing the owner can see.
 */
const CONFIRM_EVERY_MS = 60_000

/** The windows that limit an account as a whole; a per-model weekly window limits only its model. */
const ACCOUNT_WINDOWS: ReadonlySet<string> = new Set(["five-hour", "weekly", "monthly"])

export class LimitWindows extends Context.Service<
  LimitWindows,
  {
    /**
     * Records what a source said about `accountId`'s windows at `asOf`. A
     * window known from a newer observation stays. When `complete`, the
     * source reports every window the account has, so a window it leaves out
     * is dropped, unless it was observed later than `asOf`. `resets`, from the
     * same read, replaces the account's limit resets.
     */
    readonly observe: (
      accountId: string,
      windows: ReadonlyArray<ObservedWindow>,
      source: WindowSource,
      asOf: number,
      options?: { readonly complete?: boolean; readonly resets?: ResetsRead | undefined },
    ) => Effect.Effect<void>
    /** Drops limit reset `resetId` of `accountId`, which the owner just redeemed. */
    readonly redeemed: (accountId: string, resetId: string) => Effect.Effect<void>
    /** Forgets a removed account's windows and limit resets. */
    readonly forget: (accountId: string) => Effect.Effect<void>
    /** `accountId`'s windows as they are known now. */
    readonly known: (accountId: string) => ReadonlyArray<KnownWindow>
    /** `accountId`'s windows and limit resets as the daemon API reports them at `now`. */
    readonly report: (accountId: string, now: number) => AccountLimits
    /**
     * The router's headroom for `accountId` at `now`: the share left in its
     * tightest 5-hour, weekly or monthly window that has not reset yet, or
     * none when none is known.
     */
    readonly headroom: (accountId: string, now: number) => number | undefined
    /** Each account's windows and limit resets as they change, from when the subscription is made. */
    readonly subscribe: Effect.Effect<Effect.Effect<AccountLimits>, never, Scope.Scope>
  }
>()("agent-proxy/LimitWindows") {
  static readonly layer = Layer.effect(
    LimitWindows,
    Effect.gen(function* () {
      const store = yield* UsageStore
      const current = new Map<string, ReadonlyArray<KnownWindow>>(
        yield* store.windows.pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not read the last-known limit windows").pipe(
              Effect.annotateLogs({ cause: error.message }),
              Effect.as(new Map<string, ReadonlyArray<KnownWindow>>()),
            ),
          ),
        ),
      )
      const resets = new Map<string, KnownResets>(
        yield* store.resets.pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not read the last-known limit resets").pipe(
              Effect.annotateLogs({ cause: error.message }),
              Effect.as(new Map<string, KnownResets>()),
            ),
          ),
        ),
      )
      const changed = yield* PubSub.unbounded<AccountLimits>()
      const report = (accountId: string, now: number) =>
        toAccountLimits(accountId, current.get(accountId) ?? [], resets.get(accountId), now)
      const announce = (accountId: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          PubSub.publish(changed, report(accountId, now)),
        )

      /** Keeps `next` as `accountId`'s limit resets; true when they changed. */
      const keepResets = Effect.fnUntraced(function* (accountId: string, next: KnownResets) {
        const before = resets.get(accountId)
        resets.set(accountId, next)
        yield* store
          .saveResets(accountId, next)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("could not save limit resets").pipe(
                Effect.annotateLogs({ account: accountId, cause: error.message }),
              ),
            ),
          )
        return !sameResets(before, next)
      })
      // Removed accounts, whose windows a read still on its way must not bring back.
      const forgotten = new Set<string>()

      const observe = Effect.fnUntraced(function* (
        accountId: string,
        windows: ReadonlyArray<ObservedWindow>,
        source: WindowSource,
        asOf: number,
        options?: { readonly complete?: boolean; readonly resets?: ResetsRead | undefined },
      ) {
        if (forgotten.has(accountId)) return
        const resetsChanged =
          options?.resets === undefined
            ? false
            : yield* keepResets(accountId, { ...options.resets, asOf })
        const before = new Map((current.get(accountId) ?? []).map((window) => [window.id, window]))
        const after = new Map(before)
        const written: Array<KnownWindow> = []
        for (const window of windows) {
          const known = before.get(window.id)
          if (known !== undefined && known.asOf > asOf) continue
          const confirms =
            known !== undefined &&
            source === "header" &&
            known.usedShare === window.usedShare &&
            known.resetsAt === window.resetsAt &&
            asOf - known.asOf < CONFIRM_EVERY_MS
          if (confirms) continue
          const next: KnownWindow = { ...window, asOf, source }
          after.set(window.id, next)
          written.push(next)
        }
        const reported = new Set(windows.map((window) => window.id))
        const removed =
          options?.complete === true
            ? [...before.values()].filter(
                (window) => !reported.has(window.id) && window.asOf <= asOf,
              )
            : []
        for (const window of removed) after.delete(window.id)
        if (written.length === 0 && removed.length === 0) {
          if (resetsChanged) yield* announce(accountId)
          return
        }
        current.set(accountId, [...after.values()])
        yield* store
          .saveWindows(
            accountId,
            written,
            removed.map((window) => window.id),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("could not save limit windows").pipe(
                Effect.annotateLogs({ account: accountId, cause: error.message }),
              ),
            ),
          )
        yield* announce(accountId)
      })

      const redeemed = Effect.fnUntraced(function* (accountId: string, resetId: string) {
        const before = resets.get(accountId)
        if (forgotten.has(accountId) || before === undefined) return
        if (!before.resets.some((reset) => reset.id === resetId)) return
        yield* keepResets(accountId, {
          ...before,
          resets: before.resets.filter((reset) => reset.id !== resetId),
        })
        yield* announce(accountId)
      })

      const forget = Effect.fnUntraced(function* (accountId: string) {
        forgotten.add(accountId)
        current.delete(accountId)
        resets.delete(accountId)
        yield* store
          .forgetWindows(accountId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("could not forget limit windows").pipe(
                Effect.annotateLogs({ account: accountId, cause: error.message }),
              ),
            ),
          )
      })

      const known = (accountId: string) => current.get(accountId) ?? []

      const headroom = (accountId: string, now: number) => {
        const used = known(accountId)
          .filter((window) => ACCOUNT_WINDOWS.has(window.id) && window.resetsAt > now)
          .map((window) => window.usedShare)
        return used.length === 0 ? undefined : Math.min(1, Math.max(0, 1 - Math.max(...used)))
      }

      return LimitWindows.of({
        observe,
        redeemed,
        forget,
        known,
        report,
        headroom,
        subscribe: Effect.map(PubSub.subscribe(changed), (subscription) =>
          PubSub.take(subscription),
        ),
      })
    }),
  )
}
