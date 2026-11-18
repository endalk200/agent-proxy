import { spawn } from "node:child_process"
import { closeSync, openSync, readFileSync } from "node:fs"

import { Context, Data, Effect, Layer, Option, Predicate } from "effect"

/**
 * True when `pid` has exited but its parent has not reaped it. A detached
 * daemon's parent is whatever adopts orphans; in a container that is often a
 * PID 1 that never reaps, so a stopped daemon lingers as a zombie, which
 * `kill(pid, 0)` still finds. Linux reports the state in `/proc`; elsewhere
 * the OS's init reaps orphans, so there is nothing to check.
 */
export const isZombie = (pid: number): boolean => {
  if (process.platform !== "linux") return false
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // The state follows the command name, which is in parentheses and may hold spaces.
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
  } catch {
    return false
  }
}

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A process this CLI launched in the background. */
export interface LaunchedProcess {
  readonly pid: number
  /** The exit code once the process has exited, `None` while it runs. */
  readonly exitCode: Effect.Effect<Option.Option<number>>
}

/**
 * The OS processes the CLI deals with: its own, the daemon it launches, and
 * the daemon it stops.
 *
 * Kept behind a service so commands never touch `process` or
 * `child_process` directly: `bin.ts` and tests provide `layerProcess`.
 */
export class Processes extends Context.Service<
  Processes,
  {
    /** This process's id. */
    readonly pid: number
    /**
     * Runs this CLI again with `args`, detached in its own session with no
     * terminal, so it outlives the current command. Its stdout and stderr are
     * appended to `options.output`, so whatever it prints before its logger
     * exists still leaves evidence.
     */
    readonly launchSelf: (
      args: ReadonlyArray<string>,
      options: { readonly output: string },
    ) => Effect.Effect<LaunchedProcess, ProcessError>
    readonly signal: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void, ProcessError>
    /** True while a process with `pid` exists. */
    readonly isAlive: (pid: number) => Effect.Effect<boolean>
  }
>()("agent-proxy/Processes") {
  /**
   * The real processes. `self` runs this CLI again: the compiled binary is
   * its own executable, while from source it is `bun` and the entry script.
   */
  static readonly layer = (self: {
    readonly command: string
    readonly args: ReadonlyArray<string>
  }) =>
    Layer.sync(Processes, () =>
      Processes.of({
        pid: process.pid,
        launchSelf: (args, options) =>
          Effect.try({
            try: () => {
              const output = openSync(options.output, "a", 0o600)
              try {
                const child = spawn(self.command, [...self.args, ...args], {
                  detached: true,
                  stdio: ["ignore", output, output],
                  env: process.env,
                })
                let exitCode = Option.none<number>()
                child.once("exit", (code, signal) => {
                  exitCode = Option.some(code ?? (signal === null ? 1 : 128))
                })
                child.unref()
                if (child.pid === undefined) {
                  throw new Error("spawn returned no pid")
                }
                return { pid: child.pid, exitCode: Effect.sync(() => exitCode) }
              } finally {
                closeSync(output)
              }
            },
            catch: (cause) =>
              new ProcessError({
                message: `Could not launch agent-proxy ${args.join(" ")}`,
                cause,
              }),
          }),
        signal: (pid, signal) =>
          Effect.try({
            try: () => {
              process.kill(pid, signal)
            },
            catch: (cause) => new ProcessError({ message: `Could not signal pid ${pid}`, cause }),
          }),
        isAlive: (pid) =>
          Effect.sync(() => {
            try {
              process.kill(pid, 0)
              return !isZombie(pid)
            } catch (error) {
              // EPERM: the process exists but belongs to someone else.
              return Predicate.hasProperty(error, "code") && error.code === "EPERM"
            }
          }),
      }),
    )

  /** The real processes, for this CLI running from source: argv[1] is the entry script. */
  static readonly layerProcess = Layer.suspend(() =>
    Processes.layer({ command: process.execPath, args: [process.argv[1] ?? ""] }),
  )
}
