import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { alice, fakeClaude } from "../support/fake-claude.ts"
import {
  carol,
  codexHeaders,
  type CodexUser,
  dave,
  type FakeCodex,
  fakeCodex,
  erin,
} from "../support/fake-codex.ts"

// Codex accounts and the Codex proxy, in-process: a real daemon on loopback in
// a throwaway home, with a fake OpenAI (OAuth and the Codex backend) standing
// in for auth.openai.com and chatgpt.com, and a fake Claude beside it. Clients
// are plain `fetch` calls, so the test sees exactly the bytes and headers a
// client would. Each test runs on real time: sockets are real.

interface Home {
  readonly codex: FakeCodex
  readonly options?: {
    readonly dataHome?: string
    readonly apiBaseUrl?: string
    /** Leaves the real `ProviderEndpoints.layer` in place, pointed at the fakes through `AGENT_PROXY_PROVIDER_ENDPOINTS`. */
    readonly endpointsFromEnv?: boolean
  }
}

const makeHome = ({ codex, options = {} }: Home) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const claude = yield* fakeClaude
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-codex-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: options.dataHome ?? `${root}/data`,
    }
    const endpoints = ProviderEndpoints.of({
      claude: claude.endpoints,
      codex: { ...codex.endpoints, apiBaseUrl: options.apiBaseUrl ?? codex.endpoints.apiBaseUrl },
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

    /** Calls the daemon the way a client, the CLI or the dashboard does, and reads the whole answer. */
    const send = (path: string, init: RequestInit = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`${daemon.address}${path}`, init)
        return { status: response.status, headers: response.headers, text: await response.text() }
      })

    /** Calls the daemon API with a JSON body, and reads the JSON answer. */
    const api = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) =>
      Effect.map(
        send(path, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
        (response) => ({ status: response.status, json: JSON.parse(response.text) }),
      )

    const proxyKey = Effect.map(api("GET", "/api/key"), (response) => String(response.json.key))

    /** Starts a Codex login and returns its id and sign-in page. */
    const startLogin = (user: CodexUser) =>
      Effect.gen(function* () {
        codex.signInAs(user)
        const started = yield* api("POST", "/api/logins", { provider: "codex" })
        expect(started.status).toBe(201)
        return { id: String(started.json.id), authorizeUrl: String(started.json.authorizeUrl) }
      })

    /** Adds `user`'s Codex account through a browser login, and returns the finished login. */
    const signIn = (user: CodexUser) =>
      Effect.gen(function* () {
        const login = yield* startLogin(user)
        const page = yield* Effect.promise(() => fetch(login.authorizeUrl))
        expect(page.status).toBe(200)
        return (yield* api("GET", `/api/logins/${login.id}`)).json
      })

    /** Adds `user`'s Codex account the way an owner pasting the callback URL does. */
    const signInByPaste = (user: CodexUser) =>
      Effect.gen(function* () {
        const login = yield* startLogin(user)
        const redirect = yield* Effect.promise(() =>
          fetch(login.authorizeUrl, { redirect: "manual" }),
        )
        const url = redirect.headers.get("location") ?? ""
        return (yield* api("POST", `/api/logins/${login.id}/callback`, { url })).json
      })

    const accounts = Effect.map(api("GET", "/api/accounts"), (response) => response.json)

    /** Sends a short Responses API request with the proxy key, as Codex does. */
    const sendResponse = Effect.gen(function* () {
      const key = yield* proxyKey
      return yield* send("/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: responsesBody,
      })
    })

    return {
      address: daemon.address,
      claude,
      send,
      api,
      proxyKey,
      startLogin,
      signIn,
      signInByPaste,
      accounts,
      sendResponse,
    }
  })

const responsesBody = JSON.stringify({
  model: "gpt-6-luna",
  instructions: "You are Codex.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: true,
  store: false,
})

/** The access token in `login`'s account, as the fake issued it: the last one so far. */
const lastToken = (codex: FakeCodex) => codex.issuedAccessTokens().at(-1) ?? ""

layer(Layer.mergeAll(BunServices.layer, Processes.layerProcess, FetchHttpClient.layer))(
  "Codex accounts and the Codex proxy",
  (it) => {
    it.effect("a Codex sign-in whose id_token has the email only in its profile claim works", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome({ codex: yield* fakeCodex })
          const login = yield* home.signIn(erin)
          expect(login).toMatchObject({ provider: "codex", status: "succeeded" })
          expect((yield* home.accounts).accounts).toEqual([
            expect.objectContaining({
              email: "erin@example.com",
              providerAccountId: erin.accountId,
            }),
          ])
        }),
      ),
    )

    it.effect("a Codex sign-in through the browser records the email, plan and account id", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome({ codex: yield* fakeCodex })
          const login = yield* home.signIn(carol)
          expect(login).toMatchObject({ provider: "codex", status: "succeeded", created: true })
          expect(yield* home.accounts).toEqual({
            accounts: [
              expect.objectContaining({
                provider: "codex",
                providerAccountId: carol.accountId,
                email: "carol@example.com",
                plan: "Pro",
                label: "carol",
                priority: 1,
                status: "active",
              }),
            ],
            pools: [{ provider: "codex", newSessionsAccountId: login.account.id }],
          })
        }),
      ),
    )

    it.effect(
      "a pasted callback URL finishes a Codex sign-in, and the redirect goes to 127.0.0.1",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const home = yield* makeHome({ codex: yield* fakeCodex })
            const started = yield* home.startLogin(dave)
            expect(new URL(started.authorizeUrl).searchParams.get("redirect_uri")).toMatch(
              /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
            )
            yield* home.api("DELETE", `/api/logins/${started.id}`)

            const login = yield* home.signInByPaste(dave)
            expect(login).toMatchObject({
              status: "succeeded",
              created: true,
              account: {
                provider: "codex",
                providerAccountId: dave.accountId,
                email: "dave@example.com",
                plan: "Plus",
              },
            })
          }),
        ),
    )

    it.effect("signing in again to a Codex account updates it in place", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const codex = yield* fakeCodex
          const home = yield* makeHome({ codex })
          const first = yield* home.signIn(carol)
          yield* home.api("PATCH", `/api/accounts/${first.account.id}`, { label: "Work" })

          const again = yield* home.signInByPaste({
            ...carol,
            email: "carol@new.example",
            planType: "plus",
          })

          expect(again).toMatchObject({ status: "succeeded", created: false })
          const { accounts } = yield* home.accounts
          expect(accounts).toEqual([
            expect.objectContaining({
              id: first.account.id,
              label: "Work",
              email: "carol@new.example",
              plan: "Plus",
              priority: 1,
            }),
          ])
        }),
      ),
    )

    it.effect(
      "a Codex sign-in the owner cancels fails with OpenAI's reason and stores nothing",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            codex.denyNext()
            const login = yield* home.signInByPaste(carol)
            expect(login).toMatchObject({
              status: "failed",
              error: "Codex did not grant access: The user cancelled the sign-in",
            })
            expect((yield* home.accounts).accounts).toEqual([])
          }),
        ),
    )

    it.effect(
      "a Codex request reaches the backend with the account's token and account id in place of the key",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            yield* home.signIn(carol)
            const token = lastToken(codex)
            const key = yield* home.proxyKey
            // What codex-cli 0.169.0 sends (spike #6), with an odd but valid body.
            const clientHeaders = {
              accept: "text/event-stream",
              "content-type": "application/json",
              originator: "codex_exec",
              "session-id": "019a7b2e-5d3c-7c1e-9f7a-2a6b8c0d1e3f",
              "thread-id": "019a7b2e-5d3c-7c1e-9f7a-2a6b8c0d1e3f",
              "user-agent": "codex_exec/0.169.0 (Mac OS 26.6.0; arm64)",
              "x-codex-beta-features": "unified_exec",
              version: "0.169.0",
            }
            const body =
              '{"model":"gpt-6-luna",  "instructions":"You are Codex.",\n "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"héllo ✓"}]}],"stream":true}\n'

            const response = yield* home.send("/backend-api/codex/responses", {
              method: "POST",
              headers: {
                ...clientHeaders,
                authorization: `Bearer ${key}`,
                "chatgpt-account-id": "someone-elses-account",
              },
              body,
            })

            expect(response.status).toBe(200)
            expect(response.text).toContain("response.completed")
            const [upstream] = codex.apiRequests()
            expect(upstream).toMatchObject({
              method: "POST",
              path: "/backend-api/codex/responses",
              body,
            })
            expect(upstream?.headers).toMatchObject({
              ...clientHeaders,
              authorization: `Bearer ${token}`,
              "chatgpt-account-id": carol.accountId,
            })
            expect(JSON.stringify(upstream)).not.toContain(key)
            expect(
              Object.keys(upstream?.headers ?? {}).filter((name) =>
                /^(b3|traceparent|x-api-key)$/.test(name),
              ),
            ).toEqual([])
          }),
        ),
    )

    it.effect("Codex's status, x-codex-* headers and body reach the client unchanged", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const codex = yield* fakeCodex
          const home = yield* makeHome({ codex })
          yield* home.signIn(carol)
          const limited = {
            ...codexHeaders,
            "x-codex-primary-used-percent": "100",
            "x-codex-turn-state": "ts_carol_7",
            "retry-after": "3600",
          }
          const body =
            '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":3600}}'
          codex.answerApiWith(
            () =>
              new Response(body, {
                status: 429,
                headers: { ...limited, "content-type": "application/json" },
              }),
          )

          const response = yield* home.sendResponse

          expect(response.status).toBe(429)
          expect(response.text).toBe(body)
          expect(Object.fromEntries(response.headers)).toMatchObject(limited)
        }),
      ),
    )

    it.effect("a streamed Codex answer reaches the client event by event, not buffered", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const codex = yield* fakeCodex
          const home = yield* makeHome({ codex })
          yield* home.signIn(carol)
          const key = yield* home.proxyKey
          const first = 'event: response.created\ndata: {"type":"response.created"}\n\n'
          const rest = 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
          // The backend sends the rest only once the client has read the first event.
          const { promise: clientReadFirst, resolve: releaseRest } = Promise.withResolvers<void>()
          codex.answerApiWith(
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
                { headers: { ...codexHeaders, "content-type": "text/event-stream" } },
              ),
          )

          const received = yield* Effect.promise(async () => {
            const response = await fetch(`${home.address}/backend-api/codex/responses`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: responsesBody,
            })
            const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader()
            const firstRead = await Promise.race([
              reader.read(),
              Bun.sleep(3000).then(
                () => "the first event did not arrive within 3 seconds" as const,
              ),
            ])
            releaseRest()
            if (typeof firstRead === "string") return { beforeRest: firstRead, all: "" }
            const decoder = new TextDecoder()
            const beforeRest = decoder.decode(firstRead.value, { stream: true })
            const readRest = async (text: string): Promise<string> => {
              const chunk = await reader.read()
              return chunk.done
                ? text
                : readRest(text + decoder.decode(chunk.value, { stream: true }))
            }
            return {
              contentType: response.headers.get("content-type"),
              turnState: response.headers.get("x-codex-turn-state"),
              beforeRest,
              all: await readRest(beforeRest),
            }
          })

          expect(received).toEqual({
            contentType: "text/event-stream",
            turnState: "ts_fake_account_bound",
            beforeRest: first,
            all: first + rest,
          })
        }),
      ),
    )

    it.effect("GET /backend-api/codex/models is served from the backend, query and all", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const codex = yield* fakeCodex
          const home = yield* makeHome({ codex })
          yield* home.signIn(carol)
          const key = yield* home.proxyKey
          const catalog = '{"models":[{"slug":"gpt-6-luna","display_name":"GPT-6 Luna"}]}'
          codex.answerApiWith(
            () =>
              new Response(catalog, {
                headers: { "content-type": "application/json", etag: '"catalog-1"' },
              }),
          )

          const response = yield* home.send("/backend-api/codex/models?client_version=0.169.0", {
            headers: { authorization: `Bearer ${key}`, originator: "codex_exec" },
          })

          expect(response).toMatchObject({ status: 200, text: catalog })
          expect(response.headers.get("etag")).toBe('"catalog-1"')
          expect(codex.apiRequests()).toEqual([
            expect.objectContaining({
              method: "GET",
              path: "/backend-api/codex/models?client_version=0.169.0",
              body: "",
            }),
          ])
          expect(codex.apiRequests()[0]?.headers).toMatchObject({
            authorization: `Bearer ${lastToken(codex)}`,
            "chatgpt-account-id": carol.accountId,
            originator: "codex_exec",
          })
        }),
      ),
    )

    it.effect(
      "POST /backend-api/codex/alpha/search, Codex's web search, is served from the backend",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            yield* home.signIn(carol)
            const key = yield* home.proxyKey
            const query = '{"query":"effect 4 release notes"}'

            const response = yield* home.send("/backend-api/codex/alpha/search", {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: query,
            })

            expect(response.status).toBe(200)
            expect(codex.apiRequests()).toEqual([
              expect.objectContaining({
                method: "POST",
                path: "/backend-api/codex/alpha/search",
                body: query,
              }),
            ])
          }),
        ),
    )

    it.effect(
      "a WebSocket upgrade on the Codex path gets a clean 426, so the client falls back to HTTP",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            yield* home.signIn(carol)
            const key = yield* home.proxyKey

            const response = yield* home.send("/backend-api/codex/responses", {
              headers: {
                authorization: `Bearer ${key}`,
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-version": "13",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
              },
            })

            expect(response.status).toBe(426)
            expect(JSON.parse(response.text)).toEqual({
              error: {
                message: "agent-proxy: WebSocket is not supported. Send the request over HTTP.",
                type: "invalid_request_error",
                param: null,
                code: null,
              },
            })
            expect(codex.apiRequests()).toEqual([])
            // The connection is still good for the HTTP fallback.
            expect((yield* home.sendResponse).status).toBe(200)
          }),
        ),
    )

    it.effect(
      "a Codex request without the key, or with a wrong one, gets a 401 in OpenAI's shape",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            yield* home.signIn(carol)
            const wrongKey = "ap-not-the-real-key-0123456789"
            const responses = (authorization: string | undefined) =>
              home.send("/backend-api/codex/responses", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(authorization === undefined ? {} : { authorization }),
                },
                body: responsesBody,
              })

            const none = yield* responses(undefined)
            expect(none.status).toBe(401)
            expect(JSON.parse(none.text)).toEqual({
              error: {
                message:
                  "agent-proxy: no proxy key sent. Send the key `agent-proxy key` prints, as the x-api-key header or as Authorization: Bearer.",
                type: "invalid_request_error",
                param: null,
                code: "invalid_api_key",
              },
            })
            const wrong = yield* responses(`Bearer ${wrongKey}`)
            expect(wrong.status).toBe(401)
            expect(wrong.text).not.toContain(wrongKey)
            expect(JSON.parse(wrong.text).error.message).toBe(
              "agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.",
            )
            expect(codex.apiRequests()).toEqual([])
          }),
        ),
    )

    it.effect(
      "with no Codex account, a Codex client is told to add one, even with Claude accounts held",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            home.claude.signInAs(alice)
            const login = yield* home.api("POST", "/api/logins", { provider: "claude" })
            yield* Effect.promise(() => fetch(String(login.json.authorizeUrl)))
            expect(
              (yield* home.accounts).accounts.map(
                (account: { provider: string }) => account.provider,
              ),
            ).toEqual(["claude"])

            const response = yield* home.sendResponse

            expect(response.status).toBe(400)
            expect(JSON.parse(response.text)).toEqual({
              error: {
                message:
                  "agent-proxy: no Codex account. Add one with `agent-proxy accounts add codex`.",
                type: "invalid_request_error",
                param: null,
                code: null,
              },
            })
            expect(home.claude.apiRequests()).toEqual([])
            expect(codex.apiRequests()).toEqual([])
          }),
        ),
    )

    it.effect(
      "with every Codex account disabled, a Codex client is told so, and Claude still serves",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            const login = yield* home.signIn(carol)
            yield* home.api("PATCH", `/api/accounts/${login.account.id}`, { enabled: false })

            const response = yield* home.sendResponse

            expect(response.status).toBe(400)
            expect(JSON.parse(response.text).error.message).toBe(
              "agent-proxy: no Codex account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.",
            )
            expect(codex.apiRequests()).toEqual([])
          }),
        ),
    )

    it.effect(
      "the highest-priority Active Codex account serves, and a Claude request never uses it",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            yield* home.signIn(carol)
            const carolToken = lastToken(codex)
            const second = yield* home.signIn(dave)
            const key = yield* home.proxyKey

            expect((yield* home.sendResponse).status).toBe(200)
            yield* home.api("PATCH", `/api/accounts/${second.account.id}`, { priority: 1 })
            expect((yield* home.sendResponse).status).toBe(200)
            const claude = yield* home.send("/v1/messages", {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: "{}",
            })

            expect(
              codex.apiRequests().map((request) => request.headers["chatgpt-account-id"]),
            ).toEqual([carol.accountId, dave.accountId])
            expect(codex.apiRequests()[0]?.headers["authorization"]).toBe(`Bearer ${carolToken}`)
            expect(claude.status).toBe(400)
            expect(JSON.parse(claude.text).error.message).toBe(
              "agent-proxy: no Claude account. Add one with `agent-proxy accounts add claude`.",
            )
          }),
        ),
    )

    it.effect("a redirect from the Codex backend reaches the client as it is, never followed", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const codex = yield* fakeCodex
          const home = yield* makeHome({ codex })
          yield* home.signIn(carol)
          const key = yield* home.proxyKey
          codex.answerApiWith(
            () =>
              new Response(null, {
                status: 307,
                headers: { location: "/backend-api/codex/models" },
              }),
          )

          const response = yield* home.send("/backend-api/codex/responses", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: responsesBody,
            redirect: "manual",
          })

          expect(response.status).toBe(307)
          expect(response.headers.get("location")).toBe("/backend-api/codex/models")
          expect(codex.apiRequests()).toHaveLength(1)
        }),
      ),
    )

    it.effect(
      "a Codex request whose token the backend rejects is retried once after a refresh",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex })
            yield* home.signIn(carol)
            const rejected = `Bearer ${lastToken(codex)}`
            const { promise: cancelled, resolve: onCancel } = Promise.withResolvers<"cancelled">()
            // The rejection's body never finishes: it is cancelled, not read.
            codex.answerApiWith((request) =>
              request.headers.get("authorization") === rejected
                ? new Response(
                    new ReadableStream<Uint8Array>({
                      start: (controller) =>
                        controller.enqueue(new TextEncoder().encode('{"error":{"message":')),
                      cancel: () => onCancel("cancelled"),
                    }),
                    { status: 401, headers: { "content-type": "application/json" } },
                  )
                : Response.json({ id: "resp_ok" }),
            )

            const response = yield* home.sendResponse.pipe(Effect.timeout("4 seconds"))

            expect(response.status).toBe(200)
            expect(codex.refreshRequests()).toEqual(["rt_fake_1"])
            expect(codex.apiRequests().map((request) => request.headers["authorization"])).toEqual([
              rejected,
              `Bearer ${lastToken(codex)}`,
            ])
            expect(
              yield* Effect.promise(() =>
                Promise.race([cancelled, Bun.sleep(3000).then(() => "still open" as const)]),
              ),
            ).toBe("cancelled")
          }),
        ),
    )

    it.effect("when the Codex backend cannot be reached, the client gets a 502 saying so", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          // Nothing listens on port 1.
          const home = yield* makeHome({
            codex: yield* fakeCodex,
            options: { apiBaseUrl: "http://127.0.0.1:1" },
          })
          yield* home.signIn(carol)
          const response = yield* home.sendResponse
          expect(response.status).toBe(502)
          expect(JSON.parse(response.text)).toEqual({
            error: {
              message:
                "agent-proxy: could not reach Codex. Check this machine's network connection.",
              type: "server_error",
              param: null,
              code: null,
            },
          })
        }),
      ),
    )

    it.effect(
      "AGENT_PROXY_PROVIDER_ENDPOINTS points Codex sign-ins and requests at other endpoints",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const codex = yield* fakeCodex
            const home = yield* makeHome({ codex, options: { endpointsFromEnv: true } })
            const login = yield* home.signIn(carol)
            expect(login.status).toBe("succeeded")
            expect((yield* home.sendResponse).status).toBe(200)
            expect(codex.apiRequests().map((request) => request.headers["authorization"])).toEqual([
              `Bearer ${lastToken(codex)}`,
            ])
          }),
        ),
    )
  },
)
