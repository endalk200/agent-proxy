import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Vitest global setup: fails the run when a test leaves a detached process
 * running.
 *
 * `Processes.startDetached` appends every pid it spawns to the ledger named by
 * AGENT_PROXY_TEST_PROCESS_LEDGER. After the last test, any of those process
 * groups still alive is a leak: a test that timed out or skipped its cleanup.
 * The teardown kills them and fails the run. CI alone would never notice,
 * because each runner is thrown away after the job.
 */

export const LEDGER_VAR = "AGENT_PROXY_TEST_PROCESS_LEDGER"

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const commandOf = (pid: number) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim()
  } catch {
    return "(exited leader; descendants still running)"
  }
}

const recordedPids = (ledger: string) => {
  try {
    return readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** The groups among `pids` still alive at `deadline`, or as soon as none are. */
const stillAlive = async (
  pids: ReadonlyArray<number>,
  deadline: number,
): Promise<Array<number>> => {
  const alive = pids.filter(groupAlive)
  if (alive.length === 0 || Date.now() >= deadline) {
    return alive
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  return stillAlive(alive, deadline)
}

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-ledger-"))
  const ledger = join(dir, "pids")
  // Set before the workers start, so every test inherits it.
  process.env[LEDGER_VAR] = ledger

  return async function teardown() {
    // Give groups a test stopped at the very end a moment to finish exiting.
    const alive = await stillAlive(recordedPids(ledger), Date.now() + 2_000)
    const leaked = alive.map((pid) => `  pid ${pid}: ${commandOf(pid)}`)
    for (const pid of alive) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true })
    if (leaked.length > 0) {
      throw new Error(
        `Tests left ${leaked.length} detached process group(s) running; killed them:\n${leaked.join("\n")}`,
      )
    }
  }
}
