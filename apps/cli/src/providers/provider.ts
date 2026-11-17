import { createHash, randomBytes } from "node:crypto"

import { Data, type Duration, Effect } from "effect"
import type { HttpClientError, HttpClientResponse } from "effect/http"

import type { Credentials, Identity, Provider } from "../accounts/account.ts"

/**
 * What every provider adapter offers for adding an account: an OAuth
 * authorization-code login with PKCE, redirected to a loopback listener.
 */

export class ProviderLoginError extends Data.TaggedError("ProviderLoginError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** The parameters of one login's authorize request. */
export interface AuthorizeParams {
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
}

/** What the provider's redirect delivered, and what the login sent to get it. */
export interface ExchangeParams {
  readonly code: string
  readonly state: string
  readonly redirectUri: string
  readonly codeVerifier: string
}

export interface SignedIn {
  readonly identity: Identity
  readonly credentials: Credentials
}

export interface LoginAdapter {
  readonly provider: Provider
  /** The provider's display name, for messages. */
  readonly name: string
  /** The port the callback listener binds on 127.0.0.1; 0 binds any free port. */
  readonly callbackPort: number
  /** The redirect URI for a callback listener on `port`. */
  readonly redirectUri: (port: number) => string
  readonly authorizeUrl: (params: AuthorizeParams) => string
  /** Exchanges the code for tokens, and finds out who signed in. */
  readonly exchange: (params: ExchangeParams) => Effect.Effect<SignedIn, ProviderLoginError>
}

/** A PKCE verifier and its S256 challenge (RFC 7636), plus an unguessable state. */
export const makePkce = Effect.sync(() => {
  const codeVerifier = randomBytes(32).toString("base64url")
  return {
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  }
})

/**
 * The provider refused the refresh for good: the refresh token is invalid,
 * already used, or revoked. Only signing in again brings the account back.
 */
export class RefreshRejected extends Data.TaggedError("RefreshRejected")<{
  readonly reason: string
}> {}

/**
 * The refresh may or may not have happened: it was sent, but no answer was
 * read. Refresh tokens are single-use, so it must never be replayed.
 */
export class RefreshOutcomeUnknown extends Data.TaggedError("RefreshOutcomeUnknown")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/**
 * The refresh did not happen and the account's tokens still stand: the
 * provider could not be reached, or answered that it is overloaded. A later
 * refresh may succeed.
 */
export class RefreshUnavailable extends Data.TaggedError("RefreshUnavailable")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export type RefreshError = RefreshRejected | RefreshOutcomeUnknown | RefreshUnavailable

/** What every provider adapter offers for keeping an account's tokens fresh. */
export interface TokenAdapter {
  readonly provider: Provider
  /** How long before its access token expires an account is refreshed. */
  readonly refreshLead: Duration.Duration
  /** Exchanges a refresh token, once, for a new token pair. */
  readonly refresh: (refreshToken: string) => Effect.Effect<Credentials, RefreshError>
}

/** How long a refresh may take before its outcome counts as unknown. */
export const REFRESH_TIMEOUT = "30 seconds"

/**
 * Transport error codes that mean the connection was never made, so the
 * refresh request was never sent. Every other transport error may have
 * happened after the provider received it.
 */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "FailedToOpenSocket",
  "ConnectionRefused",
])

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined

/** How a refresh request to `name` that got no answer ended. */
export const refreshUnanswered = (name: string) => (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "TransportError" && NOT_CONNECTED.has(errorCode(error.reason.cause) ?? "")
    ? new RefreshUnavailable({ reason: `Could not reach ${name}.`, cause: error })
    : new RefreshOutcomeUnknown({
        reason: `The connection to ${name} closed before it answered.`,
        cause: error,
      })

/**
 * Fails with how a refresh `name` answered with anything but 200 ended;
 * `describe` reads why the provider refused it.
 */
export const refreshFailed = Effect.fnUntraced(function* (
  name: string,
  response: HttpClientResponse.HttpClientResponse,
  describe: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<string>,
) {
  // Only 429 and 503 say the refresh was not taken. Any other server error,
  // a gateway's 502 or 504 above all, may come after the provider spent the
  // single-use refresh token, so it must never be sent again.
  if (response.status === 429 || response.status === 503) {
    return yield* new RefreshUnavailable({
      reason: `${name} could not refresh the tokens now (HTTP ${response.status}).`,
    })
  }
  if (response.status >= 500) {
    return yield* new RefreshOutcomeUnknown({
      reason: `${name} answered the refresh with HTTP ${response.status}, so whether it took the refresh token is unknown.`,
    })
  }
  return yield* new RefreshRejected({ reason: yield* describe(response) })
})
