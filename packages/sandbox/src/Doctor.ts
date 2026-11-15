import { Effect, FileSystem, Option, Schema } from "effect"

import { runCli } from "./Cli.ts"
import * as Processes from "./Processes.ts"
import type { RepoPaths } from "./Repo.ts"
import type { ProcessRecord, Run } from "./Runs.ts"
import * as Web from "./Web.ts"

/** One read-only answer to "is this run worth driving?". */
export interface Check {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const InfoJson = Schema.fromJsonString(Schema.Struct({ configPath: Schema.String }))

/** Files and directories whose contents end up in, or shape, the preview build. */
const webBuildInputs = (repo: RepoPaths) =>
  ["src", "public", "index.html", "vite.config.ts", "package.json", "tsconfig.json"].map(
    (entry) => `${repo.webDir}/${entry}`,
  )

const mtimeOf = (info: FileSystem.File.Info) =>
  Option.getOrElse(
    Option.map(info.mtime, (date) => date.getTime()),
    () => 0,
  )

/** Newest modification time across `inputs` (files, or directories walked recursively), in epoch ms. */
const newestMtime = Effect.fn("Doctor.newestMtime")(function* (inputs: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const times = yield* Effect.forEach(inputs, (input) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(input))) {
        return 0
      }
      const info = yield* fs.stat(input)
      if (info.type !== "Directory") {
        return mtimeOf(info)
      }
      const entries = yield* fs.readDirectory(input, { recursive: true })
      const nested = yield* Effect.forEach(entries, (entry) =>
        fs.stat(`${input}/${entry}`).pipe(Effect.map(mtimeOf)),
      )
      return Math.max(mtimeOf(info), ...nested)
    }),
  )
  return Math.max(0, ...times)
})

const checkProcess = Effect.fn("Doctor.checkProcess")(function* (
  repo: RepoPaths,
  record: ProcessRecord,
) {
  const owned = yield* Processes.isOwned(record)
  const ready = owned ? yield* Web.isReady(record.url) : false
  const checks: Array<Check> = [
    {
      name: `${record.name} process`,
      ok: owned,
      detail: owned
        ? `pid ${record.pid} serves ${record.url}`
        : `pid ${record.pid} is gone or no longer ours; restart with \`verify web --restart\``,
    },
    {
      name: `${record.name} ready`,
      ok: ready,
      detail: ready ? `${record.url} serves the agent-proxy shell` : `${record.url} is not usable`,
    },
  ]
  if (record.mode === "preview") {
    const newest = yield* newestMtime(webBuildInputs(repo))
    const fresh = newest <= record.startedAt
    checks.push({
      name: `${record.name} build fresh`,
      ok: fresh,
      detail: fresh
        ? "no web build input changed since the preview was built"
        : "a web build input changed after the preview was built; restart with `verify web --restart`",
    })
  }
  return checks
})

/** Runs every check for `run`. Nothing here changes the run's state. */
export const diagnose = Effect.fn("Doctor.diagnose")(function* (repo: RepoPaths, run: Run) {
  const fs = yield* FileSystem.FileSystem
  const { sandbox, manifest } = run
  const intact = manifest.status === "up" && (yield* fs.exists(sandbox.configFile))
  const checks: Array<Check> = [
    {
      name: "run up",
      ok: intact,
      detail: intact
        ? `${manifest.id} from ${manifest.gitHead}`
        : `${manifest.id} is ${manifest.status}; start a new run with \`verify up\``,
    },
  ]
  if (!intact) {
    return checks
  }

  // Isolation: the CLI, run exactly as `verify cli` runs it, must resolve its
  // config inside the sandbox. A path outside means the run would touch the
  // developer's real configuration.
  const result = yield* runCli(sandbox, repo.cliSource, ["info", "--json"], { cwd: repo.root })
  const resolved = yield* Schema.decodeEffect(InfoJson)(result.stdout).pipe(
    Effect.map((info) => info.configPath),
    Effect.orElseSucceed(() => `unreadable output (exit ${result.exitCode})`),
  )
  checks.push({
    name: "isolation",
    ok: resolved === sandbox.configFile,
    detail: `agent-proxy resolves config to ${resolved}`,
  })

  for (const record of manifest.processes) {
    checks.push(...(yield* checkProcess(repo, record)))
  }
  return checks
})
