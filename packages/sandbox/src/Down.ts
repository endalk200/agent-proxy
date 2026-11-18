import { Console, Effect, Option } from "effect"

import * as Daemon from "./Daemon.ts"
import * as Processes from "./Processes.ts"
import type { RepoPaths } from "./Repo.ts"
import * as Runs from "./Runs.ts"
import * as Sandbox from "./Sandbox.ts"

/**
 * `verify down` for one run: stops its daemon, then the processes it
 * recorded, deletes its state and keeps its evidence.
 *
 * A daemon that cannot be confirmed stopped keeps the run up, state and all,
 * so it stays listed and `verify down` can find it again; the run's pid is
 * returned, and nothing else is touched (#21).
 */
export const tearDown = Effect.fn("Down.tearDown")(function* (repo: RepoPaths, run: Runs.Run) {
  const relative = (path: string) => path.replace(`${repo.root}/`, "")
  const daemon = yield* Daemon.stop(repo, run.sandbox)
  if (daemon.status === "still-running") {
    const who = daemon.pid === null ? "a daemon (no pid recorded in its lock)" : `pid ${daemon.pid}`
    const kill = daemon.pid === null ? "stop it by hand" : `\`kill ${daemon.pid}\``
    yield* Console.log(
      `daemon   ${who} is still running and did not stop, so run ${run.manifest.id} stays up with its state. Run \`verify down\` again, or ${kill} and then \`verify down\`.`,
    )
    return Option.some(daemon.pid)
  }
  yield* Console.log(`daemon   ${daemon.status}`)
  for (const record of run.manifest.processes) {
    const outcome = yield* Processes.stop(record)
    yield* Console.log(`${record.name.padEnd(8)} pid ${record.pid}: ${outcome}`)
  }
  yield* Sandbox.destroy(run.sandbox, { keepArtifacts: true })
  yield* Runs.save({ ...run, manifest: { ...run.manifest, status: "down", processes: [] } })
  yield* Console.log(
    `run      ${run.manifest.id} down; evidence kept in ${relative(run.sandbox.artifacts)}`,
  )
  return Option.none<number | null>()
})
