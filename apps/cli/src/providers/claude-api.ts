import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"

import { ProviderEndpoints } from "./endpoints.ts"
import { forwardedHeaders, type UpstreamApi, sendUpstream } from "./upstream.ts"

/**
 * The Claude adapter's upstream half: sends a client's request on to Claude's
 * API as the chosen account. It changes only what ADR-0006 allows: the
 * account's bearer token replaces the proxy key, and Claude's OAuth beta flag
 * is added when the client did not send it.
 */

/** The beta flag that lets an OAuth token call the API. */
const OAUTH_BETA = "oauth-2025-04-20"

/** `anthropic-beta` with the OAuth flag added, unless the client already sent it. */
const withOAuthBeta = (beta: string | undefined): string => {
  const flags = (beta ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag !== "")
  return beta !== undefined && flags.includes(OAUTH_BETA) ? beta : [...flags, OAUTH_BETA].join(",")
}

export class ClaudeApi extends Context.Service<ClaudeApi, UpstreamApi>()("agent-proxy/ClaudeApi") {
  static readonly layer = Layer.effect(
    ClaudeApi,
    Effect.gen(function* () {
      const { claude: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient

      return ClaudeApi.of({
        send: Effect.fn("ClaudeApi.send")(function* (request, _account, accessToken) {
          const headers = forwardedHeaders(request.headers, {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": withOAuthBeta(request.headers["anthropic-beta"]),
          })
          return yield* sendUpstream(http, "claude", endpoints.apiBaseUrl, request, headers)
        }),
      })
    }),
  )
}
