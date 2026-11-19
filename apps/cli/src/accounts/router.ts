import { Clock, Context, Duration, Effect, Layer } from "effect"

import { LimitWindows } from "../usage/limit-windows.ts"
import { type Account, type AccountStatus, accountStatus, type Provider } from "./account.ts"
import { AccountChanges } from "./changes.ts"
import { AccountStore, type AccountStoreError } from "./store.ts"

/**
 * The router (ADR-0003): chooses which account of a pool serves each
 * request, and keeps what that takes in memory only: each session's account
 * and each account's cooldown. Headroom comes from the limit windows the
 * daemon knows, the same ones the dashboard shows.
 *
 * - A session goes to its bound account while that account is Active and the
 *   session has not been idle for an hour.
 * - Otherwise, and for a request with no session, the request goes to the
 *   highest-priority Active account; equal priorities go to the most
 *   headroom, and unknown headroom counts as full.
 * - A limit the provider reports cools the account down until the limit
 *   resets, and raises `AccountChanges`' signal. A daemon that restarts has
 *   no cooldowns until the provider reports them again.
 */

/** What a provider's answer says about the account's limits, as its adapter reads it. */
export type LimitSignal =
  /** Not limited. */
  | { readonly _tag: "Within" }
  /** A short rate limit, such as per minute: retry after `retryAfterMs`. */
  | { readonly _tag: "RateLimited"; readonly retryAfterMs: number }
  /**
   * A plan's usage window is used up until `resetsAt` (epoch milliseconds).
   * `window` names it in the provider's words, such as Claude's `five_hour`.
   */
  | {
      readonly _tag: "WindowLimited"
      readonly resetsAt: number
      readonly window: string | undefined
    }

/** An account's cooldown: out of its pool until `until` (epoch milliseconds). */
export interface Cooldown {
  readonly until: number
  /** The usage window that ran out, in the provider's words; none for a short rate limit. */
  readonly window: string | undefined
}

/** Where a request goes. */
export type Choice =
  /**
   * `seen` is the session's binding as the router saw it when choosing; hand
   * it back to `record`, so an answer that arrives after the session moved on
   * never moves it back.
   */
  | { readonly _tag: "Chosen"; readonly account: Account; readonly seen: SeenBinding }
  /** No account can serve it now, and at least one is cooling down; `cooldown`, account `accountId`'s, ends first. */
  | { readonly _tag: "CoolingDown"; readonly cooldown: Cooldown; readonly accountId: string }
  /** No account can serve it until the owner acts: each one needs sign-in or is disabled, or there is none. */
  | { readonly _tag: "Unavailable"; readonly accounts: ReadonlyArray<Account> }

/** A session's binding as the router saw it when it chose an account; opaque to callers. */
export type SeenBinding = object | undefined

/** How the router sees accounts right now, for the daemon API. */
export interface RoutingView {
  readonly status: (account: Account) => AccountStatus
  /** When the account's cooldown ends, if one is running. */
  readonly cooldownEndsAt: (account: Account) => number | undefined
  /** The account a new session in `provider`'s pool goes to now. */
  readonly newSessions: (
    accounts: ReadonlyArray<Account>,
    provider: Provider,
  ) => Account | undefined
}

/** How long a session keeps its account without a request. */
const SESSION_IDLE_MS = Duration.toMillis(Duration.hours(1))

/**
 * The shortest cooldown: a limit that says it is already over still keeps
 * the account out briefly, so a request never retries it at once.
 */
const MIN_COOLDOWN_MS = 1000

/**
 * A session's account. Its identity is what `SeenBinding` compares, so it is
 * replaced only when the session moves to another account; a request that
 * keeps the session on its account only moves `at`.
 */
interface Binding {
  readonly accountId: string
  /** When the session last sent a request, in epoch milliseconds. */
  at: number
}

const bindingKey = (provider: Provider, session: string) => `${provider}\u0000${session}`

export class Router extends Context.Service<
  Router,
  {
    /**
     * Where a request for `provider` goes: in `session` when the client named
     * one, and never to an account in `tried`, which this request already
     * found limited or unable to serve.
     */
    readonly choose: (
      provider: Provider,
      session: string | undefined,
      tried: ReadonlySet<string>,
    ) => Effect.Effect<Choice, AccountStoreError>
    /**
     * Records what `account`'s answer said: a limit cools the account down;
     * any other answer binds `session` to it.
     */
    readonly record: (
      account: Account,
      session: string | undefined,
      signal: LimitSignal,
      seen?: SeenBinding,
    ) => Effect.Effect<void>
    readonly view: Effect.Effect<RoutingView>
  }
>()("agent-proxy/Router") {
  static readonly layer = Layer.effect(
    Router,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const changes = yield* AccountChanges
      const limits = yield* LimitWindows
      const bindings = new Map<string, Binding>()
      const cooldowns = new Map<string, Cooldown>()

      const coolingAt = (now: number) => (account: Account) => {
        const cooldown = cooldowns.get(account.id)
        return cooldown !== undefined && cooldown.until > now ? cooldown : undefined
      }

      const viewAt = (now: number): RoutingView => {
        const cooling = coolingAt(now)
        const headroom = (account: Account) => limits.headroom(account.id, now) ?? 1
        const status = (account: Account) => accountStatus(account, cooling(account) !== undefined)
        return {
          status,
          // Only a cooldown that decides the status is reported: a disabled
          // or signed-out account is not waiting for its limit to reset.
          cooldownEndsAt: (account) =>
            status(account) === "cooling-down" ? cooling(account)?.until : undefined,
          newSessions: (accounts, provider) =>
            accounts
              .filter((account) => account.provider === provider && status(account) === "active")
              .toSorted((a, b) => a.priority - b.priority || headroom(b) - headroom(a))[0],
        }
      }

      const choose = Effect.fn("Router.choose")(function* (
        provider: Provider,
        session: string | undefined,
        tried: ReadonlySet<string>,
      ) {
        const now = yield* Clock.currentTimeMillis
        const accounts = yield* store.list
        const view = viewAt(now)
        const servable = accounts.filter(
          (account) =>
            account.provider === provider &&
            !tried.has(account.id) &&
            view.status(account) === "active",
        )

        const binding =
          session === undefined ? undefined : bindings.get(bindingKey(provider, session))
        const bound =
          binding !== undefined && now - binding.at < SESSION_IDLE_MS
            ? servable.find((account) => account.id === binding.accountId)
            : undefined
        const account = bound ?? view.newSessions(servable, provider)
        if (account !== undefined)
          return { _tag: "Chosen", account, seen: binding } satisfies Choice

        // Out of the pool only until a limit resets: the client hears when.
        const waiting = accounts.flatMap((candidate) => {
          if (candidate.provider !== provider || !candidate.enabled || candidate.needsSignIn) {
            return []
          }
          const cooldown = cooldowns.get(candidate.id)
          return cooldown !== undefined && (cooldown.until > now || tried.has(candidate.id))
            ? [{ cooldown, accountId: candidate.id }]
            : []
        })
        const first = waiting.toSorted((a, b) => a.cooldown.until - b.cooldown.until)[0]
        return first === undefined
          ? ({ _tag: "Unavailable", accounts } satisfies Choice)
          : ({ _tag: "CoolingDown", ...first } satisfies Choice)
      })

      const coolDown = (account: Account, cooldown: Cooldown) =>
        Effect.suspend(() => {
          // Answers in flight together can arrive in any order: a short limit
          // never shortens a longer cooldown already running.
          const running = cooldowns.get(account.id)
          if (running !== undefined && running.until >= cooldown.until) return Effect.void
          cooldowns.set(account.id, cooldown)
          return Effect.logInfo("account cooling down").pipe(
            Effect.annotateLogs({
              account: account.id,
              until: new Date(cooldown.until).toISOString(),
              window: cooldown.window ?? "rate limit",
            }),
            Effect.andThen(changes.signal),
          )
        })

      const record = Effect.fn("Router.record")(function* (
        account: Account,
        session: string | undefined,
        signal: LimitSignal,
        seen?: SeenBinding,
      ) {
        const now = yield* Clock.currentTimeMillis
        switch (signal._tag) {
          case "Within": {
            for (const [key, binding] of bindings) {
              if (now - binding.at >= SESSION_IDLE_MS) bindings.delete(key)
            }
            if (session !== undefined) {
              const key = bindingKey(account.provider, session)
              const current = bindings.get(key)
              // Rebind only from the binding this request was routed by: a late
              // answer from an account the session has since left is ignored.
              // Staying on the same account keeps the binding, so a failover
              // routed by it while this answer was in flight can still rebind.
              if (current !== undefined && current.accountId === account.id) {
                current.at = now
              } else if (current === undefined || current === seen) {
                bindings.set(key, { accountId: account.id, at: now })
              }
            }
            return
          }
          case "RateLimited":
            return yield* coolDown(account, {
              until: now + Math.max(MIN_COOLDOWN_MS, signal.retryAfterMs),
              window: undefined,
            })
          case "WindowLimited":
            return yield* coolDown(account, {
              until: Math.max(now + MIN_COOLDOWN_MS, signal.resetsAt),
              window: signal.window,
            })
        }
      })

      return Router.of({
        choose,
        record,
        view: Effect.map(Clock.currentTimeMillis, viewAt),
      })
    }),
  )
}
