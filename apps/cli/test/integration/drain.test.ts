import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  ConfigProvider,
  type Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Scope,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints, realEndpoints } from "../../src/providers/endpoints.ts"
import { DrainLimit } from "../../src/proxy/in-flight.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { type FakeClaude, fakeClaude } from "../support/fake-claude.ts"

// A daemon that is told to stop while a client's turn streams through it, as
// `daemon restart` and `install-local` do (ADR-0002): it serves on until no
// proxied request is in flight, at most the drain limit, then stops. The
// daemon runs in-process in its own scope, closed here as SIGTERM closes it.

const encoder = new TextEncoder()
const event = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)

/** A streamed Claude answer that starts at once and finishes only when `finish` is called. */
const heldStream = () => {
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
  const response = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(event({ type: "message_start", message: { usage: {} } }))
        await finished
        controller.enqueue(event({ type: "message_stop" }))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  return { response, finish }
}

/** A daemon in a throwaway home holding one Claude account, in a scope of its own. */
const makeDaemon = (claude: FakeClaude, options: { readonly drainLimit?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-drain-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const accounts = `${root}/data/agent-proxy/accounts`
    yield* fs.makeDirectory(accounts, { recursive: true, mode: 0o700 })
    yield* fs.writeFileString(
      `${accounts}/work.json`,
      JSON.stringify({
        id: "work",
        provider: "claude",
        providerAccountId: "account-work:org-work",
        email: "me@work.example",
        plan: "Max 20x",
        label: "Work",
        priority: 1,
        enabled: true,
        needsSignIn: false,
        addedAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
        credentials: {
          accessToken: "sk-ant-oat01-work",
          refreshToken: "sk-ant-ort01-work",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      }),
      { mode: 0o600 },
    )
    const scope = yield* Scope.make()
    const daemon = yield* startDaemon.pipe(
      Effect.provideService(
        ProviderEndpoints,
        ProviderEndpoints.of({ ...realEndpoints, claude: claude.endpoints }),
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          HOME: `${root}/home`,
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_STATE_HOME: `${root}/state`,
          XDG_DATA_HOME: `${root}/data`,
        }),
      ),
      options.drainLimit === undefined
        ? (effect) => effect
        : Effect.provideService(DrainLimit, options.drainLimit),
      Scope.provide(scope),
    )
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const key = yield* Effect.promise(async () => {
      const body: unknown = await (await fetch(`${daemon.address}/api/key`)).json()
      return typeof body === "object" && body !== null && "key" in body ? String(body.key) : ""
    })
    /** Starts a message request, returning once its answer's first event has arrived. */
    const startTurn = (turn: { readonly hangUp?: boolean } = {}) =>
      Effect.promise(async () => {
        const client = new AbortController()
        const response = await fetch(`${daemon.address}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [] }),
          signal: client.signal,
        })
        const reader = (response.body ?? new ReadableStream<Uint8Array>())
          .pipeThrough(new TextDecoderStream())
          .getReader()
        const first = await reader.read()
        // A client that hangs up once its answer has started.
        if (turn.hangUp === true) client.abort()
        /** The rest of the answer, or how it was cut off. */
        const rest = async () => {
          let text = first.value ?? ""
          try {
            for (;;) {
              // oxlint-disable-next-line no-await-in-loop -- the answer arrives one chunk at a time
              const chunk = await reader.read()
              if (chunk.done) return { text, cut: false }
              text += chunk.value
            }
          } catch {
            return { text, cut: true }
          }
        }
        return { status: response.status, rest }
      })
    /** Stops the daemon in the background, as SIGTERM does; the fiber ends once it has stopped. */
    const stop = Effect.forkDetach(Scope.close(scope, Exit.void))
    return { address: daemon.address, key, startTurn, stop }
  })

const isDone = <A, E>(fiber: Fiber.Fiber<A, E>) => fiber.pollUnsafe() !== undefined

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    FetchHttpClient.layer,
  ),
)("a stopping daemon", (it) => {
  it.effect("serves on until the turn in flight finishes, then stops", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const held = heldStream()
        let calls = 0
        claude.answerApiWith(() =>
          ++calls === 1
            ? held.response
            : Response.json({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }),
        )
        const daemon = yield* makeDaemon(claude)
        const turn = yield* daemon.startTurn()
        expect(turn.status).toBe(200)

        const stopping = yield* daemon.stop
        yield* Effect.promise(() => Bun.sleep(300))
        expect(isDone(stopping)).toBe(false)
        // Still serving: a client that sends meanwhile is served, not refused.
        const health = yield* Effect.promise(() => fetch(`${daemon.address}/healthz`))
        expect(health.status).toBe(200)
        const meanwhile = yield* Effect.promise(() =>
          fetch(`${daemon.address}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": daemon.key },
            body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
          }),
        )
        expect(meanwhile.status).toBe(200)
        expect(isDone(stopping)).toBe(false)

        held.finish()
        const answer = yield* Effect.promise(turn.rest)
        expect(answer.cut).toBe(false)
        expect(answer.text).toContain("message_stop")
        yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"))
      }),
    ),
  )

  it.effect("a client that goes away mid-turn does not hold up the stop", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        claude.answerApiWith(() => heldStream().response)
        const daemon = yield* makeDaemon(claude)
        yield* daemon.startTurn({ hangUp: true })

        const stopping = yield* daemon.stop
        yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"))
      }),
    ),
  )

  it.effect("a turn sent while the daemon waits is served, and waited for too", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const first = heldStream()
        const second = heldStream()
        let calls = 0
        claude.answerApiWith(() => (++calls === 1 ? first.response : second.response))
        const daemon = yield* makeDaemon(claude)
        const firstTurn = yield* daemon.startTurn()

        const stopping = yield* daemon.stop
        const secondTurn = yield* daemon.startTurn()
        expect(secondTurn.status).toBe(200)
        first.finish()
        expect((yield* Effect.promise(firstTurn.rest)).cut).toBe(false)
        yield* Effect.promise(() => Bun.sleep(300))
        // The first turn is done, but the second is still in flight.
        expect(isDone(stopping)).toBe(false)

        second.finish()
        const answer = yield* Effect.promise(secondTurn.rest)
        expect(answer.cut).toBe(false)
        expect(answer.text).toContain("message_stop")
        yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"))
      }),
    ),
  )

  it.effect("a client that goes away before Claude answers does not hold up the stop", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const { promise: asked, resolve: onAsked } = Promise.withResolvers<void>()
        // Claude takes the request and never sends its headers.
        claude.answerApiWith(() => {
          onAsked()
          return new Promise<Response>(() => {})
        })
        const daemon = yield* makeDaemon(claude)
        yield* Effect.promise(async () => {
          const client = new AbortController()
          const pending = fetch(`${daemon.address}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": daemon.key },
            body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
            signal: client.signal,
          }).catch(() => undefined)
          await asked
          client.abort()
          await pending
        })

        const stopping = yield* daemon.stop
        yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"))
      }),
    ),
  )

  it.effect("an answer with no body, such as a 204, does not hold up the stop", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        claude.answerApiWith(() => new Response(null, { status: 204 }))
        const daemon = yield* makeDaemon(claude)
        const answer = yield* Effect.promise(() =>
          fetch(`${daemon.address}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": daemon.key },
            body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
          }),
        )
        expect(answer.status).toBe(204)

        const stopping = yield* daemon.stop
        yield* Fiber.join(stopping).pipe(Effect.timeout("3 seconds"))
      }),
    ),
  )

  it.effect(
    "a turn still in flight at the drain limit is cut, and the daemon stops",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          claude.answerApiWith(() => heldStream().response)
          const daemon = yield* makeDaemon(claude, { drainLimit: "300 millis" })
          const turn = yield* daemon.startTurn()

          const stopping = yield* daemon.stop
          yield* Fiber.join(stopping).pipe(Effect.timeout("10 seconds"))
          const answer = yield* Effect.promise(turn.rest)
          expect(answer.text).not.toContain("message_stop")
        }),
      ),
    15_000,
  )
})
