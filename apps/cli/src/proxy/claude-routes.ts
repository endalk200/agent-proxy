import { Effect, Option } from "effect"
import {
  Headers,
  type HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"

import { type Account, chooseAccount } from "../accounts/account.ts"
import { CredentialKeeper } from "../accounts/keeper.ts"
import { AccountStore } from "../accounts/store.ts"
import { ClaudeApi } from "../providers/claude-api.ts"
import { ProxyKey } from "./proxy-key.ts"

/**
 * The proxy's Claude routes: what Claude Code (and opencode's Claude Agent,
 * which runs it) sends to `ANTHROPIC_BASE_URL`, per spike #6.
 *
 * - `POST /v1/messages` and `POST /v1/messages/count_tokens`, query string
 *   and all, go to Claude as the highest-priority Active Claude account. When
 *   Claude rejects its token (401), the token is refreshed once and the
 *   request retried on the same account.
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

/** The proxy key a request presents, if any; an empty one counts as none. */
const presentedKey = (headers: Headers.Headers) => {
  const bearer = headers["authorization"]?.replace(/^Bearer\s+/i, "").trim()
  const apiKey = headers["x-api-key"]?.trim()
  return bearer || apiKey || undefined
}

/**
 * Response headers that describe Claude's connection to the proxy, not the
 * response. The length goes too: the client gets the body as it streams.
 */
const NOT_RELAYED = ["connection", "keep-alive", "transfer-encoding", "content-length"]

/** Why no Claude account can take the request. 400 is the status every client shows at once, with this message (spike #6). */
const noAccount = (accounts: ReadonlyArray<Account>) =>
  anthropicError(
    400,
    "invalid_request_error",
    accounts.some((other) => other.provider === "claude")
      ? "agent-proxy: no Claude account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`."
      : "agent-proxy: no Claude account. Add one with `agent-proxy accounts add claude`.",
  )

/** Claude's response, streamed to the client as it arrives. */
const relay = (upstream: HttpClientResponse.HttpClientResponse) =>
  HttpServerResponse.stream(upstream.stream, {
    status: upstream.status,
    headers: Headers.removeMany(upstream.headers, NOT_RELAYED),
  })

/** Reads and drops a response the client will not get, freeing its connection. */
const discard = (upstream: HttpClientResponse.HttpClientResponse) =>
  Effect.ignore(upstream.arrayBuffer)

const forward = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const presented = presentedKey(request.headers)
  if (presented === undefined) return noKey
  if (!(yield* (yield* ProxyKey).matches(presented))) return wrongKey

  const body = new Uint8Array(yield* request.arrayBuffer)
  const store = yield* AccountStore
  const keeper = yield* CredentialKeeper
  const claude = yield* ClaudeApi
  const send = (accessToken: string) =>
    claude.send({ method: "POST", url: request.url, headers: request.headers, body }, accessToken)

  // An account can turn out unable to serve only once chosen, when its tokens
  // cannot be refreshed; the choice is then made again without it.
  for (;;) {
    const accounts = yield* store.list
    const account = chooseAccount(accounts, "claude")
    if (account === undefined) return noAccount(accounts)
    const credentials = yield* keeper.credentialsFor(account)
    if (Option.isNone(credentials)) continue

    const upstream = yield* send(credentials.value.accessToken)
    if (upstream.status !== 401) return relay(upstream)

    // Claude rejected the token: refresh once and retry on the same account.
    const retry = yield* keeper.credentialsAfterRejection(account, credentials.value.accessToken)
    if (Option.isSome(retry) && retry.value.accessToken === credentials.value.accessToken) {
      return relay(upstream)
    }
    yield* discard(upstream)
    if (Option.isNone(retry)) continue
    return relay(yield* send(retry.value.accessToken))
  }
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
