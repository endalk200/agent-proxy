import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"

import { ProviderEndpoints } from "./endpoints.ts"
import { type ExchangeParams, type LoginAdapter, ProviderLoginError } from "./provider.ts"

/**
 * The Claude adapter's login half: Claude Code's OAuth client, with the
 * parameters the spike confirmed against Claude Code 2.1.326.
 */

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
  "user:privacy_consents:write",
].join(" ")

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Finite,
})

const TokenError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})

const Profile = Schema.Struct({
  account: Schema.Struct({ uuid: Schema.String, email: Schema.String }),
  organization: Schema.Struct({
    uuid: Schema.String,
    organization_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
    rate_limit_tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
})
type Profile = typeof Profile.Type

/** The plan as the owner knows it, such as "Max 20x", from the profile's organization. */
export const claudePlan = (organization: Profile["organization"]): string => {
  const tier = organization.rate_limit_tier ?? ""
  switch (organization.organization_type) {
    case "claude_max":
      return tier.includes("20x") ? "Max 20x" : tier.includes("5x") ? "Max 5x" : "Max"
    case "claude_pro":
      return "Pro"
    case "claude_team":
      return "Team"
    case "claude_enterprise":
      return "Enterprise"
    default:
      return "Unknown"
  }
}

const describeRejection = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TokenError)),
    Effect.map((body) => body.error_description ?? body.error),
    Effect.option,
    Effect.map((reason) =>
      Option.match(reason, {
        onNone: () => `HTTP ${response.status}`,
        onSome: (text) => `${text} (HTTP ${response.status})`,
      }),
    ),
  )

/** How long the token exchange and profile lookup may take together. */
const EXCHANGE_TIMEOUT = "30 seconds"

const unreachable = (cause: unknown) =>
  new ProviderLoginError({ message: "Could not reach Claude to finish the sign-in.", cause })

export class ClaudeLogin extends Context.Service<ClaudeLogin, LoginAdapter>()(
  "agent-proxy/ClaudeLogin",
) {
  static readonly layer = Layer.effect(
    ClaudeLogin,
    Effect.gen(function* () {
      const { claude: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient

      const exchangeCode = Effect.fn("ClaudeLogin.exchangeCode")(function* (
        params: ExchangeParams,
      ) {
        const response = yield* HttpClientRequest.post(endpoints.tokenUrl).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({
            grant_type: "authorization_code",
            code: params.code,
            state: params.state,
            client_id: CLIENT_ID,
            redirect_uri: params.redirectUri,
            code_verifier: params.codeVerifier,
          }),
          http.execute,
          Effect.mapError(unreachable),
        )
        if (response.status !== 200) {
          return yield* new ProviderLoginError({
            message: `Claude refused the sign-in: ${yield* describeRejection(response)}.`,
          })
        }
        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
          Effect.mapError(
            (cause) =>
              new ProviderLoginError({
                message: "Claude sent an unexpected token response.",
                cause,
              }),
          ),
        )
      })

      const fetchProfile = Effect.fn("ClaudeLogin.fetchProfile")(function* (accessToken: string) {
        const response = yield* HttpClientRequest.get(endpoints.profileUrl).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(accessToken),
          http.execute,
          Effect.mapError(unreachable),
        )
        if (response.status !== 200) {
          return yield* new ProviderLoginError({
            message: `Claude did not return the account's profile (HTTP ${response.status}).`,
          })
        }
        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Profile)),
          Effect.mapError(
            (cause) =>
              new ProviderLoginError({ message: "Claude sent an unexpected profile.", cause }),
          ),
        )
      })

      const exchange = Effect.fn("ClaudeLogin.exchange")(
        function* (params: ExchangeParams) {
          const tokens = yield* exchangeCode(params)
          const profile = yield* fetchProfile(tokens.access_token)
          const now = yield* Clock.currentTimeMillis
          return {
            identity: {
              provider: "claude" as const,
              // A person can belong to several organizations, each its own subscription.
              providerAccountId: `${profile.account.uuid}:${profile.organization.uuid}`,
              email: profile.account.email,
              plan: claudePlan(profile.organization),
            },
            credentials: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt: DateTime.formatIso(
                DateTime.makeUnsafe(now + Math.round(tokens.expires_in * 1000)),
              ),
            },
          }
        },
        Effect.timeoutOrElse({
          duration: EXCHANGE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ProviderLoginError({
                message: "Claude did not answer within 30 seconds. Try signing in again.",
              }),
            ),
        }),
      )

      return ClaudeLogin.of({
        provider: "claude",
        name: "Claude",
        callbackPort: endpoints.callbackPort,
        redirectUri: (port) => `http://localhost:${port}/callback`,
        authorizeUrl: ({ redirectUri, state, codeChallenge }) => {
          const url = new URL(endpoints.authorizeUrl)
          url.search = new URLSearchParams({
            code: "true",
            client_id: CLIENT_ID,
            response_type: "code",
            redirect_uri: redirectUri,
            scope: SCOPES,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state,
          }).toString()
          return url.toString()
        },
        exchange,
      })
    }),
  )
}
