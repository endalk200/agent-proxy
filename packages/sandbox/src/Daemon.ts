import { closeSync, constants, openSync, readFileSync } from "node:fs"

import { Effect, Option } from "effect"

import { runCli } from "./Cli.ts"
import type { RepoPaths } from "./Repo.ts"
import type { Sandbox } from "./Sandbox.ts"

/**
 * The agent-proxy daemon a run started with `verify cli -- daemon start`.
 *
 * It detaches, so the run's manifest never records it. It is still the run's
 * own: only a daemon on the sandbox's state directory holds that directory's
 * lock (ADR-0002), and the lock records its pid. That lock, never the state
 * file's pid, decides whether a daemon runs there: a state file can be stale,
 * name a pid the OS has since reused, or not be readable at all (#21).
 */

/**
 * How stopping the sandbox's daemon went. Only `stopped` and `not-running`
 * are safe to tear down: `still-running` means a daemon still holds the
 * sandbox's lock, whatever HTTP said, and tearing the sandbox down would
 * orphan it. Its `pid` is `null` when the lock records none.
 */
export type StopOutcome =
  | { readonly status: "stopped" | "not-running" }
  | { readonly status: "still-running"; readonly pid: number | null }

const LOCK_EX = 2
const LOCK_NB = 4

/**
 * The daemon holding the sandbox's state lock: `Some` with the pid it
 * records (`None` inside when it records none), or `None` when no daemon
 * holds it. Taking the lock for a moment to find out is safe here: only
 * teardown asks.
 */
const lockHolder = (sandbox: Sandbox) =>
  // `bun:ffi` loads only when asked: Playwright imports this package under Node.
  Effect.promise(() => import("bun:ffi")).pipe(
    Effect.map(({ dlopen, FFIType }): Option.Option<Option.Option<number>> => {
      const lock = `${sandbox.stateHome}/agent-proxy/daemon.lock`
      let fd: number
      try {
        fd = openSync(lock, constants.O_RDWR)
      } catch {
        return Option.none()
      }
      try {
        const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        })
        try {
          if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return Option.none()
        } finally {
          libc.close()
        }
        const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10)
        return Option.some(Number.isSafeInteger(pid) && pid > 0 ? Option.some(pid) : Option.none())
      } finally {
        // Closing releases the lock if this took it.
        closeSync(fd)
      }
    }),
  )

/**
 * Stops the sandbox's daemon, if one runs, the way a user would:
 * `agent-proxy daemon stop`. When that fails, the daemon counts as gone only
 * once it no longer holds the lock: one paused with SIGSTOP, or wedged,
 * answers no HTTP and still holds it.
 */
export const stop = Effect.fn("Daemon.stop")(function* (repo: RepoPaths, sandbox: Sandbox) {
  if (Option.isNone(yield* lockHolder(sandbox))) {
    const outcome: StopOutcome = { status: "not-running" }
    return outcome
  }
  const result = yield* runCli(sandbox, repo.cliSource, ["daemon", "stop"], { cwd: repo.root })
  const holder = yield* lockHolder(sandbox)
  if (Option.isNone(holder)) {
    const outcome: StopOutcome = { status: result.exitCode === 0 ? "stopped" : "not-running" }
    return outcome
  }
  const outcome: StopOutcome = {
    status: "still-running",
    pid: Option.getOrNull(holder.value),
  }
  return outcome
})

/**
 * Stops the sandbox's daemon for a test that is done with it, and kills one
 * that will not stop, so no test leaves a daemon running beside the
 * developer's (#21). Only the pid the sandbox's lock holder recorded is
 * ever signalled.
 */
export const stopForTest = (repo: RepoPaths, sandbox: Sandbox) =>
  Effect.gen(function* () {
    const outcome = yield* stop(repo, sandbox)
    if (outcome.status === "still-running" && outcome.pid !== null) {
      const pid = outcome.pid
      yield* Effect.sync(() => {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // Gone already.
        }
      })
    }
  }).pipe(Effect.ignore)
