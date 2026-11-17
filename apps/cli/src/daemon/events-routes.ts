import { Deferred, Effect, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { AccountEvents } from "./account-events.ts"
import type { LocalOnly } from "./http.ts"

/**
 * `GET /api/events`: a server-sent event stream of account changes. Its first
 * event is every account and pool as they are now; each one after is a
 * change. Each event's data is one JSON object whose `type` says which.
 *
 * - The stream asks clients to reconnect a second after it drops, so a
 *   restarted daemon is back on the page at once; a reconnected client gets
 *   the accounts as they are then, never the events it missed.
 * - A comment every 15 seconds keeps an idle connection, and any proxy on
 *   its way, from dropping it, and tells a client the daemon still answers.
 */

/** How long a client waits before reconnecting a stream that dropped. */
export const RECONNECT_MS = 1000

/** How often an idle stream gets a keep-alive comment. */
export const KEEP_ALIVE = "15 seconds"

/** Adds the route, served only to clients `localOnly` lets through. Every stream ends once `closing` is done. */
export const eventRoutes = (
  router: HttpRouter.HttpRouter,
  localOnly: LocalOnly,
  closing: Deferred.Deferred<void>,
) =>
  router.add(
    "GET",
    "/api/events",
    localOnly(
      Effect.map(AccountEvents, ({ feed }) => {
        const events = feed.pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`))
        const keepAlive = Stream.tick(KEEP_ALIVE).pipe(
          Stream.drop(1),
          Stream.map(() => ": keep-alive\n\n"),
        )
        const body = Stream.make(`retry: ${RECONNECT_MS}\n\n`).pipe(
          Stream.concat(Stream.merge(events, keepAlive, { haltStrategy: "left" })),
          // An open stream never holds up the daemon's shutdown.
          Stream.interruptWhen(Deferred.await(closing)),
          Stream.encodeText,
        )
        return HttpServerResponse.stream(body, {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
        })
      }),
    ),
  )
