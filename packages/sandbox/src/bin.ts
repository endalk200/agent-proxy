#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Data, Effect, FileSystem, Layer, Option, Runtime } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Browse from "./Browse.ts"
import { runCli } from "./Cli.ts"
import * as Doctor from "./Doctor.ts"
import * as Down from "./Down.ts"
import * as Processes from "./Processes.ts"
import { defaultRepo as repo } from "./Repo.ts"
import * as Runs from "./Runs.ts"
import * as Sandbox from "./Sandbox.ts"
import * as Web from "./Web.ts"

// `verify`: launch, check, drive, and tear down agent-proxy in a sandboxed run.
// docs/agents/verification/README.md documents how agents use it.

/** Exits with `code` without printing anything more; the command already reported. */
class ExitWith extends Data.TaggedError("ExitWith")<{ readonly code: number }> {
  // `false` tells the runtime not to log this failure; the output is already printed.
  override readonly [Runtime.errorReported] = false
  override get [Runtime.errorExitCode]() {
    return this.code
  }
}

const asUserError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message })

const userError = (userMessage: string) => new CliError.UserError({ cause: undefined, userMessage })

const relative = (path: string) => path.replace(`${repo.root}/`, "")

const runFlag = Flag.String("run").pipe(
  Flag.optional,
  Flag.withDescription("Run id to act on (default: the current run)"),
)

const up = Command.make("up", {}, () =>
  Effect.gen(function* () {
    const run = yield* Runs.up(repo)
    yield* Console.log(
      [
        `run      ${run.manifest.id}`,
        `dir      ${relative(run.sandbox.dir)}`,
        `commit   ${run.manifest.gitHead}`,
        `next     bun run verify doctor`,
      ].join("\n"),
    )
  }).pipe(Effect.mapError(asUserError)),
).pipe(Command.withDescription("Create a sandboxed run and make it the current one"))

const shell = Command.make(
  "shell",
  {
    run: runFlag,
    args: Argument.String("args").pipe(
      Argument.variadic(),
      Argument.withDescription("Arguments for the shell; put them after --, e.g. -- -c 'env'"),
    ),
  },
  ({ run: id, args }) =>
    Effect.gen(function* () {
      const run = yield* Runs.resolve(repo, id).pipe(Effect.mapError(asUserError))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const shellPath = yield* Config.String("SHELL").pipe(Config.withDefault("/bin/sh"))
      const term = yield* Config.option(Config.String("TERM"))
      // The same closed environment as `verify cli`: nothing from the calling
      // shell leaks in except PATH (and TERM, so the terminal still works).
      const env = {
        ...run.sandbox.env,
        SHELL: shellPath,
        ...(Option.isSome(term) ? { TERM: term.value } : {}),
      }
      const exitCode = yield* spawner
        .exitCode(
          ChildProcess.make(shellPath, args, {
            cwd: repo.root,
            env,
            extendEnv: false,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        .pipe(Effect.mapError(asUserError))
      if (exitCode !== 0) {
        return yield* new ExitWith({ code: exitCode })
      }
    }),
).pipe(
  Command.withDescription(
    "Open your shell inside the run's sandbox, with only PATH inherited (or run -- -c '<command>')",
  ),
)

const doctor = Command.make("doctor", { run: runFlag }, ({ run: id }) =>
  Effect.gen(function* () {
    const run = yield* Runs.resolve(repo, id).pipe(Effect.mapError(asUserError))
    const checks = yield* Doctor.diagnose(repo, run).pipe(Effect.mapError(asUserError))
    yield* Console.log(
      checks
        .map((check) => `${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(18)} ${check.detail}`)
        .join("\n"),
    )
    if (checks.some((check) => !check.ok)) {
      return yield* new ExitWith({ code: 1 })
    }
  }),
).pipe(Command.withDescription("Read-only checks: is this run worth driving?"))

const cli = Command.make(
  "cli",
  {
    run: runFlag,
    built: Flag.Boolean("built").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Run the compiled binary (apps/cli/dist/agent-proxy) instead of source"),
    ),
    extraEnv: Flag.KeyValuePair("env").pipe(
      Flag.optional,
      Flag.withDescription(
        "Set or override a variable for this invocation, e.g. --env AGENT_PROXY_CONFIG=/tmp/c.toml",
      ),
    ),
    unset: Flag.String("unset").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Remove a sandbox variable for this invocation, e.g. --unset HOME"),
    ),
    args: Argument.String("args").pipe(
      Argument.variadic(),
      Argument.withDescription("Arguments for agent-proxy; put them after --"),
    ),
  },
  ({ run: id, built, extraEnv, unset, args }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const run = yield* Runs.resolve(repo, id).pipe(Effect.mapError(asUserError))
      const entry = built ? repo.cliBuilt : repo.cliSource
      if (built && !(yield* fs.exists(entry).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new CliError.UserError({
          cause: undefined,
          userMessage: "apps/cli/dist/agent-proxy is missing; run `bun run build` first",
        })
      }
      const merged = { ...run.sandbox.env, ...Option.getOrElse(extraEnv, () => ({})) }
      const sandbox = {
        ...run.sandbox,
        env: Object.fromEntries(Object.entries(merged).filter(([key]) => !unset.includes(key))),
      }
      const result = yield* runCli(sandbox, entry, args, { cwd: repo.root }).pipe(
        Effect.mapError(asUserError),
      )
      const prefix = yield* Runs.nextArtifact(run, `cli-${args[0] ?? "root"}`).pipe(
        Effect.mapError(asUserError),
      )
      const evidence = `${prefix}.json`
      // PATH is inherited from the developer's shell and only adds noise to evidence.
      const { PATH: _inherited, ...sandboxEnv } = sandbox.env
      const record = { entry: relative(entry), env: sandboxEnv, ...result }
      yield* fs
        .writeFileString(evidence, `${JSON.stringify(record, null, 2)}\n`)
        .pipe(Effect.mapError(asUserError))
      if (result.stdout !== "") yield* Console.log(result.stdout.trimEnd())
      if (result.stderr !== "") yield* Console.error(result.stderr.trimEnd())
      yield* Console.log(
        `-- exit ${result.exitCode} · ${result.durationMs}ms · evidence ${relative(evidence)}`,
      )
      if (result.exitCode !== 0) {
        return yield* new ExitWith({ code: result.exitCode })
      }
    }),
).pipe(Command.withDescription("Run agent-proxy in the sandbox and record the result as evidence"))

const web = Command.make(
  "web",
  {
    run: runFlag,
    dev: Flag.Boolean("dev").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Run the Vite dev server with hot reload instead of the built preview"),
    ),
    restart: Flag.Boolean("restart").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Stop the run's web server first, then start a fresh one"),
    ),
  },
  ({ run: id, dev, restart }) =>
    Effect.gen(function* () {
      const run = yield* Runs.resolve(repo, id)
      const mode: Web.WebMode = dev ? "dev" : "preview"
      const existing = run.manifest.processes.find((record) => record.name === "web")
      if (existing !== undefined && !restart && existing.mode === mode) {
        if ((yield* Processes.isOwned(existing)) && (yield* Web.isReady(existing.url))) {
          yield* Console.log(`web      ${existing.url} (already running, ${existing.mode})`)
          return
        }
      }
      // Web.start records the new server and stops the one it replaces.
      const record = yield* Web.start(repo, run, mode)
      yield* Console.log(
        [
          `web      ${record.url}`,
          `mode     ${record.mode}`,
          `pid      ${record.pid}`,
          `log      ${relative(record.log)}`,
        ].join("\n"),
      )
    }).pipe(Effect.mapError(asUserError)),
).pipe(Command.withDescription("Serve the web client for this run on a free port"))

const browse = Command.make(
  "browse",
  {
    run: runFlag,
    label: Flag.String("label").pipe(
      Flag.optional,
      Flag.withDescription("Name for the evidence files (default: derived from the path)"),
    ),
    target: Argument.String("path").pipe(
      Argument.withDefault("/"),
      Argument.withDescription("Path on the run's web server, starting with /"),
    ),
  },
  ({ run: id, label, target }) =>
    Effect.gen(function* () {
      const run = yield* Runs.resolve(repo, id).pipe(Effect.mapError(asUserError))
      if (!target.startsWith("/") || target.startsWith("//")) {
        return yield* userError(`Expected a path starting with a single /, got "${target}"`)
      }
      // Only drive a server this run started and that is ready now.
      const server = run.manifest.processes.find((record) => record.name === "web")
      if (server === undefined) {
        return yield* userError("This run has no web server; start one with `bun run verify web`")
      }
      if (!(yield* Processes.isOwned(server)) || !(yield* Web.isReady(server.url))) {
        return yield* userError(
          "The run's web server is not running or not ready; restart it with `bun run verify web --restart`",
        )
      }
      const url = new URL(target, server.url).toString()
      const name = Option.getOrElse(label, () => target.replaceAll(/^\/+|\/+$/g, "") || "home")
      const report = yield* Browse.capture(run, url, name).pipe(Effect.mapError(asUserError))
      const sameOrigin = new URL(report.finalUrl).origin === new URL(server.url).origin
      yield* Console.log(
        [
          `url       ${report.finalUrl}${sameOrigin ? "" : "  (left the run's server)"}`,
          `status    ${report.status}`,
          `title     ${report.title}`,
          `console   ${report.consoleErrors.length} error(s)${report.consoleErrors.map((e) => `\n  ${e}`).join("")}`,
          `pageerror ${report.pageErrors.length}${report.pageErrors.map((e) => `\n  ${e}`).join("")}`,
          `evidence  ${relative(report.files.screenshot)}`,
          `          ${relative(report.files.aria)}`,
          `          ${relative(report.files.report)}`,
        ].join("\n"),
      )
      const clean =
        sameOrigin &&
        report.status > 0 &&
        report.status < 400 &&
        report.consoleErrors.length === 0 &&
        report.pageErrors.length === 0
      if (!clean) {
        return yield* new ExitWith({ code: 1 })
      }
    }),
).pipe(
  Command.withDescription(
    "Load a page from the run's web server in headless Chromium; save a screenshot, accessibility tree, and errors",
  ),
)

const down = Command.make(
  "down",
  {
    run: runFlag,
    all: Flag.Boolean("all").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Tear down every run that is still up"),
    ),
  },
  ({ run: id, all }) =>
    Effect.gen(function* () {
      const runs = all ? yield* Runs.list(repo) : [yield* Runs.resolve(repo, id)]
      const live = runs.filter((run) => run.manifest.status === "up")
      if (live.length === 0) {
        yield* Console.log("nothing to tear down")
      }
      const kept = yield* Effect.forEach(live, (run) => Down.tearDown(repo, run)).pipe(
        Effect.mapError(asUserError),
      )
      // A run kept up because its daemon would not stop is a failure to report.
      if (kept.some(Option.isSome)) {
        return yield* new ExitWith({ code: 1 })
      }
    }),
).pipe(
  Command.withDescription(
    "Stop the processes this run started and delete its state; keep evidence",
  ),
)

const ls = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const runs = yield* Runs.list(repo)
    if (runs.length === 0) {
      yield* Console.log("no runs")
      return
    }
    const counts = yield* Effect.forEach(runs, Runs.evidenceCount)
    yield* Console.log(
      runs
        .map(
          ({ manifest }, i) =>
            `${manifest.id}  ${manifest.status.padEnd(4)}  ${manifest.gitHead.padEnd(14)}  ${counts[i] ?? 0} capture(s)  ${manifest.processes.map((p) => `${p.name}:${p.pid}`).join(" ")}`,
        )
        .join("\n"),
    )
  }).pipe(Effect.mapError(asUserError)),
).pipe(Command.withDescription("List runs, oldest first"))

const prune = Command.make("prune", {}, () =>
  Effect.gen(function* () {
    const runs = (yield* Runs.list(repo)).filter((run) => run.manifest.status === "down")
    yield* Effect.forEach(runs, (run) => Sandbox.destroy(run.sandbox, { keepArtifacts: false }), {
      discard: true,
    })
    yield* Console.log(`pruned ${runs.length} finished run(s), evidence included`)
  }).pipe(Effect.mapError(asUserError)),
).pipe(Command.withDescription("Delete runs that are down, including their evidence"))

const verify = Command.make("verify").pipe(
  Command.withDescription("Launch, check, drive, and tear down agent-proxy in a sandbox"),
  Command.withSubcommands([up, shell, doctor, cli, web, browse, down, ls, prune]),
)

Command.run(verify, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain,
)
