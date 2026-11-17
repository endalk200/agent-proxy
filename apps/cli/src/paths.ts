import { Config, Effect, Option, Path } from "effect"

/**
 * Where agent-proxy looks for its configuration file, in priority order:
 *
 * 1. `AGENT_PROXY_CONFIG`, used as-is (resolved against the working directory).
 * 2. `$XDG_CONFIG_HOME/agent-proxy/config.toml`.
 * 3. `$HOME/.config/agent-proxy/config.toml`.
 *
 * `explicit` is true when `AGENT_PROXY_CONFIG` named the file. Only the path
 * is resolved here; nothing is read from disk.
 */
export const resolveConfigFile = Effect.gen(function* () {
  const path = yield* Path.Path
  const explicit = yield* Config.option(Config.NonEmptyString("AGENT_PROXY_CONFIG"))
  if (Option.isSome(explicit)) {
    return { path: path.resolve(explicit.value), explicit: true }
  }
  const xdgConfigHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME"))
  const configHome = Option.isSome(xdgConfigHome)
    ? xdgConfigHome.value
    : path.join(yield* Config.NonEmptyString("HOME"), ".config")
  return { path: path.join(configHome, "agent-proxy", "config.toml"), explicit: false }
})

/** The config file path from `resolveConfigFile`. */
export const resolveConfigPath = Effect.map(resolveConfigFile, (file) => file.path)

/**
 * Where the daemon keeps its lock, state file, and logs:
 * `$XDG_STATE_HOME/agent-proxy`, else `$HOME/.local/state/agent-proxy`.
 */
export const resolveStateDir = Effect.gen(function* () {
  const path = yield* Path.Path
  const xdgStateHome = yield* Config.option(Config.NonEmptyString("XDG_STATE_HOME"))
  const stateHome = Option.isSome(xdgStateHome)
    ? xdgStateHome.value
    : path.join(yield* Config.NonEmptyString("HOME"), ".local", "state")
  return path.join(stateHome, "agent-proxy")
})
