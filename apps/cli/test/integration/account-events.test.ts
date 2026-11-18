import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Console, Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import type { Provider } from "../../src/accounts/account.ts"
import { Browser } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { alice, type ClaudeUser, fakeClaude, limitHeaders } from "../support/fake-claude.ts"
import { fakeCodex } from "../support/fake-codex.ts"
import { noLaunchd } from "../support/no-launchd.ts"

// The daemon's event stream of account changes, in-process: a real daemon on
// loopback in a throwaway home, fake Claude and Codex backends, and Effect's
// test clock, which starts at the epoch and moves only when a test moves it.
// Tests read `GET /api/events` the way a browser's EventSource does, as text
// over a real socket, and change accounts only the way a client or the owner
// can: through the daemon API, the CLI, or the proxy.

/** One message on the stream: a comment, a reconnection delay, or an event's JSON data. */
type Message =
  | { readonly kind: "comment"; readonly text: string }
  | { readonly kind: "retry"; readonly ms: number }
  | { readonly kind: "data"; readonly json: unknown }

const parseMessage = (block: string): Message => {
  if (block.startsWith(":")) return { kind: "comment", text: block.slice(1).trim() }
  if (block.startsWith("retry:")) return { kind: "retry", ms: Number(block.slice(6)) }
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
  return { kind: "data", json: JSON.parse(data) }
}

/** How long a test waits on the stream before failing, in real time. */
const STREAM_WAIT_MS = 3000

/**
 * Opens the event stream at `address`, closed when the test's scope closes.
 * `next` waits for the next message; `nextEvent` skips comments and retries.
 */
const openEvents = (address: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const controller = new AbortController()
      const response = await fetch(`${address}/api/events`, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      })
      const reader = (response.body ?? new ReadableStream<Uint8Array>())
        .pipeThrough(new TextDecoderStream())
        .getReader()
      let buffer = ""
      /** The next message, or `undefined` when the stream ends. */
      const read = async (): Promise<Message | undefined> => {
        const end = buffer.indexOf("\n\n")
        if (end !== -1) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          return parseMessage(block)
        }
        const chunk = await reader.read()
        if (chunk.done) return undefined
        buffer += chunk.value
        return read()
      }
      return { controller, response, read }
    }),
    ({ controller }) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.map(({ response, read }) => {
      const next = Effect.promise(() =>
        Promise.race([
          read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`no message on the stream within ${STREAM_WAIT_MS}ms`)),
              STREAM_WAIT_MS,
            ),
          ),
        ]),
      )
      const nextEvent: Effect.Effect<unknown> = Effect.flatMap(next, (message) =>
        message === undefined
          ? Effect.die(new Error("the stream ended"))
          : message.kind === "data"
            ? Effect.succeed(message.json)
            : nextEvent,
      )
      return { response, next, nextEvent }
    }),
  )

/** A loopback port nothing listens on now. */
const freePort = Effect.sync(() => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port ?? 0
  void server.stop(true)
  return port
})

/**
 * A daemon in a throwaway home whose Claude and Codex traffic goes to the
 * fakes, listening on `listen`, and running until `scope` closes (by default
 * the test's). `start` starts another daemon in the same home, as a restart
 * does, in the scope it runs in.
 */
const makeHome = (options: { readonly listen?: string; readonly scope?: Scope.Scope } = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0)
    const fs = yield* FileSystem.FileSystem
    const claude = yield* fakeClaude
    const codex = yield* fakeCodex
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-events-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(
      `${root}/config/agent-proxy/config.toml`,
      `listen = "${options.listen ?? "127.0.0.1:0"}"\n`,
    )
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
    }
    const start = startDaemon.pipe(
      Effect.provideService(
        ProviderEndpoints,
        ProviderEndpoints.of({ claude: claude.endpoints, codex: codex.endpoints }),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    )
    const daemon = yield* options.scope === undefined ? start : Scope.provide(start, options.scope)

    /** Runs `agent-proxy <argv>` in this home, as the owner does in a terminal; returns its stdout. */
    const cli = (argv: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const stdout: Array<string> = []
        const console: Console.Console = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            stdout.push(args.join(" "))
          },
        }
        yield* runCli(argv).pipe(
          Effect.provideService(Console.Console, console),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
          Effect.provideService(
            ProviderEndpoints,
            ProviderEndpoints.of({ claude: claude.endpoints, codex: codex.endpoints }),
          ),
        )
        return stdout.join("\n")
      })

    /** Writes the file of an account the daemon held before, as `id` at `priority`. */
    const seed = (
      provider: Provider,
      id: string,
      priority: number,
      settings: { readonly enabled?: boolean; readonly needsSignIn?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        const dir = `${env.XDG_DATA_HOME}/agent-proxy/accounts`
        yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
        yield* fs.writeFileString(
          `${dir}/${id}.json`,
          JSON.stringify({
            id,
            provider,
            providerAccountId: `provider-${id}`,
            email: `${id}@example.com`,
            plan: "Pro",
            label: id,
            priority,
            enabled: settings.enabled ?? true,
            needsSignIn: settings.needsSignIn ?? false,
            addedAt: "1970-01-01T00:00:00.000Z",
            lastUsedAt: null,
            credentials: {
              accessToken: `token-${id}`,
              refreshToken: `refresh-${id}`,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          }),
          { mode: 0o600 },
        )
      })

    /** Calls the daemon API the way the dashboard does. */
    const api = (method: "GET" | "PATCH" | "DELETE", path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await fetch(`${daemon.address}${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        })
        const json: unknown = await response.json()
        return { status: response.status, json }
      })

    /** Adds `user`'s Claude account through a browser login. */
    const signIn = (user: ClaudeUser) =>
      Effect.promise(async () => {
        claude.signInAs(user)
        const started = await fetch(`${daemon.address}/api/logins`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "claude", label: "Alice" }),
        })
        const login: unknown = await started.json()
        const authorizeUrl =
          typeof login === "object" && login !== null && "authorizeUrl" in login
            ? String(login.authorizeUrl)
            : ""
        expect((await fetch(authorizeUrl)).status).toBe(200)
      })

    /** Sends a Claude message request as Claude Code does. */
    const claudeMessage = Effect.gen(function* () {
      const { json } = yield* api("GET", "/api/key")
      const key = typeof json === "object" && json !== null && "key" in json ? String(json.key) : ""
      return yield* Effect.promise(async () => {
        const response = await fetch(`${daemon.address}/v1/messages?beta=true`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 64,
            messages: [{ role: "user", content: "hi" }],
          }),
        })
        return response.status
      })
    })

    return {
      claude,
      codex,
      address: daemon.address,
      dataHome: env.XDG_DATA_HOME,
      seed,
      api,
      signIn,
      claudeMessage,
      cli,
      start,
    }
  })

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    noLaunchd,
    FetchHttpClient.layer,
    Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
  ),
)("the daemon's event stream of account changes", (it) => {
  it.effect("starts with every account and pool as they are now", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      yield* home.seed("claude", "home", 2, { enabled: false })

      const events = yield* openEvents(home.address)
      expect(events.response.headers.get("content-type")).toBe("text/event-stream")
      expect(yield* events.nextEvent).toMatchObject({
        type: "snapshot",
        accounts: [
          { id: "work", status: "active", priority: 1 },
          { id: "home", status: "disabled", priority: 2 },
        ],
        pools: [{ provider: "claude", newSessionsAccountId: "work" }],
      })
    }),
  )

  it.effect(
    "sends no snapshot when it cannot read the accounts, so no client sees an empty list",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        yield* home.seed("claude", "work", 1)
        const dir = `${home.dataHome}/agent-proxy/accounts`
        yield* fs.chmod(dir, 0o000)
        yield* Effect.addFinalizer(() => fs.chmod(dir, 0o700).pipe(Effect.ignore))

        // The stream ends, cleanly or not, before any data: the client reconnects.
        const events = yield* openEvents(home.address)
        let exit = yield* Effect.exit(events.next)
        while (Exit.isSuccess(exit) && exit.value !== undefined && exit.value.kind !== "data") {
          exit = yield* Effect.exit(events.next)
        }
        expect(Exit.isSuccess(exit) && exit.value?.kind === "data").toBe(false)
      }),
  )

  it.effect("an account disabled through the daemon API arrives as a status change", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      yield* home.seed("claude", "home", 2)
      const events = yield* openEvents(home.address)
      yield* events.nextEvent

      expect((yield* home.api("PATCH", "/api/accounts/work", { enabled: false })).status).toBe(200)
      expect(yield* events.nextEvent).toMatchObject({
        type: "status-changed",
        account: { id: "work", status: "disabled", enabled: false },
        previous: { id: "work", status: "active", enabled: true },
        pools: [{ provider: "claude", newSessionsAccountId: "home" }],
      })
    }),
  )

  it.effect("a rename and a move arrive as settings changes, one per account that moved", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      yield* home.seed("claude", "home", 2)
      const events = yield* openEvents(home.address)
      yield* events.nextEvent

      yield* home.api("PATCH", "/api/accounts/home", { label: "Personal" })
      expect(yield* events.nextEvent).toMatchObject({
        type: "settings-changed",
        account: { id: "home", label: "Personal", status: "active" },
        previous: { id: "home", label: "home" },
      })

      yield* home.api("PATCH", "/api/accounts/home", { priority: 1 })
      expect(yield* events.nextEvent).toMatchObject({
        type: "settings-changed",
        account: { id: "home", priority: 1 },
        previous: { priority: 2 },
        pools: [{ provider: "claude", newSessionsAccountId: "home" }],
      })
      expect(yield* events.nextEvent).toMatchObject({
        type: "settings-changed",
        account: { id: "work", priority: 2 },
        previous: { priority: 1 },
      })
    }),
  )

  it.effect("a removed account arrives as it was, and the pool without it", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      yield* home.seed("claude", "home", 2)
      const events = yield* openEvents(home.address)
      yield* events.nextEvent

      yield* home.api("DELETE", "/api/accounts/work")
      expect(yield* events.nextEvent).toMatchObject({
        type: "removed",
        account: { id: "work", label: "work", priority: 1 },
        pools: [{ provider: "claude", newSessionsAccountId: "home" }],
      })
      expect(yield* events.nextEvent).toMatchObject({
        type: "settings-changed",
        account: { id: "home", priority: 1 },
      })
    }),
  )

  it.effect("an account a login adds arrives as added", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      const events = yield* openEvents(home.address)
      expect(yield* events.nextEvent).toEqual({ type: "snapshot", accounts: [], pools: [] })

      yield* home.signIn(alice)
      expect(yield* events.nextEvent).toMatchObject({
        type: "added",
        account: { label: "Alice", email: alice.email, status: "active", priority: 1 },
        pools: [{ provider: "claude" }],
      })
    }),
  )

  it.effect("an account whose refresh Claude refuses arrives as needing sign-in", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.signIn(alice)
      const events = yield* openEvents(home.address)
      yield* events.nextEvent
      home.claude.refuseNextRefresh(400, { error: "invalid_grant" })

      // The fake's tokens last 8 hours; the keeper refreshes an hour early.
      yield* TestClock.adjust("7 hours")
      expect(yield* events.nextEvent).toMatchObject({
        type: "status-changed",
        account: { label: "Alice", status: "needs-sign-in" },
        previous: { status: "active" },
        pools: [{ provider: "claude", newSessionsAccountId: null }],
      })
    }),
  )

  it.effect("a cooldown arrives when Claude limits the account, and again when it ends", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      yield* home.seed("claude", "home", 2)
      // Work's five-hour window is used up until 30 minutes from the clock's start.
      home.claude.answerApiWith((request) =>
        request.headers.get("authorization") === "Bearer token-work"
          ? Response.json(
              { type: "error", error: { type: "rate_limit_error", message: "Rate limited." } },
              {
                status: 429,
                headers: {
                  ...limitHeaders,
                  "anthropic-ratelimit-unified-status": "rejected",
                  "anthropic-ratelimit-unified-reset": "1800",
                  "anthropic-ratelimit-unified-5h-status": "rejected",
                  "anthropic-ratelimit-unified-5h-reset": "1800",
                },
              },
            )
          : Response.json({ type: "message", content: [] }, { headers: limitHeaders }),
      )
      const events = yield* openEvents(home.address)
      yield* events.nextEvent

      expect(yield* home.claudeMessage).toBe(200)
      expect(yield* events.nextEvent).toMatchObject({
        type: "status-changed",
        account: {
          id: "work",
          status: "cooling-down",
          cooldownEndsAt: "1970-01-01T00:30:00.000Z",
        },
        previous: { status: "active", cooldownEndsAt: null },
        pools: [{ provider: "claude", newSessionsAccountId: "home" }],
      })
      // The request moved on to Home, which served it.
      expect(yield* events.nextEvent).toMatchObject({ type: "used", account: { id: "home" } })

      // Nothing writes when a cooldown ends: the daemon notices the time.
      yield* TestClock.adjust("30 minutes")
      expect(yield* events.nextEvent).toMatchObject({
        type: "status-changed",
        account: { id: "work", status: "active", cooldownEndsAt: null },
        previous: { status: "cooling-down" },
        pools: [{ provider: "claude", newSessionsAccountId: "work" }],
      })
    }),
  )

  it.effect("an account serving a request arrives as used, with when", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      home.claude.answerApiWith(() =>
        Response.json({ type: "message", content: [] }, { headers: limitHeaders }),
      )
      const events = yield* openEvents(home.address)
      yield* events.nextEvent

      expect(yield* home.claudeMessage).toBe(200)
      expect(yield* events.nextEvent).toMatchObject({
        type: "used",
        account: { id: "work", status: "active", lastUsedAt: "1970-01-01T00:00:00.000Z" },
        pools: [{ provider: "claude", newSessionsAccountId: "work" }],
      })
    }),
  )

  it.effect("an account disabled from the CLI arrives like any other change", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work", 1)
      yield* home.seed("claude", "home", 2)
      const events = yield* openEvents(home.address)
      yield* events.nextEvent

      yield* home.cli(["accounts", "disable", "work"])
      expect(yield* events.nextEvent).toMatchObject({
        type: "status-changed",
        account: { id: "work", status: "disabled" },
        pools: [{ provider: "claude", newSessionsAccountId: "home" }],
      })
    }),
  )

  it.effect("asks clients to reconnect after a second, and keeps an idle stream alive", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      const events = yield* openEvents(home.address)
      expect(events.response.headers.get("cache-control")).toBe("no-cache")
      expect(yield* events.next).toEqual({ kind: "retry", ms: 1000 })
      expect(yield* events.next).toMatchObject({ kind: "data", json: { type: "snapshot" } })

      yield* TestClock.adjust("15 seconds")
      expect(yield* events.next).toEqual({ kind: "comment", text: "keep-alive" })
      yield* TestClock.adjust("15 seconds")
      expect(yield* events.next).toEqual({ kind: "comment", text: "keep-alive" })
    }),
  )

  it.effect(
    "ends open streams when the daemon stops, and a client that reconnects to the restarted daemon is current again",
    () =>
      Effect.gen(function* () {
        const port = yield* freePort
        // The first daemon runs in its own scope, so the test can stop it.
        const firstRun = yield* Scope.make()
        const home = yield* makeHome({ listen: `127.0.0.1:${port}`, scope: firstRun })
        yield* home.seed("claude", "work", 1)
        const before = yield* openEvents(home.address)
        yield* before.nextEvent

        // Stopping waits up to 5 seconds for requests in flight; a stream is not one.
        const stopping = performance.now()
        yield* Scope.close(firstRun, Exit.void)
        expect(performance.now() - stopping).toBeLessThan(2000)
        expect(yield* before.next).toBeUndefined()

        yield* home.start
        const after = yield* openEvents(home.address)
        expect(yield* after.nextEvent).toMatchObject({
          type: "snapshot",
          accounts: [{ id: "work", status: "active" }],
        })
        yield* home.api("PATCH", "/api/accounts/work", { enabled: false })
        expect(yield* after.nextEvent).toMatchObject({
          type: "status-changed",
          account: { id: "work", status: "disabled" },
        })
      }),
  )
})
