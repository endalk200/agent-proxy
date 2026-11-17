import { Effect, FileSystem } from "effect"

import { runCli } from "./Cli.ts"
import type { RepoPaths } from "./Repo.ts"
import type { Sandbox } from "./Sandbox.ts"

/**
 * The agent-proxy daemon a run started with `verify cli -- daemon start`.
 *
 * It detaches, so the run's manifest never records it. It is still the run's
 * own: its state file lives in the sandbox, and only a daemon on that state
 * directory answers there.
 */

export type StopOutcome = "stopped" | "not-running" | "failed"

/** Stops the sandbox's daemon, if one runs, the way a user would: `agent-proxy daemon stop`. */
export const stop = Effect.fn("Daemon.stop")(function* (repo: RepoPaths, sandbox: Sandbox) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(`${sandbox.stateHome}/agent-proxy/daemon.json`))) {
    const outcome: StopOutcome = "not-running"
    return outcome
  }
  const result = yield* runCli(sandbox, repo.cliSource, ["daemon", "stop"], { cwd: repo.root })
  const outcome: StopOutcome =
    result.exitCode === 0
      ? "stopped"
      : result.stderr.includes("daemon is not running")
        ? "not-running"
        : "failed"
  return outcome
})
