import {
  Data,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Random,
  Schema,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import type { RepoPaths } from "./Repo.ts"
import * as Sandbox from "./Sandbox.ts"

/**
 * A verification run: one sandbox under `.verify/runs/<id>/` plus a manifest
 * that records every background process the run started, so cleanup stops
 * exactly those and nothing else.
 */

export const ProcessRecord = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  pid: Schema.Int,
  port: Schema.Int,
  url: Schema.String,
  command: Schema.Array(Schema.String),
  log: Schema.String,
  startedAt: Schema.Int,
})
export type ProcessRecord = typeof ProcessRecord.Type

export const Manifest = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Int,
  gitHead: Schema.String,
  status: Schema.Literals(["up", "down"]),
  processes: Schema.Array(ProcessRecord),
})
export type Manifest = typeof Manifest.Type

export interface Run {
  readonly manifest: Manifest
  readonly sandbox: Sandbox.Sandbox
}

export class RunNotFound extends Data.TaggedError("RunNotFound")<{
  readonly id: Option.Option<string>
}> {
  override get message() {
    return Option.match(this.id, {
      onNone: () => "No current verification run. Start one with `bun run verify up`.",
      onSome: (id) => `No verification run "${id}". List runs with \`bun run verify ls\`.`,
    })
  }
}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

const runsDir = (repo: RepoPaths) => `${repo.verifyDir}/runs`
const currentFile = (repo: RepoPaths) => `${repo.verifyDir}/current`
const manifestFile = (sandbox: Sandbox.Sandbox) => `${sandbox.dir}/manifest.json`

/** `20261115-142233-3fa1`: sortable by creation time, unique across parallel runs. */
const makeId = Effect.gen(function* () {
  const now = yield* DateTime.now
  const stamp = DateTime.formatIso(now).replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15)
  const suffix = (yield* Random.nextIntBetween(0, 0xffff)).toString(16).padStart(4, "0")
  return `${stamp}-${suffix}`
})

/** The commit the run was started from, with `+dirty` when the tree has uncommitted changes. */
const gitHead = (repo: RepoPaths) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const head = yield* spawner.string(
      ChildProcess.make("git", ["rev-parse", "--short", "HEAD"], { cwd: repo.root }),
    )
    const status = yield* spawner.string(
      ChildProcess.make("git", ["status", "--porcelain"], { cwd: repo.root }),
    )
    return `${head.trim()}${status.trim() === "" ? "" : "+dirty"}`
  }).pipe(Effect.orElseSucceed(() => "unknown"))

/** Writes the manifest atomically, so a concurrent reader never sees a partial file. */
export const save = Effect.fn("Runs.save")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem
  const target = manifestFile(run.sandbox)
  const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16)
  const temporary = `${target}.${suffix}.tmp`
  yield* fs.writeFileString(temporary, `${JSON.stringify(run.manifest, null, 2)}\n`)
  yield* fs.rename(temporary, target)
})

/** Creates a sandboxed run and makes it the current one. */
export const up = Effect.fn("Runs.up")(function* (repo: RepoPaths) {
  const fs = yield* FileSystem.FileSystem
  const id = yield* makeId
  const sandbox = yield* Sandbox.create(`${runsDir(repo)}/${id}`)
  const run: Run = {
    sandbox,
    manifest: {
      id,
      createdAt: DateTime.toEpochMillis(yield* DateTime.now),
      gitHead: yield* gitHead(repo),
      status: "up",
      processes: [],
    },
  }
  yield* save(run)
  yield* fs.writeFileString(currentFile(repo), `${id}\n`)
  return run
})

/** Loads the run named `id`, or the current run when `id` is absent. */
export const resolve = Effect.fn("Runs.resolve")(function* (
  repo: RepoPaths,
  id: Option.Option<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const notFound = new RunNotFound({ id })
  const runId = Option.isSome(id)
    ? id.value
    : (yield* fs.readFileString(currentFile(repo)).pipe(Effect.mapError(() => notFound))).trim()
  return yield* load(`${runsDir(repo)}/${runId}`).pipe(Effect.mapError(() => notFound))
})

/** Reads the run stored in `dir`. */
const load = Effect.fn("Runs.load")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const sandbox = yield* Sandbox.at(dir)
  const manifest = yield* decodeManifest(yield* fs.readFileString(manifestFile(sandbox)))
  const run: Run = { manifest, sandbox }
  return run
})

/** Every run on disk, oldest first. Unreadable directories are skipped. */
export const list = Effect.fn("Runs.list")(function* (repo: RepoPaths) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(runsDir(repo))
  if (!exists) {
    const none: ReadonlyArray<Run> = []
    return none
  }
  const ids = (yield* fs.readDirectory(runsDir(repo))).toSorted()
  const runs = yield* Effect.forEach(ids, (id) =>
    resolve(repo, Option.some(id)).pipe(Effect.option),
  )
  return runs.flatMap((run) => (Option.isSome(run) ? [run.value] : []))
})

/**
 * Records `record` in the run's manifest, replacing any process with the same
 * name. Reads the latest manifest first so a concurrent change is kept, and
 * returns the replaced records: the caller must stop them, or they would keep
 * running without any record.
 */
export const recordProcess = Effect.fn("Runs.recordProcess")(function* (
  run: Run,
  record: ProcessRecord,
) {
  const latest = yield* load(run.sandbox.dir)
  const replaced = latest.manifest.processes.filter((p) => p.name === record.name)
  const kept = latest.manifest.processes.filter((p) => p.name !== record.name)
  yield* save({ ...latest, manifest: { ...latest.manifest, processes: [...kept, record] } })
  return replaced
})

/** Removes the process with `pid` from the run's manifest. */
export const forgetProcess = Effect.fn("Runs.forgetProcess")(function* (run: Run, pid: number) {
  const latest = yield* load(run.sandbox.dir)
  const processes = latest.manifest.processes.filter((p) => p.pid !== pid)
  yield* save({ ...latest, manifest: { ...latest.manifest, processes } })
})

/** Number of evidence captures in the run so far. */
export const evidenceCount = Effect.fn("Runs.evidenceCount")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs
    .readDirectory(run.sandbox.artifacts)
    .pipe(Effect.orElseSucceed(() => []))
  return entries.filter((entry) => /^\d+$/.test(entry)).length
})

/**
 * Reserves the next evidence slot and returns a path prefix inside it, e.g.
 * `artifacts/003/cli-info`; callers append their own extensions.
 *
 * Each slot is a directory created exclusively: two captures racing for the
 * same number cannot both create it, so the loser moves on to the next one.
 * Numbers follow capture order.
 */
export const nextArtifact = Effect.fn("Runs.nextArtifact")(function* (run: Run, label: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
  const taken = (yield* fs.readDirectory(run.sandbox.artifacts))
    .map((entry) => Number.parseInt(entry, 10))
    .filter(Number.isFinite)
  const reserve = (n: number): Effect.Effect<string, PlatformError.PlatformError> => {
    const slot = path.join(run.sandbox.artifacts, String(n).padStart(3, "0"))
    return fs.makeDirectory(slot).pipe(
      Effect.as(slot),
      Effect.catch((error) =>
        fs
          .exists(slot)
          .pipe(Effect.flatMap((exists) => (exists ? reserve(n + 1) : Effect.fail(error)))),
      ),
    )
  }
  const slot = yield* reserve(Math.max(0, ...taken) + 1)
  return path.join(slot, slug)
})
