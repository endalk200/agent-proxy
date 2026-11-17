import { Console, Effect, FileSystem, Option, References, Schedule, Schema } from "effect"
import { CliError, Command, Flag } from "effect/cli"

import { loadConfigFile } from "../config.ts"
import { fetchDaemonInfo, isHealthy, type DaemonInfo } from "../daemon/client.ts"
import { startDaemon } from "../daemon/daemon.ts"
import { readStateFile, stateFiles } from "../daemon/state.ts"
import { resolveStateDir } from "../paths.ts"
import { Processes } from "../processes.ts"

/** Shows an error's own message to the user, without a stack trace. */
const asUserError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message })

const userError = (userMessage: string) => new CliError.UserError({ cause: undefined, userMessage })

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

const formatStatus = (info: DaemonInfo, options: { readonly json: boolean }) =>
  options.json
    ? JSON.stringify(info, null, 2)
    : [
        "agent-proxy daemon is running",
        `pid      ${info.pid}`,
        `address  ${info.address}`,
        `uptime   ${formatUptime(info.uptimeSeconds)}`,
        `version  ${info.version}`,
      ].join("\n")

const run = Command.make(
  "run",
  {},
  Effect.fn("daemon.run")(function* () {
    const daemon = yield* startDaemon.pipe(Effect.mapError(asUserError))
    yield* Console.log(`agent-proxy daemon listening on ${daemon.address} (pid ${daemon.pid})`)
    return yield* Effect.never
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "Run the daemon in the foreground until it receives SIGTERM or SIGINT; logs go to the state directory",
  ),
)

/** How long `start` waits for a launched daemon to answer /healthz. */
const READY_TIMEOUT_TRIES = 100
const POLL = Schedule.spaced("100 millis")

const LogLine = Schema.fromJsonString(
  Schema.Struct({
    level: Schema.String,
    annotations: Schema.Struct({ error: Schema.optionalKey(Schema.String) }),
  }),
)

/** The `error` of the last ERROR line in the daemon's log, if any. */
const lastLoggedError = (logFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(logFile).pipe(Effect.orElseSucceed(() => ""))
    const lines = text.trim().split("\n").toReversed()
    for (const line of lines) {
      const entry = Schema.decodeOption(LogLine)(line)
      if (Option.isSome(entry) && entry.value.level === "ERROR" && entry.value.annotations.error) {
        return Option.some(entry.value.annotations.error)
      }
    }
    return Option.none<string>()
  })

const start = Command.make(
  "start",
  {},
  Effect.fn("daemon.start")(function* () {
    const processes = yield* Processes
    const stateDir = yield* resolveStateDir.pipe(Effect.mapError(asUserError))
    const logFile = stateFiles(stateDir).log

    // Fail here, in the user's terminal, rather than in a background process.
    yield* loadConfigFile.pipe(Effect.mapError(asUserError))
    const existing = yield* fetchDaemonInfo.pipe(
      Effect.asSome,
      Effect.catchTag("DaemonNotRunning", () => Effect.succeedNone),
      Effect.mapError(asUserError),
    )
    if (Option.isSome(existing)) {
      return yield* userError(
        `The agent-proxy daemon is already running (pid ${existing.value.pid}) at ${existing.value.address}.`,
      )
    }

    const level = yield* References.MinimumLogLevel
    const child = yield* processes
      .launchSelf(["daemon", "run", "--log-level", level.toLowerCase()])
      .pipe(Effect.mapError(asUserError))

    // Ready means the launched daemon wrote the state file and answers /healthz.
    const poll = Effect.gen(function* () {
      const exitCode = yield* child.exitCode
      if (Option.isSome(exitCode)) {
        const reason = yield* lastLoggedError(logFile)
        return yield* userError(
          Option.match(reason, {
            onNone: () =>
              `The daemon exited during startup (exit code ${exitCode.value}). See ${logFile}.`,
            onSome: (error) => `The daemon could not start: ${error}`,
          }),
        )
      }
      const state = yield* readStateFile(stateDir)
      if (
        Option.isSome(state) &&
        state.value.pid === child.pid &&
        (yield* isHealthy(state.value.address))
      ) {
        return Option.some(state.value)
      }
      return Option.none()
    })
    const ready = yield* poll.pipe(
      Effect.repeat({ schedule: POLL, until: Option.isSome, times: READY_TIMEOUT_TRIES }),
    )
    if (Option.isNone(ready)) {
      return yield* userError(
        `The daemon (pid ${child.pid}) did not become ready within 10 seconds. See ${logFile}.`,
      )
    }
    yield* Console.log(
      `agent-proxy daemon started (pid ${ready.value.pid}) at ${ready.value.address}`,
    )
  }),
).pipe(Command.withDescription("Start the daemon in the background and wait until it is ready"))

/** How long `stop` waits for the daemon to exit after SIGTERM. */
const STOP_TIMEOUT_TRIES = 150

const stop = Command.make(
  "stop",
  {},
  Effect.fn("daemon.stop")(function* () {
    const processes = yield* Processes
    // The pid comes from the daemon itself, never only from a possibly stale state file.
    const info = yield* fetchDaemonInfo.pipe(Effect.mapError(asUserError))
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
    yield* Console.log(`agent-proxy daemon stopped (pid ${info.pid})`)
  }),
).pipe(Command.withDescription("Stop the running daemon with SIGTERM and wait for it to exit"))

const status = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print machine-readable JSON"),
    ),
  },
  Effect.fn("daemon.status")(function* ({ json }) {
    const info = yield* fetchDaemonInfo.pipe(Effect.mapError(asUserError))
    yield* Console.log(formatStatus(info, { json }))
  }),
).pipe(Command.withDescription("Show the running daemon's pid, address, and uptime"))

export const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Run, start, stop, and inspect the agent-proxy daemon"),
  Command.withSubcommands([run, start, stop, status]),
)
