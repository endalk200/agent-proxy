import { dlopen, FFIType } from "bun:ffi"
import { closeSync, constants, ftruncateSync, openSync, writeSync } from "node:fs"

import { Data, Effect, FileSystem, Option, Schema } from "effect"

/**
 * The daemon's files in its state directory (ADR-0002):
 *
 * - `daemon.lock` is held with `flock(2)` by the one daemon allowed per directory,
 *   and records its pid while held.
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

export class LockFileError extends Data.TaggedError("LockFileError")<{
  readonly lockFile: string
  readonly cause: unknown
}> {
  override get message() {
    return `Could not lock ${this.lockFile}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

const LOCK_EX = 2
const LOCK_NB = 4

let libc:
  | { readonly symbols: { readonly flock: (fd: number, operation: number) => number } }
  | undefined

/**
 * `flock(2)`, non-blocking and exclusive: true when this process now holds the lock.
 *
 * A kernel lock, not a pid in a file: the OS releases it the moment its holder
 * dies, however it dies, so a crash never leaves a lock behind, a reused pid
 * never looks like a live daemon, and two starters can never both take over.
 */
const tryFlock = (fd: number) => {
  libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  return libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0
}

/**
 * Takes the state directory's lock for `pid` until the scope closes.
 *
 * The lock file stays in place: deleting a flock'd file would let a second
 * daemon lock a new file of the same name. While held, it records the holder's pid.
 */
export const acquireLock = Effect.fn("acquireLock")(function* (stateDir: string, pid: number) {
  const { lock } = stateFiles(stateDir)

  const fd = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openSync(lock, constants.O_RDWR | constants.O_CREAT, 0o600),
      catch: (cause) => new LockFileError({ lockFile: lock, cause }),
    }),
    (descriptor) => Effect.sync(() => closeSync(descriptor)),
  )

  if (!tryFlock(fd)) {
    const holder = yield* lockHolder(lock)
    return yield* new DaemonAlreadyRunning({ pid: Option.getOrElse(holder, () => 0), stateDir })
  }

  yield* Effect.try({
    try: () => {
      ftruncateSync(fd, 0)
      writeSync(fd, `${pid}\n`, 0)
    },
    catch: (cause) => new LockFileError({ lockFile: lock, cause }),
  })

  // Runs before the descriptor closes, which releases the lock: clear the pid
  // so the file never names a daemon that is gone.
  yield* Effect.addFinalizer(() => Effect.sync(() => ftruncateSync(fd, 0)).pipe(Effect.ignore))
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
