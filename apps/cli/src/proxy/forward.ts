import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"

import { Clock, type Context, Effect, Option } from "effect"
import {
  Headers,
  HttpClientResponse,
  HttpMethod,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"

import { type Account, type Provider, providerNames } from "../accounts/account.ts"
import { CredentialKeeper } from "../accounts/keeper.ts"
import { type Cooldown, Router } from "../accounts/router.ts"
import { AccountStore } from "../accounts/store.ts"
import type { UpstreamApi } from "../providers/upstream.ts"
import { ProxyKey } from "./proxy-key.ts"

/**
 * The proxy's request handling, the same for every provider (native routing):
 * a request that carries the proxy key goes to its provider as the account
 * the router chooses from that provider's pool. When the provider rejects the
 * account's token (401), the token is refreshed once and the request retried
 * on the same account. When it answers that the account hit a limit, the
 * account cools down and the request goes to the next account; nothing has
 * reached the client yet, so it never notices. Any other answer streams back
 * as it arrives, and is never retried once it has started.
 */

/** What went wrong, for a provider's own error shape. */
export type ErrorKind = "authentication" | "invalid_request" | "server"

/** A provider's error shape, so its clients show the proxy's message. */
export type ErrorResponse = (
  status: number,
  kind: ErrorKind,
  message: string,
) => HttpServerResponse.HttpServerResponse

/**
 * A provider's own limit answer, so its clients show when work can resume:
 * every account is cooling down, and `cooldown` ends first. `now` is the
 * current time in epoch milliseconds.
 */
export type CoolingDownResponse = (
  cooldown: Cooldown,
  now: number,
) => HttpServerResponse.HttpServerResponse

/** A cooldown's end for a client's message, to the second: "2026-11-17T15:42:00Z". */
export const untilText = (until: number) => `${new Date(until).toISOString().slice(0, 19)}Z`

export interface ProxiedProvider<I> {
  readonly provider: Provider
  readonly upstream: Context.Key<I, UpstreamApi>
  readonly error: ErrorResponse
  readonly coolingDown: CoolingDownResponse
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

/** A provider's answer whose body, if any, was read in full before relaying. */
interface BufferedAnswer {
  readonly status: number
  readonly headers: Headers.Headers
  readonly body: Uint8Array | undefined
}

const decoder = new TextDecoder()

/**
 * A buffered body as text, undone from its `content-encoding` first: the
 * proxy asks providers not to decompress, so the client gets their bytes as
 * sent, but a limit has to be read to be classified. A body that cannot be
 * decoded counts as unreadable.
 */
const bodyText = (body: Uint8Array, encoding: string | undefined): string | undefined => {
  try {
    switch (encoding?.trim().toLowerCase()) {
      case undefined:
      case "":
      case "identity":
        return decoder.decode(body)
      case "gzip":
      case "x-gzip":
        return decoder.decode(gunzipSync(body))
      case "deflate":
        return decoder.decode(inflateSync(body))
      case "br":
        return decoder.decode(brotliDecompressSync(body))
      case "zstd":
        return decoder.decode(zstdDecompressSync(body))
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/** How long a 429's body may take to arrive before it is judged by its headers alone. */
const LIMIT_BODY_TIMEOUT = "5 seconds"

/** A 429's body, read in full, or none when it cannot be read in time. */
const readLimitBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.timeoutOption(LIMIT_BODY_TIMEOUT),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

/** A provider's answer read in full, sent to the client as it came. */
const replay = (answer: BufferedAnswer) =>
  HttpServerResponse.uint8Array(answer.body ?? new Uint8Array(), {
    status: answer.status,
    headers: Headers.removeMany(answer.headers, NOT_RELAYED),
  })

/** How stale an account's "last used" may get before a request it serves writes it again. */
const LAST_USED_GRANULARITY_MS = 60_000

/**
 * Records that `account` served a request, at most once a minute so a busy
 * account's file is not rewritten on every request. A failure to write it
 * never fails the request.
 */
const markUsed = (account: Account) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const last = account.lastUsedAt === null ? undefined : Date.parse(account.lastUsedAt)
    if (last !== undefined && now - last < LAST_USED_GRANULARITY_MS) return
    yield* (yield* AccountStore).markUsed(account.id, new Date(now).toISOString())
  }).pipe(
    Effect.catchTag("AccountStoreError", (cause) =>
      Effect.logWarning("could not record when an account was last used").pipe(
        Effect.annotateLogs({ account: account.id, cause: cause.message }),
      ),
    ),
  )

/** The handler that proxies a request to `provider`. */
export const forward = <I>({ provider, upstream, error, coolingDown }: ProxiedProvider<I>) => {
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

    const proxied = {
      method,
      url: request.url,
      headers: request.headers,
      body: new Uint8Array(yield* request.arrayBuffer),
    }
    const keeper = yield* CredentialKeeper
    const router = yield* Router
    const api = yield* upstream
    const session = api.sessionOf(proxied)
    const send = (account: Account, accessToken: string) => api.send(proxied, account, accessToken)

    /**
     * The provider's answer to the request sent as `account`, or none when the
     * account turns out unable to serve: its tokens cannot be refreshed.
     */
    const attempt = Effect.fnUntraced(function* (account: Account) {
      const credentials = yield* keeper.credentialsFor(account)
      if (Option.isNone(credentials)) return Option.none()
      const answer = yield* send(account, credentials.value.accessToken)
      if (answer.status !== 401) return Option.some(answer)

      // The provider rejected the token: refresh once and retry on the same account.
      // A 401 that comes back after this is the account's to own: the caller
      // moves on to the next account (spec #5: refresh once, then fail over).
      const retry = yield* keeper.credentialsAfterRejection(account, credentials.value.accessToken)
      if (Option.isSome(retry) && retry.value.accessToken === credentials.value.accessToken) {
        return Option.some(answer)
      }
      yield* discard(answer)
      if (Option.isNone(retry)) return Option.none()
      return Option.some(yield* send(account, retry.value.accessToken))
    })

    // Accounts this request found limited or unable to serve.
    const tried = new Set<string>()
    // The last limit answer, read in full: when its account is the first to
    // be free again, the client gets the provider's own answer.
    let limited: { readonly accountId: string; readonly answer: BufferedAnswer } | undefined
    // The last account's rejection of its token even after a refresh: the
    // client gets it only when no other account can take the request.
    let rejected: BufferedAnswer | undefined
    for (;;) {
      const choice = yield* router.choose(provider, session, tried)
      if (choice._tag === "CoolingDown") {
        return limited?.accountId === choice.accountId && limited.answer.body !== undefined
          ? replay(limited.answer)
          : coolingDown(choice.cooldown, yield* Clock.currentTimeMillis)
      }
      if (choice._tag === "Unavailable") {
        return rejected?.body !== undefined ? replay(rejected) : noAccount(choice.accounts)
      }
      const account = choice.account
      tried.add(account.id)

      const answer = yield* attempt(account)
      if (Option.isNone(answer)) continue
      const response = answer.value
      if (response.status === 401) {
        rejected = { status: 401, headers: response.headers, body: yield* readLimitBody(response) }
        continue
      }
      // Only a 429 is read before the client gets it: it may say the account hit a limit.
      const buffered: BufferedAnswer =
        response.status === 429
          ? { status: 429, headers: response.headers, body: yield* readLimitBody(response) }
          : { status: response.status, headers: response.headers, body: undefined }
      const signal = api.limitsOf(
        {
          ...buffered,
          body:
            buffered.body === undefined
              ? undefined
              : bodyText(buffered.body, buffered.headers["content-encoding"]),
        },
        yield* Clock.currentTimeMillis,
      )
      yield* router.record(account, session, signal, choice.seen)
      if (signal._tag === "Within") {
        yield* markUsed(account)
        return buffered.body === undefined ? relay(response) : replay(buffered)
      }
      if (buffered.body === undefined) yield* discard(response)
      limited = { accountId: account.id, answer: buffered }
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
