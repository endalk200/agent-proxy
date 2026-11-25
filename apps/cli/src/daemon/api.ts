import { Effect, Schema } from "effect"

import { type Account, AccountStatus, Provider } from "../accounts/account.ts"
import type { RoutingView } from "../accounts/router.ts"
import type { AccountLimits, LimitResetView as LimitReset } from "../usage/limit-windows.ts"
import type { ClientName, TokenCounts, UsageStatus } from "../usage/usage.ts"

/**
 * The daemon API's JSON shapes, shared by the daemon that serves them and the
 * CLI that calls them. Credentials never appear here.
 */

/** An account as the daemon API reports it. */
export const AccountView = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  providerAccountId: Schema.String,
  label: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  priority: Schema.Int,
  enabled: Schema.Boolean,
  status: AccountStatus,
  /** When a `cooling-down` account's cooldown ends, as an ISO 8601 timestamp; null for any other status. */
  cooldownEndsAt: Schema.NullOr(Schema.String),
  addedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
})
export type AccountView = typeof AccountView.Type

const isoOrNull = (millis: number | undefined) =>
  millis === undefined ? null : new Date(millis).toISOString()

/** `account` as the daemon API reports it, with its status as `routing` sees it. */
export const toAccountView = (account: Account, routing: RoutingView): AccountView => ({
  id: account.id,
  provider: account.provider,
  providerAccountId: account.providerAccountId,
  label: account.label,
  email: account.email,
  plan: account.plan,
  priority: account.priority,
  enabled: account.enabled,
  status: routing.status(account),
  cooldownEndsAt: isoOrNull(routing.cooldownEndsAt(account)),
  addedAt: account.addedAt,
  lastUsedAt: account.lastUsedAt,
})

/** A provider's pool, as the daemon API reports it. */
export const PoolView = Schema.Struct({
  provider: Provider,
  /** The account a new session goes to now, or null when no account in the pool is Active. */
  newSessionsAccountId: Schema.NullOr(Schema.String),
  /**
   * Every Active account, in the order new sessions go to them now: by
   * priority, then the most headroom. The first is `newSessionsAccountId`;
   * each after it gets new sessions when those before it can't.
   */
  newSessionsOrder: Schema.Array(Schema.String),
})
export type PoolView = typeof PoolView.Type

/** Every account, and a pool for each provider that has one, as the event stream reports them. */
export const AccountList = Schema.Struct({
  accounts: Schema.Array(AccountView),
  pools: Schema.Array(PoolView),
})
export type AccountList = typeof AccountList.Type

/** One of an account's limit resets, as the daemon API reports it. */
export const LimitResetView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The windows it refills, by id and the owner's name for each. */
  refills: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  /**
   * When the provider granted it, epoch milliseconds; null when the provider
   * does not say, or the daemon predates grant dates and sends none.
   */
  grantedAt: Schema.NullOr(Schema.Finite).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** When it expires unredeemed, epoch milliseconds; null when the provider gives no end. */
  expiresAt: Schema.NullOr(Schema.Finite),
  usableNow: Schema.Boolean,
  /** Why it cannot be redeemed right now, in the provider's words. */
  unavailableReason: Schema.NullOr(Schema.String),
  asOf: Schema.Finite,
})
export type LimitResetView = typeof LimitResetView.Type

/** An account as `GET /api/accounts` lists it: with its limit resets, the soonest to expire first. */
export const ListedAccount = Schema.Struct({
  ...AccountView.fields,
  limitResets: Schema.Array(LimitResetView),
})
export type ListedAccount = typeof ListedAccount.Type

/** `GET /api/accounts`: every account with its limit resets, and a pool for each provider that has one. */
export const AccountListing = Schema.Struct({
  accounts: Schema.Array(ListedAccount),
  pools: Schema.Array(PoolView),
})
export type AccountListing = typeof AccountListing.Type

/** A pool for each provider that has an account, as `routing` sees them now. */
export const toPools = (
  accounts: ReadonlyArray<Account>,
  routing: RoutingView,
): ReadonlyArray<PoolView> =>
  [...new Set(accounts.map((account) => account.provider))].map((provider) => {
    const order = routing.newSessionsOrder(accounts, provider).map((account) => account.id)
    return { provider, newSessionsAccountId: order[0] ?? null, newSessionsOrder: order }
  })

export const toAccountList = (
  accounts: ReadonlyArray<Account>,
  routing: RoutingView,
): AccountList => ({
  accounts: accounts.map((account) => toAccountView(account, routing)),
  pools: toPools(accounts, routing),
})

/** `GET /api/accounts`'s answer, each account with the limit resets `resetsOf` gives. */
export const toAccountListing = (
  accounts: ReadonlyArray<Account>,
  routing: RoutingView,
  resetsOf: (account: Account) => ReadonlyArray<LimitReset>,
): AccountListing => ({
  accounts: accounts.map((account) => ({
    ...toAccountView(account, routing),
    limitResets: resetsOf(account),
  })),
  pools: toPools(accounts, routing),
})

/** An account's limit windows and limit resets, as `GET /api/limits` reports them. */
export const LimitsView = Schema.Struct({
  accountId: Schema.String,
  asOf: Schema.NullOr(Schema.Finite),
  windows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      usedPct: Schema.Finite,
      resetsAt: Schema.Finite,
      asOf: Schema.Finite,
      /** A spend limit's money spent and most allowed, in major units; only on a spend limit. */
      spend: Schema.optional(
        Schema.Struct({ used: Schema.Finite, limit: Schema.Finite, currency: Schema.String }),
      ),
    }),
  ),
  limitResets: Schema.Array(LimitResetView),
  canBuyReset: Schema.Boolean,
})
export type LimitsView = typeof LimitsView.Type

/** Why a provider refused to redeem a limit reset; nothing was spent. */
export const RedeemRefusal = Schema.Literals([
  "nothing-to-refill",
  "already-redeemed",
  "cooldown",
  "ineligible",
  "unavailable",
  "rejected",
])

/** `POST /api/accounts/:id/limit-resets/:resetId/redeem`: how the redeem went. */
export const RedeemResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("redeemed"),
    message: Schema.String,
    limits: LimitsView,
  }),
  Schema.Struct({
    outcome: Schema.Literal("refused"),
    reason: RedeemRefusal,
    message: Schema.String,
    limits: LimitsView,
  }),
  Schema.Struct({
    outcome: Schema.Literal("unknown"),
    message: Schema.String,
    limits: LimitsView,
  }),
])
export type RedeemResult = typeof RedeemResult.Type

/**
 * The first message on `GET /api/events`: every account and pool as they are
 * when the stream opens, the same as `GET /api/accounts` answers. Every
 * message after it is an {@link AccountEvent} that happened later.
 */
export const AccountSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  accounts: Schema.Array(AccountView),
  pools: Schema.Array(PoolView),
})
export type AccountSnapshot = typeof AccountSnapshot.Type

/**
 * A change to one account, on `GET /api/events`. Each event carries the
 * account as it is now and every pool as it is now, so a client applies it
 * without asking again:
 *
 * - `added`: the daemon holds a new account.
 * - `removed`: the daemon forgot `account`, shown as it was.
 * - `status-changed`: its status or cooldown end changed: a cooldown started
 *   or ended, it needs sign-in or was signed in again, or it was disabled or
 *   enabled. `previous` is the account before.
 * - `settings-changed`: its label or priority changed, or its email or plan
 *   after a fresh sign-in, and its status did not. `previous` is the account before.
 * - `used`: it served a request, and nothing else changed: only `lastUsedAt`
 *   moved, which the daemon records at most once a minute.
 *
 * When no account changed but the order new sessions go in did, as accounts
 * sharing a priority trade places by headroom, a {@link PoolsChanged} says so.
 */
export const AccountEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["added", "removed", "used"]),
    account: AccountView,
    pools: Schema.Array(PoolView),
  }),
  Schema.Struct({
    type: Schema.Literals(["status-changed", "settings-changed"]),
    account: AccountView,
    previous: AccountView,
    pools: Schema.Array(PoolView),
  }),
])
export type AccountEvent = typeof AccountEvent.Type

/** The pools changed, and no account did, on `GET /api/events`; `pools` is every pool as it is now. */
export interface PoolsChanged {
  readonly type: "pools-changed"
  readonly pools: ReadonlyArray<PoolView>
}

/**
 * A proxied request finished and was recorded, on `GET /api/events`: when it
 * ended, which account served it, and what it spent.
 */
export interface UsageRecorded {
  readonly type: "usage-recorded"
  readonly usage: {
    readonly at: number
    readonly provider: Provider
    readonly accountId: string
    readonly model: string
    readonly client: ClientName
    readonly status: UsageStatus
    readonly tokens: TokenCounts
  }
}

/** One account's limit windows changed, on `GET /api/events`; `limits` is all of them as they are now. */
export interface LimitsChanged {
  readonly type: "limits-changed"
  readonly limits: AccountLimits
}

/** Every message on `GET /api/events` after the snapshot. */
export type DaemonEvent = AccountEvent | PoolsChanged | UsageRecorded | LimitsChanged

/** The fields of an account view that make a `settings-changed` event when they change. */
const settingsChanged = (before: AccountView, after: AccountView) =>
  before.label !== after.label ||
  before.priority !== after.priority ||
  before.enabled !== after.enabled ||
  before.email !== after.email ||
  before.plan !== after.plan ||
  before.provider !== after.provider ||
  before.providerAccountId !== after.providerAccountId

/** True when `a` and `b` say the same about every pool. */
const samePools = (a: ReadonlyArray<PoolView>, b: ReadonlyArray<PoolView>) =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * The events that take a client from `before` to `after`: removals, then
 * additions, then changes, or a `pools-changed` when only the pools moved.
 */
export const accountEvents = (
  before: AccountList,
  after: AccountList,
): Array<AccountEvent | PoolsChanged> => {
  const pools = after.pools
  const was = new Map(before.accounts.map((account) => [account.id, account]))
  const now = new Set(after.accounts.map((account) => account.id))
  const events: Array<AccountEvent | PoolsChanged> = before.accounts
    .filter((account) => !now.has(account.id))
    .map((account) => ({ type: "removed", account, pools }))
  for (const account of after.accounts) {
    const previous = was.get(account.id)
    if (previous === undefined) events.push({ type: "added", account, pools })
  }
  for (const account of after.accounts) {
    const previous = was.get(account.id)
    if (previous === undefined) continue
    if (previous.status !== account.status || previous.cooldownEndsAt !== account.cooldownEndsAt) {
      events.push({ type: "status-changed", account, previous, pools })
    } else if (settingsChanged(previous, account)) {
      events.push({ type: "settings-changed", account, previous, pools })
    } else if (previous.lastUsedAt !== account.lastUsedAt) {
      events.push({ type: "used", account, pools })
    }
  }
  if (events.length === 0 && !samePools(before.pools, after.pools)) {
    return [{ type: "pools-changed", pools }]
  }
  return events
}

/** `PATCH /api/accounts/:id`: change an account's settings; each one left out stays as it is. */
/** A label: at least one character that is not a space; it is stored trimmed. */
const Label = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""))

export const UpdateAccount = Schema.Struct({
  label: Schema.optionalKey(Label),
  /**
   * A priority in the account's pool, 1 first, which it then holds alone:
   * the accounts from that priority down move down one.
   */
  priority: Schema.optionalKey(Schema.Int),
  /** Another account in the pool, by id, whose priority it then shares; not with `priority`. */
  sharePriorityWith: Schema.optionalKey(Schema.String),
  /** A disabled account sits out of its pool and keeps its priority. */
  enabled: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (update) => update.priority === undefined || update.sharePriorityWith === undefined,
  ),
)
export type UpdateAccount = typeof UpdateAccount.Type

/** The body of every error the daemon API returns. */
export const ApiError = Schema.Struct({ error: Schema.String })

/**
 * Where a login stands: waiting for the owner to sign in (`pending`), or
 * finished, whether it added or updated an account (`succeeded`) or not.
 */
export const LoginStatus = Schema.Literals([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
])
export type LoginStatus = typeof LoginStatus.Type

/** A login the daemon runs for a provider (ADR-0007). */
export const LoginView = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  /** The provider's sign-in page, to open in a browser. */
  authorizeUrl: Schema.String,
  status: LoginStatus,
  /** Why a `failed` login failed. */
  error: Schema.optionalKey(Schema.String),
  /** The account a `succeeded` login added or updated. */
  account: Schema.optionalKey(AccountView),
  /** True when a `succeeded` login added a new account, false when it updated one. */
  created: Schema.optionalKey(Schema.Boolean),
})
export type LoginView = typeof LoginView.Type

/** `POST /api/logins`: start a login. */
export const StartLogin = Schema.Struct({
  provider: Provider,
  /** The label for a new account, or a new label for an account signed in again. */
  label: Schema.optionalKey(Label),
})
export type StartLogin = typeof StartLogin.Type

/** `POST /api/logins/:id/callback`: finish a login with the callback URL the owner pasted. */
export const SubmitCallback = Schema.Struct({ url: Schema.String })

/** `GET /api/key` and `POST /api/key/rotate`: the proxy key clients present (ADR-0005). */
export const ProxyKeyView = Schema.Struct({ key: Schema.String })
export type ProxyKeyView = typeof ProxyKeyView.Type
