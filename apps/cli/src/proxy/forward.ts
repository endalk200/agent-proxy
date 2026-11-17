import { type Context, Effect, Option } from "effect"
import {
  Headers,
  HttpClientResponse,
  HttpMethod,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"

import { type Account, chooseAccount, type Provider, providerNames } from "../accounts/account.ts"
import { CredentialKeeper } from "../accounts/keeper.ts"
import { AccountStore } from "../accounts/store.ts"
import type { UpstreamApi } from "../providers/upstream.ts"
import { ProxyKey } from "./proxy-key.ts"

/**
 * The proxy's request handling, the same for every provider (native routing):
 * a request that carries the proxy key goes to its provider as the
 * highest-priority Active account of that provider's pool. When the provider
 * rejects the account's token (401), the token is refreshed once and the
 * request retried on the same account. The provider's answer streams back as
 * it arrives.
 */

/** What went wrong, for a provider's own error shape. */
export type ErrorKind = "authentication" | "invalid_request" | "server"

/** A provider's error shape, so its clients show the proxy's message. */
export type ErrorResponse = (
  status: number,
  kind: ErrorKind,
  message: string,
) => HttpServerResponse.HttpServerResponse

export interface ProxiedProvider<I> {
  readonly provider: Provider
  readonly upstream: Context.Key<I, UpstreamApi>
  readonly error: ErrorResponse
}

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
 * Response headers that describe the provider's connection to the proxy, not
 * the response. The length goes too: the client gets the body as it streams.
 */
const NOT_RELAYED = ["connection", "keep-alive", "transfer-encoding", "content-length"]

/** The provider's response, streamed to the client as it arrives. */
const relay = (upstream: HttpClientResponse.HttpClientResponse) =>
  HttpServerResponse.stream(upstream.stream, {
    status: upstream.status,
    headers: Headers.removeMany(upstream.headers, NOT_RELAYED),
  })

/**
 * Drops a response the client will not get, freeing its connection. The body
 * is cancelled, not read: a rejected answer whose body never finishes must
 * not hold up the retry.
 */
const discard = (upstream: HttpClientResponse.HttpClientResponse) =>
  Option.match(HttpClientResponse.toWeb(upstream), {
    onNone: () => Effect.void,
    onSome: (response) =>
      Effect.promise(() => (response.body?.cancel() ?? Promise.resolve()).catch(() => undefined)),
  })

/** The handler that proxies a request to `provider`. */
export const forward = <I>({ provider, upstream, error }: ProxiedProvider<I>) => {
  const name = providerNames[provider]
  /**
   * Key errors are 401s: after a 401 Claude Code runs its `apiKeyHelper` again
   * and retries, so a rotated key takes effect without a restart.
   */
  const noKey = error(
    401,
    "authentication",
    "agent-proxy: no proxy key sent. Send the key `agent-proxy key` prints, as the x-api-key header or as Authorization: Bearer.",
  )
  const wrongKey = error(
    401,
    "authentication",
    "agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.",
  )
  /** Why no account can take the request. 400 is the status every client shows at once, with this message (spike #6). */
  const noAccount = (accounts: ReadonlyArray<Account>) =>
    error(
      400,
      "invalid_request",
      accounts.some((other) => other.provider === provider)
        ? `agent-proxy: no ${name} account available, every account needs sign-in or is disabled. Run \`agent-proxy accounts\`.`
        : `agent-proxy: no ${name} account. Add one with \`agent-proxy accounts add ${provider}\`.`,
    )

  const unreadable = error(400, "invalid_request", "agent-proxy: could not read the request.")

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const method = request.method
    if (!HttpMethod.isHttpMethod(method)) return unreadable
    const presented = presentedKey(request.headers)
    if (presented === undefined) return noKey
    if (!(yield* (yield* ProxyKey).matches(presented))) return wrongKey

    const body = new Uint8Array(yield* request.arrayBuffer)
    const store = yield* AccountStore
    const keeper = yield* CredentialKeeper
    const api = yield* upstream
    const send = (account: Account, accessToken: string) =>
      api.send({ method, url: request.url, headers: request.headers, body }, account, accessToken)

    // An account can turn out unable to serve only once chosen, when its tokens
    // cannot be refreshed; the choice is then made again without it.
    for (;;) {
      const accounts = yield* store.list
      const account = chooseAccount(accounts, provider)
      if (account === undefined) return noAccount(accounts)
      const credentials = yield* keeper.credentialsFor(account)
      if (Option.isNone(credentials)) continue

      const answer = yield* send(account, credentials.value.accessToken)
      if (answer.status !== 401) return relay(answer)

      // The provider rejected the token: refresh once and retry on the same account.
      const retry = yield* keeper.credentialsAfterRejection(account, credentials.value.accessToken)
      if (Option.isSome(retry) && retry.value.accessToken === credentials.value.accessToken) {
        return relay(answer)
      }
      yield* discard(answer)
      if (Option.isNone(retry)) continue
      return relay(yield* send(account, retry.value.accessToken))
    }
  }).pipe(
    Effect.catchTags({
      AccountStoreError: (cause) => Effect.succeed(error(500, "server", cause.message)),
      ProviderUnreachable: (cause) =>
        Effect.logWarning(`could not reach ${name}`).pipe(
          Effect.annotateLogs({ cause: String(cause.cause) }),
          Effect.as(error(502, "server", cause.message)),
        ),
      HttpServerError: () => Effect.succeed(unreadable),
    }),
  )
}
