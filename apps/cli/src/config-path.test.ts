import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Path } from "effect"

import { resolveConfigPath } from "./config-path.ts"

const resolveWith = (env: Record<string, string>) =>
  resolveConfigPath.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
  )

layer(Path.layer)("resolveConfigPath", (it) => {
  it.effect("prefers AGENT_PROXY_CONFIG over everything else", () =>
    Effect.gen(function* () {
      const path = yield* resolveWith({
        AGENT_PROXY_CONFIG: "/etc/agent-proxy.json",
        XDG_CONFIG_HOME: "/xdg",
        HOME: "/home/me",
      })
      expect(path).toBe("/etc/agent-proxy.json")
    }),
  )

  it.effect("falls back to XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const path = yield* resolveWith({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" })
      expect(path).toBe("/xdg/agent-proxy/config.json")
    }),
  )

  it.effect("falls back to HOME/.config", () =>
    Effect.gen(function* () {
      const path = yield* resolveWith({ HOME: "/home/me" })
      expect(path).toBe("/home/me/.config/agent-proxy/config.json")
    }),
  )

  it.effect("fails when no location can be derived", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveWith({}))
      expect(error._tag).toBe("ConfigError")
    }),
  )
})
