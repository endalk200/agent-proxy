import { randomUUID } from "node:crypto"

import { Clock, Context, Data, Effect, Layer, Option, Semaphore } from "effect"

import { type Account, type Provider, providerNames } from "../accounts/account.ts"
import { CredentialKeeper } from "../accounts/keeper.ts"
import { Router } from "../accounts/router.ts"
import { AccountNotFound, AccountStore, type AccountStoreError } from "../accounts/store.ts"
import { ClaudeApi } from "../providers/claude-api.ts"
import { CodexApi } from "../providers/codex-api.ts"
import type { RedeemAnswer, RedeemRefusal, UpstreamApi } from "../providers/upstream.ts"
import { type AccountLimits, LimitWindows } from "./limit-windows.ts"
import { LimitPoller } from "./poller.ts"

/**
 * Redeems an account's limit reset, only ever at the owner's command
 * (ADR-0010): the dashboard and `agent-proxy accounts redeem` ask for it
 * through the daemon API, and nothing in the daemon does on its own.
 *
 * - Each redeem is a new request id. An attempt that got no answer is sent
 *   once more with the same id, which the provider takes as the same redeem;
 *   if that too gets none, the outcome is unknown.
 * - A redeemed reset ends the account's cooldown from a used-up limit window
 *   at once, so it serves again; a short rate limit's cooldown stays.
 * - Whatever the outcome, the account's windows and limit resets are read
 *   again, so what the daemon reports is the provider's word on them.
 * - A disabled account may redeem: the owner asked. One that needs sign-in
 *   cannot, and nothing reaches the provider.
 */

/** The account holds no limit reset with this id, or it has expired. */
export class LimitResetNotFound extends Data.TaggedError("LimitResetNotFound")<{
  readonly accountId: string
  readonly resetId: string
}> {
  override get message() {
    return `Account ${this.accountId} holds no limit reset ${this.resetId}. It may have been redeemed or expired; list them again.`
  }
}

/** The account needs sign-in, so it cannot call its provider to redeem. */
export class RedeemNeedsSignIn extends Data.TaggedError("RedeemNeedsSignIn")<{
  readonly provider: Provider
  readonly label: string
}> {
  override get message() {
    return `${providerNames[this.provider]} account "${this.label}" needs sign-in before it can redeem a limit reset. Sign in to it again with \`agent-proxy accounts add ${this.provider}\`.`
  }
}

/** How a redeem went, as the daemon API reports it, with the account's limits read after it. */
export type RedeemResult =
  | { readonly outcome: "redeemed"; readonly message: string; readonly limits: AccountLimits }
  | {
      readonly outcome: "refused"
      readonly reason: RedeemRefusal
      readonly message: string
      readonly limits: AccountLimits
    }
  | { readonly outcome: "unknown"; readonly message: string; readonly limits: AccountLimits }

/** Why `provider` refused, in words that finish "… was not redeemed: ". */
const refusalText = (provider: Provider, reason: RedeemRefusal) => {
  const name = providerNames[provider]
  switch (reason) {
    case "nothing-to-refill":
      return "the windows it refills still have room, so it would change nothing"
    case "already-redeemed":
      return "it was already redeemed"
    case "cooldown":
      return `${name} allows another limit reset only once its wait between resets has passed`
    case "ineligible":
      return `${name} says this account may not redeem it`
    case "unavailable":
      return `${name} says it is no longer available`
    case "rejected":
      return `${name} turned the request down`
  }
}

export class Redeemer extends Context.Service<
  Redeemer,
  {
    /** Redeems `accountId`'s limit reset `resetId`, and says how it went. */
    readonly redeem: (
      accountId: string,
      resetId: string,
    ) => Effect.Effect<
      RedeemResult,
      AccountNotFound | LimitResetNotFound | RedeemNeedsSignIn | AccountStoreError
    >
  }
>()("agent-proxy/Redeemer") {
  static readonly layer = Layer.effect(
    Redeemer,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const keeper = yield* CredentialKeeper
      const limits = yield* LimitWindows
      const router = yield* Router
      const poller = yield* LimitPoller
      const apis: Readonly<Record<Provider, UpstreamApi>> = {
        claude: yield* ClaudeApi,
        codex: yield* CodexApi,
      }
      // One redeem at a time: two at once could spend two resets on one limit.
      const redeeming = yield* Semaphore.make(1)

      /** Sends the redeem, and once more with the same request id when the first got no answer. */
      const attempt = Effect.fnUntraced(function* (
        account: Account,
        accessToken: string,
        resetId: string,
      ) {
        const api = apis[account.provider]
        const requestId = randomUUID()
        const first = yield* api.redeemReset(account, accessToken, resetId, requestId)
        if (first._tag !== "Unanswered") return first
        yield* Effect.logWarning("no answer to a limit reset redeem; sending it again").pipe(
          Effect.annotateLogs({ account: account.id, reset: resetId, reason: first.reason }),
        )
        const again = yield* api.redeemReset(account, accessToken, resetId, requestId)
        // The first may have redeemed it: "already redeemed" no longer says nothing was spent.
        return again._tag === "Refused" && again.reason === "already-redeemed"
          ? ({ _tag: "Unanswered", reason: "redeemed already, perhaps by the first try" } as const)
          : again
      })

      const redeem = Effect.fn("Redeemer.redeem")(function* (accountId: string, resetId: string) {
        const account = (yield* store.list).find((candidate) => candidate.id === accountId)
        if (account === undefined) return yield* new AccountNotFound({ id: accountId })
        const needsSignIn = new RedeemNeedsSignIn({
          provider: account.provider,
          label: account.label,
        })
        if (account.needsSignIn) return yield* needsSignIn
        const reset = limits
          .report(account.id, yield* Clock.currentTimeMillis)
          .limitResets.find((candidate) => candidate.id === resetId)
        if (reset === undefined) return yield* new LimitResetNotFound({ accountId, resetId })
        const credentials = yield* keeper.credentialsFor(account)
        if (Option.isNone(credentials)) return yield* needsSignIn

        const answer: RedeemAnswer = yield* attempt(account, credentials.value.accessToken, resetId)
        yield* Effect.logInfo("limit reset redeem").pipe(
          Effect.annotateLogs({
            account: account.id,
            reset: resetId,
            outcome: answer._tag,
            ...(answer._tag === "Refused" ? { reason: answer.reason } : {}),
          }),
        )
        if (answer._tag === "Redeemed") {
          yield* limits.redeemed(account.id, resetId)
          yield* router.endWindowCooldown(account)
        }
        yield* poller.readNow(account)
        const after = limits.report(account.id, yield* Clock.currentTimeMillis)
        const name = providerNames[account.provider]
        switch (answer._tag) {
          case "Redeemed":
            return {
              outcome: "redeemed",
              message: `Redeemed "${reset.name}" on ${name} account "${account.label}".`,
              limits: after,
            } satisfies RedeemResult
          case "Refused":
            return {
              outcome: "refused",
              reason: answer.reason,
              message: `"${reset.name}" was not redeemed: ${refusalText(account.provider, answer.reason)}${answer.detail === undefined ? "" : ` (${answer.detail})`}. Nothing was spent.`,
              limits: after,
            } satisfies RedeemResult
          case "Unanswered":
            return {
              outcome: "unknown",
              message: `No answer came back from ${name}, so whether "${reset.name}" was redeemed is unknown. List the account's limit resets: a redeemed one is no longer there.`,
              limits: after,
            } satisfies RedeemResult
        }
      })

      return Redeemer.of({
        redeem: (accountId, resetId) => redeeming.withPermit(redeem(accountId, resetId)),
      })
    }),
  )
}
