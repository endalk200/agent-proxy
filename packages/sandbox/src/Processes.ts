import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { createServer } from "node:net"

import { Data, Effect, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { ProcessRecord } from "./Runs.ts"

/**
 * Background processes that outlive the `verify` command that started them.
 *
 * They run detached in their own process group so `stop` can signal the whole
 * group, and they are only ever stopped by recorded pid after checking the pid
 * still belongs to the command we started (pids get reused).
 */

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Asks the OS for a free TCP port on loopback. */
export const freePort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        const port = typeof address === "object" && address !== null ? address.port : 0
        server.close(() => resolve(port))
      })
    }),
  catch: (cause) => new ProcessError({ message: "Could not allocate a free port", cause }),
})

/** Starts `command` detached, appending stdout and stderr to `log`. Returns its pid. */
export const startDetached = (options: {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly log: string
}) =>
  Effect.try({
    try: () => {
      const fd = openSync(options.log, "a")
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", fd, fd],
      })
      closeSync(fd)
      child.unref()
      if (child.pid === undefined) {
        throw new Error(`spawn returned no pid for ${options.command}`)
      }
      return child.pid
    },
    catch: (cause) =>
      new ProcessError({
        message: `Could not start ${options.command} ${options.args.join(" ")}`,
        cause,
      }),
  })

/** Sends `signal` to `pid` (negative: the whole process group). */
const signal = (pid: number, name: NodeJS.Signals | 0) =>
  Effect.try({
    try: () => process.kill(pid, name),
    catch: (cause) => new ProcessError({ message: `Could not signal ${pid}`, cause }),
  })

const isAlive = (pid: number) =>
  signal(pid, 0).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** The command line the OS reports for `pid`, or "" when there is no such process. */
const commandLine = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner.string(
      ChildProcess.make("ps", ["-o", "command=", "-p", String(pid)]),
    )
    return output.trim()
  }).pipe(Effect.orElseSucceed(() => ""))

/**
 * True when `record.pid` is alive and runs exactly the command we recorded
 * starting. The recorded command includes the port, so a reused pid running
 * anything else does not match.
 */
export const isOwned = (record: ProcessRecord) =>
  Effect.gen(function* () {
    if (!(yield* isAlive(record.pid))) {
      return false
    }
    return (yield* commandLine(record.pid)) === record.command.join(" ")
  })

/** True while any process remains in the group `record.pid` leads. */
const isGroupAlive = (pid: number) => isAlive(-pid)

export type StopOutcome = "stopped" | "already-stopped" | "not-ours"

const waitForGroupExit = (pid: number) =>
  isGroupAlive(pid).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (alive) => !alive, times: 50 }),
    Effect.map((alive) => !alive),
  )

/**
 * Stops the process group `record` started: SIGTERM, then SIGKILL for whatever
 * is left after 5 seconds, including descendants that outlive the leader.
 *
 * A live leader must still run the recorded command, since pids get reused.
 * Once the leader has exited, the OS does not reuse its pid while the group
 * still exists, so a surviving group is still ours. `trusted` skips the check
 * for a process this invocation just spawned and still holds.
 */
export const stop = Effect.fn("Processes.stop")(function* (
  record: ProcessRecord,
  options?: { readonly trusted?: boolean },
) {
  if (!(yield* isGroupAlive(record.pid))) {
    const outcome: StopOutcome = "already-stopped"
    return outcome
  }
  if (options?.trusted !== true && (yield* isAlive(record.pid)) && !(yield* isOwned(record))) {
    const outcome: StopOutcome = "not-ours"
    return outcome
  }
  yield* signal(-record.pid, "SIGTERM").pipe(Effect.ignore)
  if (!(yield* waitForGroupExit(record.pid))) {
    yield* signal(-record.pid, "SIGKILL").pipe(Effect.ignore)
    yield* waitForGroupExit(record.pid)
  }
  const outcome: StopOutcome = "stopped"
  return outcome
})
