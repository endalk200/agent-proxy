import { readFileSync, statSync } from "node:fs"

import {
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Path,
  References,
  Schedule,
  Schema,
} from "effect"
import { Command, Flag } from "effect/cli"

import { loadConfigFile } from "../config.ts"
import { type DaemonInfo, fetchDaemonInfo, isHealthy } from "../daemon/client.ts"
import { startDaemon } from "../daemon/daemon.ts"
import { lockedBy, readStateFile, stateFiles } from "../daemon/state.ts"
import { isSupervised, Launchd, plist, SUPERVISED_VARIABLE } from "../launchd.ts"
import { displayPath, resolveStateDir } from "../paths.ts"
import { type LaunchedProcess, Processes } from "../processes.ts"
import { RuntimeInfo } from "../runtime-info.ts"
import { asUserError, ExitCode, userError } from "./errors.ts"

/** `45s`, `3m 12s`, `2h 5m`, `3d 4h`: the two largest units. */
export const formatUptime = (totalSeconds: number): string => {
  const units: ReadonlyArray<readonly [string, number]> = [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ]
  let rest = Math.max(0, Math.floor(totalSeconds))
  const parts: Array<string> = []
  for (const [unit, size] of units) {
    const count = Math.floor(rest / size)
    rest -= count * size
    if (count > 0 || (unit === "s" && parts.length === 0)) parts.push(`${count}${unit}`)
  }
  return parts.slice(0, 2).join(" ")
}

/** The daemon's state directory and the files in it. */
const daemonFiles = resolveStateDir.pipe(
  Effect.map((dir) => ({ dir, ...stateFiles(dir) })),
  Effect.mapError(asUserError),
)

// The launch agent (ADR-0008).

/**
 * True when this environment may reach the launch agent: on macOS, with
 * `HOME` the account's real home. `launchctl` acts on the real launchd
 * whatever `HOME` says, so a verify sandbox (ADR-0001) never reaches it.
 */
/** `HOME`, the real home from the OS user record, and whether they are the same directory. */
export const homes = Effect.gen(function* () {
  const runtime = yield* RuntimeInfo
  const path = yield* Path.Path
  const home = yield* Config.option(Config.NonEmptyString("HOME")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  const real = runtime.realHome
  const same =
    Option.isSome(home) &&
    Option.isSome(real) &&
    path.resolve(home.value) === path.resolve(real.value)
  return { home, real, same }
})

const agentReachable = Effect.gen(function* () {
  const runtime = yield* RuntimeInfo
  return runtime.platform === "darwin" && (yield* homes).same
})

/** The launch agent as `daemon status` reports it. */
export type AgentState =
  | { readonly installed: false }
  | { readonly installed: true; readonly loaded: false }
  | {
      readonly installed: true
      readonly loaded: true
      readonly pid: number | null
      readonly lastExitCode: number | null
    }

const agentState = Effect.gen(function* () {
  const notInstalled: AgentState = { installed: false }
  if (!(yield* agentReachable)) return notInstalled
  const launchd = yield* Launchd
  if (Option.isNone(yield* launchd.readPlist)) return notInstalled
  const state: AgentState = Option.match(yield* launchd.job, {
    onNone: () => ({ installed: true, loaded: false }),
    onSome: (job) => ({
      installed: true,
      loaded: true,
      pid: Option.getOrNull(job.pid),
      lastExitCode: Option.getOrNull(job.lastExitCode),
    }),
  })
  return state
}).pipe(Effect.mapError(asUserError))

const describeAgent = (state: AgentState) => {
  if (!state.installed) return "not installed"
  if (!state.loaded) return "installed, not loaded"
  if (state.pid !== null) return `loaded, running (pid ${state.pid})`
  return state.lastExitCode === null
    ? "loaded, not running"
    : `loaded, not running (last exit code ${state.lastExitCode})`
}

// The log.

const LogLine = Schema.fromJsonString(
  Schema.Struct({
    level: Schema.String,
    annotations: Schema.Struct({ error: Schema.optionalKey(Schema.String) }),
  }),
)

/** The `error` of the last ERROR line in `text`, one log entry per line. */
const lastError = (text: string) => {
  for (const line of text.trim().split("\n").toReversed()) {
    const entry = Schema.decodeOption(LogLine)(line)
    if (Option.isSome(entry) && entry.value.level === "ERROR" && entry.value.annotations.error) {
      return Option.some(entry.value.annotations.error)
    }
  }
  return Option.none<string>()
}

const logSize = (logFile: string) =>
  Effect.sync(() => {
    try {
      return statSync(logFile).size
    } catch {
      return 0
    }
  })

/** The bytes of `file` from `offset` on, as text; "" when it cannot be read. */
const readFrom = (file: string, offset: number) => {
  try {
    return readFileSync(file).subarray(offset).toString("utf8")
  } catch {
    return ""
  }
}

/**
 * The last error logged after the log was `offset` bytes long. A log that is
 * shorter now was rotated since: what followed `offset` is then in
 * `daemon.log.1`, and anything in the new log came after it.
 */
const errorLoggedSince = (logFile: string, offset: number) =>
  Effect.gen(function* () {
    if ((yield* logSize(logFile)) >= offset) return lastError(readFrom(logFile, offset))
    return Option.orElse(lastError(readFrom(logFile, 0)), () =>
      lastError(readFrom(`${logFile}.1`, offset)),
    )
  })

/** The last error the daemon logged, looking in the older log when the current one has none. */
const lastLoggedError = (logFile: string) =>
  Effect.sync(() =>
    Option.orElse(lastError(readFrom(logFile, 0)), () => lastError(readFrom(`${logFile}.1`, 0))),
  )

// Starting and stopping.

const POLL = Schedule.spaced("100 millis")
/** How long `start` waits for a launched daemon to answer /healthz: 10 seconds. */
const READY_TIMEOUT_TRIES = 100
/** How long `stop` waits for the daemon to exit after SIGTERM: 15 seconds. */
const STOP_TIMEOUT_TRIES = 150

/**
 * Waits until a daemon has written the state file and answers `/healthz`:
 * `launched`'s when this CLI launched it, else any but `previous`. Fails at
 * once when `launched` exits or the daemon logs an error after `logOffset`.
 */
const awaitReady = (options: {
  readonly launched: Option.Option<LaunchedProcess>
  readonly previous: Option.Option<number>
  readonly logOffset: number
}) =>
  Effect.gen(function* () {
    const files = yield* daemonFiles
    const poll = Effect.gen(function* () {
      if (Option.isSome(options.launched)) {
        const exitCode = yield* options.launched.value.exitCode
        if (Option.isSome(exitCode)) {
          const reason = yield* errorLoggedSince(files.log, options.logOffset)
          return yield* userError(
            Option.match(reason, {
              onNone: () =>
                `The daemon exited during startup (exit code ${exitCode.value}). See ${files.log} and ${files.stderr}.`,
              onSome: (error) => `The daemon could not start: ${error}`,
            }),
          )
        }
      } else {
        const reason = yield* errorLoggedSince(files.log, options.logOffset)
        if (Option.isSome(reason)) {
          return yield* userError(`The daemon could not start: ${reason.value}`)
        }
      }
      const state = yield* readStateFile(files.dir)
      const ours = Option.filter(state, (found) =>
        Option.match(options.launched, {
          onSome: (launched) => found.pid === launched.pid,
          onNone: () => !Option.contains(options.previous, found.pid),
        }),
      )
      if (Option.isSome(ours) && (yield* isHealthy(ours.value.address))) return ours
      return Option.none()
    })
    const ready = yield* poll.pipe(
      Effect.repeat({ schedule: POLL, until: Option.isSome, times: READY_TIMEOUT_TRIES }),
    )
    if (Option.isNone(ready)) {
      return yield* userError(
        `The daemon did not become ready within 10 seconds. See ${files.log} and ${files.stderr}.`,
      )
    }
    return ready.value
  })

/** The running daemon, if one answers. */
const runningDaemon = fetchDaemonInfo.pipe(
  Effect.asSome,
  Effect.catchTag("DaemonNotRunning", () => Effect.succeedNone),
  Effect.mapError(asUserError),
)

/** Stops `info`'s daemon with SIGTERM and waits for it to exit. */
const stopDaemon = (info: DaemonInfo) =>
  Effect.gen(function* () {
    const processes = yield* Processes
    yield* processes.signal(info.pid, "SIGTERM").pipe(Effect.mapError(asUserError))
    const exited = yield* processes.isAlive(info.pid).pipe(
      Effect.repeat({ schedule: POLL, until: (alive) => !alive, times: STOP_TIMEOUT_TRIES }),
      Effect.map((alive) => !alive),
    )
    if (!exited) {
      return yield* userError(
        `The daemon (pid ${info.pid}) is still running 15 seconds after SIGTERM.`,
      )
    }
  })

/**
 * Fails when a daemon holds the state directory's lock but does not answer,
 * paused or wedged: nothing can stop it through its API, and acting as if it
 * were gone would leave it running.
 */
export const ensureNoSilentDaemon = (doing: string) =>
  Effect.gen(function* () {
    const files = yield* daemonFiles
    const holder = yield* lockedBy(files.dir)
    if (Option.isNone(holder) || Option.isSome(yield* runningDaemon)) return
    const pid = Option.getOrUndefined(holder.value)
    return yield* userError(
      pid === undefined
        ? `A daemon holds the lock in ${files.dir} but does not answer, so ${doing}. Stop it, then run this again.`
        : `The daemon (pid ${pid}) holds its lock but does not answer, so ${doing}. Stop it with \`kill ${pid}\`, then run this again.`,
    )
  })

/** Stops the running daemon, if one answers, and returns its pid. */
export const stopRunningDaemon = Effect.gen(function* () {
  const running = yield* runningDaemon
  if (Option.isSome(running)) yield* stopDaemon(running.value)
  return Option.map(running, (info) => info.pid)
})

/**
 * Starts the daemon, through launchd when the launch agent is installed, and
 * waits until it is ready. `kill` stops a supervised daemon that runs but no
 * longer answers. `previous` is the daemon this one replaces.
 */
const launch = (options: { readonly kill: boolean; readonly previous: Option.Option<number> }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const processes = yield* Processes
    const files = yield* daemonFiles
    const logOffset = yield* logSize(files.log)
    if ((yield* agentState).installed) {
      const launchd = yield* Launchd
      const loaded = Option.isSome(yield* launchd.job.pipe(Effect.mapError(asUserError)))
      yield* (loaded ? launchd.kickstart({ kill: options.kill }) : launchd.bootstrap).pipe(
        Effect.mapError(asUserError),
      )
      const ready = yield* awaitReady({
        launched: Option.none(),
        previous: options.previous,
        logOffset,
      })
      return { ...ready, supervised: true }
    }
    yield* fs
      .makeDirectory(files.dir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(asUserError))
    const level = yield* References.MinimumLogLevel
    const child = yield* processes
      .launchSelf(["daemon", "run", "--log-level", level.toLowerCase()], { output: files.stderr })
      .pipe(Effect.mapError(asUserError))
    const ready = yield* awaitReady({
      launched: Option.some(child),
      previous: options.previous,
      logOffset,
    })
    return { ...ready, supervised: false }
  })

const startedLine = (
  verb: string,
  ready: { readonly pid: number; readonly address: string; readonly supervised: boolean },
) =>
  `agent-proxy daemon ${verb}${ready.supervised ? " by its launch agent" : ""} (pid ${ready.pid}) at ${ready.address}`

// The commands.

const run = Command.make(
  "run",
  {},
  Effect.fn("daemon.run")(function* () {
    const supervised = yield* isSupervised.pipe(Effect.orElseSucceed(() => false))
    const started = yield* startDaemon.pipe(
      Effect.asSome,
      // Under launchd, a daemon the owner started by hand already serves:
      // exiting 0 keeps launchd from retrying this one every few seconds.
      Effect.catchTag("DaemonAlreadyRunning", (error) =>
        supervised
          ? Console.log(`${error.message} Exiting, so launchd does not run this one again.`).pipe(
              Effect.as(Option.none()),
            )
          : Effect.fail(error),
      ),
      Effect.mapError(asUserError),
    )
    if (Option.isNone(started)) return
    yield* Console.log(
      `agent-proxy daemon listening on ${started.value.address} (pid ${started.value.pid})`,
    )
    return yield* Effect.never
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "Run the daemon in the foreground until it receives SIGTERM or SIGINT; logs go to the state directory",
  ),
)

const start = Command.make(
  "start",
  {},
  Effect.fn("daemon.start")(function* () {
    // Fail here, in the user's terminal, rather than in a background process.
    yield* loadConfigFile.pipe(Effect.mapError(asUserError))
    const existing = yield* runningDaemon
    if (Option.isSome(existing)) {
      return yield* userError(
        `The agent-proxy daemon is already running (pid ${existing.value.pid}) at ${existing.value.address}.`,
      )
    }
    const ready = yield* launch({ kill: false, previous: Option.none() })
    yield* Console.log(startedLine("started", ready))
  }),
).pipe(
  Command.withDescription(
    "Start the daemon in the background, through its launch agent when installed, and wait until it is ready",
  ),
)

const stop = Command.make(
  "stop",
  {},
  Effect.fn("daemon.stop")(function* () {
    // The pid comes from the daemon itself, never only from a possibly stale state file.
    const info = yield* fetchDaemonInfo.pipe(Effect.mapError(asUserError))
    yield* stopDaemon(info)
    // A clean exit is not restarted, so it stays stopped until the next start or login.
    const supervised = (yield* agentState).installed
    yield* Console.log(
      `agent-proxy daemon stopped (pid ${info.pid})${supervised ? ". Its launch agent starts it again at your next login, or with `agent-proxy daemon start`." : ""}`,
    )
  }),
).pipe(Command.withDescription("Stop the running daemon with SIGTERM and wait for it to exit"))

const restart = Command.make(
  "restart",
  {},
  Effect.fn("daemon.restart")(function* () {
    yield* loadConfigFile.pipe(Effect.mapError(asUserError))
    const previous = yield* stopRunningDaemon
    const ready = yield* launch({ kill: true, previous })
    yield* Console.log(startedLine(Option.isSome(previous) ? "restarted" : "started", ready))
  }),
).pipe(
  Command.withDescription(
    "Stop the running daemon, if one runs, and start it again, through its launch agent when installed",
  ),
)

const status = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print machine-readable JSON"),
    ),
  },
  Effect.fn("daemon.status")(function* ({ json }) {
    const files = yield* daemonFiles
    const running = yield* fetchDaemonInfo.pipe(
      Effect.asSome,
      Effect.catchTag("DaemonNotRunning", () => Effect.succeedNone),
      Effect.mapError(asUserError),
    )
    const launchAgent = yield* agentState
    if (Option.isSome(running)) {
      const info = running.value
      const build = info.build ?? "unknown"
      return yield* Console.log(
        json
          ? JSON.stringify({ running: true, ...info, build, logs: files.log, launchAgent }, null, 2)
          : [
              "agent-proxy daemon is running",
              `pid      ${info.pid}`,
              `address  ${info.address}`,
              `uptime   ${formatUptime(info.uptimeSeconds)}`,
              `version  ${info.version} (${build})`,
              `logs     ${yield* displayPath(files.log)}`,
            ].join("\n"),
      )
    }

    const error = yield* lastLoggedError(files.log)
    if (json) {
      yield* Console.log(
        JSON.stringify(
          { running: false, logs: files.log, launchAgent, lastError: Option.getOrNull(error) },
          null,
          2,
        ),
      )
      return yield* new ExitCode({ code: 1 })
    }
    return yield* userError(
      [
        "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`.",
        `logs          ${yield* displayPath(files.log)}`,
        `launch agent  ${describeAgent(launchAgent)}`,
        ...Option.match(error, {
          onNone: () => [],
          onSome: (message) => [`last error    ${message}`],
        }),
      ].join("\n"),
    )
  }),
).pipe(
  Command.withDescription(
    "Show the running daemon's pid, address and uptime, or why it is not running",
  ),
)

/** The variables that decide where agent-proxy keeps its files, which the supervised daemon must share. */
const DIRECTORY_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "AGENT_PROXY_CONFIG",
] as const

const install = Command.make(
  "install",
  {},
  Effect.fn("daemon.install")(function* () {
    const runtime = yield* RuntimeInfo
    const path = yield* Path.Path
    const launchd = yield* Launchd
    if (Option.isNone(runtime.binary)) {
      return yield* userError(
        "`daemon install` runs only as the installed binary, not from source. Run `bun run install-local` in the agent-proxy checkout, then `agent-proxy daemon install`.",
      )
    }
    const { home, real, same } = yield* homes
    if (!same) {
      return yield* userError(
        `\`daemon install\` refuses to run while HOME (${Option.getOrElse(home, () => "unset")}) is not your home directory (${Option.getOrElse(real, () => "unknown: the OS user record could not be read")}): launchd is not sandboxed, so a verify sandbox must never register a launch agent.`,
      )
    }
    if (runtime.platform !== "darwin") {
      return yield* userError(
        `\`daemon install\` is not supported on ${runtime.platform} yet: it registers a macOS launch agent. Run the daemon with \`agent-proxy daemon start\`.`,
      )
    }

    // Fail here, rather than in a daemon launchd keeps restarting.
    yield* loadConfigFile.pipe(Effect.mapError(asUserError))
    const files = yield* daemonFiles
    const fs = yield* FileSystem.FileSystem
    yield* fs
      .makeDirectory(files.dir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(asUserError))

    // launchd starts the daemon in `/`, so a relative path is resolved here.
    const environment: Record<string, string> = {}
    for (const name of DIRECTORY_VARIABLES) {
      const value = yield* Config.option(Config.NonEmptyString(name)).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )
      if (Option.isSome(value)) environment[name] = path.resolve(value.value)
    }
    environment[SUPERVISED_VARIABLE] = "1"

    // Installing again reloads the agent, which repoints it after the binary moves.
    yield* launchd.bootout.pipe(Effect.mapError(asUserError))
    const handedOver = yield* stopRunningDaemon
    const logOffset = yield* logSize(files.log)
    yield* launchd
      .writePlist(plist({ program: runtime.binary.value.path, environment, output: files.stderr }))
      .pipe(Effect.mapError(asUserError))
    yield* launchd.bootstrap.pipe(Effect.mapError(asUserError))

    const plistFile = yield* launchd.plistFile.pipe(Effect.mapError(asUserError))
    yield* Console.log(
      `Installed the launch agent ${yield* displayPath(plistFile)}: launchd starts the daemon when you log in, and again if it crashes.`,
    )
    if (Option.isSome(handedOver)) {
      yield* Console.log(
        `Stopped the daemon that ran without it (pid ${handedOver.value}), so the launch agent runs it from now on.`,
      )
    }
    const ready = yield* awaitReady({ launched: Option.none(), previous: handedOver, logOffset })
    yield* Console.log(startedLine("started", { ...ready, supervised: true }))
  }),
).pipe(
  Command.withDescription(
    "Register the daemon with launchd (macOS): it starts at login and restarts after a crash",
  ),
)

/** Removes the launch agent, stopping the daemon it runs; false when it was not installed. */
export const removeLaunchAgent = Effect.gen(function* () {
  if (!(yield* agentState).installed) return false
  const launchd = yield* Launchd
  yield* launchd.bootout.pipe(Effect.mapError(asUserError))
  yield* launchd.removePlist.pipe(Effect.mapError(asUserError))
  return true
})

const uninstall = Command.make(
  "uninstall",
  {},
  Effect.fn("daemon.uninstall")(function* () {
    if (!(yield* removeLaunchAgent)) {
      return yield* Console.log("The launch agent is not installed; nothing to remove.")
    }
    yield* Console.log(
      "Removed the launch agent and stopped the daemon it ran. Run it by hand with `agent-proxy daemon start`.",
    )
  }),
).pipe(
  Command.withDescription("Stop the daemon and remove its launch agent, to run it by hand again"),
)

export const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Run, start, stop, supervise, and inspect the agent-proxy daemon"),
  Command.withSubcommands([run, start, stop, restart, status, install, uninstall]),
)
