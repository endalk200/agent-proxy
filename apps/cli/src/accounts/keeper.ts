import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Semaphore,
} from "effect"

import { ClaudeTokens } from "../providers/claude.ts"
import { CodexTokens } from "../providers/codex.ts"
import type { RefreshError, TokenAdapter } from "../providers/provider.ts"
import type { Account, Credentials, Provider } from "./account.ts"
import { AccountStore, type AccountStoreError } from "./store.ts"

/**
 * The credential keeper: keeps every account's tokens fresh, and flags an
 * account Needs sign-in when they cannot be kept fresh.
 *
 * Refresh tokens are single-use, so every refresh follows the same rules:
 *
 * - At most one refresh per account runs at a time; callers that wanted one
 *   meanwhile get its result.
 * - A new token pair is stored before anything uses it.
 * - A refresh that did not happen, or whose outcome is unknown (the
 *   connection failed, timed out, or a gateway answered), is tried again
 *   later with the same refresh token, and the token in hand serves
 *   meanwhile. Retrying never costs more than giving up: if the provider did
 *   spend the token, it refuses the retry, and the account goes to Needs
 *   sign-in as it would have anyway; if it did not, the retry just works.
 *   A daemon stopped mid-refresh is the same case: it refreshes again.
 * - A refresh the provider refuses for good flags the account Needs sign-in.
 *   Signing in again clears the flag.
 *
 * A refresh runs in the keeper's own fiber, so a request that wanted it and
 * then went away never cuts it short.
 */

/** How often the keeper looks for accounts due a refresh. */
const CHECK_EVERY = "1 minute"

/** How long the keeper waits before retrying a refresh that did not happen. */
const RETRY_AFTER_MS = Duration.toMillis(Duration.minutes(5))

const expiresAtMillis = (credentials: Credentials) => Date.parse(credentials.expiresAt)

export class CredentialKeeper extends Context.Service<
  CredentialKeeper,
  {
    /**
     * Credentials to call the provider with as `account`: its current ones,
     * refreshed first when they are due. None when the account cannot serve,
     * because it needs sign-in (perhaps from this very refresh) or is gone.
     */
    readonly credentialsFor: (
      account: Account,
    ) => Effect.Effect<Option.Option<Credentials>, AccountStoreError>
    /**
     * Credentials to retry with after the provider rejected `accessToken` for
     * `account`: refreshed once, unless another caller already replaced that
     * token. Returns the same token when no refresh was possible, and none
     * when the account cannot serve.
     */
    readonly credentialsAfterRejection: (
      account: Account,
      accessToken: string,
    ) => Effect.Effect<Option.Option<Credentials>, AccountStoreError>
  }
>()("agent-proxy/CredentialKeeper") {
  /** The keeper, checking the store's accounts until its scope closes. */
  static readonly layer = Layer.effect(
    CredentialKeeper,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const adapters: Readonly<Record<Provider, TokenAdapter>> = {
        claude: yield* ClaudeTokens,
        codex: yield* CodexTokens,
      }
      const scope = yield* Effect.scope
      const locks = new Map<string, Semaphore.Semaphore>()
      /** Accounts whose last refresh did not happen, and when to try again. */
      const retryAt = yield* Ref.make(new Map<string, number>())

      const lockFor = (id: string) => {
        const existing = locks.get(id)
        if (existing !== undefined) return existing
        const lock = Semaphore.makeUnsafe(1)
        locks.set(id, lock)
        return lock
      }

      const isDue = (account: Account, now: number) =>
        now >=
        expiresAtMillis(account.credentials) -
          Duration.toMillis(adapters[account.provider].refreshLead)

      /** Records how a sent refresh ended, if the account still holds the refresh token it used. */
      const settle = (account: Account, ended: Partial<Account>) =>
        store.updateCredentials(account.id, (current) =>
          current.credentials.refreshToken === account.credentials.refreshToken
            ? {
                credentials: ended.credentials ?? current.credentials,
                needsSignIn: ended.needsSignIn ?? current.needsSignIn,
              }
            : undefined,
        )

      /** Refreshes `account`'s tokens once and stores the outcome. */
      const refresh = Effect.fnUntraced(function* (account: Account) {
        const adapter = adapters[account.provider]
        const now = yield* Clock.currentTimeMillis
        const outcome = yield* Effect.result(adapter.refresh(account.credentials.refreshToken))
        if (outcome._tag === "Success") {
          yield* Ref.update(retryAt, (all) => {
            const next = new Map(all)
            next.delete(account.id)
            return next
          })
          const stored = yield* settle(account, {
            credentials: outcome.success,
            needsSignIn: false,
          })
          yield* Effect.logInfo("account tokens refreshed")
          return stored
        }
        return yield* failed(account, outcome.failure, now)
      })

      const failed = Effect.fnUntraced(function* (
        account: Account,
        error: RefreshError,
        now: number,
      ) {
        if (error._tag !== "RefreshRejected") {
          yield* Ref.update(retryAt, (all) => new Map(all).set(account.id, now + RETRY_AFTER_MS))
          yield* Effect.logWarning("account tokens not refreshed; will retry").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          )
          return yield* settle(account, {})
        }
        yield* Effect.logWarning("account needs sign-in").pipe(
          Effect.annotateLogs({ reason: `The refresh was refused: ${error.reason}` }),
        )
        return yield* settle(account, { needsSignIn: true })
      })

      /**
       * The account's credentials once a refresh has run if `wanted` says the
       * stored account still needs one: one refresh per account at a time,
       * run in the keeper's scope.
       */
      const refreshIf = (id: string, wanted: (account: Account) => boolean) =>
        lockFor(id)
          .withPermit(
            Effect.gen(function* () {
              const account = (yield* store.list).find((candidate) => candidate.id === id)
              if (account === undefined || account.needsSignIn) return Option.none<Account>()
              const now = yield* Clock.currentTimeMillis
              const retry = (yield* Ref.get(retryAt)).get(id)
              if (!wanted(account) || (retry !== undefined && now < retry)) {
                return Option.some(account)
              }
              return yield* refresh(account)
            }).pipe(Effect.annotateLogs({ account: id })),
          )
          .pipe(
            Effect.forkIn(scope),
            Effect.flatMap(Fiber.join),
            Effect.map(
              Option.flatMap((account) =>
                account.needsSignIn ? Option.none() : Option.some(account.credentials),
              ),
            ),
          )

      const credentialsFor = Effect.fn("CredentialKeeper.credentialsFor")(function* (
        account: Account,
      ) {
        const now = yield* Clock.currentTimeMillis
        if (!isDue(account, now)) return Option.some(account.credentials)
        return yield* refreshIf(account.id, (current) => isDue(current, now))
      })

      const credentialsAfterRejection = Effect.fn("CredentialKeeper.credentialsAfterRejection")(
        function* (account: Account, accessToken: string) {
          return yield* refreshIf(
            account.id,
            (current) => current.credentials.accessToken === accessToken,
          )
        },
      )

      /** Refreshes every account that is due, one after another. */
      const check = Effect.gen(function* () {
        const accounts = yield* store.list
        const now = yield* Clock.currentTimeMillis
        for (const account of accounts) {
          if (account.needsSignIn || !isDue(account, now)) continue
          yield* refreshIf(account.id, (current) => isDue(current, now))
        }
      }).pipe(Effect.ignore({ log: "Error", message: "could not check accounts for refresh" }))

      // A ticker asks for a check every minute, and a checker runs one check
      // per ask. A tick while a check is still running asks for one more
      // check after it rather than being lost, so each check sees the time of
      // the latest tick at least, however long the store takes to read.
      const ticks = yield* Queue.sliding<void>(1)
      yield* Queue.offer(ticks, undefined)
      yield* Effect.sleep(CHECK_EVERY).pipe(
        Effect.andThen(Queue.offer(ticks, undefined)),
        Effect.forever,
        Effect.forkScoped,
      )
      yield* Queue.take(ticks).pipe(Effect.andThen(check), Effect.forever, Effect.forkScoped)

      return CredentialKeeper.of({ credentialsFor, credentialsAfterRejection })
    }),
  )
}
