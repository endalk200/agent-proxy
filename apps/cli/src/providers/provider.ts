import { createHash, randomBytes } from "node:crypto"

import { Data, Effect } from "effect"

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
