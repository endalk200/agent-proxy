import { spawnSync } from "node:child_process"

import { Config, Context, Data, Effect, FileSystem, Layer, Option, Path } from "effect"

import { writeFileAtomic } from "./atomic-file.ts"

/**
 * The launch agent that supervises the daemon on macOS (ADR-0008): it runs the
 * installed binary's `daemon run` at login and again after a crash, but not
 * after a clean exit.
 *
 * Kept behind a service, alongside `Processes`, so commands never run
 * `launchctl` or touch `~/Library/LaunchAgents` themselves: `bin.ts` provides
 * `layer`, and tests a fake that records what was asked of it.
 */

/** The launch agent's label, and the name of its plist. */
export const LABEL = "dev.endalk200.agent-proxy"

export class LaunchdError extends Data.TaggedError("LaunchdError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** The launch agent's job, as launchd has it loaded. */
export interface Job {
  /** The pid launchd runs it as, `None` while it is not running. */
  readonly pid: Option.Option<number>
  /** How its last run ended, `None` when it has never exited. */
  readonly lastExitCode: Option.Option<number>
}

const failed = (message: string) => (cause: unknown) => new LaunchdError({ message, cause })

/** Runs `launchctl` with `args`, and returns its exit status and output. */
const launchctl = (args: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const result = spawnSync("launchctl", args, { encoding: "utf8" })
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    }
  })

export class Launchd extends Context.Service<
  Launchd,
  {
    /** Where the plist lives: `$HOME/Library/LaunchAgents/dev.endalk200.agent-proxy.plist`. */
    readonly plistFile: Effect.Effect<string, LaunchdError>
    /** The plist's content, `None` when the launch agent is not installed. */
    readonly readPlist: Effect.Effect<Option.Option<string>, LaunchdError>
    readonly writePlist: (content: string) => Effect.Effect<void, LaunchdError>
    readonly removePlist: Effect.Effect<void, LaunchdError>
    /** Loads the plist into launchd, which starts the job at once (`RunAtLoad`). */
    readonly bootstrap: Effect.Effect<void, LaunchdError>
    /** Unloads the job, stopping it if it runs. Succeeds when it was not loaded. */
    readonly bootout: Effect.Effect<void, LaunchdError>
    /** Runs the job now; with `kill`, stops a running one first. */
    readonly kickstart: (options: { readonly kill: boolean }) => Effect.Effect<void, LaunchdError>
    /** The loaded job, `None` when launchd has not loaded it. */
    readonly job: Effect.Effect<Option.Option<Job>, LaunchdError>
  }
>()("agent-proxy/Launchd") {
  /** The real launchd, through `launchctl`, in the current user's GUI domain. */
  static readonly layer = Layer.effect(
    Launchd,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const plistFile = Config.NonEmptyString("HOME").pipe(
        Effect.map((home) => path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`)),
        Effect.mapError(failed("HOME is not set, so the launch agent's plist cannot be found.")),
      )
      const domain = `gui/${process.getuid?.() ?? 0}`
      const service = `${domain}/${LABEL}`

      const run = (args: ReadonlyArray<string>, what: string) =>
        Effect.flatMap(launchctl(args), (result) =>
          result.status === 0
            ? Effect.void
            : Effect.fail(
                new LaunchdError({
                  message: `launchctl could not ${what} (exit ${result.status}): ${result.output}`,
                }),
              ),
        )

      return Launchd.of({
        plistFile,
        readPlist: Effect.flatMap(plistFile, (file) =>
          fs.readFileString(file).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeedNone,
            ),
            Effect.mapError(failed(`Could not read ${file}`)),
          ),
        ),
        writePlist: (content) =>
          Effect.flatMap(plistFile, (file) =>
            fs
              .makeDirectory(path.dirname(file), { recursive: true })
              .pipe(
                Effect.andThen(writeFileAtomic(file, content, { mode: 0o644 })),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.mapError(failed(`Could not write ${file}`)),
              ),
          ),
        removePlist: Effect.flatMap(plistFile, (file) =>
          fs
            .remove(file, { force: true })
            .pipe(Effect.mapError(failed(`Could not remove ${file}`))),
        ),
        bootstrap: Effect.flatMap(plistFile, (file) =>
          run(["bootstrap", domain, file], "load the launch agent"),
        ),
        bootout: Effect.flatMap(launchctl(["bootout", service]), (result) =>
          // 3 (no such process) and 113 (could not find service): it was not loaded.
          result.status === 0 || result.status === 3 || result.status === 113
            ? Effect.void
            : Effect.fail(
                new LaunchdError({
                  message: `launchctl could not unload the launch agent (exit ${result.status}): ${result.output}`,
                }),
              ),
        ),
        kickstart: ({ kill }) =>
          run(["kickstart", ...(kill ? ["-k"] : []), service], "start the launch agent"),
        job: Effect.map(launchctl(["print", service]), (result) =>
          result.status === 0 ? Option.some(parseJob(result.output)) : Option.none(),
        ),
      })
    }),
  )
}

/** Reads a job's pid and last exit code from `launchctl print`. */
export const parseJob = (printed: string): Job => {
  const number = (pattern: RegExp) => {
    const match = pattern.exec(printed)
    return match?.[1] === undefined ? Option.none<number>() : Option.some(Number(match[1]))
  }
  return {
    pid: number(/^\s*pid = (\d+)$/m),
    lastExitCode: number(/^\s*last exit code = (-?\d+)/m),
  }
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const string = (value: string) => `<string>${escapeXml(value)}</string>`

/**
 * The launch agent's plist: run `program daemon run` at login and after a
 * crash, but not after a clean exit, with `environment`, and its stdout and
 * stderr in `output`.
 */
export const plist = (options: {
  readonly program: string
  readonly environment: Readonly<Record<string, string>>
  readonly output: string
}) => {
  const environment = Object.entries(options.environment)
    .map(([name, value]) => `\t\t<key>${escapeXml(name)}</key>\n\t\t${string(value)}`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${string(LABEL)}
\t<key>ProgramArguments</key>
\t<array>
\t\t${string(options.program)}
\t\t<string>daemon</string>
\t\t<string>run</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${environment}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>StandardOutPath</key>
\t${string(options.output)}
\t<key>StandardErrorPath</key>
\t${string(options.output)}
</dict>
</plist>
`
}

/** Set in the plist's environment, so `daemon run` knows launchd supervises it. */
export const SUPERVISED_VARIABLE = "AGENT_PROXY_SUPERVISED"

/** True when this `daemon run` runs under the launch agent. */
export const isSupervised = Config.Boolean(SUPERVISED_VARIABLE).pipe(Config.withDefault(false))
