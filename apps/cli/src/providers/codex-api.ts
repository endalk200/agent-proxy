import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"

import { ProviderEndpoints } from "./endpoints.ts"
import { forwardedHeaders, type UpstreamApi, sendUpstream } from "./upstream.ts"

/**
 * The Codex adapter's upstream half: sends a client's request on to the Codex
 * backend at chatgpt.com as the chosen account. It changes only what ADR-0006
 * allows: the account's bearer token replaces the proxy key, and
 * `chatgpt-account-id` names the account's ChatGPT workspace.
 */
export class CodexApi extends Context.Service<CodexApi, UpstreamApi>()("agent-proxy/CodexApi") {
  static readonly layer = Layer.effect(
    CodexApi,
    Effect.gen(function* () {
      const { codex: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient

      return CodexApi.of({
        send: Effect.fn("CodexApi.send")(function* (request, account, accessToken) {
          const headers = forwardedHeaders(request.headers, {
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": account.providerAccountId,
          })
          return yield* sendUpstream(http, "codex", endpoints.apiBaseUrl, request, headers)
        }),
      })
    }),
  )
}
