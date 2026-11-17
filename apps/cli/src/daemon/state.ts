import { Data, Effect, FileSystem, Option, Schema } from "effect"

import { Processes } from "../processes.ts"

/**
 * The daemon's files in its state directory (ADR-0002):
 *
 * - `daemon.lock` holds the pid of the one daemon allowed per directory.
 * - `daemon.json`, the state file, tells the CLI where the running daemon listens.
 * - `daemon.log` holds its logs, one JSON object per line.
 */
export const stateFiles = (stateDir: string) => ({
  lock: `${stateDir}/daemon.lock`,
  state: `${stateDir}/daemon.json`,
  log: `${stateDir}/daemon.log`,
})

export const StateFile = Schema.Struct({
  pid: Schema.Int,
  /** The port the daemon actually bound, even when the config asked for port 0. */
  port: Schema.Int,
  /** The base URL clients on this machine reach the daemon at. */
  address: Schema.String,
})
export type StateFile = typeof StateFile.Type

const StateFileJson = Schema.fromJsonString(StateFile)

export class DaemonAlreadyRunning extends Data.TaggedError("DaemonAlreadyRunning")<{
  readonly pid: number
  readonly stateDir: string
}> {
  override get message() {
    return `Another agent-proxy daemon (pid ${this.pid}) is already running for ${this.stateDir}.`
  }
}

/** The pid recorded in the lock file, if it holds one. */
const lockHolder = (lockFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(lockFile).pipe(Effect.option)
    return Option.flatMap(text, (content) => {
      const pid = Number.parseInt(content.trim(), 10)
      return Number.isSafeInteger(pid) && pid > 0 ? Option.some(pid) : Option.none()
    })
  })

/**
 * Takes the state directory's lock for `pid` until the scope closes.
 *
 * The lock file is created exclusively. A lock whose process no longer exists
 * was left by a daemon that crashed, and is taken over.
 */
export const acquireLock = Effect.fn("acquireLock")(function* (stateDir: string, pid: number) {
  const fs = yield* FileSystem.FileSystem
  const processes = yield* Processes
  const { lock } = stateFiles(stateDir)

  const tryCreate = fs.writeFileString(lock, `${pid}\n`, { flag: "wx", mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () => Effect.succeed(false),
    ),
  )

  if (!(yield* tryCreate)) {
    const holder = yield* lockHolder(lock)
    if (Option.isSome(holder) && (yield* processes.isAlive(holder.value))) {
      return yield* new DaemonAlreadyRunning({ pid: holder.value, stateDir })
    }
    yield* fs.remove(lock, { force: true })
    if (!(yield* tryCreate)) {
      const winner = yield* lockHolder(lock)
      return yield* new DaemonAlreadyRunning({ pid: Option.getOrElse(winner, () => 0), stateDir })
    }
  }

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Release only a lock that is still ours.
      const holder = yield* lockHolder(lock)
      if (Option.contains(holder, pid)) {
        yield* fs.remove(lock, { force: true })
      }
    }).pipe(Effect.ignore),
  )
})

/** Replaces the state file atomically, so a reader never sees half of it. */
export const writeStateFile = Effect.fn("writeStateFile")(function* (
  stateDir: string,
  state: StateFile,
) {
  const fs = yield* FileSystem.FileSystem
  const { state: target } = stateFiles(stateDir)
  const temp = `${target}.${state.pid}.tmp`
  yield* fs.writeFileString(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  yield* fs.rename(temp, target)
})

export const removeStateFile = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(stateFiles(stateDir).state, { force: true })
  })

/** The state file's contents, or `None` when there is no readable state file. */
export const readStateFile = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(stateFiles(stateDir).state).pipe(Effect.option)
    if (Option.isNone(text)) {
      return Option.none<StateFile>()
    }
    return yield* Schema.decodeEffect(StateFileJson)(text.value).pipe(Effect.option)
  })
