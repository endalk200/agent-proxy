import { Clock, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { Sandbox } from "./Sandbox.ts"

/** Everything observable about one CLI invocation: the evidence a run produces. */
export interface CliResult {
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

/**
 * How to run `entry`: a script (source `bin.ts`) through `bun`, and the
 * compiled binary (`dist/agent-proxy`) directly.
 */
export const commandFor = (entry: string, args: ReadonlyArray<string>) =>
  /\.[cm]?[jt]s$/.test(entry)
    ? { command: "bun", args: [entry, ...args] }
    : { command: entry, args: [...args] }

/**
 * Runs the agent-proxy CLI at `entry` (source `bin.ts`, or the compiled
 * binary) as a child process with only the sandbox environment, and captures
 * its output.
 */
export const runCli = Effect.fn("runCli")(function* (
  sandbox: Sandbox,
  entry: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const run = commandFor(entry, args)
  const command = [run.command, ...run.args]
  const startedAt = yield* Clock.currentTimeMillis
  const handle = yield* spawner.spawn(
    ChildProcess.make(run.command, run.args, {
      cwd: options.cwd,
      env: sandbox.env,
      extendEnv: false,
    }),
  )
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
    { concurrency: "unbounded" },
  )
  const finishedAt = yield* Clock.currentTimeMillis
  const result: CliResult = {
    command,
    exitCode,
    stdout,
    stderr,
    durationMs: finishedAt - startedAt,
  }
  return result
}, Effect.scoped)
