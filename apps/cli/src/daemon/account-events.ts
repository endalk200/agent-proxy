import { Clock, Context, Effect, Layer, PubSub, Semaphore, Stream } from "effect"

import { AccountChanges } from "../accounts/changes.ts"
import { Router } from "../accounts/router.ts"
import { AccountStore } from "../accounts/store.ts"
import {
  type AccountEvent,
  accountEvents,
  type AccountList,
  type AccountSnapshot,
  toAccountList,
} from "./api.ts"

/** How many events a subscriber that stops reading may fall behind before the oldest are dropped. */
const EVENT_BACKLOG = 1024

/**
 * Account events for the daemon API's event stream. A watcher reads the
 * accounts again whenever the store or router signal a change, and when the
 * first running cooldown ends, which nothing writes, and publishes how the
 * list moved since it last read it. No event is kept: a subscriber gets the
 * accounts as the watcher last read them, then each event after.
 */
export class AccountEvents extends Context.Service<
  AccountEvents,
  {
    /** The accounts as they are now, then each change to them, for as long as it is read. */
    readonly feed: Stream.Stream<AccountSnapshot | AccountEvent>
  }
>()("agent-proxy/AccountEvents") {
  static readonly layer = Layer.effect(
    AccountEvents,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const router = yield* Router
      const changes = yield* AccountChanges
      // Bounded, dropping the oldest event for a subscriber that stops reading,
      // so one stuck client can never grow the daemon's memory; a client that
      // reconnects gets a fresh snapshot anyway.
      const events = yield* PubSub.sliding<AccountEvent>(EVENT_BACKLOG)
      yield* Effect.addFinalizer(() => PubSub.shutdown(events))
      // Held while the watcher publishes and while a subscriber joins, so a
      // subscriber's snapshot is exactly the list its first event starts from.
      const lock = yield* Semaphore.make(1)

      const read = Effect.gen(function* () {
        const accounts = yield* store.list
        return toAccountList(accounts, yield* router.view)
      })
      let current: AccountList = yield* read.pipe(
        Effect.orElseSucceed((): AccountList => ({ accounts: [], pools: [] })),
      )

      /** Waits for a signal, or for the first running cooldown to end. */
      const untilChanged = Effect.suspend(() => {
        const ends = current.accounts.flatMap((account) =>
          account.cooldownEndsAt === null ? [] : [Date.parse(account.cooldownEndsAt)],
        )
        if (ends.length === 0) return changes.next
        return Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.timeoutOrElse(changes.next, {
            duration: Math.max(0, Math.min(...ends) - now),
            orElse: () => Effect.void,
          }),
        )
      })

      /** Reads the accounts and publishes how they moved since the last read; call it holding `lock`. */
      const catchUp = Effect.gen(function* () {
        const next = yield* read
        const happened = accountEvents(current, next)
        current = next
        yield* PubSub.publishAll(events, happened)
      })

      yield* untilChanged.pipe(
        Effect.andThen(lock.withPermit(catchUp)),
        Effect.ignore({ log: "Warn", message: "could not read the accounts for the event stream" }),
        Effect.forever,
        Effect.forkScoped,
      )

      const feed = Stream.unwrap(
        lock.withPermit(
          Effect.gen(function* () {
            // The snapshot is as fresh as `GET /api/accounts`; whatever moved
            // since the last read reaches the subscribers already listening.
            // Accounts that cannot be read end the stream instead of looking
            // like none: the client reconnects, and `GET /api/accounts` says why.
            yield* catchUp.pipe(
              Effect.tapError((error) =>
                Effect.logWarning("could not read the accounts for the event stream").pipe(
                  Effect.annotateLogs({ cause: error.message }),
                ),
              ),
              Effect.orDie,
            )
            const subscription = yield* PubSub.subscribe(events)
            const snapshot: AccountSnapshot = { type: "snapshot", ...current }
            return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription))
          }),
        ),
      )

      return AccountEvents.of({ feed })
    }),
  )
}
