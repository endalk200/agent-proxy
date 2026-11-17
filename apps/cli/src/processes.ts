import { spawn } from "node:child_process"

import { Context, Data, Effect, Layer, Option, Predicate } from "effect"

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
     * terminal and no inherited stdio, so it outlives the current command.
     */
    readonly launchSelf: (
      args: ReadonlyArray<string>,
    ) => Effect.Effect<LaunchedProcess, ProcessError>
    readonly signal: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void, ProcessError>
    /** True while a process with `pid` exists. */
    readonly isAlive: (pid: number) => Effect.Effect<boolean>
  }
>()("agent-proxy/Processes") {
  static readonly layerProcess = Layer.sync(Processes, () =>
    Processes.of({
      pid: process.pid,
      launchSelf: (args) =>
        Effect.try({
          try: () => {
            // argv[1] is the entry script: src/bin.ts from source, dist/bin.js when built.
            const entry = process.argv[1] ?? ""
            const child = spawn(process.execPath, [entry, ...args], {
              detached: true,
              stdio: "ignore",
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
          },
          catch: (cause) =>
            new ProcessError({ message: `Could not launch agent-proxy ${args.join(" ")}`, cause }),
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
            return true
          } catch (error) {
            // EPERM: the process exists but belongs to someone else.
            return Predicate.hasProperty(error, "code") && error.code === "EPERM"
          }
        }),
    }),
  )
}
