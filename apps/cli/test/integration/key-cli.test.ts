import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { Browser } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints, realEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { alice, type FakeClaude, fakeClaude } from "../support/fake-claude.ts"

// `key` and `key --rotate`, driven in-process through the real command tree
// against an in-process daemon (`daemon run`) whose Claude traffic goes to a
// fake Claude. Whether a key works is observed the way a client sees it: a
// proxy request with it is served, or refused with a 401.

const notRunning =
  "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`."

/** Adds alice's Claude account through the daemon's login API and a browser that signs in. */
const addAccount = (claude: FakeClaude, address: string) =>
  Effect.promise(async () => {
    claude.signInAs(alice)
    const started = await fetch(`${address}/api/logins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude" }),
    })
    const login: unknown = await started.json()
    if (typeof login === "object" && login !== null && "authorizeUrl" in login) {
      await fetch(String(login.authorizeUrl))
    }
  })

/** The status a Claude request presenting `key` gets from the proxy at `address`. */
const statusWithKey = (address: string, key: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${address}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 8, messages: [] }),
    })
    await response.arrayBuffer()
    return response.status
  })

const makeHome = (claude: FakeClaude) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-key-cli-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
    }
    const stateDir = `${root}/state/agent-proxy`

    /** Runs `agent-proxy <argv>` in this home, and returns what it printed to stdout and stderr. */
    const cli = (argv: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const stdout: Array<string> = []
        const stderr: Array<string> = []
        const console: Console.Console = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            stdout.push(args.join(" "))
          },
          error: (...args: ReadonlyArray<unknown>) => {
            stderr.push(args.join(" "))
          },
        }
        yield* runCli(argv).pipe(
          Effect.provideService(Console.Console, console),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
          Effect.provideService(
            ProviderEndpoints,
            ProviderEndpoints.of({ ...realEndpoints, claude: claude.endpoints }),
          ),
        )
        return { stdout: stdout.join("\n"), stderr: stderr.join("\n") }
      })

    /** Runs `agent-proxy daemon run` in the background until the test's scope closes. */
    const runDaemon = Effect.gen(function* () {
      yield* Effect.forkScoped(cli(["daemon", "run"]))
      yield* fs.exists(`${stateDir}/daemon.json`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (exists) => exists,
          times: 250,
        }),
      )
      const state: unknown = JSON.parse(yield* fs.readFileString(`${stateDir}/daemon.json`))
      return typeof state === "object" && state !== null && "address" in state
        ? String(state.address)
        : ""
    })

    return { cli, runDaemon }
  })

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    FetchHttpClient.layer,
    Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
  ),
)("agent-proxy key", (it) => {
  it.effect("key fails with the daemon-down hint when no daemon runs", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        for (const argv of [["key"], ["key", "--rotate"]]) {
          const error = yield* Effect.flip(home.cli(argv))
          expect(error._tag === "UserError" && error.userMessage).toBe(notRunning)
        }
      }),
    ),
  )

  it.effect("key prints the proxy key, and the proxy serves requests that carry it", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        const address = yield* home.runDaemon
        yield* addAccount(claude, address)

        const { stdout, stderr } = yield* home.cli(["key"])
        expect(stdout).toMatch(/^\S{32,}$/)
        expect(stderr).toBe("")
        expect(yield* statusWithKey(address, stdout)).toBe(200)
        expect((yield* home.cli(["key"])).stdout).toBe(stdout)
      }),
    ),
  )

  it.effect("key --rotate prints a new key, and the old key stops working at once", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        const address = yield* home.runDaemon
        yield* addAccount(claude, address)
        const oldKey = (yield* home.cli(["key"])).stdout

        const rotated = yield* home.cli(["key", "--rotate"])
        expect(rotated.stdout).toMatch(/^\S{32,}$/)
        expect(rotated.stdout).not.toBe(oldKey)
        expect(rotated.stderr).toBe(
          "Rotated the proxy key; the old key no longer works. Clients that run `agent-proxy key` pick up the new one on their next request.",
        )
        expect(yield* statusWithKey(address, oldKey)).toBe(401)
        expect(yield* statusWithKey(address, rotated.stdout)).toBe(200)
        expect((yield* home.cli(["key"])).stdout).toBe(rotated.stdout)
      }),
    ),
  )
})
