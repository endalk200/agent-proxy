import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"

import type { Account } from "../../src/accounts/account.ts"
import { AccountChanges } from "../../src/accounts/changes.ts"
import { Router } from "../../src/accounts/router.ts"
import { AccountStore, AccountStoreError } from "../../src/accounts/store.ts"
import { AccountEvents } from "../../src/daemon/account-events.ts"

// `AccountEvents` on its own, under the test clock: the store, the router and
// the change signal are fakes, so a test decides exactly what the watcher
// reads and when, and counts how often it reads.

const account = (id: string, label: string): Account => ({
  id,
  provider: "claude",
  providerAccountId: `account-${id}`,
  email: `${id}@example.com`,
  plan: "max",
  label,
  priority: 1,
  enabled: true,
  needsSignIn: false,
  addedAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
  credentials: {
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
})

/** Runs an effect with `layer` built for it, in a scope of its own. */
const withLayer =
  <ROut, E2>(layer: Layer.Layer<ROut, E2>) =>
  <A, E>(effect: Effect.Effect<A, E, ROut>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(effect, context)),
    )

/** A store whose `list` answers with `read`, counting each call. */
const fakes = (options: {
  readonly read: (call: number) => Effect.Effect<ReadonlyArray<Account>, AccountStoreError>
  readonly cooldownEndsAt?: number
  readonly next?: Effect.Effect<void>
}) => {
  let reads = 0
  const unused = Effect.die("not used by AccountEvents")
  const layer = AccountEvents.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AccountStore,
          AccountStore.of({
            list: Effect.suspend(() => options.read(++reads)),
            upsert: () => unused,
            updateSettings: () => unused,
            remove: () => unused,
            updateCredentials: () => unused,
            markUsed: () => unused,
          }),
        ),
        Layer.succeed(
          Router,
          Router.of({
            choose: () => unused,
            record: () => unused,
            view: Effect.succeed({
              status: () => (options.cooldownEndsAt === undefined ? "active" : "cooling-down"),
              cooldownEndsAt: () => options.cooldownEndsAt,
              newSessions: () => undefined,
            }),
          }),
        ),
        Layer.succeed(
          AccountChanges,
          AccountChanges.of({ signal: Effect.void, next: options.next ?? Effect.never }),
        ),
      ),
    ),
  )
  return { layer, reads: () => reads }
}

it.effect("waits between reads while the accounts cannot be read after a cooldown ends (#25)", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const store = fakes({
      read: (call) =>
        call === 1
          ? Effect.succeed([account("a", "Work")])
          : Effect.fail(new AccountStoreError({ message: "the accounts directory is unreadable" })),
      cooldownEndsAt: 10_000,
    })
    yield* Effect.gen(function* () {
      yield* AccountEvents
      expect(store.reads()).toBe(1)
      // The cooldown ends, and every read after it fails.
      yield* TestClock.adjust("10 seconds")
      yield* TestClock.adjust("5 seconds")
      // About one read a second, never a loop that rereads at once.
      expect(store.reads()).toBeGreaterThan(1)
      expect(store.reads()).toBeLessThanOrEqual(7)
    }).pipe(withLayer(store.layer))
  }),
)

it.effect(
  "ends a subscriber that falls too far behind, so it reconnects to a fresh snapshot (#25)",
  () =>
    Effect.gen(function* () {
      let label = 0
      let signals = 0
      const store = fakes({
        // Each read finds the account renamed, which is one event.
        read: () => Effect.sync(() => [account("a", `Work ${label++}`)]),
        // A change is signalled whenever the watcher waits, 2,000 times.
        next: Effect.suspend(() => (signals++ < 2000 ? Effect.yieldNow : Effect.never)),
      })
      yield* Effect.gen(function* () {
        const { feed } = yield* AccountEvents
        // A subscriber that takes the snapshot, then stops reading until `gate` opens.
        const gate = yield* Deferred.make<void>()
        const received: Array<unknown> = []
        const reader = yield* feed.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => received.push(event)).pipe(
              Effect.andThen(received.length === 1 ? Deferred.await(gate) : Effect.void),
            ),
          ),
          Effect.forkChild,
        )
        while (received.length === 0) yield* Effect.yieldNow
        // The watcher publishes far more than the backlog meanwhile.
        yield* Effect.yieldNow.pipe(Effect.repeat({ while: () => signals < 2000 }))
        yield* Deferred.succeed(gate, undefined)

        // The stream ended, rather than going on with events missing; the
        // client reconnects, and its first event is a fresh snapshot.
        const ended = yield* Fiber.join(reader).pipe(
          Effect.timeout("2 seconds"),
          Effect.exit,
          TestClock.withLive,
        )
        expect(Exit.isSuccess(ended)).toBe(true)
        // It fell behind: it got the snapshot and a backlog's worth, never all 2,000.
        expect(received.length).toBeGreaterThan(1000)
        expect(received.length).toBeLessThan(1 + 2000)
      }).pipe(withLayer(store.layer))
    }),
)
