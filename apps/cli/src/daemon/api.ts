import { Schema } from "effect"

import {
  type Account,
  AccountStatus,
  accountStatus,
  chooseAccount,
  Provider,
} from "../accounts/account.ts"

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
  addedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
})
export type AccountView = typeof AccountView.Type

export const toAccountView = (account: Account): AccountView => ({
  id: account.id,
  provider: account.provider,
  providerAccountId: account.providerAccountId,
  label: account.label,
  email: account.email,
  plan: account.plan,
  priority: account.priority,
  enabled: account.enabled,
  status: accountStatus(account),
  addedAt: account.addedAt,
  lastUsedAt: account.lastUsedAt,
})

/** A provider's pool, as the daemon API reports it. */
export const PoolView = Schema.Struct({
  provider: Provider,
  /** The account a new session goes to now, or null when no account in the pool is Active. */
  newSessionsAccountId: Schema.NullOr(Schema.String),
})
export type PoolView = typeof PoolView.Type

/** `GET /api/accounts`: every account, and a pool for each provider that has one. */
export const AccountList = Schema.Struct({
  accounts: Schema.Array(AccountView),
  pools: Schema.Array(PoolView),
})
export type AccountList = typeof AccountList.Type

export const toAccountList = (accounts: ReadonlyArray<Account>): AccountList => ({
  accounts: accounts.map(toAccountView),
  pools: [...new Set(accounts.map((account) => account.provider))].map((provider) => ({
    provider,
    newSessionsAccountId: chooseAccount(accounts, provider)?.id ?? null,
  })),
})

/** `PATCH /api/accounts/:id`: change an account's settings; each one left out stays as it is. */
/** A label: at least one character that is not a space; it is stored trimmed. */
const Label = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""))

export const UpdateAccount = Schema.Struct({
  label: Schema.optionalKey(Label),
  /** A position in the account's pool, 1 first; the others shift to make room. */
  priority: Schema.optionalKey(Schema.Int),
  /** A disabled account sits out of its pool and keeps its priority. */
  enabled: Schema.optionalKey(Schema.Boolean),
})
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
