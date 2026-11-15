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
 * Runs the agent-proxy CLI at `entry` (source `bin.ts` or built `bin.js`) as a
 * child process with only the sandbox environment, and captures its output.
 */
export const runCli = Effect.fn("runCli")(function* (
  sandbox: Sandbox,
  entry: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ["bun", entry, ...args]
  const startedAt = yield* Clock.currentTimeMillis
  const handle = yield* spawner.spawn(
    ChildProcess.make("bun", [entry, ...args], {
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
