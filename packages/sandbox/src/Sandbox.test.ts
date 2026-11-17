import { expect, layer } from "@effect/vitest"
import { Effect, Path } from "effect"

import { layout } from "./Sandbox.ts"

const sandboxAt = (dir: string) =>
  Effect.gen(function* () {
    return layout(yield* Path.Path, dir, "/usr/bin")
  })

layer(Path.layer)("Sandbox.layout", (it) => {
  it.effect("puts every per-user location inside the sandbox directory", () =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxAt("/runs/abc")
      const dirs = [
        sandbox.home,
        sandbox.configHome,
        sandbox.stateHome,
        sandbox.cacheHome,
        sandbox.dataHome,
        sandbox.tmp,
        sandbox.logs,
        sandbox.artifacts,
      ]
      expect(dirs.every((dir) => dir.startsWith("/runs/abc/"))).toBe(true)
    }),
  )

  it.effect("resolves the config file where agent-proxy looks under XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxAt("/runs/abc")
      expect(sandbox.configFile).toBe("/runs/abc/config/agent-proxy/config.toml")
    }),
  )

  it.effect("builds a closed environment that inherits only PATH", () =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxAt("/runs/abc")
      expect(Object.keys(sandbox.env).toSorted()).toEqual([
        "HOME",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ])
      expect(sandbox.env["PATH"]).toBe("/usr/bin")
      expect(sandbox.env["XDG_CONFIG_HOME"]).toBe(sandbox.configHome)
    }),
  )
})
