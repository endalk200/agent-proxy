import { Data, Effect } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  type HttpMethod,
} from "effect/http"

import { type Account, type Provider, providerNames } from "../accounts/account.ts"
import type { LimitSignal } from "../accounts/router.ts"
import type { ObservedWindow, ResetsRead, TokenCounts } from "../usage/usage.ts"

/**
 * What every provider adapter's upstream half shares: sending a client's
 * request on to the provider as the chosen account, changing only what
 * ADR-0006 allows. Everything else, body included, goes through byte for byte.
 */

export class ProviderUnreachable extends Data.TaggedError("ProviderUnreachable")<{
  readonly provider: Provider
  readonly cause: unknown
}> {
  override get message() {
    return `agent-proxy: could not reach ${providerNames[this.provider]}. Check this machine's network connection.`
  }
}

/** A client's request, as the proxy received it. */
export interface ProxiedRequest {
  readonly method: HttpMethod.HttpMethod
  /** The path and query string, such as `/v1/messages?beta=true`. */
  readonly url: string
  readonly headers: Headers.Headers
  readonly body: Uint8Array
}

export interface UpstreamApi {
  /**
   * Sends `request` to the provider as `account`, whose access token is
   * given, and returns the provider's response as soon as its headers
   * arrive; its body is read as it streams in, still encoded as the provider
   * sent it.
   */
  readonly send: (
    request: ProxiedRequest,
    account: Account,
    accessToken: string,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, ProviderUnreachable>
  /** The session `request` belongs to, as its client names it, if it does. */
  readonly sessionOf: (request: ProxiedRequest) => string | undefined
  /**
   * What the provider's answer says about the account's limits, `now` being
   * the time in epoch milliseconds. `body` is given for a 429, and for an
   * answer `mayRefuse` names, when it could be read.
   */
  readonly limitsOf: (answer: ProviderAnswer, now: number) => LimitSignal
  /**
   * Whether an answer with `status` may be one `cannotServe` recognizes, so
   * its body is read in full before the client gets it.
   */
  readonly mayRefuse: (status: number) => boolean
  /**
   * Whether the answer turns the request down for something about this
   * account that another account may not share, such as a plan without the
   * model asked for. `body` is given as for `limitsOf`.
   */
  readonly cannotServe: (answer: ProviderAnswer) => boolean
  /** The limit windows the answer's headers report, `now` being the time in epoch milliseconds. */
  readonly windowsOf: (headers: Headers.Headers, now: number) => ReadonlyArray<ObservedWindow>
  /**
   * What a generation request spent, from the provider's own usage events in
   * the response body, read in full and decoded. `complete` is true when the
   * body reached its final usage event.
   */
  readonly usageOf: (body: string) => SpentTokens
  /**
   * Reads `account`'s limit windows from the provider's usage endpoint: the
   * daemon's own read-only request, never a client's.
   */
  readonly readWindows: (
    account: Account,
    accessToken: string,
    now: number,
  ) => Effect.Effect<WindowsRead>
  /**
   * Asks the provider to redeem `account`'s limit reset `resetId`, once.
   * `requestId` names the attempt: the provider takes a request with the same
   * id again as the same redeem, so an attempt that got no answer can be
   * retried with it.
   */
  readonly redeemReset: (
    account: Account,
    accessToken: string,
    resetId: string,
    requestId: string,
  ) => Effect.Effect<RedeemAnswer>
}

/**
 * Why a provider refused to redeem a limit reset, which leaves it unspent:
 *
 * - `nothing-to-refill`: the windows it refills are not used enough for it to change anything.
 * - `already-redeemed`: it was redeemed before.
 * - `cooldown`: the provider's own wait between two resets has not passed.
 * - `ineligible`: the account may not redeem it.
 * - `unavailable`: it is no longer there to redeem.
 * - `rejected`: the provider turned the request down without saying why it would.
 */
export type RedeemRefusal =
  | "nothing-to-refill"
  | "already-redeemed"
  | "cooldown"
  | "ineligible"
  | "unavailable"
  | "rejected"

/** How one attempt to redeem a limit reset went. */
export type RedeemAnswer =
  | { readonly _tag: "Redeemed" }
  /** Nothing was spent; `detail` says more, such as the HTTP status of a `rejected` one. */
  | { readonly _tag: "Refused"; readonly reason: RedeemRefusal; readonly detail?: string }
  /** No answer was read, so whether it was redeemed is unknown. */
  | { readonly _tag: "Unanswered"; readonly reason: string }

/** What a response body says its request spent. */
export interface SpentTokens {
  readonly tokens: TokenCounts
  readonly complete: boolean
}

/** How a read of a provider's usage endpoint went. */
export type WindowsRead =
  | {
      readonly _tag: "Read"
      readonly windows: ReadonlyArray<ObservedWindow>
      /**
       * The account's limit resets, read with its windows; none when the
       * provider's answer about them was missing, failed, or in a shape this
       * build does not know, so the ones known before stay.
       */
      readonly resets: ResetsRead | undefined
    }
  /** The provider asked the daemon to wait `retryAfterMs` before reading again. */
  | { readonly _tag: "Busy"; readonly retryAfterMs: number }
  | { readonly _tag: "Failed"; readonly reason: string }

/** A provider's answer as its adapter judges its limits. */
export interface ProviderAnswer {
  readonly status: number
  readonly headers: Headers.Headers
  readonly body: string | undefined
}

/** A number header's value, if it holds a finite number. */
export const numberHeader = (headers: Headers.Headers, name: string): number | undefined => {
  const value = headers[name]
  if (value === undefined || value.trim() === "") return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/** How long to wait before retrying, from `Retry-After` in seconds or as a date; a minute when it is missing. */
export const retryAfterMs = (headers: Headers.Headers, now: number): number => {
  const seconds = numberHeader(headers, "retry-after")
  if (seconds !== undefined) return Math.max(0, seconds) * 1000
  const date = Date.parse(headers["retry-after"] ?? "")
  return Number.isNaN(date) ? 60_000 : Math.max(0, date - now)
}

export type Json = Readonly<Record<string, unknown>>

export const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

/** `text` parsed as a JSON object, if it is one. */
export const parseObject = (text: string): Json | undefined => {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

export const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** A share used, 0 to 1, from a value that may stray a little outside it. */
export const shareOf = (value: number) => Math.min(1, Math.max(0, value))

/**
 * The JSON objects a response body carries: each server-sent event's data,
 * or the body itself when it is one JSON object. Anything unreadable is skipped.
 */
export const bodyEvents = (body: string): ReadonlyArray<Json> => {
  const whole = body.trimStart().startsWith("{") ? parseObject(body) : undefined
  if (whole !== undefined) return [whole]
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    const event = data === "" ? undefined : parseObject(data)
    return event === undefined ? [] : [event]
  })
}

/**
 * A limit window's id from its length in minutes: 5 hours, a week, or about
 * a month. Any other length is not a window the dashboard knows.
 */
export const windowIdOfMinutes = (minutes: number | undefined) =>
  minutes === undefined
    ? undefined
    : minutes === 300
      ? "five-hour"
      : minutes === 7 * 24 * 60
        ? "weekly"
        : minutes >= 28 * 24 * 60 && minutes <= 31 * 24 * 60
          ? "monthly"
          : undefined

/** How long a read of a usage endpoint may take. */
const READ_TIMEOUT = "30 seconds"

/**
 * GETs a provider's usage endpoint at `url` with `headers`, and reads its
 * windows from the JSON answer with `parse`, which returns none for a shape
 * it does not know. `resets` then reads the account's limit resets, from the
 * same answer or another request bounded on its own, so one that stalls
 * never costs the windows already read; it never fails, answering none for
 * anything it cannot read.
 */
export const readUsageEndpoint = (
  http: HttpClient.HttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  now: number,
  parse: (body: Json) => ReadonlyArray<ObservedWindow> | undefined,
  resets: (body: Json) => Effect.Effect<ResetsRead | undefined> = () => Effect.undefined,
): Effect.Effect<WindowsRead> =>
  Effect.gen(function* () {
    const read = yield* readWindowsOnly(http, url, headers, now, parse)
    if (read._tag !== "Read") return read
    return { _tag: "Read", windows: read.windows, resets: yield* resets(read.body) } as const
  })

/** The usage read itself, bounded by `READ_TIMEOUT`, with the answer its windows came from. */
const readWindowsOnly = (
  http: HttpClient.HttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  now: number,
  parse: (body: Json) => ReadonlyArray<ObservedWindow> | undefined,
) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({ accept: "application/json", ...headers }),
      http.execute,
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    )
    if (response.status === 429) {
      return { _tag: "Busy", retryAfterMs: retryAfterMs(response.headers, now) } as const
    }
    if (response.status !== 200) {
      return { _tag: "Failed", reason: `HTTP ${response.status}` } as const
    }
    const body = asObject(yield* response.json)
    const windows = body === undefined ? undefined : parse(body)
    if (body === undefined || windows === undefined) {
      return { _tag: "Failed", reason: "an answer of an unknown shape" } as const
    }
    return { _tag: "Read", windows, body } as const
  }).pipe(
    Effect.timeoutOrElse({
      duration: READ_TIMEOUT,
      orElse: () => Effect.succeed({ _tag: "Failed", reason: "no answer in time" } as const),
    }),
    Effect.catch((cause) => Effect.succeed({ _tag: "Failed", reason: cause.message } as const)),
  )

/** How long one attempt to redeem a limit reset may take. */
const REDEEM_TIMEOUT = "30 seconds"

/**
 * POSTs `body` to a provider's redeem endpoint at `url` with `headers`, and
 * reads the outcome from its JSON answer with `outcome`, which returns none
 * for one it does not know. A status that refuses the request (4xx) without
 * an outcome it knows is `rejected`; a redirect, a timeout (408), a server
 * error, or an answer it cannot read may come after the provider redeemed
 * it, so it is `Unanswered`.
 */
export const postRedeem = (
  http: HttpClient.HttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Readonly<Record<string, unknown>>,
  outcome: (answer: Json) => RedeemAnswer | undefined,
): Effect.Effect<RedeemAnswer> =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ accept: "application/json", ...headers }),
      HttpClientRequest.bodyJsonUnsafe(body),
      http.execute,
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    )
    const status = response.status
    const answered =
      (status >= 200 && status < 300) || (status >= 400 && status < 500 && status !== 408)
    if (!answered) return { _tag: "Unanswered", reason: `HTTP ${status}` } as const
    const read = asObject(yield* response.json.pipe(Effect.orElseSucceed(() => undefined)))
    const known = read === undefined ? undefined : outcome(read)
    if (known !== undefined) return known
    return status < 300
      ? ({ _tag: "Unanswered", reason: "an answer of an unknown shape" } as const)
      : ({ _tag: "Refused", reason: "rejected", detail: `HTTP ${status}` } as const)
  }).pipe(
    Effect.timeoutOrElse({
      duration: REDEEM_TIMEOUT,
      orElse: () => Effect.succeed({ _tag: "Unanswered", reason: "no answer in time" } as const),
    }),
    Effect.catch((cause) => Effect.succeed({ _tag: "Unanswered", reason: cause.message } as const)),
  )

/**
 * Bun's fetch options for passthrough: a compressed body stays as it arrived,
 * so the client gets the bytes its `content-encoding` header describes, and a
 * redirect goes back to the client rather than being followed with the
 * account's token.
 */
const passThroughEncoding: BunFetchRequestInit = { decompress: false, redirect: "manual" }

/**
 * Request headers never forwarded: the proxy key, which the account's token
 * replaces, and those that describe the client's own connection to the proxy.
 */
const NOT_FORWARDED = [
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

/** The client's headers, without the proxy key or its connection's own, with `set` laid over them. */
export const forwardedHeaders = (headers: Headers.Headers, set: Readonly<Record<string, string>>) =>
  Headers.setAll(Headers.removeMany(headers, NOT_FORWARDED), set)

/** Sends `request` to `origin` + its path with `headers`, through `http`, as passthrough. */
export const sendUpstream = (
  http: HttpClient.HttpClient,
  provider: Provider,
  origin: string,
  request: ProxiedRequest,
  headers: Headers.Headers,
) =>
  HttpClientRequest.make(request.method)(`${origin}${request.url}`).pipe(
    HttpClientRequest.setHeaders(headers),
    request.body.byteLength === 0 && (request.method === "GET" || request.method === "HEAD")
      ? (built) => built
      : HttpClientRequest.setBody(
          HttpBody.raw(request.body, {
            contentType: request.headers["content-type"],
            contentLength: request.body.byteLength,
          }),
        ),
    http.execute,
    // Nothing but the client's own headers goes upstream: no trace headers.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, passThroughEncoding),
    Effect.mapError((cause) => new ProviderUnreachable({ provider, cause })),
  )
