import { Schema } from "effect"

/** The providers whose accounts agent-proxy can hold. */
export const Provider = Schema.Literals(["claude", "codex"])
export type Provider = typeof Provider.Type

/** Each provider's name as the owner reads it. */
export const providerNames: Readonly<Record<Provider, string>> = {
  claude: "Claude",
  codex: "Codex",
}

/** A provider's OAuth tokens for one account. */
export const Credentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  /** When the access token expires, as an ISO 8601 timestamp. */
  expiresAt: Schema.String,
})
export type Credentials = typeof Credentials.Type

/** Who an account is, as its provider reports it at login. */
export interface Identity {
  readonly provider: Provider
  /** The provider's own id for the account; the same login always yields the same id. */
  readonly providerAccountId: string
  readonly email: string
  readonly plan: string
}

/** One account as the daemon stores it: identity, the owner's settings, and credentials. */
export const Account = Schema.Struct({
  id: Schema.String,
  provider: Provider,
  providerAccountId: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  label: Schema.String,
  /** The account's place in its pool: 1 gets new sessions first. */
  priority: Schema.Int,
  enabled: Schema.Boolean,
  needsSignIn: Schema.Boolean,
  addedAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  credentials: Credentials,
  /**
   * When a refresh of `credentials` started whose outcome is not yet recorded,
   * as an ISO 8601 timestamp. Written before the refresh is sent, so a daemon
   * that stops mid-refresh finds it on its next start: refresh tokens are
   * single-use, so such a refresh is never replayed.
   */
  refreshStartedAt: Schema.optionalKey(Schema.String),
})
export type Account = typeof Account.Type

/** The part of an account its credential keeper changes. */
export interface CredentialState {
  readonly credentials: Credentials
  readonly needsSignIn: boolean
  readonly refreshStartedAt?: string
}

/** Where an account stands with its pool (see GLOSSARY.md). */
export const AccountStatus = Schema.Literals(["active", "needs-sign-in", "disabled"])
export type AccountStatus = typeof AccountStatus.Type

export const accountStatus = (account: Account): AccountStatus =>
  !account.enabled ? "disabled" : account.needsSignIn ? "needs-sign-in" : "active"

/**
 * The account that serves `provider`'s next request: the Active account
 * highest in its pool's priority, if there is one.
 */
export const chooseAccount = (
  accounts: ReadonlyArray<Account>,
  provider: Provider,
): Account | undefined =>
  accounts
    .filter((account) => account.provider === provider && accountStatus(account) === "active")
    .toSorted((a, b) => a.priority - b.priority)[0]
