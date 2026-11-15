import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Processes from "../../src/Processes.ts"
import { defaultRepo, repoPaths } from "../../src/Repo.ts"
import * as Runs from "../../src/Runs.ts"
import * as Web from "../../src/Web.ts"

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-processes-" })
})

const groupAlive = (pid: number) =>
  Effect.try({ try: () => process.kill(-pid, 0), catch: () => "gone" }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** Starts `sh -c <script> sh <extra...>` detached and records it like `verify web` would. */
const startShell = (script: string, port: number) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const root = yield* tempDir
      const command = ["sh", "-c", script, "sh", "--port", String(port)]
      const pid = yield* Processes.startDetached({
        command: "sh",
        args: command.slice(1),
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "" },
        log: `${root}/log`,
      })
      const record: Runs.ProcessRecord = {
        name: "probe",
        mode: "dev",
        pid,
        port,
        url: "",
        command,
        log: `${root}/log`,
        startedAt: 0,
      }
      return record
    }),
    (record) =>
      Effect.try({ try: () => process.kill(-record.pid, "SIGKILL"), catch: () => "gone" }).pipe(
        Effect.ignore,
      ),
  )

/** Every live process whose command line mentions `--port <port>`. */
const processesOnPort = (port: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner.string(ChildProcess.make("ps", ["-axo", "command="]))
    return output.split("\n").filter((line) => new RegExp(`--port ${port}( |$)`).test(line))
  })

layer(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))("process supervision", (it) => {
  it.effect("does not claim a process whose command only shares a port prefix", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        // `; true` keeps sh resident (a lone command is exec-ed), so ps shows our arguments.
        const record = yield* startShell("sleep 30; true", 12345)
        expect(yield* Processes.isOwned(record)).toBe(true)
        // Same pid, but a record for a different command on port 1: `--port 1` is a
        // prefix of `--port 12345`, which must not count as ownership.
        const impostor = { ...record, port: 1, command: ["other", "--port", "1"] }
        expect(yield* Processes.isOwned(impostor)).toBe(false)
        expect(yield* Processes.stop(impostor)).toBe("not-ours")
      }),
    ),
  )

  it.effect(
    "stops descendants that ignore SIGTERM after the group leader exits",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          // The leader dies on SIGTERM; its child ignores SIGTERM and keeps the group alive.
          const record = yield* startShell("(trap '' TERM; exec sleep 300) & wait", 23456)
          yield* Effect.sleep("200 millis")
          expect(yield* Processes.stop(record)).toBe("stopped")
          expect(yield* groupAlive(record.pid)).toBe(false)
        }),
      ),
    30_000,
  )

  it.effect("hands out unique evidence numbers to concurrent captures", () =>
    Effect.gen(function* () {
      const root = yield* tempDir
      const repo = { ...repoPaths(root), verifyDir: `${root}/.verify` }
      const run = yield* Runs.up(repo)
      const paths = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, i) => `capture ${i}`),
        (label) => Runs.nextArtifact(run, label),
        { concurrency: "unbounded" },
      )
      expect(new Set(paths.map((path) => path.split("/").at(-2))).size).toBe(12)
    }),
  )

  it.effect(
    "leaves no unrecorded server when start is interrupted before ready",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const root = yield* tempDir
          const repo = { ...repoPaths(root), verifyDir: `${root}/.verify` }
          const run = yield* Runs.up(repo)
          const port = yield* Processes.freePort
          const outcome = yield* Web.start(defaultRepo, run, "dev", { port }).pipe(
            Effect.timeout("50 millis"),
            Effect.option,
          )
          expect(Option.isNone(outcome)).toBe(true)
          yield* Effect.sleep("500 millis")
          expect(yield* processesOnPort(port)).toEqual([])
          const after = yield* Runs.resolve(repo, Option.some(run.manifest.id))
          expect(after.manifest.processes).toEqual([])
        }),
      ),
    30_000,
  )
})
