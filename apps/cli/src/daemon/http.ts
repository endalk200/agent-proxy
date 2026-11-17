import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

/** Helpers shared by the daemon API's routes. */

const isLoopback = (ip: string) =>
  ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")

/**
 * True when a peer at `ip` is this machine: a loopback address, or the
 * non-loopback address the daemon listens on, which only this machine can
 * connect from (a client on this machine reaching that address arrives from it).
 */
const isThisMachine = (ip: string, listenHost: string) =>
  isLoopback(ip) || ip === listenHost || ip === `::ffff:${listenHost}`

/** The daemon API's error body, `{ "error": message }`, with `status`. */
export const apiError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status })

/**
 * Serves a handler only to clients on this machine, for a daemon listening
 * on `listenHost`: until remote access is designed, the daemon API is local.
 */
export const localOnly =
  (listenHost: string) =>
  <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Option.exists(request.peerAddress, (ip) => isThisMachine(ip, listenHost))
        ? handler
        : Effect.succeed(
            apiError(403, "The daemon API is served to clients on this machine only."),
          ),
    )

export type LocalOnly = ReturnType<typeof localOnly>
