import { Clock, Context, Data, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClientRequest, type HttpClientResponse } from "effect/http"

import type { Credentials } from "../accounts/account.ts"
import { ProviderEndpoints } from "./endpoints.ts"
import {
  type ExchangeParams,
  type LoginAdapter,
  ProviderLoginError,
  REFRESH_TIMEOUT,
  RefreshOutcomeUnknown,
  refreshFailed,
  refreshUnanswered,
  type TokenAdapter,
  oauthClient,
} from "./provider.ts"

/**
 * The Codex adapter's login and token halves: Codex's OAuth client at
 * auth.openai.com, with the parameters the spike confirmed against codex-cli
 * 0.169.0 and codex-rs `login/`. Who signed in comes from the id_token's
 * claims; there is no profile endpoint to ask.
 */

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke"
/** Codex names itself in its sign-in; agent-proxy signs in as Codex's own client. */
const ORIGINATOR = "codex_cli_rs"

/** The claims agent-proxy reads from OpenAI's tokens. */
const Claims = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  exp: Schema.optionalKey(Schema.Finite),
  // Where OpenAI puts the email when the top-level claim is absent; Codex reads it too.
  "https://api.openai.com/profile": Schema.optionalKey(
    Schema.Struct({ email: Schema.optionalKey(Schema.String) }),
  ),
  "https://api.openai.com/auth": Schema.optionalKey(
    Schema.Struct({
      chatgpt_account_id: Schema.optionalKey(Schema.String),
      chatgpt_plan_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})
type Claims = typeof Claims.Type

/** A token OpenAI issued that agent-proxy cannot read. */
class TokenUnreadable extends Data.TaggedError("TokenUnreadable")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/**
 * The claims in a JWT's payload. The token came straight from OpenAI's token
 * endpoint over TLS, so its signature is not checked.
 */
const decodeClaims = (jwt: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()),
    catch: (cause) => new TokenUnreadable({ reason: "the token is not a JWT", cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Claims)))

const CodeTokens = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite),
})

/** A refresh answer: Codex keeps its refresh token when the answer leaves one out. */
const RefreshTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
})

/**
 * When an access token issued at `now` expires: as `expires_in` says, or else
 * as the token's own `exp` claim says, which is what Codex reads.
 */
const expiresAt = (accessToken: string, expiresIn: number | undefined, now: number) =>
  Effect.gen(function* () {
    if (expiresIn !== undefined) return now + Math.round(expiresIn * 1000)
    const claims = yield* decodeClaims(accessToken)
    if (claims.exp === undefined) {
      return yield* new TokenUnreadable({
        reason: "the access token says nothing of when it expires",
      })
    }
    return claims.exp * 1000
  })

const toCredentials = (
  tokens: { readonly access_token: string; readonly expires_in?: number },
  refreshToken: string,
  now: number,
) =>
  Effect.map(expiresAt(tokens.access_token, tokens.expires_in, now), (expires): Credentials => ({
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires)),
  }))

const planNames: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  promax: "Pro Max",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
}

/** The plan as the owner knows it, such as "Pro", from the id_token's `chatgpt_plan_type`. */
export const codexPlan = (planType: string | null | undefined): string =>
  planType === undefined || planType === null || planType === ""
    ? "Unknown"
    : (planNames[planType] ?? planType)

/** Why OpenAI refused a token request, from either of the error shapes it answers with. */
const describeRejection = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Struct({
          error: Schema.Union([
            Schema.String,
            Schema.Struct({
              message: Schema.optionalKey(Schema.String),
              code: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ]),
          error_description: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
    Effect.map((body) =>
      typeof body.error === "string"
        ? (body.error_description ?? body.error)
        : (body.error.message ?? body.error.code ?? "refused"),
    ),
    Effect.option,
    Effect.map((reason) =>
      Option.match(reason, {
        onNone: () => `HTTP ${response.status}`,
        onSome: (text) => `${text} (HTTP ${response.status})`,
      }),
    ),
  )

/** How long the token exchange may take. */
const EXCHANGE_TIMEOUT = "30 seconds"

const unreachable = (cause: unknown) =>
  new ProviderLoginError({ message: "Could not reach OpenAI to finish the sign-in.", cause })

const unexpectedTokens = (cause: unknown) =>
  new ProviderLoginError({ message: "OpenAI sent an unexpected token response.", cause })

const unreadableRefresh = (cause: unknown) =>
  new RefreshOutcomeUnknown({ reason: "OpenAI's answer to the refresh could not be read.", cause })

/** Who signed in, from the id_token. */
const identityOf = (claims: Claims) =>
  Effect.gen(function* () {
    const auth = claims["https://api.openai.com/auth"]
    const accountId = auth?.chatgpt_account_id
    const email = claims.email ?? claims["https://api.openai.com/profile"]?.email
    if (accountId === undefined || accountId === "" || email === undefined || email === "") {
      return yield* new ProviderLoginError({
        message: "OpenAI's sign-in did not say which ChatGPT account signed in.",
      })
    }
    return {
      provider: "codex" as const,
      // The ChatGPT workspace: a person in several has one subscription in each.
      providerAccountId: accountId,
      email,
      plan: codexPlan(auth?.chatgpt_plan_type),
    }
  })

export class CodexLogin extends Context.Service<CodexLogin, LoginAdapter>()(
  "agent-proxy/CodexLogin",
) {
  static readonly layer = Layer.effect(
    CodexLogin,
    Effect.gen(function* () {
      const { codex: endpoints } = yield* ProviderEndpoints
      const http = yield* oauthClient

      const exchange = Effect.fn("CodexLogin.exchange")(
        function* (params: ExchangeParams) {
          // Codex sends the code exchange form-encoded.
          const response = yield* HttpClientRequest.post(endpoints.tokenUrl).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyUrlParams({
              grant_type: "authorization_code",
              client_id: CLIENT_ID,
              code: params.code,
              redirect_uri: params.redirectUri,
              code_verifier: params.codeVerifier,
            }),
            http.execute,
            Effect.mapError(unreachable),
          )
          if (response.status !== 200) {
            return yield* new ProviderLoginError({
              message: `OpenAI refused the sign-in: ${yield* describeRejection(response)}.`,
            })
          }
          const tokens = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CodeTokens)),
            Effect.mapError(unexpectedTokens),
          )
          const claims = yield* decodeClaims(tokens.id_token).pipe(
            Effect.mapError(unexpectedTokens),
          )
          const identity = yield* identityOf(claims)
          const now = yield* Clock.currentTimeMillis
          const credentials = yield* toCredentials(tokens, tokens.refresh_token, now).pipe(
            Effect.mapError(unexpectedTokens),
          )
          return { identity, credentials }
        },
        Effect.timeoutOrElse({
          duration: EXCHANGE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ProviderLoginError({
                message: "OpenAI did not answer within 30 seconds. Try signing in again.",
              }),
            ),
        }),
      )

      return CodexLogin.of({
        provider: "codex",
        name: "Codex",
        callbackPort: endpoints.callbackPort,
        redirectUri: (port) => `http://127.0.0.1:${port}/auth/callback`,
        authorizeUrl: ({ redirectUri, state, codeChallenge }) => {
          const url = new URL(endpoints.authorizeUrl)
          url.search = new URLSearchParams({
            response_type: "code",
            client_id: CLIENT_ID,
            redirect_uri: redirectUri,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state,
            scope: SCOPES,
            id_token_add_organizations: "true",
            codex_cli_simplified_flow: "true",
            originator: ORIGINATOR,
          }).toString()
          return url.toString()
        },
        exchange,
      })
    }),
  )
}

/**
 * The Codex adapter's token half: refreshes an account's tokens with Codex's
 * OAuth client, a day before they expire. OpenAI's refresh tokens are
 * single-use: a refresh replaces both tokens.
 */
export class CodexTokens extends Context.Service<CodexTokens, TokenAdapter>()(
  "agent-proxy/CodexTokens",
) {
  static readonly layer = Layer.effect(
    CodexTokens,
    Effect.gen(function* () {
      const { codex: endpoints } = yield* ProviderEndpoints
      const http = yield* oauthClient

      const refresh = Effect.fn("CodexTokens.refresh")(
        function* (refreshToken: string) {
          // Codex sends a refresh as JSON, unlike its code exchange.
          const response = yield* HttpClientRequest.post(endpoints.tokenUrl).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({
              grant_type: "refresh_token",
              client_id: CLIENT_ID,
              refresh_token: refreshToken,
            }),
            http.execute,
            Effect.mapError(refreshUnanswered("OpenAI")),
          )
          if (response.status !== 200) {
            return yield* refreshFailed("OpenAI", response, describeRejection)
          }
          const tokens = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RefreshTokens)),
            Effect.mapError(unreadableRefresh),
          )
          const now = yield* Clock.currentTimeMillis
          return yield* toCredentials(tokens, tokens.refresh_token ?? refreshToken, now).pipe(
            Effect.mapError(unreadableRefresh),
          )
        },
        Effect.timeoutOrElse({
          duration: REFRESH_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new RefreshOutcomeUnknown({ reason: "OpenAI did not answer within 30 seconds." }),
            ),
        }),
      )

      return CodexTokens.of({ provider: "codex", refreshLead: Duration.days(1), refresh })
    }),
  )
}
