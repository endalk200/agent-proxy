import { appendFileSync, renameSync, statSync } from "node:fs"

import { Context, Effect, Logger } from "effect"

/**
 * The daemon's log file, one JSON object per line, rotated by the daemon
 * itself: once it reaches the limit it becomes `<file>.1`, replacing the one
 * before, so the logs never hold more than about twice the limit. The daemon
 * logs no request, so the limit holds a long history; rotation is a safety
 * net, not routine.
 */

/** How large the log may grow before it is rotated: 10 MB. */
export const LogFileLimit = Context.Reference<number>("agent-proxy/LogFileLimit", {
  defaultValue: () => 10 * 1024 * 1024,
})

const sizeOf = (file: string) => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/**
 * A logger appending to `file`, and `rotateIfFull`, which the daemon runs once
 * it holds its lock, so a daemon that is refused never rotates the log of the
 * one that runs. Each line is written at once, so a crash loses nothing logged
 * before it.
 */
export const openLogFile = Effect.fn("openLogFile")(function* (file: string) {
  const limit = yield* LogFileLimit
  const rotateIfFull = () => {
    if (sizeOf(file) < limit) return
    try {
      renameSync(file, `${file}.1`)
    } catch {
      // A log that cannot be rotated keeps growing rather than stopping the daemon.
    }
  }
  const logger = Logger.map(Logger.formatJson, (line) => {
    try {
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch {
      // A log that cannot be written never takes the daemon down.
      return
    }
    rotateIfFull()
  })
  return { logger, rotateIfFull: Effect.sync(rotateIfFull) }
})
