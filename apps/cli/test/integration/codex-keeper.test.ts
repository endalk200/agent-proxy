import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { fakeClaude } from "../support/fake-claude.ts"
import { carol, type FakeCodex, fakeCodex } from "../support/fake-codex.ts"

// The credential keeper with Codex accounts, in-process: a real daemon on
// loopback in a throwaway home, a fake OpenAI (OAuth and the Codex backend),
// and Effect's test clock, which starts at the epoch and moves only when a
// test moves it. Sockets are real, so a test waits for the fake to see what it
// expects rather than for time to pass. Only the daemon's HTTP surface, the
// fake, and account files are observed.

/**
 * A fake OpenAI whose tokens last 25 hours, so a Codex account, refreshed a
 * day before its token expires, is due an hour after signing in: moving the
 * test clock fires the keeper's every one-minute check, so days take seconds.
 */
const fakeOpenAi = Effect.tap(fakeCodex, (codex) =>
  Effect.sync(() => codex.issueTokensLasting(25 * 60 * 60)),
)

/** Moves the clock to when the first tokens are due a refresh, and no further. */
const untilRefreshDue = TestClock.adjust("1 hour")

/** Waits for `promise`, failing the test if it takes longer than 3 real seconds. */
const within3s = <A>(what: string, promise: Promise<A>) =>
  Effect.promise(() =>
    Promise.race([
      promise,
      Bun.sleep(3000).then(() => Promise.reject(new Error(`timed out waiting for ${what}`))),
    ]),
  )

const makeHome = (codex: FakeCodex) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const claude = yield* fakeClaude
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-codex-keeper-" })
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

    const fetchText = (path: string, init: RequestInit = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`${daemon.address}${path}`, init)
        return { status: response.status, text: await response.text() }
      })

    /** Adds carol's Codex account through a browser login. */
    const signIn = Effect.promise(async () => {
      codex.signInAs(carol)
      const started = await fetch(`${daemon.address}/api/logins`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "codex" }),
      })
      const login: unknown = await started.json()
      const authorizeUrl =
        typeof login === "object" && login !== null && "authorizeUrl" in login
          ? String(login.authorizeUrl)
          : ""
      expect((await fetch(authorizeUrl)).status).toBe(200)
    })

    /** Sends a short Responses API request with the proxy key. */
    const sendResponse = Effect.gen(function* () {
      const key = String(JSON.parse((yield* fetchText("/api/key")).text).key)
      return yield* fetchText("/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: '{"model":"gpt-6-luna","input":"hi","stream":true}',
      })
    })

    const statuses = Effect.map(fetchText("/api/accounts"), (response): ReadonlyArray<string> =>
      JSON.parse(response.text).accounts.map((account: { status: string }) => account.status),
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

    /** The credentials in the only account file, as the daemon wrote them. */
    const storedCredentials = Effect.gen(function* () {
      const dir = `${env.XDG_DATA_HOME}/agent-proxy/accounts`
      const name = (yield* fs.readDirectory(dir)).find((file) => !file.startsWith("."))
      const text = yield* fs.readFileString(`${dir}/${name}`)
      return JSON.parse(text).credentials
    })

    return { signIn, sendResponse, statuses, statusBecomes, storedCredentials }
  })

/** The bearer tokens the fake's backend was called with, oldest first. */
const upstreamTokens = (codex: FakeCodex) =>
  codex.apiRequests().map((request) => request.headers["authorization"])

const services = Layer.mergeAll(
  BunServices.layer,
  RuntimeInfo.layerProcess,
  Processes.layerProcess,
  FetchHttpClient.layer,
)

layer(services)("the credential keeper with Codex accounts", (it) => {
  it.effect("refreshes a Codex token a day before it expires, and not before", () =>
    Effect.gen(function* () {
      const codex = yield* fakeOpenAi
      const home = yield* makeHome(codex)
      yield* home.signIn

      yield* TestClock.adjust("59 minutes")
      yield* Effect.promise(() => Bun.sleep(200))
      expect(codex.refreshRequests()).toEqual([])

      yield* TestClock.adjust("1 minute")
      yield* within3s("the refresh", codex.refreshesArrived(1))

      expect(codex.refreshRequests()).toEqual(["rt_fake_1"])
      expect((yield* home.sendResponse).status).toBe(200)
      expect(upstreamTokens(codex)).toEqual([`Bearer ${codex.issuedAccessTokens()[1]}`])
      expect(yield* home.storedCredentials).toMatchObject({ refreshToken: "rt_fake_2" })
    }),
  )

  it.effect("a token answer without expires_in takes the expiry from the access token", () =>
    Effect.gen(function* () {
      const codex = yield* fakeOpenAi
      codex.omitExpiresIn()
      const home = yield* makeHome(codex)
      yield* home.signIn
      const [accessToken] = codex.issuedAccessTokens()
      const exp: number = JSON.parse(
        Buffer.from(accessToken?.split(".")[1] ?? "", "base64url").toString(),
      ).exp

      expect(yield* home.storedCredentials).toMatchObject({
        accessToken,
        expiresAt: new Date(exp * 1000).toISOString(),
      })
    }),
  )

  for (const [status, refusal] of [
    [400, { error: "invalid_grant", error_description: "Refresh token not found or invalid" }],
    [
      401,
      {
        error: {
          message: "Your refresh token has already been used to generate a new access token.",
          type: "invalid_request_error",
          code: "refresh_token_reused",
        },
      },
    ],
    [
      401,
      {
        error: {
          message: "Your refresh token was revoked.",
          type: "invalid_request_error",
          code: "refresh_token_invalidated",
        },
      },
    ],
  ] as const) {
    it.effect(
      `a Codex refresh refused with HTTP ${status} ${JSON.stringify(refusal)} flags the account Needs sign-in`,
      () =>
        Effect.gen(function* () {
          const codex = yield* fakeOpenAi
          const home = yield* makeHome(codex)
          yield* home.signIn
          codex.refuseNextRefresh(status, refusal)

          yield* untilRefreshDue
          yield* within3s("the refresh", codex.refreshesArrived(1))
          yield* within3s("Needs sign-in", home.statusBecomes("needs-sign-in"))

          const response = yield* home.sendResponse
          expect(response.status).toBe(400)
          expect(JSON.parse(response.text).error.message).toBe(
            "agent-proxy: no Codex account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.",
          )
          expect(codex.apiRequests()).toEqual([])
        }),
    )
  }

  for (const status of [408, 500, 502, 504]) {
    it.effect(
      `a Codex refresh answered with HTTP ${status} leaves the account active and is tried again later`,
      () =>
        Effect.gen(function* () {
          const codex = yield* fakeOpenAi
          const home = yield* makeHome(codex)
          yield* home.signIn
          codex.refuseNextRefresh(status, { error: "bad_gateway" })

          yield* untilRefreshDue
          yield* within3s("the first refresh", codex.refreshesArrived(1))
          expect(yield* home.statuses).toEqual(["active"])
          yield* TestClock.adjust("5 minutes")
          yield* within3s("the second refresh", codex.refreshesArrived(2))
          expect(codex.refreshRequests()).toEqual(["rt_fake_1", "rt_fake_1"])
          expect(yield* home.statuses).toEqual(["active"])
        }),
    )
  }

  it.effect(
    "a Codex refresh answered with a redirect is never followed, and is tried again later",
    () =>
      Effect.gen(function* () {
        const codex = yield* fakeOpenAi
        const home = yield* makeHome(codex)
        yield* home.signIn
        // Back to the token endpoint itself: following it would send the token twice.
        codex.redirectNextRefresh(codex.endpoints.tokenUrl)

        yield* untilRefreshDue
        yield* within3s("the first refresh", codex.refreshesArrived(1))
        // A redirect refuses nothing: the account stays active.
        expect(yield* home.statuses).toEqual(["active"])
        expect(codex.refreshRequests()).toEqual(["rt_fake_1"])
        yield* TestClock.adjust("5 minutes")
        yield* within3s("the second refresh", codex.refreshesArrived(2))
        expect(codex.refreshRequests()).toEqual(["rt_fake_1", "rt_fake_1"])
        expect(yield* home.statuses).toEqual(["active"])
      }),
  )

  it.effect("a Codex refresh whose connection drops before an answer is tried again later", () =>
    Effect.gen(function* () {
      const codex = yield* fakeOpenAi
      const home = yield* makeHome(codex)
      yield* home.signIn
      codex.dropNextRefresh()

      yield* untilRefreshDue
      yield* within3s("the first refresh", codex.refreshesArrived(1))
      expect(yield* home.statuses).toEqual(["active"])
      yield* TestClock.adjust("5 minutes")
      yield* within3s("the second refresh", codex.refreshesArrived(2))
      expect(codex.refreshRequests()).toEqual(["rt_fake_1", "rt_fake_1"])
      expect(yield* home.statuses).toEqual(["active"])
    }),
  )

  for (const status of [429, 503]) {
    it.effect(
      `a Codex refresh answered with HTTP ${status} leaves the account active and is tried again later`,
      () =>
        Effect.gen(function* () {
          const codex = yield* fakeOpenAi
          const home = yield* makeHome(codex)
          yield* home.signIn
          codex.refuseNextRefresh(status, { error: "temporarily_unavailable" })

          yield* untilRefreshDue
          yield* within3s("the first refresh", codex.refreshesArrived(1))
          expect(yield* home.statuses).toEqual(["active"])

          yield* TestClock.adjust("5 minutes")
          yield* within3s("the second refresh", codex.refreshesArrived(2))
          expect(codex.refreshRequests()).toEqual(["rt_fake_1", "rt_fake_1"])
          expect((yield* home.sendResponse).status).toBe(200)
          expect(upstreamTokens(codex)).toEqual([`Bearer ${codex.issuedAccessTokens()[1]}`])
        }),
    )
  }
})
