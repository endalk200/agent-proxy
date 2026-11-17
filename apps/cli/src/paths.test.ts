import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Path } from "effect"

import { resolveConfigPath, resolveDataDir, resolveStateDir } from "./paths.ts"

const resolveWith = (env: Record<string, string>) =>
  resolveConfigPath.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
  )

layer(Path.layer)("resolveConfigPath", (it) => {
  it.effect("prefers AGENT_PROXY_CONFIG over everything else", () =>
    Effect.gen(function* () {
      const path = yield* resolveWith({
        AGENT_PROXY_CONFIG: "/etc/agent-proxy.toml",
        XDG_CONFIG_HOME: "/xdg",
        HOME: "/home/me",
      })
      expect(path).toBe("/etc/agent-proxy.toml")
    }),
  )

  it.effect("falls back to XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const path = yield* resolveWith({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" })
      expect(path).toBe("/xdg/agent-proxy/config.toml")
    }),
  )

  it.effect("falls back to HOME/.config", () =>
    Effect.gen(function* () {
      const path = yield* resolveWith({ HOME: "/home/me" })
      expect(path).toBe("/home/me/.config/agent-proxy/config.toml")
    }),
  )

  it.effect("fails when no location can be derived", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveWith({}))
      expect(error._tag).toBe("ConfigError")
    }),
  )

  it.effect("keeps daemon state under XDG_STATE_HOME", () =>
    Effect.gen(function* () {
      const dir = yield* resolveStateDir.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ XDG_STATE_HOME: "/state", HOME: "/home/me" }),
        ),
      )
      expect(dir).toBe("/state/agent-proxy")
    }),
  )

  it.effect("keeps daemon state under HOME/.local/state without XDG_STATE_HOME", () =>
    Effect.gen(function* () {
      const dir = yield* resolveStateDir.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ HOME: "/home/me" }),
        ),
      )
      expect(dir).toBe("/home/me/.local/state/agent-proxy")
    }),
  )

  it.effect("keeps accounts under XDG_DATA_HOME", () =>
    Effect.gen(function* () {
      const dir = yield* resolveDataDir.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ XDG_DATA_HOME: "/data", HOME: "/home/me" }),
        ),
      )
      expect(dir).toBe("/data/agent-proxy")
    }),
  )

  it.effect("keeps accounts under HOME/.local/share without XDG_DATA_HOME", () =>
    Effect.gen(function* () {
      const dir = yield* resolveDataDir.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ HOME: "/home/me" }),
        ),
      )
      expect(dir).toBe("/home/me/.local/share/agent-proxy")
    }),
  )
})
