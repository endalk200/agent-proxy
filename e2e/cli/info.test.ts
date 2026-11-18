import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"

// Black-box: run the built binary as a user would, in a sandbox whose HOME and
// XDG directories are throwaway, and check only stdout, stderr, and exit code.
const agentProxy = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
    const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
    const result = yield* runCli(sandbox, defaultRepo.cliBuilt, args, { cwd: root })
    return { sandbox, result }
  })

const Info = Schema.fromJsonString(
  Schema.Struct({ runtime: Schema.String, configPath: Schema.String }),
)

layer(BunServices.layer)("agent-proxy (built binary)", (it) => {
  it.effect("prints its version", () =>
    Effect.gen(function* () {
      const { result } = yield* agentProxy(["--version"])
      expect(result.exitCode).toBe(0)
      // The compiled binary names the commit it was built from.
      expect(result.stdout.trim()).toMatch(/^agent-proxy v\d+\.\d+\.\d+ \([0-9a-f]{7,}(-dirty)?\)$/)
    }),
  )

  it.effect("info --json reports the runtime and the config path inside its home", () =>
    Effect.gen(function* () {
      const { sandbox, result } = yield* agentProxy(["info", "--json"])
      expect(result.exitCode).toBe(0)
      const info = yield* Schema.decodeEffect(Info)(result.stdout)
      expect(info.runtime).toBe("bun")
      expect(info.configPath).toBe(sandbox.configFile)
    }),
  )

  it.effect("exits non-zero on an unknown subcommand", () =>
    Effect.gen(function* () {
      const { result } = yield* agentProxy(["bogus"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout + result.stderr).toContain('Unknown subcommand "bogus"')
    }),
  )
})
