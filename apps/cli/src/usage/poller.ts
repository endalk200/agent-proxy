import { Clock, Context, Duration, Effect, Layer, Option, Queue, Semaphore, Stream } from "effect"

import type { Account, Credentials, Provider } from "../accounts/account.ts"
import { CredentialKeeper } from "../accounts/keeper.ts"
import { AccountStore } from "../accounts/store.ts"
import { AccountEvents } from "../daemon/account-events.ts"
import { ClaudeApi } from "../providers/claude-api.ts"
import { CodexApi } from "../providers/codex-api.ts"
import type { UpstreamApi } from "../providers/upstream.ts"
import { LimitWindows } from "./limit-windows.ts"

/**
 * Keeps idle accounts' limit windows current by reading each provider's
 * usage endpoint as the account: once for every account the daemon has not
 * read yet (all of them at startup, and each one added later), every 30
 * minutes, once just after any known window resets, and whenever the owner
 * asks.
 *
 * - Reads go one account at a time across the whole daemon: reading several
 *   accounts at once is what got CLIProxyAPI's users HTTP 429s.
 * - A provider that answers 429 is not read again until its `Retry-After`
 *   passes, an hour at most.
 * - Accounts that need sign-in or are disabled are skipped.
 * - A read that fails leaves the last-known windows as they were, with their
 *   old "as of"; it is logged, never surfaced as an error.
 */

/** How often every account is read. */
const EVERY_MS = Duration.toMillis(Duration.minutes(30))

/** How long after a window resets its account is read again, so the provider has moved on. */
const AFTER_RESET_MS = Duration.toMillis(Duration.minutes(1))

/** True when `account` can be read: it is enabled and signed in. */
const servable = (account: Account) => account.enabled && !account.needsSignIn

/** The longest a provider's `Retry-After` keeps the daemon from reading it. */
const MAX_RETRY_AFTER_MS = Duration.toMillis(Duration.hours(1))

export class LimitPoller extends Context.Service<
  LimitPoller,
  {
    /** Reads `accountId`'s windows, or every account's, and returns once the reads finish. */
    readonly refresh: (accountId?: string) => Effect.Effect<void>
  }
>()("agent-proxy/LimitPoller") {
  static readonly layer = Layer.effect(
    LimitPoller,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const keeper = yield* CredentialKeeper
      const limits = yield* LimitWindows
      const apis: Readonly<Record<Provider, UpstreamApi>> = {
        claude: yield* ClaudeApi,
        codex: yield* CodexApi,
      }
      const reading = yield* Semaphore.make(1)
      /** When each provider may be read again after a 429. */
      const busyUntil: Record<Provider, number> = { claude: 0, codex: 0 }
      /** When each account was last read, or skipped for needing sign-in or being disabled. */
      const lastRead = new Map<string, number>()

      const accounts = store.list.pipe(
        Effect.catch((error) =>
          Effect.logWarning("could not list accounts to read their limit windows").pipe(
            Effect.annotateLogs({ cause: error.message }),
            Effect.as<ReadonlyArray<Account>>([]),
          ),
        ),
      )

      /** Reads `account`'s windows from its provider's usage endpoint, one account at a time. */
      const read = (account: Account) =>
        reading.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (!servable(account)) {
              lastRead.set(account.id, now)
              return
            }
            if (busyUntil[account.provider] > now) return
            lastRead.set(account.id, now)
            const credentials = yield* keeper
              .credentialsFor(account)
              .pipe(Effect.orElseSucceed(() => Option.none<Credentials>()))
            if (Option.isNone(credentials)) return
            const result = yield* apis[account.provider].readWindows(
              account,
              credentials.value.accessToken,
              now,
            )
            const at = yield* Clock.currentTimeMillis
            switch (result._tag) {
              case "Read":
                return yield* limits.observe(account.id, result.windows, "endpoint", at, {
                  complete: true,
                })
              case "Busy":
                busyUntil[account.provider] = at + Math.min(MAX_RETRY_AFTER_MS, result.retryAfterMs)
                return yield* Effect.logWarning(
                  "provider asked to wait before reading limit windows again",
                ).pipe(
                  Effect.annotateLogs({
                    provider: account.provider,
                    until: new Date(busyUntil[account.provider]).toISOString(),
                  }),
                )
              case "Failed":
                return yield* Effect.logWarning("could not read limit windows").pipe(
                  Effect.annotateLogs({ account: account.id, reason: result.reason }),
                )
            }
          }),
        )

      const refresh = (accountId?: string) =>
        Effect.flatMap(accounts, (all) =>
          Effect.forEach(
            all.filter((account) => accountId === undefined || account.id === accountId),
            read,
            { discard: true },
          ),
        )

      /**
       * When `account` is next due a read on its own: now when it has never
       * been read, else just after the first known window that resets after
       * its last read, and never before its provider's `Retry-After` passes.
       */
      const dueAt = (account: Account): number | undefined => {
        const last = lastRead.get(account.id)
        if (last === undefined) return busyUntil[account.provider]
        if (!servable(account)) return undefined
        const resets = limits
          .known(account.id)
          .filter((window) => window.resetsAt > last)
          .map((window) => window.resetsAt + AFTER_RESET_MS)
        return resets.length === 0
          ? undefined
          : Math.max(Math.min(...resets), busyUntil[account.provider])
      }

      // A window observed may reset sooner than the wait, and an account
      // added has never been read: either wakes the wait early. Wakes that
      // come while a pass runs fold into one more pass.
      const wake = yield* Queue.sliding<void>(1)
      const nextChange = yield* limits.subscribe
      yield* nextChange.pipe(
        Effect.andThen(Queue.offer(wake, undefined)),
        Effect.forever,
        Effect.forkScoped,
      )
      const { feed } = yield* AccountEvents
      yield* feed.pipe(
        Stream.filter((event) => event.type === "added"),
        Stream.runForEach(() => Queue.offer(wake, undefined)),
        // A stream that ends, having fallen behind, is joined again.
        Effect.forever,
        Effect.forkScoped,
      )
      const started = yield* Clock.currentTimeMillis
      let everyoneAt = started + EVERY_MS

      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (now >= everyoneAt) {
          everyoneAt = now + EVERY_MS
          yield* refresh()
        }
        const all = yield* accounts
        const due = all.filter((account) => (dueAt(account) ?? Infinity) <= now)
        yield* Effect.forEach(due, read, { discard: true })
        const after = yield* Clock.currentTimeMillis
        // A deadline the pass ran past is due at once, not dropped.
        const nextAt = Math.min(everyoneAt, ...all.map((account) => dueAt(account) ?? Infinity))
        yield* Effect.timeoutOrElse(Queue.take(wake), {
          duration: Math.max(0, nextAt - after),
          orElse: () => Effect.void,
        })
      }).pipe(Effect.forever, Effect.forkScoped)

      return LimitPoller.of({ refresh })
    }),
  )
}
