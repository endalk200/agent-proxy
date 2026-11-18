import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { runCli } from "../../src/Cli.ts"
import * as Daemon from "../../src/Daemon.ts"
import * as Down from "../../src/Down.ts"
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
      const sandbox = yield* Sandbox.scoped(`${yield* tempDir}/box`)
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
          const sandbox = yield* Sandbox.scoped(`${yield* tempDir}/box`)
          const stateFile = `${sandbox.stateHome}/agent-proxy/daemon.json`
          const started = yield* runCli(sandbox, defaultRepo.cliSource, ["daemon", "start"], {
            cwd: defaultRepo.root,
          })
          expect(started.exitCode).toBe(0)
          expect(yield* fs.exists(stateFile)).toBe(true)
          expect(yield* Daemon.stop(defaultRepo, sandbox)).toEqual({ status: "stopped" })
          expect(yield* fs.exists(stateFile)).toBe(false)
          expect(yield* Daemon.stop(defaultRepo, sandbox)).toEqual({ status: "not-running" })
        }),
      ),
    60_000,
  )

  it.effect(
    "a scoped sandbox stops the daemon its test started, even one the test never stopped",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const pid = yield* Effect.scoped(
            Effect.gen(function* () {
              const sandbox = yield* Sandbox.scoped(`${yield* tempDir}/box`)
              yield* runCli(sandbox, defaultRepo.cliSource, ["daemon", "start"], {
                cwd: defaultRepo.root,
              })
              return yield* daemonPid(sandbox)
            }),
          )
          expect(yield* Processes.isAlive(pid)).toBe(false)
        }),
      ),
    60_000,
  )

  it.effect(
    "verify down keeps a run up, state and all, while its daemon is alive but does not answer (#21)",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* tempDir
          const repo = { ...defaultRepo, verifyDir: `${root}/.verify` }
          const run = yield* Runs.up(repo)
          const started = yield* runCli(run.sandbox, repo.cliSource, ["daemon", "start"], {
            cwd: repo.root,
          })
          expect(started.exitCode).toBe(0)
          const pid = yield* daemonPid(run.sandbox)
          // Paused, as a wedged daemon is: alive, and answering nothing.
          yield* Effect.acquireRelease(
            Effect.sync(() => process.kill(pid, "SIGSTOP")),
            () =>
              Effect.sync(() => {
                try {
                  process.kill(pid, "SIGCONT")
                } catch {
                  // Stopped by the test already.
                }
              }).pipe(Effect.andThen(Daemon.stopForTest(repo, run.sandbox))),
          )

          expect(yield* Down.tearDown(repo, run)).toStrictEqual(Option.some(pid))
          const kept = yield* Runs.resolve(repo, Option.some(run.manifest.id))
          expect(kept.manifest.status).toBe("up")
          expect(yield* fs.exists(`${run.sandbox.stateHome}/agent-proxy/daemon.json`)).toBe(true)

          // Running again, it stops it and the run goes down.
          process.kill(pid, "SIGCONT")
          expect(yield* Down.tearDown(repo, kept)).toStrictEqual(Option.none())
          expect(yield* Processes.isAlive(pid)).toBe(false)
          const down = yield* Runs.resolve(repo, Option.some(run.manifest.id))
          expect(down.manifest.status).toBe("down")
        }),
      ),
    60_000,
  )

  it.effect(
    "verify down tears down a run whose daemon died without cleaning up",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* tempDir
          const repo = { ...defaultRepo, verifyDir: `${root}/.verify` }
          const run = yield* Runs.up(repo)
          yield* fs.makeDirectory(`${run.sandbox.stateHome}/agent-proxy`, { recursive: true })
          // Port 9 (discard) has no listener, and no process has pid 999999.
          yield* fs.writeFileString(
            `${run.sandbox.stateHome}/agent-proxy/daemon.json`,
            JSON.stringify({ pid: 999_999, port: 9, address: "http://127.0.0.1:9" }),
          )
          expect(yield* Down.tearDown(repo, run)).toStrictEqual(Option.none())
          expect((yield* Runs.resolve(repo, Option.some(run.manifest.id))).manifest.status).toBe(
            "down",
          )
        }),
      ),
    60_000,
  )

  it.effect(
    "never signals a process a stale state file names, unless a daemon in the sandbox holds the lock",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const sandbox = yield* Sandbox.create(`${yield* tempDir}/box`)
          // An unrelated process, as a reused pid would be.
          const bystander = yield* Effect.acquireRelease(
            Effect.sync(() => Bun.spawn(["sleep", "30"])),
            (child) => Effect.sync(() => child.kill("SIGKILL")),
          )
          yield* fs.makeDirectory(`${sandbox.stateHome}/agent-proxy`, { recursive: true })
          for (const pid of [bystander.pid, -1]) {
            yield* fs.writeFileString(
              `${sandbox.stateHome}/agent-proxy/daemon.json`,
              JSON.stringify({ pid, port: 9, address: "http://127.0.0.1:9" }),
            )
            expect(yield* Daemon.stop(defaultRepo, sandbox)).toEqual({ status: "not-running" })
            yield* Daemon.stopForTest(defaultRepo, sandbox)
            expect(yield* Processes.isAlive(bystander.pid)).toBe(true)
          }
        }),
      ),
    60_000,
  )

  it.effect(
    "verify down keeps a run whose state file cannot be read while its daemon runs (#21)",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const sandbox = yield* Sandbox.scoped(`${yield* tempDir}/box`)
          yield* runCli(sandbox, defaultRepo.cliSource, ["daemon", "start"], {
            cwd: defaultRepo.root,
          })
          const pid = yield* daemonPid(sandbox)
          yield* fs.writeFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`, "{")
          expect(yield* Daemon.stop(defaultRepo, sandbox)).toEqual({
            status: "still-running",
            pid,
          })
          // The scoped sandbox still stops it on close: the lock names it.
        }),
      ),
    60_000,
  )
})

/** The pid the sandbox's daemon recorded in its state file. */
const daemonPid = (sandbox: Sandbox.Sandbox) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const state = yield* fs.readFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`)
    return (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })))(
      state,
    )).pid
  })
