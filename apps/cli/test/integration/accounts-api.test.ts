import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"

import { AccountList, LoginView } from "../../src/daemon/api.ts"
import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints, realEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import {
  alice,
  bob,
  carol,
  type ClaudeUser,
  type FakeClaude,
  fakeClaude,
} from "../support/fake-claude.ts"

// The daemon's account and login API, in-process: a real listener on loopback,
// HOME and the XDG directories in a temporary directory, and a fake Claude
// OAuth server standing in for Anthropic. Account files are observed only as
// files the daemon wrote, and seeded only in the format it writes.

/**
 * A daemon in a throwaway home whose Claude logins go to `claude`. With
 * `dataHome`, it uses that data directory, as a restarted daemon would.
 */
const makeHome = (claude: FakeClaude, options: { readonly dataHome?: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-accounts-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: options.dataHome ?? `${root}/data`,
    }
    const dataDir = `${env.XDG_DATA_HOME}/agent-proxy`
    const accountsDir = `${dataDir}/accounts`
    const daemon = yield* startDaemon.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
      Effect.provideService(
        ProviderEndpoints,
        ProviderEndpoints.of({ ...realEndpoints, claude: claude.endpoints }),
      ),
    )

    /** Calls the daemon API the way the CLI and dashboard do: JSON in, JSON out. */
    const request = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const base = HttpClientRequest.make(method)(`${daemon.address}${path}`)
        const response = yield* client.execute(
          body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, body),
        )
        const json: unknown = yield* response.json
        return { status: response.status, json }
      })

    const accounts = request("GET", "/api/accounts").pipe(
      Effect.flatMap(({ json }) => Schema.decodeUnknownEffect(AccountList)(json)),
      Effect.map((list) => list.accounts),
    )

    const startLogin = (body: unknown = { provider: "claude" }) =>
      request("POST", "/api/logins", body).pipe(
        Effect.tap(({ status }) => Effect.sync(() => expect(status).toBe(201))),
        Effect.flatMap(({ json }) => Schema.decodeUnknownEffect(LoginView)(json)),
      )

    const login = (id: string) =>
      request("GET", `/api/logins/${id}`).pipe(
        Effect.flatMap(({ json }) => Schema.decodeUnknownEffect(LoginView)(json)),
      )

    /** Signs `user` in through the browser, the whole way, and returns the finished login. */
    const signIn = (user: ClaudeUser, body: unknown = { provider: "claude" }) =>
      Effect.gen(function* () {
        claude.signInAs(user)
        const started = yield* startLogin(body)
        yield* signInWithBrowser(started.authorizeUrl)
        return yield* login(started.id)
      })

    /** The files in the accounts directory, with their permission bits. */
    const accountFiles = Effect.gen(function* () {
      const names = yield* fs.readDirectory(accountsDir)
      return yield* Effect.forEach(names.toSorted(), (name) =>
        Effect.map(fs.stat(`${accountsDir}/${name}`), (info) => ({
          name,
          mode: info.mode & 0o777,
        })),
      )
    })

    /** Writes an account file the way a daemon that held `user` before would have. */
    const seedAccount = (
      user: ClaudeUser,
      settings: {
        label: string
        priority: number
        enabled: boolean
        needsSignIn: boolean
        /** The account's id; `seeded<priority>` when none is given. */
        id?: string
      },
    ) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(accountsDir, { recursive: true, mode: 0o700 })
        const { id = `seeded${settings.priority}`, ...rest } = settings
        yield* fs.writeFileString(
          `${accountsDir}/${id}.json`,
          JSON.stringify({
            id,
            provider: "claude",
            providerAccountId: `${user.accountUuid}:${user.organizationUuid}`,
            email: user.email,
            plan: "Pro",
            ...rest,
            addedAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            credentials: {
              accessToken: "sk-ant-oat01-old",
              refreshToken: "sk-ant-ort01-old",
              expiresAt: "2026-01-01T08:00:00.000Z",
            },
          }),
          { mode: 0o600 },
        )
        return id
      })

    const readAccountFile = (id: string) =>
      Effect.map(fs.readFileString(`${accountsDir}/${id}.json`), (text): unknown =>
        JSON.parse(text),
      )

    return {
      dataHome: env.XDG_DATA_HOME,
      dataDir,
      accountsDir,
      request,
      accounts,
      startLogin,
      login,
      signIn,
      accountFiles,
      seedAccount,
      readAccountFile,
    }
  })

/**
 * What the owner's browser does with an authorize URL: Claude signs them in
 * and redirects to the daemon's callback, which answers with a page.
 */
const signInWithBrowser = (authorizeUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const page = yield* client.get(authorizeUrl)
    return { status: page.status, text: yield* page.text }
  })

/**
 * What a browser that cannot reach the daemon sees: Claude signs the owner in
 * and redirects, but the redirect never arrives. Returns the URL it was sent
 * to, which the owner copies from the address bar.
 */
const signInWithoutReachingDaemon = (authorizeUrl: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => fetch(authorizeUrl, { redirect: "manual" }))
    expect(response.status).toBe(302)
    return response.headers.get("location") ?? ""
  })

/** The callback port in a login's redirect URI. */
const callbackPort = (authorizeUrl: string) =>
  Number(new URL(new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "").port)

/** True when nothing listens on `port` any more: binding it succeeds. */
const isFree = (port: number) =>
  Effect.sync(() => {
    try {
      Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() }).stop(true)
      return true
    } catch {
      return false
    }
  })

const aliceAtWork: ClaudeUser = {
  ...alice,
  organizationUuid: "7d3e2a90-cccc-4b2b-8b2b-000000000003",
  email: "alice@work.example",
  organizationType: "claude_team",
}

const services = Layer.mergeAll(
  BunServices.layer,
  RuntimeInfo.layerProcess,
  Processes.layerProcess,
  FetchHttpClient.layer,
)

layer(services)("daemon account API", (it) => {
  it.effect("lists no accounts before any is added", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const response = yield* home.request("GET", "/api/accounts")
      expect(response).toEqual({ status: 200, json: { accounts: [], pools: [] } })
    }),
  )

  it.effect("a redirect login adds the account with its email, plan and provider account id", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      claude.signInAs(alice)

      const started = yield* home.startLogin()
      expect(started.status).toBe("pending")
      const page = yield* signInWithBrowser(started.authorizeUrl)
      expect(page.status).toBe(200)
      expect(page.text).toContain("alice@example.com")

      const finished = yield* home.login(started.id)
      expect(finished).toMatchObject({ status: "succeeded", created: true })
      expect(yield* home.accounts).toEqual([
        expect.objectContaining({
          provider: "claude",
          providerAccountId: `${alice.accountUuid}:${alice.organizationUuid}`,
          email: "alice@example.com",
          plan: "Max 20x",
          status: "active",
          enabled: true,
        }),
      ])
    }),
  )

  it.effect("a seat that pays for each request is added with a usage-based plan", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      expect(yield* home.signIn(carol)).toMatchObject({
        status: "succeeded",
        account: { email: "carol@example.com", plan: "Enterprise · usage-based" },
      })
    }),
  )

  it.effect("a pasted callback URL finishes the login and adds the account", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      claude.signInAs(bob)

      const started = yield* home.startLogin()
      const pasted = yield* signInWithoutReachingDaemon(started.authorizeUrl)
      const response = yield* home.request("POST", `/api/logins/${started.id}/callback`, {
        url: pasted,
      })
      expect(response.status).toBe(200)
      expect(yield* Schema.decodeUnknownEffect(LoginView)(response.json)).toMatchObject({
        status: "succeeded",
        created: true,
        account: { email: "bob@example.com", plan: "Pro" },
      })
      expect(yield* home.accounts).toEqual([
        expect.objectContaining({
          provider: "claude",
          providerAccountId: `${bob.accountUuid}:${bob.organizationUuid}`,
          email: "bob@example.com",
          plan: "Pro",
        }),
      ])
    }),
  )

  it.effect("a new account joins the bottom of its pool, labelled after its email", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.signIn(alice)
      yield* home.signIn(bob)
      yield* home.signIn(aliceAtWork)
      expect(
        (yield* home.accounts).map(({ label, email, priority, plan }) => ({
          label,
          email,
          priority,
          plan,
        })),
      ).toEqual([
        { label: "alice", email: "alice@example.com", priority: 1, plan: "Max 20x" },
        { label: "bob", email: "bob@example.com", priority: 2, plan: "Pro" },
        { label: "alice 2", email: "alice@work.example", priority: 3, plan: "Team" },
      ])
    }),
  )

  it.effect("a new account takes the label it was given", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const login = yield* home.signIn(alice, { provider: "claude", label: "Personal Max" })
      expect(login.account?.label).toBe("Personal Max")
      expect((yield* home.accounts).map((account) => account.label)).toEqual(["Personal Max"])
    }),
  )

  it.effect("signing in again updates the account in place, keeping its settings", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      yield* home.signIn(bob)
      const first = yield* home.signIn(alice, { provider: "claude", label: "Work" })
      const again = yield* home.signIn(alice)

      expect(again).toMatchObject({ status: "succeeded", created: false })
      expect(again.account?.id).toBe(first.account?.id)
      const accounts = yield* home.accounts
      expect(accounts.map(({ email, label, priority }) => ({ email, label, priority }))).toEqual([
        { email: "bob@example.com", label: "bob", priority: 1 },
        { email: "alice@example.com", label: "Work", priority: 2 },
      ])
      // The file holds the tokens from the latest sign-in.
      expect(yield* home.readAccountFile(first.account?.id ?? "")).toMatchObject({
        credentials: { accessToken: claude.issuedAccessTokens().at(-1) },
      })
    }),
  )

  it.effect("signing in again to a disabled account keeps it disabled at its priority", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      const id = yield* home.seedAccount(alice, {
        label: "Old",
        priority: 3,
        enabled: false,
        needsSignIn: true,
      })
      const login = yield* home.signIn(alice)
      expect(login).toMatchObject({ status: "succeeded", created: false })
      expect(yield* home.accounts).toEqual([
        expect.objectContaining({
          id,
          label: "Old",
          priority: 3,
          enabled: false,
          status: "disabled",
          plan: "Max 20x",
        }),
      ])
      expect(yield* home.readAccountFile(id)).toMatchObject({
        credentials: { accessToken: claude.issuedAccessTokens().at(-1) },
      })
    }),
  )

  it.effect("signing in again to an account that needs sign-in makes it active", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.seedAccount(bob, { label: "B", priority: 1, enabled: true, needsSignIn: true })
      expect((yield* home.accounts).map((account) => account.status)).toEqual(["needs-sign-in"])
      yield* home.signIn(bob)
      expect((yield* home.accounts).map((account) => account.status)).toEqual(["active"])
    }),
  )

  it.effect("keeps each account in its own 0600 file in a 0700 directory, with no temp files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome(yield* fakeClaude)
      const first = yield* home.signIn(alice)
      const second = yield* home.signIn(bob)
      yield* home.signIn(alice)

      expect((yield* fs.stat(home.dataDir)).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(home.accountsDir)).mode & 0o777).toBe(0o700)
      expect(yield* home.accountFiles).toEqual(
        [`${first.account?.id}.json`, `${second.account?.id}.json`]
          .toSorted()
          .map((name) => ({ name, mode: 0o600 })),
      )
    }),
  )

  it.effect("ignores a temp file left by a crash mid-write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.signIn(alice)
      const [file] = yield* home.accountFiles
      // A crash between writing the temp file and renaming it leaves this behind.
      yield* fs.writeFileString(`${home.accountsDir}/.${file?.name}.1a2b3c4d.tmp`, '{"id": "ha')
      expect((yield* home.accounts).map((account) => account.email)).toEqual(["alice@example.com"])
    }),
  )

  it.effect("cancelling a login stores nothing and frees the callback port", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const started = yield* home.startLogin()
      const port = callbackPort(started.authorizeUrl)
      expect(yield* isFree(port)).toBe(false)

      const cancelled = yield* home.request("DELETE", `/api/logins/${started.id}`)
      expect(cancelled.status).toBe(200)
      expect(cancelled.json).toMatchObject({ status: "cancelled" })
      expect(yield* isFree(port)).toBe(true)
      // The browser coming back late finds nothing listening and adds nothing.
      expect(yield* Effect.exit(signInWithBrowser(started.authorizeUrl))).toMatchObject({
        _tag: "Failure",
      })
      expect(yield* home.accounts).toEqual([])
    }),
  )

  it.effect("a login nobody finishes expires after 10 minutes and frees the callback port", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const started = yield* home.startLogin()
      yield* TestClock.adjust("9 minutes")
      expect((yield* home.login(started.id)).status).toBe("pending")
      yield* TestClock.adjust("1 minute")
      expect((yield* home.login(started.id)).status).toBe("expired")
      expect(yield* isFree(callbackPort(started.authorizeUrl))).toBe(true)
      expect(yield* home.accounts).toEqual([])
    }),
  )

  it.effect("starting another Claude login cancels the one still waiting", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const first = yield* home.startLogin()
      const second = yield* home.startLogin()
      expect((yield* home.login(first.id)).status).toBe("cancelled")
      expect((yield* home.login(second.id)).status).toBe("pending")
    }),
  )

  it.effect("rejects a pasted URL from another sign-in and keeps waiting", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      const started = yield* home.startLogin()
      const pasted = new URL(yield* signInWithoutReachingDaemon(started.authorizeUrl))
      pasted.searchParams.set("state", "someone-elses-state")

      const rejected = yield* home.request("POST", `/api/logins/${started.id}/callback`, {
        url: pasted.toString(),
      })
      expect(rejected.status).toBe(400)
      expect(rejected.json).toEqual({
        error: "That URL belongs to another Claude sign-in, not the one in progress.",
      })
      expect((yield* home.login(started.id)).status).toBe("pending")

      const notUrl = yield* home.request("POST", `/api/logins/${started.id}/callback`, {
        url: "the code",
      })
      expect(notUrl.status).toBe(400)
      expect((yield* home.login(started.id)).status).toBe("pending")
    }),
  )

  it.effect("a login the owner denies fails and stores nothing", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      claude.denyNext()
      const started = yield* home.startLogin()
      const page = yield* signInWithBrowser(started.authorizeUrl)
      expect(page.status).toBe(400)
      expect(yield* home.login(started.id)).toMatchObject({
        status: "failed",
        error: "Claude did not grant access: The user denied access",
      })
      expect(yield* home.accounts).toEqual([])
    }),
  )

  it.effect("a login fails when Claude does not answer the token exchange within 30 seconds", () =>
    Effect.gen(function* () {
      const claude = yield* fakeClaude
      const home = yield* makeHome(claude)
      const started = yield* home.startLogin()
      const arrived = claude.hangNextToken()
      const pasted = yield* signInWithoutReachingDaemon(started.authorizeUrl)
      const submitted = yield* Effect.forkScoped(
        home.request("POST", `/api/logins/${started.id}/callback`, { url: pasted }),
      )
      yield* Effect.promise(() => arrived)
      yield* TestClock.adjust("30 seconds")
      const response = yield* Fiber.join(submitted)
      expect(response.json).toMatchObject({
        status: "failed",
        error: "Claude did not answer within 30 seconds. Try signing in again.",
      })
      expect(yield* isFree(callbackPort(started.authorizeUrl))).toBe(true)
      expect(yield* home.accounts).toEqual([])
    }),
  )

  it.effect(
    "repairs a pool whose priorities a failed change left out of order when it starts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const claude = yield* fakeClaude
        const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-data-" })
        // A removal that stopped before renumbering leaves a gap at priority 2.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* makeHome(claude, { dataHome })
            yield* first.seedAccount(alice, {
              label: "A",
              priority: 1,
              enabled: true,
              needsSignIn: false,
            })
            yield* first.seedAccount(bob, {
              label: "B",
              priority: 3,
              enabled: true,
              needsSignIn: false,
            })
          }),
        )
        const second = yield* makeHome(claude, { dataHome })
        const priorities = (yield* second.accounts).map((account) => account.priority)
        expect(priorities.toSorted((a, b) => a - b)).toEqual([1, 2])
      }),
  )

  it.effect("removes temp files a crash left behind when it starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const claude = yield* fakeClaude
      const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-data-" })
      // The first daemon signs in, leaves a temp file as a crash would, and is gone.
      const leftover = yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHome(claude, { dataHome })
          yield* first.signIn(alice)
          const [file] = yield* first.accountFiles
          const path = `${first.accountsDir}/.${file?.name}.1a2b3c4d.tmp`
          yield* fs.writeFileString(path, '{"id": "ha', { mode: 0o600 })
          return path
        }),
      )
      const second = yield* makeHome(claude, { dataHome })
      expect(yield* second.accounts).toHaveLength(1)
      expect(yield* fs.exists(leftover)).toBe(false)
    }),
  )

  it.effect("renaming an account changes its label and nothing else", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const login = yield* home.signIn(alice)
      const id = login.account?.id ?? ""
      const response = yield* home.request("PATCH", `/api/accounts/${id}`, { label: "Work" })
      expect(response.status).toBe(200)
      expect(response.json).toMatchObject({ id, label: "Work", priority: 1, status: "active" })
      expect(yield* home.accounts).toEqual([
        expect.objectContaining({ id, label: "Work", priority: 1, enabled: true }),
      ])
    }),
  )

  it.effect("moving an account to a priority shifts the others in its pool", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.signIn(alice)
      yield* home.signIn(bob)
      const work = yield* home.signIn(aliceAtWork, { provider: "claude", label: "Work" })
      const order = Effect.map(home.accounts, (accounts) =>
        accounts.map(({ label, priority }) => `${priority} ${label}`),
      )

      const up = yield* home.request("PATCH", `/api/accounts/${work.account?.id}`, {
        priority: 1,
      })
      expect(up).toMatchObject({ status: 200, json: { label: "Work", priority: 1 } })
      expect(yield* order).toEqual(["1 Work", "2 alice", "3 bob"])

      const alices = (yield* home.accounts).find((account) => account.label === "alice")
      yield* home.request("PATCH", `/api/accounts/${alices?.id}`, { priority: 3 })
      expect(yield* order).toEqual(["1 Work", "2 bob", "3 alice"])
    }),
  )

  it.effect("refuses a priority outside its pool", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.signIn(alice)
      const login = yield* home.signIn(bob)
      for (const priority of [0, 3, 1.5]) {
        const response = yield* home.request("PATCH", `/api/accounts/${login.account?.id}`, {
          priority,
        })
        expect(response.status).toBe(400)
      }
      const outside = yield* home.request("PATCH", `/api/accounts/${login.account?.id}`, {
        priority: 3,
      })
      expect(outside.json).toEqual({
        error: "In the Claude pool, a priority is 1 or 2.",
      })
      expect((yield* home.accounts).map(({ label, priority }) => `${priority} ${label}`)).toEqual([
        "1 alice",
        "2 bob",
      ])
    }),
  )

  it.effect("removing an account deletes its file, and the accounts below move up", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.signIn(alice)
      const removed = yield* home.signIn(bob)
      yield* home.signIn(aliceAtWork)
      const id = removed.account?.id ?? ""

      const response = yield* home.request("DELETE", `/api/accounts/${id}`)
      expect(response).toMatchObject({ status: 200, json: { id, email: "bob@example.com" } })
      expect((yield* home.accountFiles).map((file) => file.name)).not.toContain(`${id}.json`)
      expect(yield* home.accountFiles).toHaveLength(2)
      expect((yield* home.accounts).map(({ label, priority }) => `${priority} ${label}`)).toEqual([
        "1 alice",
        "2 alice 2",
      ])
    }),
  )

  it.effect("answers 404 for an account it does not hold", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      for (const method of ["PATCH", "DELETE"] as const) {
        const response = yield* home.request(method, "/api/accounts/nope", { label: "x" })
        expect(response).toEqual({ status: 404, json: { error: "No account nope." } })
      }
    }),
  )

  it.effect("says which account gets each pool's new sessions", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      yield* home.seedAccount(alice, {
        label: "Off",
        priority: 1,
        enabled: false,
        needsSignIn: false,
      })
      yield* home.seedAccount(bob, {
        label: "Signed out",
        priority: 2,
        enabled: true,
        needsSignIn: true,
      })
      const pools = Effect.map(
        home.request("GET", "/api/accounts"),
        ({ json }) => Schema.decodeUnknownSync(AccountList)(json).pools,
      )
      expect(yield* pools).toEqual([
        { provider: "claude", newSessionsAccountId: null, newSessionsOrder: [] },
      ])

      const work = yield* home.signIn(aliceAtWork)
      const id = work.account?.id ?? ""
      expect(yield* pools).toEqual([
        { provider: "claude", newSessionsAccountId: id, newSessionsOrder: [id] },
      ])

      // Every Active account, in the order new sessions go to them.
      yield* home.request("PATCH", `/api/accounts/${id}`, { priority: 1 })
      yield* home.request("PATCH", "/api/accounts/seeded1", { enabled: true })
      expect(yield* pools).toEqual([
        { provider: "claude", newSessionsAccountId: id, newSessionsOrder: [id, "seeded1"] },
      ])
    }),
  )

  it.effect("an account shares another's priority, and can take one alone again", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const a = (yield* home.signIn(alice)).account?.id ?? ""
      const b = (yield* home.signIn(bob)).account?.id ?? ""
      const c = (yield* home.signIn(aliceAtWork)).account?.id ?? ""
      // Accounts sharing a priority, added at the same moment, are listed by id.
      const order = Effect.map(home.accounts, (accounts) =>
        accounts.map(({ label, priority }) => `${priority} ${label}`).toSorted(),
      )

      const shared = yield* home.request("PATCH", `/api/accounts/${c}`, { sharePriorityWith: a })
      expect(shared).toMatchObject({ status: 200, json: { id: c, priority: 1 } })
      expect(yield* order).toEqual(["1 alice", "1 alice 2", "2 bob"])

      // Its old priority, now empty, closes up; the one it left keeps the other.
      yield* home.request("PATCH", `/api/accounts/${a}`, { sharePriorityWith: b })
      expect(yield* order).toEqual(["1 alice 2", "2 alice", "2 bob"])

      // Taken out alone above the accounts it shared with.
      yield* home.request("PATCH", `/api/accounts/${b}`, { priority: 2 })
      expect(yield* order).toEqual(["1 alice 2", "2 bob", "3 alice"])

      const both = yield* home.request("PATCH", `/api/accounts/${a}`, {
        priority: 1,
        sharePriorityWith: b,
      })
      expect(both.status).toBe(400)
      const unknown = yield* home.request("PATCH", `/api/accounts/${a}`, {
        sharePriorityWith: "nope",
      })
      expect(unknown).toEqual({
        status: 400,
        json: { error: "No account nope to share a priority with." },
      })
      expect(yield* order).toEqual(["1 alice 2", "2 bob", "3 alice"])
    }),
  )

  it.effect("starting, closes gaps between priorities and keeps shared ones shared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const claude = yield* fakeClaude
      const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-data-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHome(claude, { dataHome })
          const seeded = { enabled: true, needsSignIn: false }
          yield* first.seedAccount(alice, { ...seeded, id: "a", label: "a", priority: 3 })
          yield* first.seedAccount(bob, { ...seeded, id: "b", label: "b", priority: 3 })
          yield* first.seedAccount(aliceAtWork, { ...seeded, id: "c", label: "c", priority: 7 })
        }),
      )
      const second = yield* makeHome(claude, { dataHome })
      expect((yield* second.accounts).map(({ label, priority }) => `${priority} ${label}`)).toEqual(
        ["1 a", "1 b", "2 c"],
      )
    }),
  )

  it.effect("answers 404 for a login it does not know", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const response = yield* home.request("GET", "/api/logins/nope")
      expect(response.status).toBe(404)
    }),
  )

  it.effect("refuses to start a login for a provider it does not know", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(yield* fakeClaude)
      const response = yield* home.request("POST", "/api/logins", { provider: "gemini" })
      expect(response.status).toBe(400)
    }),
  )
})
