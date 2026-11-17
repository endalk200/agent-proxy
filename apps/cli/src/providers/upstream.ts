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
}

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

/** The headroom left by the most used of `usedShares` (each 0 to 1), or none when none is known. */
export const headroomOf = (usedShares: ReadonlyArray<number | undefined>): number | undefined => {
  const known = usedShares.filter((share) => share !== undefined)
  return known.length === 0 ? undefined : Math.min(1, Math.max(0, 1 - Math.max(...known)))
}

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
