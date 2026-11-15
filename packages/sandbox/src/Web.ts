import { Clock, Data, Effect, FileSystem, Schedule, Stream } from "effect"
import { HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Processes from "./Processes.ts"
import type { RepoPaths } from "./Repo.ts"
import * as Runs from "./Runs.ts"
import type { ProcessRecord } from "./Runs.ts"

export type WebMode = "preview" | "dev"

export class WebError extends Data.TaggedError("WebError")<{ readonly message: string }> {}

/**
 * Ready means usable: the server answers 200 with the app's own HTML shell,
 * not merely that something accepted a connection on the port.
 */
export const isReady = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text.pipe(Effect.map((html) => html.includes("<title>agent-proxy</title>")))
        : Effect.succeed(false),
    ),
    Effect.orElseSucceed(() => false),
  )

/**
 * Builds the web client through Turbo, so an unchanged client is a cache hit.
 * Success is the build's exit code; Turbo prints "successful" even in its
 * failure summary.
 */
const build = Effect.fn("Web.build")(function* (repo: RepoPaths, log: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(
    ChildProcess.make("bun", ["x", "turbo", "run", "build", "--filter=@agent-proxy/web"], {
      cwd: repo.root,
      extendEnv: true,
    }),
  )
  const [output, exitCode] = yield* Effect.all(
    [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
    { concurrency: "unbounded" },
  )
  yield* fs.writeFileString(log, output)
  if (exitCode !== 0) {
    return yield* new WebError({ message: `Web build failed (exit ${exitCode}); see ${log}` })
  }
}, Effect.scoped)

/**
 * Starts the web client for `run` on a free port and waits until it is ready.
 *
 * - `preview` builds first and serves `apps/web/dist`: what users get.
 * - `dev` runs the Vite dev server with hot reload: edits show up live.
 *
 * The process is recorded in the run's manifest before the readiness wait, and
 * stopped and forgotten if anything after the spawn fails or is interrupted,
 * so no server is ever left running without a record.
 */
export const start = Effect.fn("Web.start")(function* (
  repo: RepoPaths,
  run: Runs.Run,
  mode: WebMode,
  options?: { readonly port?: number },
) {
  const { sandbox } = run
  // Taken before the build: any source edit after this moment is not in the bundle.
  const startedAt = yield* Clock.currentTimeMillis
  if (mode === "preview") {
    yield* build(repo, `${sandbox.logs}/web-build.log`)
  }
  const port = options?.port ?? (yield* Processes.freePort)
  const url = `http://127.0.0.1:${port}/`
  const viteArgs = mode === "preview" ? ["vite", "preview"] : ["vite"]
  const args = ["--bun", ...viteArgs, "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
  const log = `${sandbox.logs}/web.log`

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pid = yield* Processes.startDetached({
        command: "bun",
        args,
        cwd: repo.webDir,
        env: sandbox.env,
        log,
      })
      const record: ProcessRecord = {
        name: "web",
        mode,
        pid,
        port,
        url,
        command: ["bun", ...args],
        log,
        startedAt,
      }
      const cleanup = Processes.stop(record, { trusted: true }).pipe(
        Effect.andThen(Runs.forgetProcess(run, pid)),
        Effect.ignore,
      )
      return yield* restore(
        Effect.gen(function* () {
          const replaced = yield* Runs.recordProcess(run, record)
          yield* Effect.forEach(replaced, (old) => Processes.stop(old), { discard: true })
          const ready = yield* isReady(url).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("200 millis"),
              until: (ok) => ok,
              times: 150,
            }),
          )
          if (!ready) {
            return yield* new WebError({
              message: `Web server did not become ready at ${url}; see ${log}`,
            })
          }
          return record
        }),
      ).pipe(Effect.onError(() => cleanup))
    }),
  )
})
