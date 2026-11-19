import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  ConfigProvider,
  Console,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Scope,
} from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { Browser } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { Launchd } from "../../src/launchd.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"

// The launch agent (ADR-0008): `daemon install`, `uninstall`, `start`, `stop`
// and `restart`, driven in-process through the real command tree in a
// throwaway HOME that stands in for the owner's real one. launchd and the OS
// processes are fakes that record what they were asked: "starting the
// daemon" runs `daemon run` in-process, and SIGTERM interrupts it, as a real
// daemon shuts down on it. Real launchd is checked by hand (features/daemon.md).

const INSTALLED = "/Users/owner/.local/bin/agent-proxy"

interface Options {
  /** Defaults to macOS. */
  readonly platform?: string
  /** False runs from source. */
  readonly compiled?: boolean
  /** False makes HOME a sandbox rather than the owner's real home. */
  readonly realHome?: boolean
}

/** The services the commands run with, which the test's layer provides. */
type Services = BunServices.BunServices | HttpClient.HttpClient | ProviderEndpoints | Browser

const makeHome = (options: Options = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const scope = yield* Scope.Scope
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-launch-agent-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const home = `${root}/home`
    const stateDir = `${root}/state/agent-proxy`
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
    }

    const runtime = RuntimeInfo.of({
      runtime: "bun",
      runtimeVersion: Bun.version,
      platform: options.platform ?? "darwin",
      arch: "arm64",
      binary:
        options.compiled === false
          ? Option.none()
          : Option.some({ path: INSTALLED, commit: "abc1234", dirty: false }),
      realHome: Option.some(options.realHome === false ? "/Users/owner" : home),
    })

    /** Every call to launchd and to the processes, in order. */
    const calls: Array<string> = []

    // Every service the commands use, so a daemon forked from a fake keeps them.
    const services = yield* Effect.context<Services>()

    /** The daemon "processes": `daemon run` in-process, each with a pid of its own. */
    const daemons = new Map<
      number,
      { readonly fiber: Fiber.Fiber<unknown, unknown>; readonly supervised: boolean }
    >()
    let nextPid = 70_001
    const isAlive = (pid: number) =>
      daemons.get(pid)?.fiber.pollUnsafe() === undefined && daemons.has(pid)
    /** The daemon that runs now, if any. */
    const current = () => [...daemons].find(([pid]) => isAlive(pid))

    const startDaemon = (
      supervised: boolean,
    ): Effect.Effect<{ readonly pid: number; readonly fiber: Fiber.Fiber<unknown, unknown> }> =>
      Effect.gen(function* () {
        const pid = nextPid++
        const fiber = yield* cli(
          ["daemon", "run"],
          supervised ? { AGENT_PROXY_SUPERVISED: "1" } : {},
          pid,
        ).pipe(Effect.provideContext(services), Effect.forkIn(scope))
        daemons.set(pid, { fiber, supervised })
        return { pid, fiber }
      })
    const stopDaemon = (pid: number) =>
      Effect.suspend(() => {
        const found = daemons.get(pid)
        return found === undefined ? Effect.void : Fiber.interrupt(found.fiber)
      })
    const supervisedPid = () => {
      const running = current()
      return running !== undefined && running[1].supervised
        ? Option.some(running[0])
        : Option.none<number>()
    }

    let plist = Option.none<string>()
    let loaded = false
    const launchd = Launchd.of({
      plistFile: Effect.succeed(`${home}/Library/LaunchAgents/dev.endalk200.agent-proxy.plist`),
      readPlist: Effect.sync(() => plist),
      writePlist: (content) =>
        Effect.sync(() => {
          calls.push("launchd write plist")
          plist = Option.some(content)
        }),
      removePlist: Effect.sync(() => {
        calls.push("launchd remove plist")
        plist = Option.none()
      }),
      bootstrap: Effect.gen(function* () {
        calls.push("launchd bootstrap")
        loaded = true
        // RunAtLoad.
        yield* startDaemon(true)
      }),
      bootout: Effect.gen(function* () {
        calls.push("launchd bootout")
        const pid = supervisedPid()
        if (loaded && Option.isSome(pid)) yield* stopDaemon(pid.value)
        loaded = false
      }),
      kickstart: ({ kill }) =>
        Effect.gen(function* () {
          calls.push(kill ? "launchd kickstart -k" : "launchd kickstart")
          const pid = supervisedPid()
          if (Option.isSome(pid)) {
            if (!kill) return
            yield* stopDaemon(pid.value)
          }
          yield* startDaemon(true)
        }),
      job: Effect.sync(() =>
        loaded ? Option.some({ pid: supervisedPid(), lastExitCode: Option.none() }) : Option.none(),
      ),
    })

    /** The processes as `pid` sees them: the CLI's own, or a daemon's. */
    const processesFor = (pid: number) =>
      Processes.of({
        pid,
        launchSelf: (args, launched) =>
          Effect.gen(function* () {
            calls.push(`launch ${args.slice(0, 2).join(" ")} > ${launched.output}`)
            const started = yield* startDaemon(false)
            return {
              pid: started.pid,
              exitCode: Effect.sync(() => {
                const exit = started.fiber.pollUnsafe()
                return exit === undefined
                  ? Option.none()
                  : Option.some(Exit.isSuccess(exit) ? 0 : 1)
              }),
            }
          }).pipe(Effect.provideContext(services)),
        signal: (target, signal) =>
          Effect.gen(function* () {
            calls.push(`signal ${signal}`)
            yield* stopDaemon(target)
          }),
        isAlive: (target) => Effect.sync(() => isAlive(target)),
      })

    /**
     * Runs `agent-proxy <argv>` in this home as process `pid`, and returns what
     * it printed to stdout.
     */
    const cli = (
      argv: ReadonlyArray<string>,
      extraEnv: Readonly<Record<string, string>> = {},
      pid = 70_000,
    ) =>
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
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord({ ...env, ...extraEnv }),
          ),
          Effect.provideService(RuntimeInfo, runtime),
          Effect.provideService(Processes, processesFor(pid)),
          Effect.provideService(Launchd, launchd),
        )
        return lines.join("\n")
      })

    /** Runs a command that should fail, and returns the message the owner sees. */
    const fails = (argv: ReadonlyArray<string>) =>
      Effect.map(Effect.flip(cli(argv)), (error) =>
        error._tag === "UserError" ? error.userMessage : String(error),
      )

    return {
      root,
      home,
      stateDir,
      calls,
      cli,
      fails,
      plist: () => plist,
      /** The daemon that runs now: its pid, and whether launchd started it. */
      running: () => {
        const found = current()
        return found === undefined
          ? Option.none()
          : Option.some({ pid: found[0], supervised: found[1].supervised })
      },
      /** Unloads the agent behind the CLI's back, as `launchctl bootout` by hand would. */
      unload: Effect.sync(() => {
        loaded = false
      }),
      /** Starts the daemon by hand, as `daemon start` does without the agent. */
      startByHand: cli(["daemon", "start"]),
    }
  })

/** Whether a daemon runs now, and if so whether launchd started it. */
const supervision = (home: {
  readonly running: () => Option.Option<{ readonly supervised: boolean }>
}) =>
  Option.match(home.running(), {
    onNone: () => "stopped",
    onSome: (found) => String(found.supervised),
  })

const STARTED =
  /^agent-proxy daemon started by its launch agent \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+$/

layer(
  Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    ProviderEndpoints.layer,
    Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
  ),
)("agent-proxy daemon install", (it) => {
  it.effect(
    "writes a launch agent that runs the installed binary at login and after a crash, and starts it",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome()
          const output = yield* home.cli(["daemon", "install"])

          const plist = Option.getOrThrow(home.plist())
          expect(plist).toContain("<string>dev.endalk200.agent-proxy</string>")
          expect(plist).toContain(
            `<array>\n\t\t<string>${INSTALLED}</string>\n\t\t<string>daemon</string>\n\t\t<string>run</string>\n\t</array>`,
          )
          expect(plist).toContain("<key>RunAtLoad</key>\n\t<true/>")
          expect(plist).toContain(
            "<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>\n\t</dict>",
          )
          // The supervised daemon resolves the same directories as this shell.
          for (const [name, value] of [
            ["XDG_CONFIG_HOME", `${home.root}/config`],
            ["XDG_STATE_HOME", `${home.root}/state`],
            ["XDG_DATA_HOME", `${home.root}/data`],
            ["AGENT_PROXY_SUPERVISED", "1"],
          ]) {
            expect(plist).toContain(`<key>${name}</key>\n\t\t<string>${value}</string>`)
          }
          expect(plist).not.toContain("AGENT_PROXY_CONFIG")
          expect(plist).toContain(
            `<key>StandardErrorPath</key>\n\t<string>${home.stateDir}/daemon.stderr.log</string>`,
          )

          expect(home.calls).toEqual([
            "launchd bootout",
            "launchd write plist",
            "launchd bootstrap",
          ])
          expect(supervision(home)).toBe("true")
          const lines = output.split("\n")
          expect(lines[0]).toBe(
            "Installed the launch agent ~/Library/LaunchAgents/dev.endalk200.agent-proxy.plist: launchd starts the daemon when you log in, and again if it crashes.",
          )
          expect(lines[1]).toMatch(STARTED)

          const status = JSON.parse(yield* home.cli(["daemon", "status", "--json"]))
          expect(status).toMatchObject({
            running: true,
            launchAgent: {
              installed: true,
              loaded: true,
              pid: Option.getOrThrow(home.running()).pid,
              lastExitCode: null,
            },
          })
        }),
      ),
  )

  it.effect("passes AGENT_PROXY_CONFIG on as an absolute path, since launchd starts in /", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.cli(["daemon", "install"], {
          AGENT_PROXY_CONFIG: `${home.root}/config/agent-proxy/../agent-proxy/config.toml`,
        })
        expect(Option.getOrThrow(home.plist())).toContain(
          `<key>AGENT_PROXY_CONFIG</key>\n\t\t<string>${home.root}/config/agent-proxy/config.toml</string>`,
        )
      }),
    ),
  )

  it.effect("hands a daemon started by hand over to the launch agent", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.startByHand
        const byHand = Option.getOrThrow(home.running())
        expect(byHand.supervised).toBe(false)

        const output = yield* home.cli(["daemon", "install"])
        expect(output).toContain(
          `Stopped the daemon that ran without it (pid ${byHand.pid}), so the launch agent runs it from now on.`,
        )
        expect(supervision(home)).toBe("true")
      }),
    ),
  )

  it.effect("refuses inside a sandbox, where HOME is not the real home, and touches nothing", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome({ realHome: false })
        expect(yield* home.fails(["daemon", "install"])).toBe(
          `\`daemon install\` refuses to run while HOME (${home.home}) is not your home directory (/Users/owner): launchd is not sandboxed, so a verify sandbox must never register a launch agent.`,
        )
        expect(home.calls).toEqual([])
        expect(yield* fs.exists(home.stateDir)).toBe(false)
      }),
    ),
  )

  it.effect("refuses when run from source", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ compiled: false })
        expect(yield* home.fails(["daemon", "install"])).toBe(
          "`daemon install` runs only as the installed binary, not from source. Run `bun run install-local` in the agent-proxy checkout, then `agent-proxy daemon install`.",
        )
        expect(home.calls).toEqual([])
      }),
    ),
  )

  it.effect("says it is not supported on Linux yet, and touches nothing", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ platform: "linux" })
        expect(yield* home.fails(["daemon", "install"])).toBe(
          "`daemon install` is not supported on linux yet: it registers a macOS launch agent. Run the daemon with `agent-proxy daemon start`.",
        )
        expect(home.calls).toEqual([])
      }),
    ),
  )

  it.effect("run again, rewrites the plist and reloads the agent", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.cli(["daemon", "install"])
        home.calls.length = 0
        const output = yield* home.cli(["daemon", "install"])
        // The daemon is stopped with SIGTERM before launchd lets go of it, so
        // it finishes the requests in flight: launchd's own stop is a 20-second kill.
        expect(home.calls).toEqual([
          "signal SIGTERM",
          "launchd bootout",
          "launchd write plist",
          "launchd bootstrap",
        ])
        expect(output).not.toContain("ran without it")
        expect(output.split("\n").at(-1)).toMatch(STARTED)
        expect(supervision(home)).toBe("true")
      }),
    ),
  )
})

layer(
  Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    ProviderEndpoints.layer,
    Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
  ),
)("agent-proxy daemon with the launch agent", (it) => {
  it.effect("start goes through launchd, loading the agent first if it is not loaded", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.cli(["daemon", "install"])
        yield* home.cli(["daemon", "stop"])
        home.calls.length = 0

        expect(yield* home.cli(["daemon", "start"])).toMatch(STARTED)
        expect(home.calls).toEqual(["launchd kickstart"])
        expect(supervision(home)).toBe("true")

        // Unloaded, as after `launchctl bootout` by hand: start loads it again.
        yield* home.cli(["daemon", "stop"])
        yield* home.unload
        home.calls.length = 0
        expect(yield* home.cli(["daemon", "start"])).toMatch(STARTED)
        expect(home.calls).toEqual(["launchd bootstrap"])
      }),
    ),
  )

  it.effect("stop sends SIGTERM, and the daemon stays stopped until it is started again", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.cli(["daemon", "install"])
        const supervised = Option.getOrThrow(home.running())
        home.calls.length = 0

        expect(yield* home.cli(["daemon", "stop"])).toBe(
          `agent-proxy daemon stopped (pid ${supervised.pid}). Its launch agent starts it again at your next login, or with \`agent-proxy daemon start\`.`,
        )
        expect(home.calls).toEqual(["signal SIGTERM"])
        expect(supervision(home)).toBe("stopped")
        const error = yield* home.fails(["daemon", "status"])
        expect(error).toContain("launch agent  loaded, not running")
      }),
    ),
  )

  it.effect("restart stops the supervised daemon and has launchd start it again", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.cli(["daemon", "install"])
        home.calls.length = 0

        expect(yield* home.cli(["daemon", "restart"])).toMatch(
          /^agent-proxy daemon restarted by its launch agent \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+$/,
        )
        expect(home.calls).toEqual(["signal SIGTERM", "launchd kickstart -k"])
        expect(supervision(home)).toBe("true")
      }),
    ),
  )

  it.effect("restart without the agent stops the daemon and starts it again by hand", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ realHome: false })
        yield* home.startByHand
        home.calls.length = 0

        expect(yield* home.cli(["daemon", "restart"])).toMatch(
          /^agent-proxy daemon restarted \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+$/,
        )
        expect(home.calls).toEqual([
          "signal SIGTERM",
          `launch daemon run > ${home.stateDir}/daemon.stderr.log`,
        ])
        expect(supervision(home)).toBe("false")
      }),
    ),
  )

  it.effect("restart with no daemon running starts one", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ realHome: false })
        expect(yield* home.cli(["daemon", "restart"])).toMatch(/^agent-proxy daemon started \(pid/)
        expect(supervision(home)).toBe("false")
      }),
    ),
  )

  it.effect("a sandbox never consults launchd, even when its HOME holds a launch agent", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ realHome: false })
        yield* home.startByHand
        yield* home.cli(["daemon", "stop"])
        yield* Effect.flip(home.cli(["daemon", "status"]))
        expect(home.calls.filter((call) => call.startsWith("launchd"))).toEqual([])
      }),
    ),
  )

  it.effect("uninstall stops the supervised daemon and removes the agent", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.cli(["daemon", "install"])
        home.calls.length = 0

        expect(yield* home.cli(["daemon", "uninstall"])).toBe(
          "Removed the launch agent and stopped the daemon it ran. Run it by hand with `agent-proxy daemon start`.",
        )
        expect(home.calls).toEqual(["launchd bootout", "launchd remove plist"])
        expect(home.plist()).toStrictEqual(Option.none())
        expect(supervision(home)).toBe("stopped")
        expect(yield* home.fails(["daemon", "status"])).toContain("launch agent  not installed")
      }),
    ),
  )

  it.effect("uninstall with no agent installed says so, and succeeds", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        expect(yield* home.cli(["daemon", "uninstall"])).toBe(
          "The launch agent is not installed; nothing to remove.",
        )
        expect(home.calls).toEqual([])
      }),
    ),
  )
})
