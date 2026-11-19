import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import type { Credentials } from "../../src/accounts/account.ts"
import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints, realEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { alice, bob, type ClaudeUser, type FakeClaude, fakeClaude } from "../support/fake-claude.ts"

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
    /** Tokens of an account for alice the daemon held before it started. */
    readonly seed?: Credentials
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
    if (options.seed !== undefined) {
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
          credentials: options.seed,
        }),
        { mode: 0o600 },
      )
    }
    const daemon = yield* startDaemon.pipe(
      Effect.provideService(
        ProviderEndpoints,
        ProviderEndpoints.of({
          ...realEndpoints,
          claude: { ...claude.endpoints, tokenUrl: options.tokenUrl ?? claude.endpoints.tokenUrl },
        }),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    )

    /** Calls the daemon; interrupting the call hangs up on it. */
    const fetchJson = (path: string, init: RequestInit = {}) =>
      Effect.promise(async (signal) => {
        const response = await fetch(`${daemon.address}${path}`, { ...init, signal })
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
      (response): ReadonlyArray<{ id: string; label: string; email: string; status: string }> =>
        JSON.parse(response.text).accounts,
    )

    /** The id of `user`'s account. */
    const idOf = (user: ClaudeUser) =>
      Effect.map(accounts, (all) => all.find((account) => account.email === user.email)?.id ?? "")

    /** Resolves once the only account's status is `status`, asking the daemon API every 20ms. */
    const statusBecomes = (status: string): Promise<void> =>
      fetch(`${daemon.address}/api/accounts`)
        .then((response) => response.text())
        .then((text) =>
          JSON.parse(text).accounts[0]?.status === status
            ? undefined
            : Bun.sleep(20).then(() => statusBecomes(status)),
        )

    /** The JSON in each account file, as the daemon wrote it; temp files mid-write are skipped. */
    const accountFiles = Effect.gen(function* () {
      const dir = `${env.XDG_DATA_HOME}/agent-proxy/accounts`
      const names = (yield* fs.readDirectory(dir))
        .filter((name) => !name.startsWith("."))
        .toSorted()
      return yield* Effect.forEach(names, (name) =>
        Effect.map(fs.readFileString(`${dir}/${name}`), (text) => ({ name, text })),
      )
    })

    return {
      dataHome: env.XDG_DATA_HOME,
      fetchJson,
      idOf,
      signIn,
      sendMessage,
      accounts,
      statusBecomes,
      accountFiles,
    }
  })

/**
 * Moves the clock to when the fake's first tokens are due a refresh, an hour
 * before they expire, and no further. The keeper refreshes then, whether its
 * check wakes at that minute or was still reading the store and reads the
 * clock after. Moving the clock again while that refresh is in flight would
 * fire its timeout, so tests move it only once nothing is refreshing.
 */
const untilRefreshDue = TestClock.adjust(`${TOKEN_LIFETIME_HOURS - 1} hours`)

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

const services = Layer.mergeAll(
  BunServices.layer,
  RuntimeInfo.layerProcess,
  Processes.layerProcess,
  FetchHttpClient.layer,
)

layer(services)("the credential keeper", (it) => {
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
      const held = claude.holdNextRefresh()
      // The daemon starts holding an account whose token expired as it stopped.
      const home = yield* makeHome(claude, {
        seed: { ...claude.grant(alice), expiresAt: "1970-01-01T00:00:00.000Z" },
      })

      const responses = yield* Effect.all(
        Array.from({ length: 10 }, () => home.sendMessage),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)
      yield* within3s("the refresh", held.arrived)
      // Give the requests time to reach the daemon while the refresh is held.
      yield* Effect.promise(() => Bun.sleep(200))
      expect(claude.apiRequests()).toEqual([])
      held.release()

      expect((yield* Fiber.join(responses)).map((response) => response.status)).toEqual(
        Array.from({ length: 10 }, () => 200),
      )
      expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1"])
      expect(upstreamTokens(claude)).toEqual(
        Array.from({ length: 10 }, () => "Bearer sk-ant-oat01-fake-2"),
      )
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

  it.effect("a 401 whose body never finishes still leads to the refreshed retry", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      yield* home.signIn(alice)
      claude.answerApiWith((request) =>
        request.headers.get("authorization") === "Bearer sk-ant-oat01-fake-1"
          ? new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) =>
                  controller.enqueue(new TextEncoder().encode('{"type":"error",')),
              }),
              { status: 401, headers: { "content-type": "application/json" } },
            )
          : Response.json({ type: "message", content: [{ type: "text", text: "ok" }] }),
      )

      const response = yield* home.sendMessage.pipe(Effect.timeout("4 seconds"))

      expect(response.status).toBe(200)
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

  it.effect("a request Claude rejects again after the refresh moves on to the next account", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      yield* home.signIn(alice)
      yield* home.signIn(bob)
      // Alice's tokens are refused, old and refreshed alike; Bob's work.
      claude.answerApiWith((request) =>
        ["Bearer sk-ant-oat01-fake-1", "Bearer sk-ant-oat01-fake-3"].includes(
          request.headers.get("authorization") ?? "",
        )
          ? unauthorized()
          : Response.json({ type: "message", content: [{ type: "text", text: "ok" }] }),
      )

      const response = yield* home.sendMessage

      expect(response.status).toBe(200)
      expect(upstreamTokens(claude)).toEqual([
        "Bearer sk-ant-oat01-fake-1",
        "Bearer sk-ant-oat01-fake-3",
        "Bearer sk-ant-oat01-fake-2",
      ])
    }),
  )

  it.effect(
    "a request Claude rejects again after the refresh, with no other account, gets Claude's 401",
    () =>
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
    "a refresh whose connection drops before an answer is tried again later with the same token",
    () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        claude.dropNextRefresh()

        yield* untilRefreshDue
        yield* within3s("the first refresh", claude.refreshesArrived(1))
        // The token in hand still works until it expires.
        expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
        expect((yield* home.sendMessage).status).toBe(200)

        yield* TestClock.adjust("5 minutes")
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
    "a refresh Claude took whose answer was lost: the retry is refused, and the account needs sign-in",
    () =>
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.signIn(alice)
        claude.spendAndDropNextRefresh()

        yield* untilRefreshDue
        yield* within3s("the first refresh", claude.refreshesArrived(1))
        expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])

        yield* TestClock.adjust("5 minutes")
        yield* within3s("Needs sign-in", home.statusBecomes("needs-sign-in"))
        yield* TestClock.adjust("1 day")
        expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1", "sk-ant-ort01-fake-1"])
      }),
  )

  it.effect(
    "a daemon stopped mid-refresh leaves the old token pair, and refreshes again once it starts",
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
            // Claude rejects the token hours before it is due a refresh, so
            // the request asks for one, which is held until the daemon stops.
            claude.answerApiWith(rejectToken("Bearer sk-ant-oat01-fake-1"))
            const held = claude.holdNextRefresh()
            yield* Effect.forkScoped(Effect.ignore(home.sendMessage))
            yield* within3s("the refresh", held.arrived)
            return { home, files }
          }),
        )
        const [stopped] = yield* before.home.accountFiles
        const [signedIn] = before.files
        const left = JSON.parse(stopped?.text ?? "{}")
        expect(left.credentials).toEqual(JSON.parse(signedIn?.text ?? "{}").credentials)
        expect(left.needsSignIn).toBe(false)

        // Claude never took the held refresh, so the restarted daemon's own
        // refresh of the same token succeeds, and its request is served.
        const restarted = yield* makeHome(claude, { dataHome })
        expect((yield* restarted.accounts).map((account) => account.status)).toEqual(["active"])
        expect((yield* restarted.sendMessage).status).toBe(200)
        expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1", "sk-ant-ort01-fake-1"])
        expect(upstreamTokens(claude).at(-1)).toBe("Bearer sk-ant-oat01-fake-2")
        expect((yield* restarted.accountFiles).map((file) => file.name)).toEqual([signedIn?.name])
      }),
  )

  for (const status of [502, 504]) {
    it.effect(
      `a refresh answered by a gateway ${status} leaves the account active and is tried again later`,
      () =>
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          // A gateway error says nothing about whether Claude spent the refresh
          // token; the retry finds out.
          claude.refuseNextRefresh(status, { error: "bad_gateway" })

          yield* untilRefreshDue
          yield* within3s("the first refresh", claude.refreshesArrived(1))
          expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
          yield* TestClock.adjust("5 minutes")
          yield* within3s("the second refresh", claude.refreshesArrived(2))
          expect(claude.refreshRequests()).toEqual(["sk-ant-ort01-fake-1", "sk-ant-ort01-fake-1"])
          expect((yield* home.sendMessage).status).toBe(200)
          expect(upstreamTokens(claude)).toEqual(["Bearer sk-ant-oat01-fake-2"])
        }),
    )
  }

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
          // Due a refresh as the daemon starts: the token expires in 30 minutes.
          seed: {
            accessToken: "sk-ant-oat01-seeded",
            refreshToken: "sk-ant-ort01-seeded",
            expiresAt: "1970-01-01T00:30:00.000Z",
          },
          tokenUrl: "http://127.0.0.1:1/v1/oauth/token",
        })

        const response = yield* home.sendMessage

        expect(response.status).toBe(200)
        expect(upstreamTokens(claude)).toEqual(["Bearer sk-ant-oat01-seeded"])
        expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
      }),
  )

  it.effect("an account removed while its tokens refresh stays removed", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      yield* home.signIn(alice)
      yield* home.signIn(bob)
      const held = claude.holdNextRefresh()
      yield* untilRefreshDue
      yield* within3s("alice's refresh", held.arrived)

      const removed = yield* home.fetchJson(`/api/accounts/${yield* home.idOf(alice)}`, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)
      held.release()
      // The keeper refreshes due accounts one after another, so bob's
      // refresh starts only once alice's has ended.
      yield* within3s("bob's refresh", claude.refreshesArrived(2))

      expect((yield* home.accounts).map((account) => account.email)).toEqual([bob.email])
      expect((yield* home.accountFiles).map((file) => JSON.parse(file.text).email)).toEqual([
        bob.email,
      ])
    }),
  )

  it.effect("a label set while the tokens refresh is kept along with the new tokens", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      yield* home.signIn(alice)
      const held = claude.holdNextRefresh()
      yield* untilRefreshDue
      yield* within3s("the refresh", held.arrived)

      const renamed = yield* home.fetchJson(`/api/accounts/${yield* home.idOf(alice)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Work" }),
      })
      expect(renamed.status).toBe(200)
      held.release()
      // The request waits for the refresh in flight, then uses its tokens.
      expect((yield* home.sendMessage).status).toBe(200)

      expect(upstreamTokens(claude)).toEqual(["Bearer sk-ant-oat01-fake-2"])
      const [file] = yield* home.accountFiles
      expect(JSON.parse(file?.text ?? "{}")).toMatchObject({
        label: "Work",
        credentials: {
          accessToken: "sk-ant-oat01-fake-2",
          refreshToken: "sk-ant-ort01-fake-2",
        },
      })
      expect((yield* home.accounts).map((account) => account.label)).toEqual(["Work"])
    }),
  )
})
