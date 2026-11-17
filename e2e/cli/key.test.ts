import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"

// `key` and `key --rotate`, black-box: the built binary in a sandbox. Clients
// such as Codex give their key command 5 seconds, so both answers are timed.
// Proxy requests here carry no account, so no provider is contacted: a key
// that works gets the "no Claude account" error, a key that does not gets 401.

const notRunning =
  "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`."

/** Far inside the 5 seconds Codex allows its auth command, process start included. */
const QUICK_MS = 2500

const StateFile = Schema.fromJsonString(Schema.Struct({ address: Schema.String }))

const sandboxed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
  const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
  const agentProxy = (args: ReadonlyArray<string>) =>
    runCli(sandbox, defaultRepo.cliBuilt, args, { cwd: root })
  // Registered after the sandbox, so it runs before the sandbox is removed.
  yield* Effect.addFinalizer(() => agentProxy(["daemon", "stop"]).pipe(Effect.ignore))
  const address = fs.readFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`).pipe(
    Effect.flatMap(Schema.decodeEffect(StateFile)),
    Effect.map((state) => state.address),
  )
  return { agentProxy, address, keyFile: `${sandbox.dataHome}/agent-proxy/key` }
})

/** The status a Claude request presenting `key` gets from the proxy at `address`. */
const statusWithKey = (address: string, key: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(`${address}/v1/messages?beta=true`).pipe(
        HttpClientRequest.setHeader("x-api-key", key),
        HttpClientRequest.bodyJsonUnsafe({ model: "claude-sonnet-4-5", messages: [] }),
      ),
    )
    return response.status
  })

layer(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))(
  "agent-proxy key (built binary)",
  (it) => {
    it.effect("key fails quickly with the daemon-down hint", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const { agentProxy } = yield* sandboxed
          for (const args of [["key"], ["key", "--rotate"]]) {
            const result = yield* agentProxy(args)
            expect(result.exitCode).toBe(1)
            expect(result.stdout).toBe("")
            expect(result.stderr).toContain(notRunning)
            expect(result.durationMs).toBeLessThan(QUICK_MS)
          }
        }),
      ),
    )

    it.effect(
      "key prints the stored key quickly, and --rotate replaces it at once",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const { agentProxy, address, keyFile } = yield* sandboxed
            expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
            const proxy = yield* address

            const printed = yield* agentProxy(["key"])
            expect(printed.exitCode).toBe(0)
            expect(printed.durationMs).toBeLessThan(QUICK_MS)
            const key = printed.stdout.trim()
            expect(key).toBe(yield* fs.readFileString(keyFile))
            expect(yield* statusWithKey(proxy, key)).toBe(400)

            const rotated = yield* agentProxy(["key", "--rotate"])
            expect(rotated.exitCode).toBe(0)
            const newKey = rotated.stdout.trim()
            expect(newKey).not.toBe(key)
            expect(rotated.stderr).toContain("the old key no longer works")
            expect(yield* statusWithKey(proxy, key)).toBe(401)
            expect(yield* statusWithKey(proxy, newKey)).toBe(400)
            expect((yield* agentProxy(["key"])).stdout.trim()).toBe(newKey)
            expect(yield* fs.readFileString(keyFile)).toBe(newKey)
          }),
        ),
      60_000,
    )
  },
)
