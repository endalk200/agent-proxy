import { Context, Effect, Layer, Queue } from "effect"

/**
 * A signal that some account may have changed: the store raises it after
 * each write, and the router when a cooldown starts. It says nothing about
 * what changed; whoever waits on it reads the accounts again to find out.
 * Signals raised while nobody waits fold into one.
 */
export class AccountChanges extends Context.Service<
  AccountChanges,
  {
    /** Says that some account may have changed. */
    readonly signal: Effect.Effect<void>
    /** Waits for a signal raised since the last wait returned. */
    readonly next: Effect.Effect<void>
  }
>()("agent-proxy/AccountChanges") {
  static readonly layer = Layer.effect(
    AccountChanges,
    Effect.gen(function* () {
      const signals = yield* Queue.sliding<void>(1)
      return AccountChanges.of({
        signal: Queue.offer(signals, undefined).pipe(Effect.asVoid),
        next: Queue.take(signals),
      })
    }),
  )
}
