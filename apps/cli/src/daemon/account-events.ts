import { type Cause, Clock, Context, Effect, Layer, Queue, Semaphore, Stream } from "effect"

import { AccountChanges } from "../accounts/changes.ts"
import { Router } from "../accounts/router.ts"
import { AccountStore } from "../accounts/store.ts"
import { LimitWindows } from "../usage/limit-windows.ts"
import { UsageStore } from "../usage/store.ts"
import {
  accountEvents,
  type AccountList,
  type AccountSnapshot,
  type DaemonEvent,
  type UsageRecorded,
  toAccountList,
} from "./api.ts"

/** How many events a subscriber that stops reading may fall behind before its stream is ended. */
const EVENT_BACKLOG = 1024

/** How long the watcher waits after a read of the accounts fails before it reads again. */
const RETRY_AFTER_FAILURE = "1 second"

/**
 * Events for the daemon API's event stream. A watcher reads the accounts
 * again whenever the store or router signal a change, and when the first
 * running cooldown ends, which nothing writes, and publishes how the list
 * moved since it last read it. Recorded usage and changed limit windows are
 * published as they happen. Each list read is also handed to the usage
 * store, which keeps the names of the accounts held (a removal is recorded
 * where it is made, with the name the account had). No event is
 * kept: a subscriber gets the
 * accounts as the watcher last read them, then each event after. A
 * subscriber that falls more than `EVENT_BACKLOG` events behind has its
 * stream ended, so it reconnects and starts again from a snapshot, rather
 * than going on with events missing.
 */
export class AccountEvents extends Context.Service<
  AccountEvents,
  {
    /** The accounts as they are now, then each event after, for as long as it is read. */
    readonly feed: Stream.Stream<AccountSnapshot | DaemonEvent>
    /** Tells every subscriber that a request's usage was recorded. */
    readonly usageRecorded: (usage: UsageRecorded["usage"]) => Effect.Effect<void>
  }
>()("agent-proxy/AccountEvents") {
  static readonly layer = Layer.effect(
    AccountEvents,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const router = yield* Router
      const changes = yield* AccountChanges
      const limits = yield* LimitWindows
      const usageStore = yield* UsageStore
      // Each subscriber's events wait in its own bounded queue, so one stuck
      // client can never grow the daemon's memory or hold up the others.
      const subscribers = new Set<Queue.Queue<DaemonEvent, Cause.Done>>()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const queue of subscribers) Queue.endUnsafe(queue)
          subscribers.clear()
        }),
      )
      /** Hands `happened` to every subscriber, ending the stream of one that has fallen too far behind. */
      const publish = (happened: ReadonlyArray<DaemonEvent>) =>
        Effect.sync(() => {
          for (const queue of subscribers) {
            if (!happened.every((event) => Queue.offerUnsafe(queue, event))) {
              subscribers.delete(queue)
              Queue.endUnsafe(queue)
            }
          }
        })
      // Held while the watcher publishes and while a subscriber joins, so a
      // subscriber's snapshot is exactly the list its first event starts from.
      const lock = yield* Semaphore.make(1)

      const read = Effect.gen(function* () {
        const accounts = yield* store.list
        return toAccountList(accounts, yield* router.view)
      })
      /**
       * Hands the usage store the accounts `list` holds, read from `readAt`.
       * It writes on every read, rare as they are: a list that looks the same
       * as the last one may follow a removal and a sign-in back that no read
       * saw between them.
       */
      const remember = (list: AccountList, readAt: number) =>
        usageStore
          .rememberAccounts(
            list.accounts.map(({ id, provider, label, email, plan }) => ({
              id,
              provider,
              label,
              email,
              plan,
            })),
            readAt,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("could not remember the accounts' names").pipe(
                Effect.annotateLogs({ cause: error.message }),
              ),
            ),
          )

      /** Reads the accounts, and hands them to the usage store. */
      const readAndRemember = Effect.gen(function* () {
        const readAt = yield* Clock.currentTimeMillis
        const list = yield* read
        yield* remember(list, readAt)
        return list
      })

      let current: AccountList = yield* readAndRemember.pipe(
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
        const next = yield* readAndRemember
        const happened = accountEvents(current, next)
        current = next
        yield* publish(happened)
      })

      yield* untilChanged.pipe(
        Effect.andThen(lock.withPermit(catchUp)),
        // `current` stays as it was, so a cooldown in it that has ended would
        // make the next wait return at once: waiting here keeps a read that
        // keeps failing from spinning and flooding the log.
        Effect.catch((error) =>
          Effect.logWarning("could not read the accounts for the event stream").pipe(
            Effect.annotateLogs({ cause: error.message }),
            Effect.andThen(Effect.sleep(RETRY_AFTER_FAILURE)),
          ),
        ),
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
            const queue = yield* Queue.dropping<DaemonEvent, Cause.Done>(EVENT_BACKLOG)
            subscribers.add(queue)
            const snapshot: AccountSnapshot = { type: "snapshot", ...current }
            return Stream.concat(Stream.make(snapshot), Stream.fromQueue(queue)).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  subscribers.delete(queue)
                  Queue.endUnsafe(queue)
                }),
              ),
            )
          }),
        ),
      )

      const nextLimits = yield* limits.subscribe
      yield* nextLimits.pipe(
        Effect.flatMap((changed) => publish([{ type: "limits-changed", limits: changed }])),
        Effect.forever,
        Effect.forkScoped,
      )

      return AccountEvents.of({
        feed,
        usageRecorded: (usage) => publish([{ type: "usage-recorded", usage }]),
      })
    }),
  )
}
