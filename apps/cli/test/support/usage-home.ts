import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import type { Provider } from "../../src/accounts/account.ts"
import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { type FakeClaude, fakeClaude } from "./fake-claude.ts"
import { type FakeCodex, fakeCodex } from "./fake-codex.ts"

// A daemon for usage and limit-window tests, in-process: a real daemon on
// loopback in a throwaway home, fake Claude and Codex backends, and Effect's
// test clock, set to a fixed moment. Clients are plain `fetch` calls to the
// proxy; tests read only what the daemon API reports (`/api/usage/*`,
// `/api/limits` and `/api/events`).

/** 2026-11-18 09:00 UTC, which is 18:00 in Tokyo. */
export const NOW = Date.UTC(2026, 10, 18, 9, 0, 0)
export const HOUR = 3_600_000

/** How long a test waits on the event stream before failing, in real time. */
const STREAM_WAIT_MS = 3000

/** The events on `GET /api/events`, read as a browser's EventSource does. */
export const openEvents = (address: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const controller = new AbortController()
      const response = await fetch(`${address}/api/events`, { signal: controller.signal })
      const reader = (response.body ?? new ReadableStream<Uint8Array>())
        .pipeThrough(new TextDecoderStream())
        .getReader()
      let buffer = ""
      const read = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const end = buffer.indexOf("\n\n")
          if (end !== -1) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n")
            const event: unknown = data === "" ? undefined : JSON.parse(data)
            if (typeof event === "object" && event !== null) return { ...event }
            continue
          }
          // oxlint-disable-next-line no-await-in-loop -- the stream arrives one chunk at a time
          const chunk = await reader.read()
          if (chunk.done) throw new Error("the stream ended")
          buffer += chunk.value
        }
      }
      return { controller, read }
    }),
    ({ controller }) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.map(({ read }) => {
      /** The next event whose `type` is `type`, skipping others. */
      const next = (type: string): Effect.Effect<Record<string, unknown>> =>
        Effect.promise(() =>
          Promise.race([
            (async () => {
              for (;;) {
                // oxlint-disable-next-line no-await-in-loop -- events arrive one at a time
                const event = await read()
                if (event["type"] === type) return event
              }
            })(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`no ${type} event within ${STREAM_WAIT_MS}ms`)),
                STREAM_WAIT_MS,
              ),
            ),
          ]),
        )
      return { next }
    }),
  )

/** An account the daemon held before it started. */
export interface SeededAccount {
  readonly provider: Provider
  readonly id: string
  readonly priority?: number
  readonly enabled?: boolean
  readonly needsSignIn?: boolean
}

/**
 * A daemon in a throwaway home whose Claude and Codex traffic goes to the
 * fakes, started at `startAt` on the test clock, holding `accounts`.
 * `prepare` sets the fakes up before the daemon starts, which reads every
 * account's limit windows at once. `restart` stops it and starts another
 * on the same data directory.
 */
export const makeHome = (
  options: {
    readonly startAt?: number
    readonly accounts?: ReadonlyArray<SeededAccount>
    readonly prepare?: (fakes: { readonly claude: FakeClaude; readonly codex: FakeCodex }) => void
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(options.startAt ?? NOW)
    const fs = yield* FileSystem.FileSystem
    const claude = yield* fakeClaude
    const codex = yield* fakeCodex
    options.prepare?.({ claude, codex })
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-usage-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
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

    /** Stops the daemon, runs `whileStopped`, and starts another on the same data directory. */
    const restartAfter = <E>(whileStopped: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        yield* Scope.close(scope, Exit.void)
        yield* whileStopped
        scope = yield* Scope.make()
        daemon = yield* Scope.provide(start, scope)
      })
    const restart = restartAfter(Effect.void)

    const send = (path: string, init: RequestInit = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`${daemon.address}${path}`, init)
        return { status: response.status, headers: response.headers, text: await response.text() }
      })

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

    const key = Effect.map(api("GET", "/api/key"), (response) => String(response.json.key))

    /** Writes the file of an account the daemon held before, as `id` at `priority`. */
    const seed = (
      provider: Provider,
      id: string,
      priority = 1,
      settings: {
        readonly enabled?: boolean
        readonly needsSignIn?: boolean
        /** Its tokens; by default `token-<id>`, good until 2099. */
        readonly credentials?: {
          readonly accessToken: string
          readonly refreshToken: string
          readonly expiresAt: string
        }
      } = {},
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
            addedAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
            credentials: settings.credentials ?? {
              accessToken: `token-${id}`,
              refreshToken: `refresh-${id}`,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          }),
          { mode: 0o600 },
        )
      })

    /** Leaves account `id`'s file unreadable, as a half-written or damaged file would be. */
    const damage = (id: string) =>
      fs.writeFileString(`${env.XDG_DATA_HOME}/agent-proxy/accounts/${id}.json`, "{", {
        mode: 0o600,
      })

    for (const account of options.accounts ?? []) {
      yield* seed(account.provider, account.id, account.priority ?? 1, account)
    }
    let scope = yield* Scope.make()
    let daemon = yield* Scope.provide(start, scope)
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

    /** Sends a Claude message request as Claude Code does. */
    const claudeMessage = (
      message: { readonly model?: string; readonly path?: string; readonly session?: string } = {},
    ) =>
      Effect.gen(function* () {
        return yield* send(message.path ?? "/v1/messages?beta=true", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "claude-cli/2.1.326 (external, cli)",
            "x-api-key": yield* key,
            ...(message.session === undefined
              ? {}
              : { "x-claude-code-session-id": message.session }),
          },
          body: JSON.stringify({
            model: message.model ?? "claude-sonnet-4-5",
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        })
      })

    /** Sends a Codex Responses request as Codex does. */
    const codexResponse = (response: { readonly model?: string } = {}) =>
      Effect.gen(function* () {
        return yield* send("/backend-api/codex/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "codex_cli_rs/0.169.0 (Mac OS 26.6.0; arm64)",
            authorization: `Bearer ${yield* key}`,
            "session-id": "codex-session",
          },
          body: JSON.stringify({
            model: response.model ?? "gpt-5.4",
            instructions: "Be brief.",
            input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
            stream: true,
          }),
        })
      })

    /** Adds an account through a browser login at the fake provider, as the dashboard does. */
    const signIn = (provider: Provider) =>
      Effect.gen(function* () {
        const started = yield* api("POST", "/api/logins", { provider })
        const authorizeUrl = String(started.json.authorizeUrl)
        yield* Effect.promise(() => fetch(authorizeUrl).then((response) => response.text()))
      })

    /** `GET /api/limits`: every account's limit windows. */
    const limits = Effect.map(api("GET", "/api/limits"), (response) => response.json)

    /** `GET /api/usage/<what>` with `params`, in Tokyo unless `tz` is given. */
    const usage = (what: string, params: Readonly<Record<string, string>> = {}) =>
      Effect.map(
        api(
          "GET",
          `/api/usage/${what}?${new URLSearchParams({ tz: "Asia/Tokyo", ...params }).toString()}`,
        ),
        (response) => response.json,
      )

    return {
      claude,
      codex,
      restart,
      restartAfter,
      /** The daemon's data directory, `agent-proxy` under `XDG_DATA_HOME`. */
      dataDir: `${env.XDG_DATA_HOME}/agent-proxy`,
      send,
      api,
      seed,
      damage,
      claudeMessage,
      codexResponse,
      usage,
      limits,
      signIn,
      events: Effect.suspend(() => openEvents(daemon.address)),
      address: () => daemon.address,
      key,
    }
  })

export const sse = (body: string, headers: Readonly<Record<string, string>>) =>
  new Response(body, { headers: { ...headers, "content-type": "text/event-stream" } })

export const services = Layer.mergeAll(
  BunServices.layer,
  RuntimeInfo.layerProcess,
  Processes.layerProcess,
  FetchHttpClient.layer,
)
