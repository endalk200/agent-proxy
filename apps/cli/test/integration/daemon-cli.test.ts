import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Console, Effect, Fiber, FileSystem, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { Browser } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"

// The `daemon` commands, driven in-process through the real command tree with
// a throwaway HOME and XDG directories. `daemon run` serves on a real loopback
// port; `start` and `stop` manage OS processes and are covered by the e2e suite.
// Each test runs on real time (TestClock.withLive): the daemon serves real sockets.

const StatusJson = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    address: Schema.String,
    version: Schema.String,
    startedAt: Schema.String,
    uptimeSeconds: Schema.Finite,
  }),
)

const makeHome = (config: string, extraEnv: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-cli-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, config)
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      ...extraEnv,
    }
    const stateDir = `${root}/state/agent-proxy`

    /** Runs `agent-proxy <argv>` in this home and returns what it printed to stdout. */
    const cli = (argv: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const console: Console.Console = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            lines.push(args.join(" "))
          },
        }
        yield* runCli(argv).pipe(
          Effect.provideService(Console.Console, console),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
        )
        return lines.join("\n")
      })

    /** Runs `agent-proxy daemon run` in the background until the test's scope closes. */
    const runDaemon = Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(cli(["daemon", "run"]))
      yield* fs.exists(`${stateDir}/daemon.json`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (exists) => exists,
          times: 250,
        }),
      )
      return fiber
    })

    return { stateDir, cli, runDaemon }
  })

const notRunning =
  "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`."

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    FetchHttpClient.layer,
    ProviderEndpoints.layer,
    Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
  ),
)("agent-proxy daemon", (it) => {
  it.effect("status fails with a one-line hint when no daemon runs, and starts none", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        const error = yield* Effect.flip(home.cli(["daemon", "status"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(notRunning)
        expect(yield* fs.exists(`${home.stateDir}/daemon.json`)).toBe(false)
        expect(yield* fs.exists(`${home.stateDir}/daemon.lock`)).toBe(false)
      }),
    ),
  )

  it.effect("status --json fails the same way when no daemon runs", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        const error = yield* Effect.flip(home.cli(["daemon", "status", "--json"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(notRunning)
      }),
    ),
  )

  it.effect("status reports a daemon that died without cleaning up as not running", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        yield* fs.makeDirectory(home.stateDir, { recursive: true })
        // Port 9 (discard) has no listener on a developer machine.
        yield* fs.writeFileString(
          `${home.stateDir}/daemon.json`,
          JSON.stringify({ pid: 999_999, port: 9, address: "http://127.0.0.1:9" }),
        )
        const error = yield* Effect.flip(home.cli(["daemon", "status"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(notRunning)
      }),
    ),
  )

  it.effect(
    "status and stop ignore a stale state file whose address now serves another daemon",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const other = yield* makeHome('listen = "127.0.0.1:0"\n')
          yield* other.runDaemon
          const { address, port } = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ address: Schema.String, port: Schema.Int })),
          )(yield* fs.readFileString(`${other.stateDir}/daemon.json`))

          // This home's daemon crashed, and another state directory's daemon took its port.
          const home = yield* makeHome('listen = "127.0.0.1:0"\n')
          yield* fs.makeDirectory(home.stateDir, { recursive: true })
          yield* fs.writeFileString(
            `${home.stateDir}/daemon.json`,
            JSON.stringify({ pid: 999_999, port, address }),
          )

          const statusError = yield* Effect.flip(home.cli(["daemon", "status"]))
          expect(statusError._tag === "UserError" && statusError.userMessage).toBe(notRunning)
          const stopError = yield* Effect.flip(home.cli(["daemon", "stop"]))
          expect(stopError._tag === "UserError" && stopError.userMessage).toBe(notRunning)
          // The other directory's daemon was never signalled.
          expect(yield* other.cli(["daemon", "status"])).toMatch(/^agent-proxy daemon is running/)
        }),
      ),
  )

  it.effect("status gives up on an address that sends headers but never finishes its body", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: () =>
                new Response(
                  new ReadableStream({
                    start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
            }),
          ),
          (s) => Effect.promise(() => s.stop(true)),
        )
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        yield* fs.makeDirectory(home.stateDir, { recursive: true })
        yield* fs.writeFileString(
          `${home.stateDir}/daemon.json`,
          JSON.stringify({
            pid: 999_999,
            port: server.port,
            address: `http://127.0.0.1:${server.port}`,
          }),
        )
        const error = yield* Effect.flip(home.cli(["daemon", "status"])).pipe(
          Effect.timeout("4 seconds"),
        )
        expect(error._tag).toBe("UserError")
      }),
    ),
  )

  it.effect("status --json reports the running daemon's pid, address and uptime", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        yield* home.runDaemon
        const status = yield* Schema.decodeEffect(StatusJson)(
          yield* home.cli(["daemon", "status", "--json"]),
        )
        expect(status.pid).toBe(process.pid)
        expect(status.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
        expect(status.address).not.toBe("http://127.0.0.1:0")
        expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0)
      }),
    ),
  )

  it.effect("status prints the pid, address and uptime as aligned lines", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        yield* home.runDaemon
        const output = yield* home.cli(["daemon", "status"])
        expect(output).toMatch(
          new RegExp(
            [
              "^agent-proxy daemon is running",
              `pid      ${process.pid}`,
              String.raw`address  http://127\.0\.0\.1:\d+`,
              String.raw`uptime   \d+s`,
              String.raw`version  \d+\.\d+\.\d+$`,
            ].join("\n"),
          ),
        )
      }),
    ),
  )

  it.effect("run prints where it listens, and removes its state file when interrupted", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        const fiber = yield* home.runDaemon
        expect(yield* fs.exists(`${home.stateDir}/daemon.json`)).toBe(true)
        yield* Fiber.interrupt(fiber)
        expect(yield* fs.exists(`${home.stateDir}/daemon.json`)).toBe(false)
        const error = yield* Effect.flip(home.cli(["daemon", "status"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(notRunning)
      }),
    ),
  )

  it.effect("run refuses to start a second daemon on the same state directory", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome('listen = "127.0.0.1:0"\n')
        yield* home.runDaemon
        const error = yield* Effect.flip(home.cli(["daemon", "run"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(
          `Another agent-proxy daemon (pid ${process.pid}) is already running for ${home.stateDir}.`,
        )
      }),
    ),
  )

  it.effect("run fails on an unknown config key, naming the key and its line", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome('listen = "127.0.0.1:0"\nport = 8318\n')
        const error = yield* Effect.flip(home.cli(["daemon", "run"]))
        expect(error._tag === "UserError" && error.userMessage).toMatch(
          /config\.toml, line 2: unknown key "port" \(the only key is "listen"\)$/,
        )
      }),
    ),
  )

  it.effect("run refuses a config file named by AGENT_PROXY_CONFIG that does not exist", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome("", { AGENT_PROXY_CONFIG: "/nonexistent/agent-proxy.toml" })
        const error = yield* Effect.flip(home.cli(["daemon", "run"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(
          "AGENT_PROXY_CONFIG names /nonexistent/agent-proxy.toml, which does not exist.",
        )
      }),
    ),
  )
})
