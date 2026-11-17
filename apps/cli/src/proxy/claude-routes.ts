import { Effect } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { chooseAccount } from "../accounts/account.ts"
import { AccountStore } from "../accounts/store.ts"
import { ClaudeApi } from "../providers/claude-api.ts"
import { ProxyKey } from "./proxy-key.ts"

/**
 * The proxy's Claude routes: what Claude Code (and opencode's Claude Agent,
 * which runs it) sends to `ANTHROPIC_BASE_URL`, per spike #6.
 *
 * - `POST /v1/messages` and `POST /v1/messages/count_tokens`, query string
 *   and all, go to Claude as the highest-priority Active Claude account.
 * - `HEAD /api/hello`, Claude Code's startup check, is answered here without
 *   the proxy key, which it does not send.
 */

/** An error in the shape Anthropic's API returns, so Claude Code shows its message. */
const anthropicError = (status: number, type: string, message: string) =>
  HttpServerResponse.jsonUnsafe({ type: "error", error: { type, message } }, { status })

/**
 * Key errors are 401s: after a 401 Claude Code runs its `apiKeyHelper` again
 * and retries, so a rotated key takes effect without a restart.
 */
const noKey = anthropicError(
  401,
  "authentication_error",
  "agent-proxy: no proxy key sent. Send the key `agent-proxy key` prints, as the x-api-key header or as Authorization: Bearer.",
)
const wrongKey = anthropicError(
  401,
  "authentication_error",
  "agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.",
)

/**
 * The proxy key a request presents, if any; an empty one counts as none, so an
 * empty `Authorization: Bearer` (trimmed to `Bearer` in transit) never shadows
 * a valid `x-api-key`.
 */
const presentedKey = (headers: Headers.Headers) => {
  const bearer = /^Bearer(?:\s+(.*))?$/i.exec(headers["authorization"]?.trim() ?? "")?.[1]?.trim()
  const apiKey = headers["x-api-key"]?.trim()
  return bearer || apiKey || undefined
}

/**
 * Response headers that describe Claude's connection to the proxy, not the
 * response. The length goes too: the client gets the body as it streams.
 */
const NOT_RELAYED = ["connection", "keep-alive", "transfer-encoding", "content-length"]

const forward = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const presented = presentedKey(request.headers)
  if (presented === undefined) return noKey
  if (!(yield* (yield* ProxyKey).matches(presented))) return wrongKey

  const accounts = yield* (yield* AccountStore).list
  const account = chooseAccount(accounts, "claude")
  if (account === undefined) {
    // 400 is the status every client shows at once, with this message (spike #6).
    return anthropicError(
      400,
      "invalid_request_error",
      accounts.some((other) => other.provider === "claude")
        ? "agent-proxy: no Claude account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`."
        : "agent-proxy: no Claude account. Add one with `agent-proxy accounts add claude`.",
    )
  }

  const body = new Uint8Array(yield* request.arrayBuffer)
  const upstream = yield* (yield* ClaudeApi).send(
    { method: "POST", url: request.url, headers: request.headers, body },
    account.credentials.accessToken,
  )
  return HttpServerResponse.stream(upstream.stream, {
    status: upstream.status,
    headers: Headers.removeMany(upstream.headers, NOT_RELAYED),
  })
}).pipe(
  Effect.catchTags({
    AccountStoreError: (error) => Effect.succeed(anthropicError(500, "api_error", error.message)),
    ClaudeUnreachable: (error) =>
      Effect.logWarning("could not reach Claude").pipe(
        Effect.annotateLogs({ cause: String(error.cause) }),
        Effect.as(anthropicError(502, "api_error", error.message)),
      ),
    HttpServerError: () =>
      Effect.succeed(
        anthropicError(400, "invalid_request_error", "agent-proxy: could not read the request."),
      ),
  }),
)

/** Adds the routes to `router`. */
export const claudeRoutes = (router: HttpRouter.HttpRouter) =>
  Effect.all([
    router.add("POST", "/v1/messages", forward),
    router.add("POST", "/v1/messages/count_tokens", forward),
    // HEAD requests are served by GET routes.
    router.add("GET", "/api/hello", HttpServerResponse.empty({ status: 200 })),
  ])
