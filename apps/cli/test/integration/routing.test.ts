import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import type { Provider } from "../../src/accounts/account.ts"
import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { fakeClaude, limitHeaders } from "../support/fake-claude.ts"
import { codexHeaders, fakeCodex } from "../support/fake-codex.ts"

// Routing across a pool, in-process: a real daemon on loopback in a throwaway
// home, fake Claude and Codex backends, and Effect's test clock, which starts
// at the epoch and moves only when a test moves it. Sockets are real. Tests
// see only what a client sees (which account's token reached the provider,
// and the proxy's answers) and what the daemon API reports.

/** A daemon in a throwaway home whose Claude and Codex traffic goes to the fakes. */
const makeHome = Effect.gen(function* () {
  // The test clock is shared by the tests in this file: each starts at the epoch.
  yield* TestClock.setTime(0)
  const fs = yield* FileSystem.FileSystem
  const claude = yield* fakeClaude
  const codex = yield* fakeCodex
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-routing-" })
  yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
  yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
  const env = {
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_STATE_HOME: `${root}/state`,
    XDG_DATA_HOME: `${root}/data`,
  }
  const daemon = yield* startDaemon.pipe(
    Effect.provideService(
      ProviderEndpoints,
      ProviderEndpoints.of({ claude: claude.endpoints, codex: codex.endpoints }),
    ),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
  )

  const send = (path: string, init: RequestInit = {}) =>
    Effect.promise(async () => {
      const response = await fetch(`${daemon.address}${path}`, init)
      return { status: response.status, headers: response.headers, text: await response.text() }
    })

  const api = (method: "GET" | "PATCH" | "DELETE", path: string, body?: unknown) =>
    Effect.map(
      send(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
      (response) => ({ status: response.status, json: JSON.parse(response.text) }),
    )

  const key = Effect.map(api("GET", "/api/key"), (response) => String(response.json.key))

  /**
   * Writes the file of an account the daemon held before, as `id` at
   * `priority`. Its access token is `token-<id>`, so a test tells which
   * account served a request by the token that reached the provider.
   */
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

  /** Sends a Claude message request as Claude Code does, in `session` when one is given. */
  const claudeMessage = (session?: string) =>
    Effect.gen(function* () {
      return yield* send("/v1/messages?beta=true", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": yield* key,
          ...(session === undefined ? {} : { "x-claude-code-session-id": session }),
        },
        body: messagesBody,
      })
    })

  /** Sends a Codex Responses request with `headers` and the body's fields laid over a short request. */
  const codexResponse = (
    options: {
      readonly headers?: Readonly<Record<string, string>>
      readonly body?: Readonly<Record<string, unknown>>
    } = {},
  ) =>
    Effect.gen(function* () {
      return yield* send("/backend-api/codex/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${yield* key}`,
          ...options.headers,
        },
        body: JSON.stringify({ ...responsesBody, ...options.body }),
      })
    })

  /** The account each request so far reached `provider` as, oldest first. */
  const servedBy = (provider: Provider) =>
    (provider === "claude" ? claude : codex)
      .apiRequests()
      .map((request) => request.headers["authorization"]?.replace(/^Bearer token-/, ""))

  /** `GET /api/accounts`: each account's status, and cooldown end when it has one. */
  const accounts = Effect.map(api("GET", "/api/accounts"), (response) => response.json)

  return { claude, codex, send, api, seed, claudeMessage, codexResponse, servedBy, accounts }
})

const messagesBody = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
})

const responsesBody = {
  model: "gpt-6-luna",
  instructions: "You are Codex.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: true,
  store: false,
}

/** A Claude answer with `headers` laid over the usual limit headers. */
const claudeAnswer = (status: number, headers: Readonly<Record<string, string>> = {}) =>
  Response.json(
    status === 200
      ? { id: "msg_fake", type: "message", content: [{ type: "text", text: "Hello." }] }
      : { type: "error", error: { type: "rate_limit_error", message: "Rate limited." } },
    { status, headers: { ...limitHeaders, ...headers } },
  )

/** A short streamed Codex answer with the usual limit headers. */
const codexAnswer = () =>
  new Response(
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { ...codexHeaders, "content-type": "text/event-stream" } },
  )

/** Account `id`'s status and cooldown end in a `GET /api/accounts` answer. */
const statusOf = (list: unknown, id: string) => {
  const accounts: ReadonlyArray<{
    readonly id: string
    readonly status: string
    readonly cooldownEndsAt: string | null
  }> =
    typeof list === "object" && list !== null && "accounts" in list && Array.isArray(list.accounts)
      ? list.accounts
      : []
  const account = accounts.find((candidate) => candidate.id === id)
  return { status: account?.status, cooldownEndsAt: account?.cooldownEndsAt }
}

/** The account a provider request was sent as, from its token. */
const accountOf = (request: Request) =>
  request.headers.get("authorization")?.replace(/^Bearer token-/, "") ?? ""

const services = Layer.mergeAll(
  BunServices.layer,
  RuntimeInfo.layerProcess,
  Processes.layerProcess,
  FetchHttpClient.layer,
)

layer(services)("routing a pool's accounts", (it) => {
  it.effect("a session stays on its account while another session goes by priority", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1, { enabled: false })
      yield* home.seed("claude", "second", 2)

      expect((yield* home.claudeMessage("session-a")).status).toBe(200)
      yield* home.api("PATCH", "/api/accounts/first", { enabled: true })
      expect((yield* home.claudeMessage("session-a")).status).toBe(200)
      expect((yield* home.claudeMessage("session-b")).status).toBe(200)
      expect((yield* home.claudeMessage()).status).toBe(200)

      expect(home.servedBy("claude")).toEqual(["second", "second", "first", "first"])
    }),
  )

  it.effect("after an hour idle, a session can move to a higher-priority account", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1, { enabled: false })
      yield* home.seed("claude", "second", 2)

      yield* home.claudeMessage("session-a")
      yield* home.api("PATCH", "/api/accounts/first", { enabled: true })
      yield* TestClock.adjust("59 minutes")
      yield* home.claudeMessage("session-a")
      yield* TestClock.adjust("59 minutes")
      yield* home.claudeMessage("session-a")
      yield* TestClock.adjust("60 minutes")
      yield* home.claudeMessage("session-a")

      expect(home.servedBy("claude")).toEqual(["second", "second", "second", "first"])
    }),
  )

  it.effect("a session whose account is disabled or removed moves to the next account", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      yield* home.seed("claude", "second", 2)
      yield* home.seed("claude", "third", 3)

      yield* home.claudeMessage("session-a")
      yield* home.api("PATCH", "/api/accounts/first", { enabled: false })
      yield* home.claudeMessage("session-a")
      yield* home.api("PATCH", "/api/accounts/first", { enabled: true })
      yield* home.api("DELETE", "/api/accounts/second")
      yield* home.claudeMessage("session-a")

      expect(home.servedBy("claude")).toEqual(["first", "second", "first"])
    }),
  )

  it.effect(
    "a Claude window limit moves the request to the next account, cooled until the window resets",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome
        yield* home.seed("claude", "first", 1)
        yield* home.seed("claude", "second", 2)
        // The 5-hour window resets 30 minutes from the test clock's start.
        home.claude.answerApiWith((request) =>
          accountOf(request) === "first"
            ? claudeAnswer(429, {
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-reset": "1800",
                "anthropic-ratelimit-unified-representative-claim": "five_hour",
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-reset": "1800",
                "anthropic-ratelimit-unified-7d-status": "allowed",
                "anthropic-ratelimit-unified-7d-reset": "500000",
              })
            : claudeAnswer(200),
        )

        const answer = yield* home.claudeMessage("session-a")
        expect(answer.status).toBe(200)
        expect(JSON.parse(answer.text)).toMatchObject({ content: [{ text: "Hello." }] })
        expect(statusOf(yield* home.accounts, "first")).toEqual({
          status: "cooling-down",
          cooldownEndsAt: "1970-01-01T00:30:00.000Z",
        })
        expect((yield* home.accounts).pools).toEqual([
          { provider: "claude", newSessionsAccountId: "second" },
        ])

        // A new session skips the cooling account; once the window resets it is Active again.
        yield* home.claudeMessage("session-b")
        home.claude.answerApiWith(() => claudeAnswer(200))
        yield* TestClock.adjust("30 minutes")
        expect(statusOf(yield* home.accounts, "first")).toEqual({
          status: "active",
          cooldownEndsAt: null,
        })
        yield* home.claudeMessage("session-c")
        // The session that moved stays where it moved to.
        yield* home.claudeMessage("session-a")

        expect(home.servedBy("claude")).toEqual(["first", "second", "second", "first", "second"])
      }),
  )

  it.effect("a gzip-compressed usage_limit_reached still cools the account until resets_at", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1)
      yield* home.seed("codex", "second", 2)
      home.codex.answerApiWith((request) =>
        accountOf(request) === "first"
          ? new Response(
              Bun.gzipSync(
                JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 7200 } }),
              ),
              {
                status: 429,
                headers: {
                  ...codexHeaders,
                  "content-type": "application/json",
                  "content-encoding": "gzip",
                  "retry-after": "30",
                },
              },
            )
          : codexAnswer(),
      )

      expect((yield* home.codexResponse()).status).toBe(200)
      expect(statusOf(yield* home.accounts, "first")).toEqual({
        status: "cooling-down",
        cooldownEndsAt: "1970-01-01T02:00:00.000Z",
      })
    }),
  )

  it.effect("a late answer from a session's old account never undoes its failover", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      yield* home.seed("claude", "second", 2)
      const arrived = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let firstCalls = 0
      home.claude.answerApiWith(async (request) => {
        if (accountOf(request) !== "first") return claudeAnswer(200)
        firstCalls++
        if (firstCalls === 1) {
          arrived.resolve()
          await release.promise
          return claudeAnswer(200)
        }
        return claudeAnswer(429, { "retry-after": "30" })
      })

      // Two requests of one session in flight on "first": the second hits a limit and moves on.
      const held = yield* Effect.forkChild(home.claudeMessage("session-a"))
      yield* Effect.promise(() => arrived.promise)
      expect((yield* home.claudeMessage("session-a")).status).toBe(200)
      release.resolve()
      yield* Fiber.join(held)

      yield* TestClock.adjust("31 seconds")
      home.claude.answerApiWith(() => claudeAnswer(200))
      yield* home.claudeMessage("session-a")
      expect(home.servedBy("claude")).toEqual(["first", "first", "second", "second"])
    }),
  )

  it.effect(
    "an old account's success landing while the failover is in flight keeps the failover",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome
        yield* home.seed("claude", "first", 1)
        yield* home.seed("claude", "second", 2)
        const heldOnFirst = Promise.withResolvers<void>()
        const releaseFirst = Promise.withResolvers<void>()
        const heldOnSecond = Promise.withResolvers<void>()
        const releaseSecond = Promise.withResolvers<void>()
        let firstCalls = 0
        let secondCalls = 0
        home.claude.answerApiWith(async (request) => {
          if (accountOf(request) === "second") {
            secondCalls++
            if (secondCalls === 1) {
              heldOnSecond.resolve()
              await releaseSecond.promise
            }
            return claudeAnswer(200)
          }
          firstCalls++
          if (firstCalls === 2) {
            heldOnFirst.resolve()
            await releaseFirst.promise
            return claudeAnswer(200)
          }
          return firstCalls === 1 ? claudeAnswer(200) : claudeAnswer(429, { "retry-after": "30" })
        })

        // The session is bound to "first"; two of its requests go there together.
        expect((yield* home.claudeMessage("session-a")).status).toBe(200)
        const held = yield* Effect.forkChild(home.claudeMessage("session-a"))
        yield* Effect.promise(() => heldOnFirst.promise)
        // The second hits a limit and moves on to "second", which answers last.
        const failover = yield* Effect.forkChild(home.claudeMessage("session-a"))
        yield* Effect.promise(() => heldOnSecond.promise)
        releaseFirst.resolve()
        yield* Fiber.join(held)
        releaseSecond.resolve()
        expect((yield* Fiber.join(failover)).status).toBe(200)

        yield* TestClock.adjust("31 seconds")
        yield* home.claudeMessage("session-a")
        expect(home.servedBy("claude")).toEqual(["first", "first", "first", "second", "second"])
      }),
  )

  it.effect("a short limit arriving after a window limit never shortens the cooldown", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1)
      yield* home.seed("codex", "second", 2)
      const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      let firstCalls = 0
      home.codex.answerApiWith(async (request) => {
        if (accountOf(request) !== "first") return codexAnswer()
        const call = firstCalls++
        arrived[call]?.resolve()
        await release[call]?.promise
        return call === 0
          ? Response.json(
              { error: { type: "usage_limit_reached", resets_at: 7200 } },
              { status: 429, headers: codexHeaders },
            )
          : Response.json(
              { error: { type: "rate_limit_exceeded" } },
              { status: 429, headers: { ...codexHeaders, "retry-after": "30" } },
            )
      })

      const window = yield* Effect.forkChild(home.codexResponse())
      yield* Effect.promise(() => arrived[0]?.promise ?? Promise.resolve())
      const minute = yield* Effect.forkChild(home.codexResponse())
      yield* Effect.promise(() => arrived[1]?.promise ?? Promise.resolve())
      release[0]?.resolve()
      yield* Fiber.join(window)
      release[1]?.resolve()
      yield* Fiber.join(minute)

      expect(statusOf(yield* home.accounts, "first")).toEqual({
        status: "cooling-down",
        cooldownEndsAt: "1970-01-01T02:00:00.000Z",
      })
    }),
  )

  it.effect("an account that serves a request records when, at most once a minute", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      home.claude.answerApiWith(() => claudeAnswer(200))
      const lastUsed = Effect.map(home.accounts, (list) =>
        typeof list === "object" &&
        list !== null &&
        "accounts" in list &&
        Array.isArray(list.accounts)
          ? list.accounts[0]?.lastUsedAt
          : undefined,
      )

      expect(yield* lastUsed).toBeNull()
      yield* TestClock.adjust("10 seconds")
      yield* home.claudeMessage()
      expect(yield* lastUsed).toBe("1970-01-01T00:00:10.000Z")
      yield* TestClock.adjust("30 seconds")
      yield* home.claudeMessage()
      expect(yield* lastUsed).toBe("1970-01-01T00:00:10.000Z")
      yield* TestClock.adjust("40 seconds")
      yield* home.claudeMessage()
      expect(yield* lastUsed).toBe("1970-01-01T00:01:20.000Z")
    }),
  )

  it.effect("a cooling account that is disabled reports no cooldown end", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      yield* home.seed("claude", "second", 2)
      home.claude.answerApiWith((request) =>
        accountOf(request) === "first"
          ? claudeAnswer(429, { "retry-after": "30" })
          : claudeAnswer(200),
      )
      yield* home.claudeMessage()
      yield* home.api("PATCH", "/api/accounts/first", { enabled: false })

      expect(statusOf(yield* home.accounts, "first")).toEqual({
        status: "disabled",
        cooldownEndsAt: null,
      })
    }),
  )

  it.effect("a per-minute 429 cools the account for Retry-After only, never a window", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      yield* home.seed("claude", "second", 2)
      // The answer also names the windows' resets, but no window is rejected.
      home.claude.answerApiWith((request) =>
        accountOf(request) === "first"
          ? claudeAnswer(429, {
              "retry-after": "30",
              "anthropic-ratelimit-unified-reset": "10800",
            })
          : claudeAnswer(200),
      )

      expect((yield* home.claudeMessage()).status).toBe(200)
      expect(statusOf(yield* home.accounts, "first")).toEqual({
        status: "cooling-down",
        cooldownEndsAt: "1970-01-01T00:00:30.000Z",
      })
      home.claude.answerApiWith(() => claudeAnswer(200))
      yield* TestClock.adjust("30 seconds")
      expect(statusOf(yield* home.accounts, "first").status).toBe("active")
      yield* home.claudeMessage()

      expect(home.servedBy("claude")).toEqual(["first", "second", "first"])
    }),
  )

  it.effect("a Claude 7-day limit cools the account until the latest rejected window resets", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      yield* home.seed("claude", "second", 2)
      home.claude.answerApiWith((request) =>
        accountOf(request) === "first"
          ? claudeAnswer(429, {
              "retry-after": "30",
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-reset": "10800",
              "anthropic-ratelimit-unified-representative-claim": "five_hour",
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-reset": "10800",
              "anthropic-ratelimit-unified-7d-status": "rejected",
              "anthropic-ratelimit-unified-7d-reset": "432000",
            })
          : claudeAnswer(200),
      )

      expect((yield* home.claudeMessage()).status).toBe(200)
      expect(statusOf(yield* home.accounts, "first")).toEqual({
        status: "cooling-down",
        cooldownEndsAt: "1970-01-06T00:00:00.000Z",
      })
    }),
  )

  it.effect(
    "Codex's usage_limit_reached cools the whole account until resets_at, for every model",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome
        yield* home.seed("codex", "first", 1)
        yield* home.seed("codex", "second", 2)
        home.codex.answerApiWith((request) =>
          accountOf(request) === "first"
            ? Response.json(
                {
                  error: {
                    type: "usage_limit_reached",
                    message: "The usage limit has been reached",
                    plan_type: "pro",
                    resets_at: 7200,
                    resets_in_seconds: 7200,
                  },
                },
                { status: 429, headers: { ...codexHeaders, "retry-after": "30" } },
              )
            : codexAnswer(),
        )

        const answer = yield* home.codexResponse({ body: { model: "gpt-6-luna" } })
        expect(answer.status).toBe(200)
        expect(answer.text).toContain("response.completed")
        expect(statusOf(yield* home.accounts, "first")).toEqual({
          status: "cooling-down",
          cooldownEndsAt: "1970-01-01T02:00:00.000Z",
        })
        yield* home.codexResponse({ body: { model: "gpt-6-sol" } })

        expect(home.servedBy("codex")).toEqual(["first", "second", "second"])
      }),
  )

  it.effect("a Codex 429 that is not a usage limit cools the account for Retry-After", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1)
      yield* home.seed("codex", "second", 2)
      home.codex.answerApiWith((request) =>
        accountOf(request) === "first"
          ? Response.json(
              { error: { type: "rate_limit_exceeded", message: "Slow down" } },
              { status: 429, headers: { "retry-after": "20" } },
            )
          : codexAnswer(),
      )

      expect((yield* home.codexResponse()).status).toBe(200)
      expect(statusOf(yield* home.accounts, "first")).toEqual({
        status: "cooling-down",
        cooldownEndsAt: "1970-01-01T00:00:20.000Z",
      })
    }),
  )

  it.effect("a Codex session is bound by session-id, else by the body's prompt_cache_key", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1, { enabled: false })
      yield* home.seed("codex", "second", 2)

      // Codex sends session-id; opencode sends only prompt_cache_key (spike #6).
      yield* home.codexResponse({ headers: { "session-id": "codex-session" } })
      yield* home.codexResponse({ body: { prompt_cache_key: "ses_opencode" } })
      yield* home.api("PATCH", "/api/accounts/first", { enabled: true })
      yield* home.codexResponse({ headers: { "session-id": "codex-session" } })
      yield* home.codexResponse({ body: { prompt_cache_key: "ses_opencode" } })
      yield* home.codexResponse()

      expect(home.servedBy("codex")).toEqual(["second", "second", "second", "second", "first"])
    }),
  )

  it.effect("a session is kept apart per provider", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "claude-one", 1)
      yield* home.seed("codex", "codex-one", 1)

      expect((yield* home.claudeMessage("shared-id")).status).toBe(200)
      expect((yield* home.codexResponse({ headers: { "session-id": "shared-id" } })).status).toBe(
        200,
      )
      expect(home.servedBy("claude")).toEqual(["claude-one"])
      expect(home.servedBy("codex")).toEqual(["codex-one"])
    }),
  )

  it.effect("a failure after the first byte reaches the client as it is, never retried", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("claude", "first", 1)
      yield* home.seed("claude", "second", 2)
      const started = 'event: message_start\ndata: {"type":"message_start"}\n\n'
      const failed =
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'
      home.claude.answerApiWith(
        () =>
          new Response(started + failed, {
            headers: { ...limitHeaders, "content-type": "text/event-stream" },
          }),
      )

      const answer = yield* home.claudeMessage("session-a")
      expect(answer.status).toBe(200)
      expect(answer.text).toBe(started + failed)
      expect(home.servedBy("claude")).toEqual(["first"])
      expect(statusOf(yield* home.accounts, "first").status).toBe("active")
    }),
  )

  it.effect(
    "with every Claude account cooling down, Claude Code gets a 429 with the earliest reset",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome
        yield* home.seed("claude", "first", 1)
        yield* home.seed("claude", "second", 2)
        yield* home.seed("claude", "third", 3, { needsSignIn: true })
        // The account tried last is not the first to reset, so its own answer would mislead.
        const resets: Readonly<Record<string, string>> = { first: "7200", second: "18000" }
        home.claude.answerApiWith((request) =>
          claudeAnswer(429, {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": resets[accountOf(request)] ?? "",
            "anthropic-ratelimit-unified-representative-claim": "five_hour",
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": resets[accountOf(request)] ?? "",
          }),
        )

        yield* TestClock.adjust("10 minutes")
        const answer = yield* home.claudeMessage()
        expect(answer.status).toBe(429)
        expect(JSON.parse(answer.text)).toEqual({
          type: "error",
          error: {
            type: "rate_limit_error",
            message:
              "agent-proxy: every Claude account is cooling down. The first is available again at 1970-01-01T02:00:00Z.",
          },
        })
        expect(answer.headers.get("retry-after")).toBe("6600")
        expect(answer.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected")
        expect(answer.headers.get("anthropic-ratelimit-unified-reset")).toBe("7200")
        expect(answer.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe(
          "five_hour",
        )
        expect(answer.headers.get("anthropic-ratelimit-unified-5h-status")).toBe("rejected")
        expect(answer.headers.get("anthropic-ratelimit-unified-5h-reset")).toBe("7200")
        expect(home.servedBy("claude")).toEqual(["first", "second"])

        // Later requests are answered at once, without asking Claude.
        expect((yield* home.claudeMessage()).status).toBe(429)
        expect(home.servedBy("claude")).toEqual(["first", "second"])
        expect((yield* home.accounts).pools).toEqual([
          { provider: "claude", newSessionsAccountId: null },
        ])
      }),
  )

  it.effect("with every Codex account cooling down, Codex gets usage_limit_reached", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1)
      yield* home.seed("codex", "second", 2)
      const resets: Readonly<Record<string, number>> = { first: 3600, second: 7200 }
      home.codex.answerApiWith((request) =>
        Response.json(
          {
            error: {
              type: "usage_limit_reached",
              message: "Limit",
              resets_at: resets[accountOf(request)],
            },
          },
          { status: 429 },
        ),
      )

      const answer = yield* home.codexResponse()
      expect(answer.status).toBe(429)
      expect(answer.headers.get("retry-after")).toBe("3600")
      expect(JSON.parse(answer.text)).toEqual({
        error: {
          type: "usage_limit_reached",
          message:
            "agent-proxy: every Codex account is cooling down. The first is available again at 1970-01-01T01:00:00Z.",
          resets_at: 3600,
          resets_in_seconds: 3600,
        },
      })
      expect(home.servedBy("codex")).toEqual(["first", "second"])
    }),
  )

  it.effect(
    "when the account that just hit its limit resets first, the client gets its own answer",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome
        yield* home.seed("claude", "only", 1)
        const body =
          '{"type":"error","error":{"type":"rate_limit_error","message":"Claude says wait."}}'
        const rejected = {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": "3600",
          "retry-after": "3600",
        }
        home.claude.answerApiWith(
          () =>
            new Response(body, {
              status: 429,
              headers: { ...limitHeaders, ...rejected, "content-type": "application/json" },
            }),
        )

        const answer = yield* home.claudeMessage()
        expect(answer.status).toBe(429)
        expect(answer.text).toBe(body)
        expect(Object.fromEntries(answer.headers)).toMatchObject(rejected)
        expect(statusOf(yield* home.accounts, "only")).toEqual({
          status: "cooling-down",
          cooldownEndsAt: "1970-01-01T01:00:00.000Z",
        })
      }),
  )

  it.effect("with every Codex account needing sign-in or disabled, Codex gets a 400", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1, { needsSignIn: true })
      yield* home.seed("codex", "second", 2, { enabled: false })

      const answer = yield* home.codexResponse()
      expect(answer.status).toBe(400)
      expect(JSON.parse(answer.text)).toEqual({
        error: {
          message:
            "agent-proxy: no Codex account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.",
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      })
      expect(home.servedBy("codex")).toEqual([])
    }),
  )

  it.effect("accounts of equal priority are chosen by headroom, unknown counting as full", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      // Two accounts at one priority, as a change interrupted between its file writes leaves them.
      yield* home.seed("claude", "busy", 1)
      yield* home.seed("claude", "idle", 1)
      const utilization: Record<string, string> = { busy: "0.9", idle: "0.2" }
      home.claude.answerApiWith((request) =>
        claudeAnswer(200, {
          "anthropic-ratelimit-unified-5h-utilization": utilization[accountOf(request)] ?? "0",
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
        }),
      )

      // Unknown headroom is full, so the first request goes by the listed order.
      yield* home.claudeMessage()
      yield* home.claudeMessage()
      yield* home.claudeMessage()
      utilization["idle"] = "0.95"
      yield* home.claudeMessage()
      yield* home.claudeMessage()

      expect(home.servedBy("claude")).toEqual(["busy", "idle", "idle", "idle", "busy"])
    }),
  )

  it.effect("a Codex failover passes the client's x-codex-turn-state on unchanged", () =>
    Effect.gen(function* () {
      const home = yield* makeHome
      yield* home.seed("codex", "first", 1)
      yield* home.seed("codex", "second", 2)
      home.codex.answerApiWith((request) =>
        accountOf(request) === "first"
          ? Response.json(
              { error: { type: "usage_limit_reached", resets_at: 3600 } },
              { status: 429 },
            )
          : codexAnswer(),
      )

      yield* home.codexResponse({
        headers: { "session-id": "codex-session", "x-codex-turn-state": "ts_from_first" },
      })

      expect(
        home.codex.apiRequests().map((request) => request.headers["x-codex-turn-state"]),
      ).toEqual(["ts_from_first", "ts_from_first"])
    }),
  )
})
