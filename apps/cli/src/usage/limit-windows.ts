import { Context, Effect, Layer, PubSub, type Scope } from "effect"

import { UsageStore } from "./store.ts"
import {
  compareWindows,
  type KnownWindow,
  type ObservedWindow,
  type WindowSource,
  windowLabel,
} from "./usage.ts"

/**
 * Each account's limit windows as the daemon last knew them, from two
 * sources: the headers of every proxied answer, and the provider's usage
 * endpoint. Per window, the newer "as of" wins, whatever its source. The
 * windows live in memory for the router and the daemon API, and in the
 * usage store, so a restarted daemon starts from what it knew.
 */

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
  }>
}

/** `windows` as the daemon API reports them for `accountId`. */
export const toAccountLimits = (
  accountId: string,
  windows: ReadonlyArray<KnownWindow>,
): AccountLimits => ({
  accountId,
  asOf: windows.length === 0 ? null : Math.max(...windows.map((window) => window.asOf)),
  windows: windows.toSorted(compareWindows).map((window) => ({
    id: window.id,
    label: windowLabel(window.id),
    usedPct: Math.round(window.usedShare * 1000) / 10,
    resetsAt: window.resetsAt,
    asOf: window.asOf,
  })),
})

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
     * is dropped, unless it was observed later than `asOf`.
     */
    readonly observe: (
      accountId: string,
      windows: ReadonlyArray<ObservedWindow>,
      source: WindowSource,
      asOf: number,
      options?: { readonly complete?: boolean },
    ) => Effect.Effect<void>
    /** Forgets a removed account's windows. */
    readonly forget: (accountId: string) => Effect.Effect<void>
    /** `accountId`'s windows as they are known now. */
    readonly known: (accountId: string) => ReadonlyArray<KnownWindow>
    /**
     * The router's headroom for `accountId` at `now`: the share left in its
     * tightest 5-hour, weekly or monthly window that has not reset yet, or
     * none when none is known.
     */
    readonly headroom: (accountId: string, now: number) => number | undefined
    /** Each account's windows as they change, from when the subscription is made. */
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
      const changed = yield* PubSub.unbounded<AccountLimits>()
      // Removed accounts, whose windows a read still on its way must not bring back.
      const forgotten = new Set<string>()

      const observe = Effect.fnUntraced(function* (
        accountId: string,
        windows: ReadonlyArray<ObservedWindow>,
        source: WindowSource,
        asOf: number,
        options?: { readonly complete?: boolean },
      ) {
        if (forgotten.has(accountId)) return
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
        if (written.length === 0 && removed.length === 0) return
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
        yield* PubSub.publish(changed, toAccountLimits(accountId, [...after.values()]))
      })

      const forget = Effect.fnUntraced(function* (accountId: string) {
        forgotten.add(accountId)
        current.delete(accountId)
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
        forget,
        known,
        headroom,
        subscribe: Effect.map(PubSub.subscribe(changed), (subscription) =>
          PubSub.take(subscription),
        ),
      })
    }),
  )
}
