import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

/** Helpers shared by the daemon API's routes. */

const isLoopback = (ip: string) =>
  ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")

/** The daemon API's error body, `{ "error": message }`, with `status`. */
export const apiError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status })

/**
 * Serves `handler` only to loopback clients: until remote access is designed,
 * the daemon API is local.
 */
export const loopbackOnly = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Option.exists(request.peerAddress, isLoopback)
      ? handler
      : Effect.succeed(apiError(403, "The daemon API is served to clients on this machine only.")),
  )
