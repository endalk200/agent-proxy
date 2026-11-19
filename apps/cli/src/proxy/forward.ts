import {
  brotliDecompressSync,
  constants,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib"

import { Clock, type Context, Effect, Option, Stream } from "effect"
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
import { AccountEvents } from "../daemon/account-events.ts"
import type { ProxiedRequest, UpstreamApi } from "../providers/upstream.ts"
import { LimitWindows } from "../usage/limit-windows.ts"
import { UsageStore } from "../usage/store.ts"
import { type ClientName, noTokens, type TokenCounts, type UsageStatus } from "../usage/usage.ts"
import { InFlight } from "./in-flight.ts"
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
 *
 * Every answer's limit-window headers update the account's limit windows.
 * A generation request is also recorded as usage once its response ends:
 * a copy of the body is read for the provider's usage events as it streams
 * by, and the bytes the client gets are never changed (ADR-0006, ADR-0009).
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

/**
 * The provider's response, streamed to the client as it arrives. Once the
 * stream ends, however it ends (in full, cut off upstream, or because the
 * client went away), `ended` gets the body's usage-bearing part as text,
 * and then `done` runs.
 */
const relay = (
  upstream: HttpClientResponse.HttpClientResponse,
  ended: ((body: string) => Effect.Effect<void>) | undefined,
  done: Effect.Effect<void>,
) => {
  const tap = usageTap(upstream.headers["content-encoding"])
  const stream =
    ended === undefined
      ? upstream.stream.pipe(Stream.onExit(() => done))
      : upstream.stream.pipe(
          Stream.tap((chunk) => Effect.sync(() => tap.push(chunk))),
          Stream.onExit(() => Effect.suspend(() => ended(tap.text())).pipe(Effect.ensuring(done))),
        )
  return HttpServerResponse.stream(stream, {
    status: upstream.status,
    headers: Headers.removeMany(upstream.headers, NOT_RELAYED),
  })
}

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

/** Decompresses as much of a body as arrived, so a stream cut off midway still yields its start. */
const PARTIAL = { finishFlush: constants.Z_SYNC_FLUSH }

/**
 * A buffered body as text, undone from its `content-encoding` first: the
 * proxy asks providers not to decompress, so the client gets their bytes as
 * sent, but a limit has to be read to be classified, and usage to be
 * recorded. A body that cannot be decoded counts as unreadable.
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
        return decoder.decode(gunzipSync(body, PARTIAL))
      case "deflate":
        return decoder.decode(inflateSync(body, PARTIAL))
      case "br":
        return decoder.decode(
          brotliDecompressSync(body, { finishFlush: constants.BROTLI_OPERATION_FLUSH }),
        )
      case "zstd":
        return decoder.decode(zstdDecompressSync(body))
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}

/**
 * A copy of a streamed body, kept only as far as its usage needs. A body as
 * sent (no `content-encoding`) is decoded as it streams by, and of its
 * server-sent events only those that mention `"usage"` are kept, so a long
 * answer's text deltas are never held. A compressed body is kept whole and
 * decoded at the end.
 */
const usageTap = (encoding: string | undefined) => {
  const plain = ["", "identity"].includes(encoding?.trim().toLowerCase() ?? "")
  if (!plain) {
    const chunks: Array<Uint8Array> = []
    return {
      push: (chunk: Uint8Array) => void chunks.push(chunk),
      text: () => bodyText(Buffer.concat(chunks), encoding) ?? "",
    }
  }
  const streaming = new TextDecoder()
  const kept: Array<string> = []
  let pending = ""
  return {
    push: (chunk: Uint8Array) => {
      const blocks = (pending + streaming.decode(chunk, { stream: true })).split(/\r?\n\r?\n/)
      pending = blocks.pop() ?? ""
      for (const block of blocks) if (block.includes('"usage"')) kept.push(block)
    },
    text: () => [...kept, pending + streaming.decode()].join("\n\n"),
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

/** The `model` a request's JSON body asks for, read without changing the body; `unknown` when it names none. */
const modelOf = (request: ProxiedRequest) => {
  try {
    const body: unknown = JSON.parse(decoder.decode(request.body))
    const model =
      typeof body === "object" && body !== null && "model" in body ? body.model : undefined
    return typeof model === "string" && model.trim() !== "" ? model.trim() : "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * The client a request came from (spike #6). opencode's Claude path runs
 * Claude Code through the Agent SDK with the SDK's default entrypoint, which
 * its `User-Agent` names as `sdk-ts`; an app that names its own entrypoint,
 * such as T3 Code's `t3-code`, is running Claude Code. opencode's Codex path
 * sends its own session header.
 */
const clientOf = (headers: Headers.Headers): ClientName => {
  const agent = headers["user-agent"]?.toLowerCase() ?? ""
  if (
    agent.startsWith("opencode") ||
    agent.includes("sdk-ts, agent-sdk/") ||
    headers["x-opencode-session-id"]
  ) {
    return "opencode"
  }
  if (agent.startsWith("claude-cli/")) return "claude-code"
  // An app that embeds Codex (T3 Code says "T3") renames its User-Agent, but
  // Codex still sends its own headers on every request.
  if (agent.startsWith("codex_") || headers["x-codex-window-id"]) return "codex"
  return "other"
}

const isSuccess = (status: number) => status >= 200 && status < 300

/** The signal Bun aborts when the client of `request` goes away, if the request has one. */
const abortSignalOf = (request: HttpServerRequest.HttpServerRequest) => {
  const source: object = request.source
  return "signal" in source && source.signal instanceof AbortSignal ? source.signal : undefined
}

/** Records nothing: a route that does not record usage. */
const recordNothing = () => Effect.void

/**
 * The handler that proxies a request to `provider`. With `recordsUsage`,
 * each request it serves is recorded as usage: only generation requests
 * spend usage, so token counting and the like are not.
 */
export const forward = <I>(
  { provider, upstream, error, coolingDown }: ProxiedProvider<I>,
  { recordsUsage }: { readonly recordsUsage: boolean } = { recordsUsage: false },
) => {
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

  return Effect.suspend(() => {
    // The account the request last went to, which a failure is recorded against.
    let lastAccount: Account | undefined
    let record: (
      accountId: string,
      status: UsageStatus,
      tokens?: TokenCounts,
    ) => Effect.Effect<void> = recordNothing
    // Whether this request's row is recorded, or left to the relayed body to record.
    let settled = false
    // Ends this request's time in flight; a relayed answer ends it when its stream does.
    let leave: Effect.Effect<void> = Effect.void
    let relaying = false
    const recordFailure = Effect.suspend(() =>
      lastAccount === undefined ? Effect.void : record(lastAccount.id, "failed"),
    )

    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const startedAt = yield* Clock.currentTimeMillis
      const method = request.method
      if (!HttpMethod.isHttpMethod(method)) return unreadable
      const presented = presentedKey(request.headers)
      if (presented === undefined) return noKey
      if (!(yield* (yield* ProxyKey).matches(presented))) return wrongKey
      leave = yield* (yield* InFlight).enter(abortSignalOf(request))

      const proxied = {
        method,
        url: request.url,
        headers: request.headers,
        body: new Uint8Array(yield* request.arrayBuffer),
      }
      const keeper = yield* CredentialKeeper
      const router = yield* Router
      const api = yield* upstream
      const limits = yield* LimitWindows
      const session = api.sessionOf(proxied)
      if (recordsUsage) {
        const usage = yield* UsageStore
        const events = yield* AccountEvents
        const model = modelOf(proxied)
        const client = clientOf(proxied.headers)
        // A store that cannot record never fails or holds up the response.
        record = (accountId, status, tokens = noTokens) =>
          Effect.gen(function* () {
            settled = true
            const at = yield* Clock.currentTimeMillis
            yield* usage.record({
              at,
              provider,
              accountId,
              model,
              client,
              session,
              status,
              latencyMs: at - startedAt,
              tokens,
            })
            yield* events.usageRecorded({ at, provider, accountId, model, client, status, tokens })
          }).pipe(
            Effect.catchTag("UsageStoreError", (cause) =>
              Effect.logWarning("could not record usage").pipe(
                Effect.annotateLogs({ account: accountId, cause: cause.message }),
              ),
            ),
          )
      }
      /** Records the limit windows an answer's headers report. */
      const observeWindows = (account: Account, headers: Headers.Headers) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const windows = api.windowsOf(headers, now)
          if (windows.length > 0) yield* limits.observe(account.id, windows, "header", now)
        })
      /** Records what a relayed answer spent once its body has gone by. */
      const spent = (account: Account, response: HttpClientResponse.HttpClientResponse) =>
        recordsUsage
          ? (body: string) => {
              if (!isSuccess(response.status)) return record(account.id, "failed")
              const usage = api.usageOf(body)
              return record(account.id, usage.complete ? "success" : "incomplete", usage.tokens)
            }
          : undefined
      const send = (account: Account, accessToken: string) =>
        api.send(proxied, account, accessToken)

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
        const retry = yield* keeper.credentialsAfterRejection(
          account,
          credentials.value.accessToken,
        )
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
      let rejected: { readonly accountId: string; readonly answer: BufferedAnswer } | undefined
      for (;;) {
        const choice = yield* router.choose(provider, session, tried)
        if (choice._tag === "CoolingDown") {
          yield* record(choice.accountId, "limited")
          return limited?.accountId === choice.accountId && limited.answer.body !== undefined
            ? replay(limited.answer)
            : coolingDown(choice.cooldown, yield* Clock.currentTimeMillis)
        }
        if (choice._tag === "Unavailable") {
          if (rejected?.answer.body === undefined) {
            yield* recordFailure
            return noAccount(choice.accounts)
          }
          // The client is shown this account's rejection, so it is the one recorded.
          yield* record(rejected.accountId, "failed")
          return replay(rejected.answer)
        }
        const account = choice.account
        tried.add(account.id)
        lastAccount = account

        const answer = yield* attempt(account)
        if (Option.isNone(answer)) continue
        const response = answer.value
        yield* observeWindows(account, response.headers)
        if (response.status === 401) {
          rejected = {
            accountId: account.id,
            answer: {
              status: 401,
              headers: response.headers,
              body: yield* readLimitBody(response),
            },
          }
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
          settled = true
          if (buffered.body !== undefined) return replay(buffered)
          const relayed = relay(response, spent(account, response), leave)
          // An answer the server sends without a body (204, 205, 304, or one
          // to a HEAD) never runs its stream, so the handler ends it instead.
          relaying = !HttpServerResponse.omitsBody(relayed, method === "HEAD")
          return relayed
        }
        if (buffered.body === undefined) yield* discard(response)
        limited = { accountId: account.id, answer: buffered }
      }
    }).pipe(
      Effect.catchTags({
        AccountStoreError: (cause) =>
          recordFailure.pipe(Effect.as(error(500, "server", cause.message))),
        ProviderUnreachable: (cause) =>
          Effect.logWarning(`could not reach ${name}`).pipe(
            Effect.annotateLogs({ cause: String(cause.cause) }),
            Effect.andThen(recordFailure),
            Effect.as(error(502, "server", cause.message)),
          ),
        HttpServerError: () => Effect.succeed(unreadable),
      }),
      // A client that goes away before any answer still sent its request,
      // which the provider may have started on.
      Effect.onInterrupt(() =>
        settled || lastAccount === undefined ? Effect.void : record(lastAccount.id, "incomplete"),
      ),
      Effect.ensuring(Effect.suspend(() => (relaying ? Effect.void : leave))),
    )
  })
}
