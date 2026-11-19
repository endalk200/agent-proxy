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
import type { ObservedWindow, TokenCounts } from "../usage/usage.ts"

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
   * the time in epoch milliseconds. `body` is given for a 429 only, when it
   * could be read.
   */
  readonly limitsOf: (answer: ProviderAnswer, now: number) => LimitSignal
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
}

/** What a response body says its request spent. */
export interface SpentTokens {
  readonly tokens: TokenCounts
  readonly complete: boolean
}

/** How a read of a provider's usage endpoint went. */
export type WindowsRead =
  | { readonly _tag: "Read"; readonly windows: ReadonlyArray<ObservedWindow> }
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
 * it does not know.
 */
export const readUsageEndpoint = (
  http: HttpClient.HttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  now: number,
  parse: (body: Json) => ReadonlyArray<ObservedWindow> | undefined,
): Effect.Effect<WindowsRead> =>
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
    return windows === undefined
      ? ({ _tag: "Failed", reason: "an answer of an unknown shape" } as const)
      : ({ _tag: "Read", windows } as const)
  }).pipe(
    Effect.timeoutOrElse({
      duration: READ_TIMEOUT,
      orElse: () => Effect.succeed({ _tag: "Failed", reason: "no answer in time" } as const),
    }),
    Effect.catch((cause) => Effect.succeed({ _tag: "Failed", reason: cause.message } as const)),
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
