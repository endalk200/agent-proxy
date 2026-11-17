import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { runCli } from "../../src/Cli.ts"
import * as Daemon from "../../src/Daemon.ts"
import * as Processes from "../../src/Processes.ts"
import { defaultRepo, repoPaths } from "../../src/Repo.ts"
import * as Runs from "../../src/Runs.ts"
import * as Sandbox from "../../src/Sandbox.ts"
import * as Web from "../../src/Web.ts"

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-sandbox-" })
})

const InfoJson = Schema.fromJsonString(Schema.Struct({ configPath: Schema.String }))

layer(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))("sandbox", (it) => {
  it.effect("creates its directories and config fixture, and removes them on scope close", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* tempDir
      const dir = `${root}/box`
      const configFile = yield* Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* Sandbox.scoped(dir)
          expect(yield* fs.readFileString(sandbox.configFile)).toBe(Sandbox.CONFIG_FIXTURE)
          expect(yield* fs.exists(sandbox.artifacts)).toBe(true)
          return sandbox.configFile
        }),
      )
      expect(yield* fs.exists(configFile)).toBe(false)
      expect(yield* fs.exists(dir)).toBe(false)
    }),
  )

  it.effect("keeps only the evidence when destroyed with keepArtifacts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sandbox = yield* Sandbox.create(`${yield* tempDir}/box`)
      yield* fs.writeFileString(`${sandbox.artifacts}/proof.txt`, "proof")
      yield* Sandbox.destroy(sandbox, { keepArtifacts: true })
      expect(yield* fs.exists(`${sandbox.artifacts}/proof.txt`)).toBe(true)
      expect(yield* fs.exists(sandbox.home)).toBe(false)
      expect(yield* fs.exists(sandbox.configHome)).toBe(false)
    }),
  )

  it.effect("runs the real CLI isolated: it resolves config inside the sandbox", () =>
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.create(`${yield* tempDir}/box`)
      const result = yield* runCli(sandbox, defaultRepo.cliSource, ["info", "--json"], {
        cwd: defaultRepo.root,
      })
      expect(result.exitCode).toBe(0)
      const info = yield* Schema.decodeEffect(InfoJson)(result.stdout)
      expect(info.configPath).toBe(sandbox.configFile)
    }),
  )

  it.effect("numbers evidence in capture order and finds the current run", () =>
    Effect.gen(function* () {
      const root = yield* tempDir
      const repo = { ...repoPaths(root), verifyDir: `${root}/.verify` }
      const run = yield* Runs.up(repo)
      const first = yield* Runs.nextArtifact(run, "cli info")
      const second = yield* Runs.nextArtifact(run, "Browse /settings")
      expect(first.endsWith("/artifacts/001/cli-info")).toBe(true)
      expect(second.endsWith("/artifacts/002/browse-settings")).toBe(true)
      const current = yield* Runs.resolve(repo, Option.none())
      expect(current.manifest.id).toBe(run.manifest.id)
      expect(yield* Runs.evidenceCount(current)).toBe(2)
    }),
  )

  // withLive: readiness and shutdown poll on real time, which TestClock would freeze.
  it.effect(
    "starts the web dev server ready, then stops its whole process group",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const root = yield* tempDir
          const repo = { ...repoPaths(root), verifyDir: `${root}/.verify` }
          const run = yield* Runs.up(repo)
          // The finalizer stops the server even when an assertion fails or the test times out.
          const record = yield* Effect.acquireRelease(
            Web.start(defaultRepo, run, "dev"),
            (started) => Processes.stop(started).pipe(Effect.orDie),
          )
          expect(yield* Web.isReady(record.url)).toBe(true)
          expect(yield* Processes.isOwned(record)).toBe(true)
          expect(yield* Processes.stop(record)).toBe("stopped")
          expect(yield* Processes.isOwned(record)).toBe(false)
          expect(yield* Processes.stop(record)).toBe("already-stopped")
          // The server was recorded in the run's manifest while it ran.
          const recorded = yield* Runs.resolve(repo, Option.some(run.manifest.id))
          expect(recorded.manifest.processes.map((p) => p.pid)).toEqual([record.pid])
        }),
      ),
    60_000,
  )

  it.effect(
    "stops a daemon started inside the sandbox, so teardown leaves nothing running",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const sandbox = yield* Sandbox.create(`${yield* tempDir}/box`)
          const stateFile = `${sandbox.stateHome}/agent-proxy/daemon.json`
          const started = yield* Effect.acquireRelease(
            runCli(sandbox, defaultRepo.cliSource, ["daemon", "start"], { cwd: defaultRepo.root }),
            () => Daemon.stop(defaultRepo, sandbox).pipe(Effect.ignore),
          )
          expect(started.exitCode).toBe(0)
          expect(yield* fs.exists(stateFile)).toBe(true)
          expect(yield* Daemon.stop(defaultRepo, sandbox)).toBe("stopped")
          expect(yield* fs.exists(stateFile)).toBe(false)
          expect(yield* Daemon.stop(defaultRepo, sandbox)).toBe("not-running")
        }),
      ),
    60_000,
  )
})
