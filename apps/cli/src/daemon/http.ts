import { isIP } from "node:net"

import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

/** Helpers shared by the daemon API's routes. */

/**
 * True when `ip` is a loopback address. Only an IP literal is one: a name
 * such as `127.evil.example` merely looks like one, and a page that rebinds
 * it to loopback must still be refused.
 */
const isLoopback = (ip: string) =>
  isIP(ip) !== 0 && (ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127."))

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

/** The host a `Host` header or origin names, without its port or IPv6 brackets. */
const hostName = (host: string) => {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[(.*)\]$/, "$1")
  } catch {
    return undefined
  }
}

/**
 * True when the request names this daemon by a name only this machine
 * resolves to it: a loopback address, `localhost`, or the address it listens
 * on. A page that rebinds its own name to loopback still sends that name, so
 * it is refused even though it connects from loopback.
 */
const namesThisDaemon = (host: string | undefined, listenHost: string) => {
  if (host === undefined) return true
  const name = hostName(host)
  return name !== undefined && (name === "localhost" || isLoopback(name) || name === listenHost)
}

/**
 * True when the request did not come from a page of another origin: a
 * browser sends `Origin` with every cross-origin request and every POST, so
 * a page elsewhere cannot rotate the key or change accounts by posting a
 * form. The CLI sends none; the dashboard's own requests match its `Host`.
 */
const sameOrigin = (origin: string | undefined, host: string | undefined) => {
  if (origin === undefined) return true
  try {
    return host !== undefined && new URL(origin).host === host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Serves a handler only to clients on this machine, for a daemon listening
 * on `listenHost`: until remote access is designed, the daemon API is local.
 * A browser on this machine is one too, so a request must also name this
 * daemon in `Host` and come from no other site's page.
 */
export const localOnly =
  (listenHost: string) =>
  <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
      if (!Option.exists(request.peerAddress, (ip) => isThisMachine(ip, listenHost))) {
        return Effect.succeed(
          apiError(403, "The daemon API is served to clients on this machine only."),
        )
      }
      const host = request.headers["host"]
      return namesThisDaemon(host, listenHost) && sameOrigin(request.headers["origin"], host)
        ? handler
        : Effect.succeed(apiError(403, "The daemon API is not served to other sites' pages."))
    })

export type LocalOnly = ReturnType<typeof localOnly>
