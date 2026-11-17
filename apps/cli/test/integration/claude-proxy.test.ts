import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import {
  alice,
  bob,
  type ClaudeUser,
  type FakeClaude,
  fakeClaude,
  limitHeaders,
} from "../support/fake-claude.ts"

// The Claude proxy, in-process: a real daemon on loopback in a throwaway home,
// with a fake Claude (OAuth and API) standing in for Anthropic. Clients are
// plain `fetch` calls, so the test sees exactly the bytes and headers a client
// would. Each test runs on real time: sockets are real.

/**
 * A daemon in a throwaway home whose Claude traffic goes to `claude`. With
 * `dataHome`, it uses that data directory, as a restarted daemon would.
 */
const makeHome = (
  claude: FakeClaude,
  options: {
    readonly dataHome?: string
    readonly apiBaseUrl?: string
    /** Leaves the real `ProviderEndpoints.layer` in place, pointed at the fake through `AGENT_PROXY_PROVIDER_ENDPOINTS`. */
    readonly endpointsFromEnv?: boolean
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-claude-proxy-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: options.dataHome ?? `${root}/data`,
    }
    const endpoints = ProviderEndpoints.of({
      claude: {
        ...claude.endpoints,
        apiBaseUrl: options.apiBaseUrl ?? claude.endpoints.apiBaseUrl,
      },
    })
    const daemon = yield* startDaemon.pipe(
      options.endpointsFromEnv === true
        ? Effect.provide(ProviderEndpoints.layer)
        : Effect.provideService(ProviderEndpoints, endpoints),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord(
          options.endpointsFromEnv === true
            ? { ...env, AGENT_PROXY_PROVIDER_ENDPOINTS: JSON.stringify(endpoints) }
            : env,
        ),
      ),
    )

    /** Sends a request the way a client does, and reads the whole answer. */
    const send = (path: string, init: RequestInit = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`${daemon.address}${path}`, init)
        return { status: response.status, headers: response.headers, text: await response.text() }
      })

    /** Asks the daemon API for the proxy key, as `agent-proxy key` does. */
    const proxyKey = Effect.promise(async () => {
      const response = await fetch(`${daemon.address}/api/key`)
      expect(response.status).toBe(200)
      const body: unknown = await response.json()
      return typeof body === "object" && body !== null && "key" in body ? String(body.key) : ""
    })

    /** Adds `user`'s account through a browser login, and returns the access token it got. */
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
        return claude.issuedAccessTokens().at(-1) ?? ""
      })

    /**
     * Writes an account file the way a daemon that held `user` before would
     * have, with `settings`; its access token is `sk-ant-oat01-seeded-<priority>`.
     */
    const seedAccount = (
      user: ClaudeUser,
      settings: { priority: number; enabled: boolean; needsSignIn: boolean },
    ) =>
      Effect.gen(function* () {
        const accountsDir = `${env.XDG_DATA_HOME}/agent-proxy/accounts`
        yield* fs.makeDirectory(accountsDir, { recursive: true, mode: 0o700 })
        const id = `seeded${settings.priority}`
        yield* fs.writeFileString(
          `${accountsDir}/${id}.json`,
          JSON.stringify({
            id,
            provider: "claude",
            providerAccountId: `${user.accountUuid}:${user.organizationUuid}:${settings.priority}`,
            email: user.email,
            plan: "Pro",
            label: id,
            ...settings,
            addedAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            credentials: {
              accessToken: `sk-ant-oat01-seeded-${settings.priority}`,
              refreshToken: `sk-ant-ort01-seeded-${settings.priority}`,
              expiresAt: "2099-01-01T08:00:00.000Z",
            },
          }),
          { mode: 0o600 },
        )
      })

    /** Calls the daemon API the way the CLI and dashboard do, and reads the JSON answer. */
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

    /** Sends a short message request with the proxy key. */
    const sendMessage = Effect.gen(function* () {
      const key = yield* proxyKey
      return yield* send("/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: messagesBody,
      })
    })

    return {
      address: daemon.address,
      dataHome: env.XDG_DATA_HOME,
      send,
      proxyKey,
      signIn,
      seedAccount,
      sendMessage,
      api,
    }
  })

const messagesBody = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hi" }],
})

layer(Layer.mergeAll(BunServices.layer, Processes.layerProcess, FetchHttpClient.layer))(
  "the Claude proxy",
  (it) => {
    it.effect("a request without the proxy key gets a 401 saying no key was sent", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome(yield* fakeClaude)
          const response = yield* home.send("/v1/messages?beta=true", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: messagesBody,
          })
          expect(response.status).toBe(401)
          expect(JSON.parse(response.text)).toEqual({
            type: "error",
            error: {
              type: "authentication_error",
              message:
                "agent-proxy: no proxy key sent. Send the key `agent-proxy key` prints, as the x-api-key header or as Authorization: Bearer.",
            },
          })
        }),
      ),
    )

    it.effect("a request with a wrong proxy key gets a 401 that does not echo the key", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome(yield* fakeClaude)
          const wrongKey = "ap-not-the-real-key-0123456789"
          for (const header of [
            { "x-api-key": wrongKey },
            { authorization: `Bearer ${wrongKey}` },
          ]) {
            const response = yield* home.send("/v1/messages?beta=true", {
              method: "POST",
              headers: { "content-type": "application/json", ...header },
              body: messagesBody,
            })
            expect(response.status).toBe(401)
            expect(response.text).not.toContain(wrongKey)
            expect(JSON.parse(response.text)).toEqual({
              type: "error",
              error: {
                type: "authentication_error",
                message:
                  "agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.",
              },
            })
          }
        }),
      ),
    )

    it.effect(
      "a request with the key reaches Claude with the account's token in place of the key",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const claude = yield* fakeClaude
            const home = yield* makeHome(claude)
            const token = yield* home.signIn(alice)
            const key = yield* home.proxyKey

            const response = yield* home.send("/v1/messages?beta=true", {
              method: "POST",
              // Claude Code sends the key both ways (spike #6).
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
                "x-api-key": key,
              },
              body: messagesBody,
            })

            expect(response.status).toBe(200)
            expect(JSON.parse(response.text)).toMatchObject({
              content: [{ text: "Hello from the fake." }],
            })
            const [upstream] = claude.apiRequests()
            expect(upstream).toMatchObject({ method: "POST", path: "/v1/messages?beta=true" })
            expect(upstream?.headers["authorization"]).toBe(`Bearer ${token}`)
            expect(upstream?.headers["x-api-key"]).toBeUndefined()
            expect(JSON.stringify(upstream)).not.toContain(key)
          }),
        ),
    )

    it.effect("the client's other headers and body reach Claude unchanged", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const key = yield* home.proxyKey
          // What Claude Code 2.1.326 sends (spike #6), with an odd but valid body.
          const clientHeaders = {
            accept: "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
            "content-type": "application/json",
            "user-agent": "claude-cli/2.1.326 (external, cli)",
            "x-app": "cli",
            "x-claude-code-session-id": "4b0f9a2e-5d3c-4c1e-9f7a-2a6b8c0d1e3f",
            "x-stainless-retry-count": "0",
            "x-stainless-timeout": "600",
          }
          const body =
            '{"model":"claude-sonnet-4-5",  "max_tokens":64,\n "messages":[{"role":"user","content":"héllo ✓"}]}\n'

          yield* home.send("/v1/messages?beta=true", {
            method: "POST",
            headers: {
              ...clientHeaders,
              "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
              authorization: `Bearer ${key}`,
              "x-api-key": key,
            },
            body,
          })

          const [upstream] = claude.apiRequests()
          expect(upstream?.body).toBe(body)
          expect(upstream?.headers).toMatchObject(clientHeaders)
          expect(upstream?.headers["anthropic-beta"]).toBe(
            "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
          )
          expect(
            Object.keys(upstream?.headers ?? {}).filter((name) => /^(b3|traceparent)$/.test(name)),
          ).toEqual([])
        }),
      ),
    )

    it.effect("the OAuth beta is added only when the client did not send it", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const key = yield* home.proxyKey
          const send = (headers: Record<string, string>) =>
            home.send("/v1/messages/count_tokens?beta=true", {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key, ...headers },
              body: messagesBody,
            })

          yield* send({})
          yield* send({ "anthropic-beta": "oauth-2025-04-20,claude-code-20250219" })

          expect(
            claude
              .apiRequests()
              .map((request) => [request.path, request.headers["anthropic-beta"]]),
          ).toEqual([
            ["/v1/messages/count_tokens?beta=true", "oauth-2025-04-20"],
            ["/v1/messages/count_tokens?beta=true", "oauth-2025-04-20,claude-code-20250219"],
          ])
        }),
      ),
    )

    it.effect("Claude's status, limit headers and body reach the client unchanged", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const key = yield* home.proxyKey
          const rejected = {
            ...limitHeaders,
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-utilization": "1.0",
            "retry-after": "7200",
          }
          const body =
            '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}'
          claude.answerApiWith(
            () =>
              new Response(body, {
                status: 429,
                headers: { ...rejected, "content-type": "application/json" },
              }),
          )

          const response = yield* home.send("/v1/messages?beta=true", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key },
            body: messagesBody,
          })

          expect(response.status).toBe(429)
          expect(response.text).toBe(body)
          expect(Object.fromEntries(response.headers)).toMatchObject(rejected)
        }),
      ),
    )

    it.effect("a streamed answer reaches the client event by event, not buffered to the end", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const key = yield* home.proxyKey
          const first = 'event: message_start\ndata: {"type":"message_start"}\n\n'
          const rest = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          // Claude sends the rest only once the client has read the first event.
          const { promise: clientReadFirst, resolve: releaseRest } = Promise.withResolvers<void>()
          claude.answerApiWith(
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  async start(controller) {
                    controller.enqueue(new TextEncoder().encode(first))
                    await clientReadFirst
                    controller.enqueue(new TextEncoder().encode(rest))
                    controller.close()
                  },
                }),
                { headers: { ...limitHeaders, "content-type": "text/event-stream" } },
              ),
          )

          const received = yield* Effect.promise(async () => {
            const response = await fetch(`${home.address}/v1/messages?beta=true`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: messagesBody,
            })
            const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader()
            const firstRead = await Promise.race([
              reader.read(),
              Bun.sleep(3000).then(
                () => "the first event did not arrive within 3 seconds" as const,
              ),
            ])
            if (typeof firstRead === "string") {
              releaseRest()
              return {
                contentType: response.headers.get("content-type"),
                beforeRest: firstRead,
                all: "",
              }
            }
            const decoder = new TextDecoder()
            const beforeRest = decoder.decode(firstRead.value, { stream: true })
            releaseRest()
            const readRest = async (text: string): Promise<string> => {
              const chunk = await reader.read()
              return chunk.done
                ? text
                : readRest(text + decoder.decode(chunk.value, { stream: true }))
            }
            return {
              contentType: response.headers.get("content-type"),
              beforeRest,
              all: await readRest(beforeRest),
            }
          })

          expect(received).toEqual({
            contentType: "text/event-stream",
            beforeRest: first,
            all: first + rest,
          })
        }),
      ),
    )

    it.effect("a compressed answer reaches the client as Claude encoded it", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const key = yield* home.proxyKey
          const body = JSON.stringify({
            type: "message",
            content: [{ type: "text", text: "zipped" }],
          })
          claude.answerApiWith(
            (request) =>
              new Response(Bun.gzipSync(body), {
                headers: {
                  "content-type": "application/json",
                  "content-encoding": "gzip",
                  vary: request.headers.get("accept-encoding") ?? "",
                },
              }),
          )

          const response = yield* home.send("/v1/messages?beta=true", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "accept-encoding": "gzip, deflate, br",
              "x-api-key": key,
            },
            body: messagesBody,
          })

          expect(response.status).toBe(200)
          expect(response.headers.get("vary")).toBe("gzip, deflate, br")
          expect(response.text).toBe(body)
        }),
      ),
    )

    it.effect("Claude Code's startup check, HEAD /api/hello without a key, gets 200", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome(yield* fakeClaude)
          const response = yield* home.send("/api/hello", { method: "HEAD" })
          expect(response.status).toBe(200)
        }),
      ),
    )

    it.effect("the highest-priority Active Claude account serves the request", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.seedAccount(bob, { priority: 1, enabled: true, needsSignIn: true })
          yield* home.seedAccount(bob, { priority: 2, enabled: false, needsSignIn: false })
          const aliceToken = yield* home.signIn(alice)
          yield* home.signIn(bob)

          expect((yield* home.sendMessage).status).toBe(200)
          expect(claude.apiRequests().map((request) => request.headers["authorization"])).toEqual([
            `Bearer ${aliceToken}`,
          ])
        }),
      ),
    )

    it.effect("a disabled account is skipped, and re-enabled serves again from its slot", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.seedAccount(alice, { priority: 1, enabled: true, needsSignIn: false })
          yield* home.seedAccount(bob, { priority: 2, enabled: true, needsSignIn: false })
          const servedBy = Effect.gen(function* () {
            expect((yield* home.sendMessage).status).toBe(200)
            return claude.apiRequests().at(-1)?.headers["authorization"]
          })

          const disabled = yield* home.api("PATCH", "/api/accounts/seeded1", { enabled: false })
          expect(disabled).toMatchObject({
            status: 200,
            json: { enabled: false, status: "disabled", priority: 1 },
          })
          expect(yield* servedBy).toBe("Bearer sk-ant-oat01-seeded-2")

          yield* home.api("PATCH", "/api/accounts/seeded1", { enabled: true })
          expect(yield* servedBy).toBe("Bearer sk-ant-oat01-seeded-1")
        }),
      ),
    )

    it.effect("a request streaming on a removed account completes, and the next goes on", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.seedAccount(alice, { priority: 1, enabled: true, needsSignIn: false })
          yield* home.seedAccount(bob, { priority: 2, enabled: true, needsSignIn: false })
          const key = yield* home.proxyKey
          const first = 'event: message_start\ndata: {"type":"message_start"}\n\n'
          const rest = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
          // Claude sends the rest only once the account has been removed.
          const { promise: removed, resolve: onRemoved } = Promise.withResolvers<void>()
          claude.answerApiWith(
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  async start(controller) {
                    controller.enqueue(new TextEncoder().encode(first))
                    await removed
                    controller.enqueue(new TextEncoder().encode(rest))
                    controller.close()
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
          )

          const response = yield* Effect.promise(() =>
            fetch(`${home.address}/v1/messages?beta=true`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: messagesBody,
            }),
          )
          const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader()
          yield* Effect.promise(() => reader.read())
          expect(yield* home.api("DELETE", "/api/accounts/seeded1")).toMatchObject({ status: 200 })
          onRemoved()
          const decoder = new TextDecoder()
          const readRest = async (text: string): Promise<string> => {
            const chunk = await reader.read()
            return chunk.done
              ? text
              : readRest(text + decoder.decode(chunk.value, { stream: true }))
          }
          const received = yield* Effect.promise(() => readRest(""))
          expect(received).toBe(rest)

          expect((yield* home.sendMessage).status).toBe(200)
          expect(claude.apiRequests().map((request) => request.headers["authorization"])).toEqual([
            "Bearer sk-ant-oat01-seeded-1",
            "Bearer sk-ant-oat01-seeded-2",
          ])
        }),
      ),
    )

    it.effect("with no Claude account, the client is told to add one", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          const response = yield* home.sendMessage
          expect(response.status).toBe(400)
          expect(JSON.parse(response.text)).toEqual({
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "agent-proxy: no Claude account. Add one with `agent-proxy accounts add claude`.",
            },
          })
          expect(claude.apiRequests()).toEqual([])
        }),
      ),
    )

    it.effect("with every Claude account needing sign-in or disabled, the client is told so", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.seedAccount(alice, { priority: 1, enabled: true, needsSignIn: true })
          yield* home.seedAccount(bob, { priority: 2, enabled: false, needsSignIn: false })
          const response = yield* home.sendMessage
          expect(response.status).toBe(400)
          expect(JSON.parse(response.text)).toEqual({
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "agent-proxy: no Claude account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.",
            },
          })
          expect(claude.apiRequests()).toEqual([])
        }),
      ),
    )

    it.effect("rotating the key stops the old key at once and serves the new one", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const oldKey = yield* home.proxyKey

          const rotated = yield* home.send("/api/key/rotate", { method: "POST" })
          expect(rotated.status).toBe(200)
          const newKey = String(JSON.parse(rotated.text).key)
          expect(newKey).not.toBe(oldKey)
          expect(yield* home.proxyKey).toBe(newKey)

          const withKey = (key: string) =>
            home.send("/v1/messages?beta=true", {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: messagesBody,
            })
          const old = yield* withKey(oldKey)
          expect(old.status).toBe(401)
          expect(JSON.parse(old.text).error.message).toMatch(/^agent-proxy: wrong proxy key\./)
          expect((yield* withKey(newKey)).status).toBe(200)
        }),
      ),
    )

    it.effect("the key is kept across restarts, alone in a file only the owner can read", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const claude = yield* fakeClaude
          const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-data-" })
          const dataDir = `${dataHome}/agent-proxy`
          const keyFile = `${dataDir}/key`
          /** Runs `use` against a daemon that stops once it returns. */
          const withDaemon = <A>(
            use: (home: Effect.Success<ReturnType<typeof makeHome>>) => Effect.Effect<A>,
          ) => Effect.scoped(Effect.flatMap(makeHome(claude, { dataHome }), use))

          const first = yield* withDaemon((home) => home.proxyKey)
          expect(yield* fs.readFileString(keyFile)).toBe(first)
          expect((yield* fs.stat(keyFile)).mode & 0o777).toBe(0o600)
          expect((yield* fs.stat(dataDir)).mode & 0o777).toBe(0o700)

          const rotated = yield* withDaemon((home) =>
            Effect.gen(function* () {
              expect(yield* home.proxyKey).toBe(first)
              const response = yield* home.send("/api/key/rotate", { method: "POST" })
              return String(JSON.parse(response.text).key)
            }),
          )
          expect(yield* withDaemon((home) => home.proxyKey)).toBe(rotated)
          expect(yield* fs.readFileString(keyFile)).toBe(rotated)
          expect(
            (yield* fs.readDirectory(dataDir)).filter((name) => name.endsWith(".tmp")),
          ).toEqual([])
        }),
      ),
    )

    it.effect("a client that stops reading mid-stream cancels Claude's stream", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude)
          yield* home.signIn(alice)
          const key = yield* home.proxyKey
          const { promise: cancelled, resolve: onCancel } = Promise.withResolvers<"cancelled">()
          claude.answerApiWith(
            () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'),
                    )
                  },
                  cancel() {
                    onCancel("cancelled")
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              ),
          )

          const outcome = yield* Effect.promise(async () => {
            const controller = new AbortController()
            const response = await fetch(`${home.address}/v1/messages?beta=true`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: messagesBody,
              signal: controller.signal,
            })
            await response.body?.getReader().read()
            controller.abort()
            return Promise.race([cancelled, Bun.sleep(3000).then(() => "still streaming" as const)])
          })

          expect(outcome).toBe("cancelled")
        }),
      ),
    )

    it.effect("when Claude cannot be reached, the client gets a 502 saying so", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          // Nothing listens on port 1.
          const home = yield* makeHome(claude, { apiBaseUrl: "http://127.0.0.1:1" })
          yield* home.signIn(alice)
          const response = yield* home.sendMessage
          expect(response.status).toBe(502)
          expect(JSON.parse(response.text)).toEqual({
            type: "error",
            error: {
              type: "api_error",
              message:
                "agent-proxy: could not reach Claude. Check this machine's network connection.",
            },
          })
        }),
      ),
    )

    it.effect("AGENT_PROXY_PROVIDER_ENDPOINTS points proxied requests at another Claude API", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const claude = yield* fakeClaude
          const home = yield* makeHome(claude, { endpointsFromEnv: true })
          const token = yield* home.signIn(alice)
          expect((yield* home.sendMessage).status).toBe(200)
          expect(claude.apiRequests().map((request) => request.headers["authorization"])).toEqual([
            `Bearer ${token}`,
          ])
        }),
      ),
    )
  },
)
