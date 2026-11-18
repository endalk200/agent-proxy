import { dirname, join } from "node:path"

import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import { isAlive } from "../support/process.ts"

// The daemon's lifecycle, black-box: the compiled binary in a sandbox whose
// config binds any free port. Only commands, their output, the state file,
// and HTTP are observed. Every test's sandbox stops its daemon, even when the
// test fails.

const StateFile = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, port: Schema.Int, address: Schema.String }),
)

const Status = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    address: Schema.String,
    version: Schema.String,
    startedAt: Schema.String,
    uptimeSeconds: Schema.Finite,
  }),
)

const notRunning =
  "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`."

const sandboxed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
  const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
  const agentProxy = (args: ReadonlyArray<string>) =>
    runCli(sandbox, defaultRepo.cliBuilt, args, { cwd: root })
  const stateFile = `${sandbox.stateHome}/agent-proxy/daemon.json`
  return { sandbox, root, agentProxy, stateFile }
})

const healthz = (address: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return (yield* client.get(`${address}/healthz`)).status
  })

const get = (url: string) =>
  Effect.gen(function* () {
    const response = yield* (yield* HttpClient.HttpClient).get(url)
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      body: yield* response.text,
    }
  })

layer(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))(
  "agent-proxy daemon (built binary)",
  (it) => {
    it.effect("status before any start fails with a hint and starts nothing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { agentProxy, stateFile } = yield* sandboxed
        const result = yield* agentProxy(["daemon", "status"])
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(notRunning)
        expect(yield* fs.exists(stateFile)).toBe(false)
      }),
    )

    it.effect(
      "start, status, healthz, a refused second daemon, then stop",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const { agentProxy, stateFile } = yield* sandboxed

            const started = yield* agentProxy(["daemon", "start"])
            expect(started.exitCode).toBe(0)
            const state = yield* Schema.decodeEffect(StateFile)(yield* fs.readFileString(stateFile))
            expect(state.port).toBeGreaterThan(0)
            expect(state.address).toBe(`http://127.0.0.1:${state.port}`)
            expect(started.stdout.trim()).toBe(
              `agent-proxy daemon started (pid ${state.pid}) at ${state.address}`,
            )
            expect(yield* healthz(state.address)).toBe(200)

            const status = yield* agentProxy(["daemon", "status", "--json"])
            expect(status.exitCode).toBe(0)
            const info = yield* Schema.decodeEffect(Status)(status.stdout)
            expect(info).toMatchObject({ pid: state.pid, address: state.address })
            expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0)

            const text = yield* agentProxy(["daemon", "status"])
            expect(text.stdout).toContain(`pid      ${state.pid}`)
            expect(text.stdout).toContain(`address  ${state.address}`)
            expect(text.stdout).toMatch(/uptime {3}\d+s/)

            const secondStart = yield* agentProxy(["daemon", "start"])
            expect(secondStart.exitCode).toBe(1)
            expect(secondStart.stderr).toContain(
              `The agent-proxy daemon is already running (pid ${state.pid}) at ${state.address}.`,
            )
            const secondRun = yield* agentProxy(["daemon", "run"])
            expect(secondRun.exitCode).toBe(1)
            expect(secondRun.stderr).toContain(
              `Another agent-proxy daemon (pid ${state.pid}) is already running`,
            )

            const stopped = yield* agentProxy(["daemon", "stop"])
            expect(stopped.exitCode).toBe(0)
            expect(stopped.stdout.trim()).toBe(`agent-proxy daemon stopped (pid ${state.pid})`)
            expect(isAlive(state.pid)).toBe(false)
            expect(yield* fs.exists(stateFile)).toBe(false)

            const after = yield* agentProxy(["daemon", "status"])
            expect(after.exitCode).toBe(1)
            expect(after.stderr).toContain(notRunning)
          }),
        ),
      60_000,
    )

    it.effect(
      "a foreground daemon exits 0 on SIGTERM and removes its state file",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const { sandbox, root, stateFile } = yield* sandboxed
            const daemon = yield* spawner.spawn(
              ChildProcess.make(defaultRepo.cliBuilt, ["daemon", "run"], {
                cwd: root,
                env: sandbox.env,
                extendEnv: false,
              }),
            )
            const appeared = yield* fs.exists(stateFile).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("50 millis"),
                until: (exists) => exists,
                times: 200,
              }),
            )
            expect(appeared).toBe(true)
            const state = yield* Schema.decodeEffect(StateFile)(yield* fs.readFileString(stateFile))
            expect(yield* healthz(state.address)).toBe(200)

            yield* daemon.kill({ killSignal: "SIGTERM" })
            expect(yield* daemon.exitCode).toBe(0)
            expect(yield* fs.exists(stateFile)).toBe(false)
          }),
        ),
      60_000,
    )

    it.effect(
      "serves the dashboard embedded in the binary, which has no build beside it",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const { agentProxy, stateFile } = yield* sandboxed
            expect(yield* fs.exists(join(dirname(defaultRepo.cliBuilt), "web"))).toBe(false)
            expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
            const state = yield* Schema.decodeEffect(StateFile)(yield* fs.readFileString(stateFile))

            const page = yield* get(`${state.address}/`)
            expect(page.status).toBe(200)
            expect(page.contentType).toMatch(/^text\/html/)
            const script = /src="\/(assets\/[^"]+\.js)"/.exec(page.body)?.[1]
            expect(script).toBeDefined()
            const asset = yield* get(`${state.address}/${script}`)
            expect(asset.status).toBe(200)
            expect(asset.contentType).toMatch(/^text\/javascript/)
          }),
        ),
      60_000,
    )

    it.effect(
      "names the build it runs, by its commit",
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { agentProxy } = yield* sandboxed
            expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
            const status = yield* agentProxy(["daemon", "status", "--json"])
            expect(JSON.parse(status.stdout)).toMatchObject({
              build: expect.stringMatching(/^[0-9a-f]{7,}(-dirty)?$/),
            })
            expect((yield* agentProxy(["daemon", "status"])).stdout).toMatch(
              /version {2}\d+\.\d+\.\d+ \([0-9a-f]{7,}(-dirty)?\)/,
            )
          }),
        ),
      60_000,
    )

    it.effect("daemon install refuses inside the sandbox, and writes no launch agent", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { sandbox, agentProxy } = yield* sandboxed
        const result = yield* agentProxy(["daemon", "install"])
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(
          `\`daemon install\` refuses to run while HOME (${sandbox.home}) is not your home directory`,
        )
        expect(yield* fs.exists(`${sandbox.home}/Library`)).toBe(false)
      }),
    )

    it.effect("start fails on a malformed config, naming its line", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { sandbox, agentProxy, stateFile } = yield* sandboxed
        yield* fs.writeFileString(sandbox.configFile, 'listen = "127.0.0.1:0"\nlisten = "x"\n')
        const result = yield* agentProxy(["daemon", "start"])
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain(
          `Invalid config file ${sandbox.configFile}, line 2: Cannot redefine key 'listen'`,
        )
        expect(yield* fs.exists(stateFile)).toBe(false)
      }),
    )
  },
)
