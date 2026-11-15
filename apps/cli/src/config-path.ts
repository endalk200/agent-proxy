import { Config, Effect, Option, Path } from "effect"

/**
 * Where agent-proxy looks for its configuration file, in priority order:
 *
 * 1. `AGENT_PROXY_CONFIG`, used as-is (resolved against the working directory).
 * 2. `$XDG_CONFIG_HOME/agent-proxy/config.json`.
 * 3. `$HOME/.config/agent-proxy/config.json`.
 *
 * Only the path is resolved here; nothing is read from disk.
 */
export const resolveConfigPath = Effect.gen(function* () {
  const path = yield* Path.Path
  const explicit = yield* Config.option(Config.NonEmptyString("AGENT_PROXY_CONFIG"))
  if (Option.isSome(explicit)) {
    return path.resolve(explicit.value)
  }
  const xdgConfigHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME"))
  const configHome = Option.isSome(xdgConfigHome)
    ? xdgConfigHome.value
    : path.join(yield* Config.NonEmptyString("HOME"), ".config")
  return path.join(configHome, "agent-proxy", "config.json")
})
