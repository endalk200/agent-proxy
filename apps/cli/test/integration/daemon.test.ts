import { networkInterfaces } from "node:os"

import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"

// The daemon's HTTP surface, in-process: a real listener on loopback, with
// HOME and the XDG directories pointing into a temporary directory.

const StateFile = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, port: Schema.Int, address: Schema.String }),
)

const DaemonInfo = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    address: Schema.String,
    version: Schema.String,
    startedAt: Schema.String,
    uptimeSeconds: Schema.Finite,
  }),
)

/** A throwaway home whose config.toml holds `config`. */
const makeHome = (config: string, extraEnv: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-daemon-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, config)
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
      ...extraEnv,
    }
    return {
      stateDir: `${root}/state/agent-proxy`,
      dataHome: env.XDG_DATA_HOME,
      stateFile: `${root}/state/agent-proxy/daemon.json`,
      start: startDaemon.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
      ),
    }
  })

const freePortConfig = 'listen = "127.0.0.1:0"\n'

const get = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(url)
    return { status: response.status, body: yield* response.text }
  })

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    FetchHttpClient.layer,
    ProviderEndpoints.layer,
  ),
)("daemon", (it) => {
  it.effect("binds a free port for port 0 and records it with its pid in the state file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome(freePortConfig)
      const daemon = yield* home.start
      const state = yield* Schema.decodeEffect(StateFile)(yield* fs.readFileString(home.stateFile))
      expect(state.port).toBeGreaterThan(0)
      expect(state.pid).toBe(process.pid)
      expect(state.address).toBe(`http://127.0.0.1:${state.port}`)
      expect(daemon.address).toBe(state.address)
    }),
  )

  it.effect("answers /healthz with 200 once started", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(freePortConfig)
      const daemon = yield* home.start
      const health = yield* get(`${daemon.address}/healthz`)
      expect(health.status).toBe(200)
    }),
  )

  it.effect("reports its pid, address, version and uptime to loopback clients", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(freePortConfig)
      const daemon = yield* home.start
      const response = yield* get(`${daemon.address}/api/daemon`)
      expect(response.status).toBe(200)
      const info = yield* Schema.decodeEffect(DaemonInfo)(response.body)
      expect(info.pid).toBe(process.pid)
      expect(info.address).toBe(daemon.address)
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0)
    }),
  )

  it.effect("refuses a second daemon on the same state directory", () =>
    Effect.gen(function* () {
      const home = yield* makeHome(freePortConfig)
      yield* home.start
      const error = yield* Effect.flip(Effect.scoped(home.start))
      expect(error.message).toBe(
        `Another agent-proxy daemon (pid ${process.pid}) is already running for ${home.stateDir}.`,
      )
    }),
  )

  it.effect(
    "refuses a second daemon on the same data directory, even with its own state directory",
    () =>
      Effect.gen(function* () {
        const first = yield* makeHome(freePortConfig)
        yield* first.start
        const second = yield* makeHome(freePortConfig, { XDG_DATA_HOME: first.dataHome })
        const error = yield* Effect.flip(Effect.scoped(second.start))
        expect(error.message).toBe(
          `Another agent-proxy daemon (pid ${process.pid}) is already running for ${first.dataHome}/agent-proxy.`,
        )
      }),
  )

  it.effect(
    "takes over a lock left by a crash even when its pid now belongs to another process",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome(freePortConfig)
        yield* fs.makeDirectory(home.stateDir, { recursive: true })
        // After a reboot, the crashed daemon's pid can be reused by any process: here, pid 1.
        yield* fs.writeFileString(`${home.stateDir}/daemon.lock`, "1\n")
        const daemon = yield* home.start
        const health = yield* get(`${daemon.address}/healthz`)
        expect(health.status).toBe(200)
      }),
  )

  const lanAddress = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address

  // Passes trivially on a machine with no non-loopback IPv4 interface.
  it.effect("serves its API to this machine when it listens on a non-loopback local address", () =>
    Effect.gen(function* () {
      if (lanAddress === undefined) return
      const home = yield* makeHome(`listen = "${lanAddress}:0"\n`)
      const daemon = yield* home.start
      const response = yield* get(`${daemon.address}/api/daemon`)
      expect(response.status).toBe(200)
    }),
  )

  it.effect("removes the state file and frees the state directory when it stops", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome(freePortConfig)
      yield* Effect.scoped(home.start)
      expect(yield* fs.exists(home.stateFile)).toBe(false)
      const again = yield* Effect.scoped(home.start)
      expect(again.port).toBeGreaterThan(0)
    }),
  )

  it.effect("writes one JSON object per line to its log in the state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome(freePortConfig)
      yield* Effect.scoped(home.start)
      const lines = (yield* fs.readFileString(`${home.stateDir}/daemon.log`)).trim().split("\n")
      const entries = lines.map((line): unknown => JSON.parse(line))
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: "INFO", message: "daemon started" }),
          expect.objectContaining({ level: "INFO", message: "daemon stopped" }),
        ]),
      )
    }),
  )

  it.effect("fails to start on a malformed config, naming the line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome('# agent-proxy\nlisten = "127.0.0.1:0\n')
      const error = yield* Effect.flip(Effect.scoped(home.start))
      expect(error.message).toMatch(/config\.toml, line 2: Unterminated string/)
      expect(yield* fs.exists(home.stateFile)).toBe(false)
    }),
  )

  it.effect("fails to start when its port is taken, naming the address", () =>
    Effect.gen(function* () {
      const first = yield* makeHome(freePortConfig)
      const running = yield* first.start
      const second = yield* makeHome(`listen = "127.0.0.1:${running.port}"\n`)
      const error = yield* Effect.flip(Effect.scoped(second.start))
      expect(error.message).toMatch(
        new RegExp(`^Could not listen on 127\\.0\\.0\\.1:${running.port}: `),
      )
    }),
  )

  it.effect("logs why it could not start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const first = yield* makeHome(freePortConfig)
      const running = yield* first.start
      const second = yield* makeHome(`listen = "127.0.0.1:${running.port}"\n`)
      yield* Effect.flip(Effect.scoped(second.start))
      const lines = (yield* fs.readFileString(`${second.stateDir}/daemon.log`)).trim().split("\n")
      expect(lines.map((line): unknown => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          level: "ERROR",
          message: "daemon failed to start",
          annotations: {
            error: expect.stringMatching(/^Could not listen on 127\.0\.0\.1:/),
          },
        }),
      )
    }),
  )
})
