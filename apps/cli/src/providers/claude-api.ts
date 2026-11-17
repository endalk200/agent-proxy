import { Context, Data, Effect, Layer } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http"

import { ProviderEndpoints } from "./endpoints.ts"

/**
 * The Claude adapter's upstream half: sends a client's request on to Claude's
 * API as the chosen account. It changes only what ADR-0006 allows: the
 * account's bearer token replaces the proxy key, and Claude's OAuth beta flag
 * is added when the client did not send it. Everything else, body included,
 * goes through byte for byte.
 */

export class ClaudeUnreachable extends Data.TaggedError("ClaudeUnreachable")<{
  readonly cause: unknown
}> {
  override get message() {
    return "agent-proxy: could not reach Claude. Check this machine's network connection."
  }
}

/** A client's request, as the proxy received it. */
export interface ProxiedRequest {
  readonly method: "POST"
  /** The path and query string, such as `/v1/messages?beta=true`. */
  readonly url: string
  readonly headers: Headers.Headers
  readonly body: Uint8Array
}

/**
 * Bun's fetch options for passthrough: a compressed body stays as it arrived,
 * so the client gets the bytes its `content-encoding` header describes, and a
 * redirect goes back to the client rather than being followed with the
 * account's token.
 */
const passThroughEncoding: BunFetchRequestInit = { decompress: false, redirect: "manual" }

/** The beta flag that lets an OAuth token call the API. */
const OAUTH_BETA = "oauth-2025-04-20"

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

/** `anthropic-beta` with the OAuth flag added, unless the client already sent it. */
const withOAuthBeta = (beta: string | undefined): string => {
  const flags = (beta ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag !== "")
  return beta !== undefined && flags.includes(OAUTH_BETA) ? beta : [...flags, OAUTH_BETA].join(",")
}

/** The headers Claude gets: the client's, with the account's token in place of the proxy key. */
const upstreamHeaders = (headers: Headers.Headers, accessToken: string) => {
  const forwarded = Headers.removeMany(headers, NOT_FORWARDED)
  return Headers.setAll(forwarded, {
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": withOAuthBeta(headers["anthropic-beta"]),
  })
}

export class ClaudeApi extends Context.Service<
  ClaudeApi,
  {
    /**
     * Sends `request` to Claude as the account whose access token is given,
     * and returns Claude's response as soon as its headers arrive; its body
     * is read as it streams in, still encoded as Claude sent it.
     */
    readonly send: (
      request: ProxiedRequest,
      accessToken: string,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, ClaudeUnreachable>
  }
>()("agent-proxy/ClaudeApi") {
  static readonly layer = Layer.effect(
    ClaudeApi,
    Effect.gen(function* () {
      const { claude: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient

      const send = Effect.fn("ClaudeApi.send")(function* (
        request: ProxiedRequest,
        accessToken: string,
      ) {
        return yield* HttpClientRequest.make(request.method)(
          `${endpoints.apiBaseUrl}${request.url}`,
        ).pipe(
          HttpClientRequest.setHeaders(upstreamHeaders(request.headers, accessToken)),
          HttpClientRequest.setBody(
            HttpBody.raw(request.body, {
              contentType: request.headers["content-type"],
              contentLength: request.body.byteLength,
            }),
          ),
          http.execute,
          // Nothing but the client's own headers goes upstream: no trace headers.
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.provideService(FetchHttpClient.RequestInit, passThroughEncoding),
          Effect.mapError((cause) => new ClaudeUnreachable({ cause })),
        )
      })

      return ClaudeApi.of({ send })
    }),
  )
}
