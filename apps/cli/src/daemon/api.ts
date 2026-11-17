import { Schema } from "effect"

import { type Account, AccountStatus, accountStatus, Provider } from "../accounts/account.ts"

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

export const AccountList = Schema.Struct({ accounts: Schema.Array(AccountView) })
export type AccountList = typeof AccountList.Type

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
  label: Schema.optionalKey(Schema.NonEmptyString),
})
export type StartLogin = typeof StartLogin.Type

/** `POST /api/logins/:id/callback`: finish a login with the callback URL the owner pasted. */
export const SubmitCallback = Schema.Struct({ url: Schema.String })
