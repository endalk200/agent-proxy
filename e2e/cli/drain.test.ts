import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Schema } from "effect"
import { TestClock } from "effect/testing"

import { isAlive } from "../support/process.ts"

// Stopping a daemon mid-turn, black-box: the built daemon in a sandbox
// proxies a Claude turn whose answer a fake API holds open, and is stopped
// with `daemon stop`, which sends it SIGTERM. Only commands, the client's
// answer, and the daemon's process are observed.

const StateFile = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, address: Schema.String }))

/** A Claude API whose every answer starts streaming and then holds, never finishing. */
const holdingApi = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"message_start","message":{}}\n\n'),
              )
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    }),
  ),
  (server) => Effect.promise(() => server.stop(true)),
)

layer(BunServices.layer)("agent-proxy daemon stop, mid-turn (built binary)", (it) => {
  it.effect(
    "stop waits for the turn in flight and says so; a second stop cuts it off",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const api = yield* holdingApi
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
          const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
          const env = {
            ...sandbox.env,
            AGENT_PROXY_PROVIDER_ENDPOINTS: JSON.stringify({
              claude: { apiBaseUrl: `http://127.0.0.1:${api.port}` },
            }),
          }
          const agentProxy = (args: ReadonlyArray<string>) =>
            runCli({ ...sandbox, env }, defaultRepo.cliBuilt, args, { cwd: root })
          yield* Effect.addFinalizer(() => agentProxy(["daemon", "stop"]).pipe(Effect.ignore))

          const accountsDir = `${sandbox.dataHome}/agent-proxy/accounts`
          yield* fs.makeDirectory(accountsDir, { recursive: true, mode: 0o700 })
          yield* fs.writeFileString(
            `${accountsDir}/aa01.json`,
            JSON.stringify({
              id: "aa01",
              provider: "claude",
              providerAccountId: "account-aa01:org-aa01",
              email: "me@work.example",
              plan: "Max 20x",
              label: "Work",
              priority: 1,
              enabled: true,
              needsSignIn: false,
              addedAt: "2026-11-01T00:00:00.000Z",
              lastUsedAt: null,
              credentials: {
                accessToken: "sk-ant-oat01-work",
                refreshToken: "sk-ant-ort01-work",
                expiresAt: "2099-01-01T00:00:00.000Z",
              },
            }),
            { mode: 0o600 },
          )

          expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
          const key = (yield* agentProxy(["key"])).stdout.trim()
          const { pid, address } = yield* Schema.decodeEffect(StateFile)(
            yield* fs.readFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`),
          )

          // A turn whose answer has started streaming, read until it ends or is cut.
          const turn = yield* Effect.promise(async () => {
            const response = await fetch(`${address}/v1/messages`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key },
              body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [] }),
            })
            const reader = (response.body ?? new ReadableStream<Uint8Array>()).getReader()
            await reader.read()
            return {
              ended: (async () => {
                try {
                  for (;;) {
                    // oxlint-disable-next-line no-await-in-loop -- the answer arrives one chunk at a time
                    if ((await reader.read()).done) return "ended"
                  }
                } catch {
                  return "cut"
                }
              })(),
            }
          })

          const firstStop = yield* Effect.forkChild(agentProxy(["daemon", "stop"]))
          yield* Effect.promise(() => Bun.sleep(2000))
          // Still serving the turn, and still running.
          expect(isAlive(pid)).toBe(true)
          expect((yield* Effect.promise(() => fetch(`${address}/healthz`))).status).toBe(200)

          const secondStop = yield* agentProxy(["daemon", "stop"])
          expect(secondStop.exitCode).toBe(0)
          const first = yield* Fiber.join(firstStop)
          expect(first.exitCode).toBe(0)
          expect(first.stderr).toContain(
            `Waiting for the daemon (pid ${pid}) to finish the requests in flight, at most 10m.`,
          )
          expect(first.stdout).toContain(`agent-proxy daemon stopped (pid ${pid})`)
          expect(isAlive(pid)).toBe(false)
          expect(yield* Effect.promise(() => turn.ended)).not.toBe("ended")
        }),
      ),
    60_000,
  )
})
