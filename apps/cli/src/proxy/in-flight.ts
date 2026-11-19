import { Context, Duration, Effect } from "effect"

/**
 * The proxied requests in flight: each one from when its proxy key is
 * accepted until the client has its whole answer, or has gone away. The
 * daemon waits for none to be in flight before it stops, so a restart never
 * cuts a client's turn short (ADR-0002).
 */

/**
 * How long a stopping daemon waits for the requests in flight to finish. A
 * long Claude turn streams for minutes; one still going after this is cut.
 */
export const DrainLimit = Context.Reference<Duration.Input>("agent-proxy/DrainLimit", {
  defaultValue: () => "10 minutes",
})

/** How the wait for no request in flight ended. */
export type Drained = "idle" | "timed-out" | "signalled"

export class InFlight extends Context.Service<
  InFlight,
  {
    /**
     * Counts one request as in flight, and returns what ends it. Ending it
     * twice counts once. `aborted` ends it too, once it fires: a client that
     * goes away before its answer starts streaming must not hold up a stop.
     */
    readonly enter: (aborted: AbortSignal | undefined) => Effect.Effect<Effect.Effect<void>>
    readonly count: Effect.Effect<number>
    /**
     * Waits until no request is in flight, at most `max` of real time (the
     * wait is for clients, whatever clock the daemon's effects see), or until
     * the process gets SIGTERM or SIGINT again, which says to stop now.
     */
    readonly drain: (max: Duration.Input) => Effect.Effect<Drained>
  }
>()("agent-proxy/InFlight") {}

export const makeInFlight = () => {
  let count = 0
  // Settled whenever no request is in flight.
  let idle = Promise.withResolvers<void>()
  idle.resolve()

  const enter = (aborted: AbortSignal | undefined) =>
    Effect.sync(() => {
      if (count === 0) idle = Promise.withResolvers<void>()
      count++
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        aborted?.removeEventListener("abort", end)
        count--
        if (count === 0) idle.resolve()
      }
      if (aborted?.aborted) end()
      else aborted?.addEventListener("abort", end, { once: true })
      return Effect.sync(end)
    })

  const drain = (max: Duration.Input) =>
    Effect.promise(
      () =>
        new Promise<Drained>((resolve) => {
          const timer = setTimeout(() => finish("timed-out"), Duration.toMillis(max))
          const signalled = () => finish("signalled")
          function finish(how: Drained) {
            clearTimeout(timer)
            process.off("SIGTERM", signalled)
            process.off("SIGINT", signalled)
            resolve(how)
          }
          process.on("SIGTERM", signalled)
          process.on("SIGINT", signalled)
          void idle.promise.then(() => finish("idle"))
        }),
    )

  return InFlight.of({ enter, count: Effect.sync(() => count), drain })
}
