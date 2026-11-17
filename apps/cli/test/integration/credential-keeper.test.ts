import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { alice, type ClaudeUser, type FakeClaude, fakeClaude } from "../support/fake-claude.ts"

// The credential keeper, in-process: a real daemon on loopback in a throwaway
// home, a fake Claude (OAuth and API), and Effect's test clock, which starts
// at the epoch and moves only when a test moves it. Sockets are real, so a
// test waits for the fake to see what it expects rather than for time to pass.
// Only the daemon's HTTP surface, the fake, and account files are observed.

/** The fake issues tokens that expire 8 hours after they are issued. */
const TOKEN_LIFETIME_HOURS = 8

/** Waits for `promise`, failing the test if it takes longer than 3 real seconds. */
const within3s = <A>(what: string, promise: Promise<A>) =>
  Effect.promise(() =>
    Promise.race([
      promise,
      Bun.sleep(3000).then(() => Promise.reject(new Error(`timed out waiting for ${what}`))),
    ]),
  )

/** A daemon in a throwaway home (or the data home given, as a restarted daemon would) whose Claude traffic goes to `claude`. */
const makeHome = (
  claude: FakeClaude,
  options: {
    readonly dataHome?: string
    readonly tokenUrl?: string
    readonly seedDueAccount?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-keeper-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: options.dataHome ?? `${root}/data`,
    }
    // An account the daemon held before it started, with tokens that expire
    // 30 minutes after the test clock's start, so they are due a refresh at once.
    if (options.seedDueAccount === true) {
      const dir = `${env.XDG_DATA_HOME}/agent-proxy/accounts`
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
      yield* fs.writeFileString(
        `${dir}/seeded.json`,
        JSON.stringify({
          id: "seeded",
          provider: "claude",
          providerAccountId: `${alice.accountUuid}:${alice.organizationUuid}`,
          email: alice.email,
          plan: "Max 20x",
          label: "alice",
          priority: 1,
          enabled: true,
          needsSignIn: false,
          addedAt: "1970-01-01T00:00:00.000Z",
          lastUsedAt: null,
          credentials: {
            accessToken: "sk-ant-oat01-seeded",
            refreshToken: "sk-ant-ort01-seeded",
            expiresAt: "1970-01-01T00:30:00.000Z",
          },
        }),
        { mode: 0o600 },
      )
    }
    const daemon = yield* startDaemon.pipe(
      Effect.provideService(
        ProviderEndpoints,
        ProviderEndpoints.of({
          claude: { ...claude.endpoints, tokenUrl: options.tokenUrl ?? claude.endpoints.tokenUrl },
        }),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    )

    const fetchJson = (path: string, init: RequestInit = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`${daemon.address}${path}`, init)
        return { status: response.status, text: await response.text() }
      })

    const proxyKey = Effect.map(fetchJson("/api/key"), (response) =>
      String(JSON.parse(response.text).key),
    )

    /** Adds `user`'s account through a browser login. */
    const signIn = (user: ClaudeUser) =>
      Effect.promise(async () => {
        claude.signInAs(user)
        const started = await fetch(`${daemon.address}/api/logins`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "claude" }),
        })
        const login: unknown = await started.json()
        const authorizeUrl =
          typeof login === "object" && login !== null && "authorizeUrl" in login
            ? String(login.authorizeUrl)
            : ""
        expect((await fetch(authorizeUrl)).status).toBe(200)
      })

    /** Sends a short message request with the proxy key. */
    const sendMessage = Effect.gen(function* () {
      const key = yield* proxyKey
      return yield* fetchJson("/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: messagesBody,
      })
    })

    /** The accounts as `GET /api/accounts` reports them. */
    const accounts = Effect.map(
      fetchJson("/api/accounts"),
      (response): ReadonlyArray<{ email: string; status: string }> =>
        JSON.parse(response.text).accounts,
    )

    /** Resolves once the only account's status is `status`, asking the daemon API every 20ms. */
    const statusBecomes = (status: string): Promise<void> =>
      fetch(`${daemon.address}/api/accounts`)
        .then((response) => response.text())
        .then((text) =>
          JSON.parse(text).accounts[0]?.status === status
            ? undefined
            : Bun.sleep(20).then(() => statusBecomes(status)),
        )

    /** The JSON in each account file, as the daemon wrote it. */
    const accountFiles = Effect.gen(function* () {
      const dir = `${env.XDG_DATA_HOME}/agent-proxy/accounts`
      const names = (yield* fs.readDirectory(dir)).toSorted()
      return yield* Effect.forEach(names, (name) =>
        Effect.map(fs.readFileString(`${dir}/${name}`), (text) => ({ name, text })),
      )
    })

    return {
      dataHome: env.XDG_DATA_HOME,
      signIn,
      sendMessage,
      accounts,
      statusBecomes,
      accountFiles,
    }
  })

/** Moves the clock to when the fake's first tokens are due a refresh, and one keeper check past it. */
const untilRefreshDue = Effect.gen(function* () {
  yield* TestClock.adjust(`${TOKEN_LIFETIME_HOURS - 1} hours`)
  yield* TestClock.adjust("1 minute")
})

const noAccountAvailable = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "agent-proxy: no Claude account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.",
  },
}

const messagesBody = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
})

const unauthorizedBody = {
  type: "error",
  error: { type: "authentication_error", message: "OAuth token has expired." },
}

const unauthorized = () => Response.json(unauthorizedBody, { status: 401 })

/** An API that rejects `authorization` with a 401 and answers every other token. */
const rejectToken =
  (authorization: string) =>
  (request: Request): Response =>
    request.headers.get("authorization") === authorization
      ? unauthorized()
      : Response.json({ type: "message", content: [{ type: "text", text: "ok" }] })

/** The bearer tokens the fake's API was called with, oldest first. */
const upstreamTokens = (claude: FakeClaude) =>
  claude.apiRequests().map((request) => request.headers["authorization"])

layer(Layer.mergeAll(BunServices.layer, Processes.layerProcess, FetchHttpClient.layer))(
  "the credential keeper",
  (it) => {
    it.effect("refreshes a token an hour before it expires, with no request needing it", () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        expect(claude.refreshRequests()).toEqual([])

        // The keeper checks once a minute; the clock jumps past checks that
        // are still reading the store, so it moves to an hour before expiry
        // first, then one check later.
        yield* untilRefreshDue
        yield* within3s("the refresh", claude.refreshesArrived(1))

        expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
        expect((yield* home.sendMessage).status).toBe(200)
        expect(upstreamTokens(claude)).toEqual(["Bearer sk-ant-oat01-fake-2"])
      }),
    )

    it.effect("many requests while a token is expired cause exactly one refresh", () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        const held = claude.holdNextRefresh()

        yield* TestClock.adjust(`${TOKEN_LIFETIME_HOURS} hours`)
        yield* TestClock.adjust("1 minute")
        const responses = yield* Effect.all(
          Array.from({ length: 10 }, () => home.sendMessage),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild)
        yield* within3s("the refresh", held.arrived)
        // Give the requests time to reach the daemon while the refresh is held.
        yield* Effect.promise(() => Bun.sleep(200))
        held.release()

        expect((yield* Fiber.join(responses)).map((response) => response.status)).toEqual(
          Array.from({ length: 10 }, () => 200),
        )
        expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
        expect(new Set(upstreamTokens(claude))).toEqual(new Set(["Bearer sk-ant-oat01-fake-2"]))
      }),
    )

    it.effect(
      "a request whose token Claude rejects is retried once after a refresh, and succeeds",
      () =>
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          claude.answerApiWith(rejectToken("Bearer sk-ant-oat01-fake-1"))

          const response = yield* home.sendMessage

          expect(response.status).toBe(200)
          expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
          expect(upstreamTokens(claude)).toEqual([
            "Bearer sk-ant-oat01-fake-1",
            "Bearer sk-ant-oat01-fake-2",
          ])
        }),
    )

    it.effect("requests whose token Claude rejects all at once share one refresh", () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        claude.answerApiWith(rejectToken("Bearer sk-ant-oat01-fake-1"))

        const responses = yield* Effect.all(
          Array.from({ length: 10 }, () => home.sendMessage),
          { concurrency: "unbounded" },
        )

        expect(responses.map((response) => response.status)).toEqual(
          Array.from({ length: 10 }, () => 200),
        )
        expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
      }),
    )

    it.effect("a request Claude rejects again after the refresh gets Claude's 401", () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        claude.answerApiWith(() => unauthorized())

        const response = yield* home.sendMessage

        expect(response.status).toBe(401)
        expect(JSON.parse(response.text)).toEqual(unauthorizedBody)
        expect(upstreamTokens(claude)).toEqual([
          "Bearer sk-ant-oat01-fake-1",
          "Bearer sk-ant-oat01-fake-2",
        ])
      }),
    )

    for (const [status, refusal] of [
      [400, { error: "invalid_grant", error_description: "Refresh token not found or invalid" }],
      [400, { error: "refresh_token_reused", error_description: "Refresh token already used" }],
      [401, { error: "invalid_grant", error_description: "Refresh token revoked" }],
    ] as const) {
      it.effect(
        `a refresh refused with ${refusal.error} (${refusal.error_description}) flags the account Needs sign-in`,
        () =>
          Effect.gen(function* () {
            const claude = yield* fakeClaude
            const home = yield* makeHome(claude)
            yield* home.signIn(alice)
            claude.refuseNextRefresh(status, refusal)

            yield* untilRefreshDue
            yield* within3s("the refresh", claude.refreshesArrived(1))
            yield* within3s("Needs sign-in", home.statusBecomes("needs-sign-in"))

            const response = yield* home.sendMessage
            expect(response.status).toBe(400)
            expect(JSON.parse(response.text)).toEqual(noAccountAvailable)
            expect(claude.apiRequests()).toEqual([])
          }),
      )
    }

    it.effect("a token Claude rejects whose refresh is refused gets the no-account error", () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        claude.answerApiWith(() => unauthorized())
        claude.refuseNextRefresh(400, { error: "invalid_grant" })

        const response = yield* home.sendMessage

        expect(response.status).toBe(400)
        expect(JSON.parse(response.text)).toEqual(noAccountAvailable)
        expect((yield* home.accounts).map((account) => account.status)).toEqual(["needs-sign-in"])
      }),
    )

    it.effect("signing in again clears Needs sign-in", () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        claude.refuseNextRefresh(400, { error: "invalid_grant" })
        yield* untilRefreshDue
        yield* within3s("Needs sign-in", home.statusBecomes("needs-sign-in"))

        yield* home.signIn(alice)

        expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
        expect((yield* home.sendMessage).status).toBe(200)
        expect(upstreamTokens(claude)).toEqual(["Bearer sk-ant-oat01-fake-2"])
      }),
    )

    it.effect(
      "a refresh whose connection drops after sending is never retried, and the account needs sign-in after a restart too",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const claude = yield* fakeClaude
          const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-data-" })

          yield* Effect.scoped(
            Effect.gen(function* () {
              const home = yield* makeHome(claude, { dataHome })
              yield* home.signIn(alice)
              claude.dropNextRefresh()
              yield* untilRefreshDue
              yield* within3s("Needs sign-in", home.statusBecomes("needs-sign-in"))
              yield* TestClock.adjust("2 hours")
              expect((yield* home.sendMessage).status).toBe(400)
            }),
          )
          const restarted = yield* makeHome(claude, { dataHome })
          yield* TestClock.adjust("1 day")

          expect((yield* restarted.accounts).map((account) => account.status)).toEqual([
            "needs-sign-in",
          ])
          expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
          expect(claude.apiRequests()).toEqual([])
        }),
    )

    it.effect(
      "a daemon stopped mid-refresh leaves the old token pair, and the account needs sign-in when it starts again",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const claude = yield* fakeClaude
          const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-data-" })

          const before = yield* Effect.scoped(
            Effect.gen(function* () {
              const home = yield* makeHome(claude, { dataHome })
              yield* home.signIn(alice)
              const files = yield* home.accountFiles
              const held = claude.holdNextRefresh()
              yield* untilRefreshDue
              yield* within3s("the refresh", held.arrived)
              return { home, files }
            }),
          )
          const [stopped] = yield* before.home.accountFiles
          const [signedIn] = before.files
          expect(JSON.parse(stopped?.text ?? "{}").credentials).toEqual(
            JSON.parse(signedIn?.text ?? "{}").credentials,
          )

          const restarted = yield* makeHome(claude, { dataHome })
          yield* TestClock.adjust("1 day")

          expect((yield* restarted.accounts).map((account) => account.status)).toEqual([
            "needs-sign-in",
          ])
          expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
          expect((yield* restarted.accountFiles).map((file) => file.name)).toEqual([signedIn?.name])
        }),
    )

    it.effect(
      "a refresh Claude cannot take now leaves the account active and is tried again later",
      () =>
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          claude.refuseNextRefresh(503, { error: "temporarily_unavailable" })

          yield* untilRefreshDue
          yield* within3s("the first refresh", claude.refreshesArrived(1))
          expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
          expect((yield* home.sendMessage).status).toBe(200)

          yield* TestClock.adjust("5 minutes")
          yield* TestClock.adjust("1 minute")
          yield* within3s("the second refresh", claude.refreshesArrived(2))

          expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1", "sk-ant-ort01-fake-1"])
          expect((yield* home.sendMessage).status).toBe(200)
          expect(upstreamTokens(claude)).toEqual([
            "Bearer sk-ant-oat01-fake-1",
            "Bearer sk-ant-oat01-fake-2",
          ])
        }),
    )

    it.effect(
      "a refresh that cannot reach Claude leaves the account active and its token in use",
      () =>
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          // Nothing listens on port 1.
          const home = yield* makeHome(claude, {
            seedDueAccount: true,
            tokenUrl: "http://127.0.0.1:1/v1/oauth/token",
          })

          const response = yield* home.sendMessage

          expect(response.status).toBe(200)
          expect(upstreamTokens(claude)).toEqual(["Bearer sk-ant-oat01-seeded"])
          expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
        }),
    )
  },
)
