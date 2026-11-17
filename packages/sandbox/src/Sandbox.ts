import { Config, Effect, FileSystem, Path } from "effect"

/**
 * An isolated environment for running agent-proxy.
 *
 * Every per-user location the CLI and daemon can touch (home, XDG config,
 * state, cache, data, temp) points inside `dir`, so a run never reads or
 * writes the developer's real configuration and never meets their daemon.
 */
export interface Sandbox {
  readonly dir: string
  readonly home: string
  readonly configHome: string
  readonly stateHome: string
  readonly cacheHome: string
  readonly dataHome: string
  readonly tmp: string
  readonly logs: string
  readonly artifacts: string
  /** Where agent-proxy resolves its config file inside this sandbox. */
  readonly configFile: string
  /** The complete environment for processes in the sandbox. Only PATH is inherited. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Written to `configFile` so runs start from a known config. The daemon binds
 * any free port, so parallel runs never collide (ADR-0002); the state file
 * records the port it got.
 */
export const CONFIG_FIXTURE = 'listen = "127.0.0.1:0"\n'

/** Computes the sandbox layout for `dir` without touching the filesystem. */
export const layout = (path: Path.Path, dir: string, inheritedPath: string): Sandbox => {
  const home = path.join(dir, "home")
  const configHome = path.join(dir, "config")
  const stateHome = path.join(dir, "state")
  const cacheHome = path.join(dir, "cache")
  const dataHome = path.join(dir, "data")
  const tmp = path.join(dir, "tmp")
  return {
    dir,
    home,
    configHome,
    stateHome,
    cacheHome,
    dataHome,
    tmp,
    logs: path.join(dir, "logs"),
    artifacts: path.join(dir, "artifacts"),
    configFile: path.join(configHome, "agent-proxy", "config.toml"),
    env: {
      PATH: inheritedPath,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
      TMPDIR: tmp,
      NO_COLOR: "1",
    },
  }
}

/** Directories removed when a sandbox is torn down. `artifacts` is not among them. */
const scratchDirs = (sandbox: Sandbox) => [
  sandbox.home,
  sandbox.configHome,
  sandbox.stateHome,
  sandbox.cacheHome,
  sandbox.dataHome,
  sandbox.tmp,
  sandbox.logs,
]

/** Opens an existing sandbox directory, or lays out a new one, without creating anything. */
export const at = Effect.fn("Sandbox.at")(function* (dir: string) {
  const path = yield* Path.Path
  const inheritedPath = yield* Config.String("PATH")
  return layout(path, path.resolve(dir), inheritedPath)
})

/** Creates the sandbox directories and writes the config fixture. */
export const create = Effect.fn("Sandbox.create")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sandbox = yield* at(dir)
  yield* Effect.forEach(
    [...scratchDirs(sandbox), sandbox.artifacts, path.dirname(sandbox.configFile)],
    (directory) => fs.makeDirectory(directory, { recursive: true }),
    { discard: true },
  )
  yield* fs.writeFileString(sandbox.configFile, CONFIG_FIXTURE)
  return sandbox
})

/** Removes everything the sandbox created. With `keepArtifacts`, the evidence survives. */
export const destroy = Effect.fn("Sandbox.destroy")(function* (
  sandbox: Sandbox,
  options: { readonly keepArtifacts: boolean },
) {
  const fs = yield* FileSystem.FileSystem
  const targets = options.keepArtifacts ? scratchDirs(sandbox) : [sandbox.dir]
  yield* Effect.forEach(targets, (target) => fs.remove(target, { recursive: true, force: true }), {
    discard: true,
  })
})

/** A sandbox that is created now and destroyed, artifacts included, when the scope closes. */
export const scoped = (dir: string) =>
  Effect.acquireRelease(create(dir), (sandbox) =>
    destroy(sandbox, { keepArtifacts: false }).pipe(Effect.orDie),
  )
