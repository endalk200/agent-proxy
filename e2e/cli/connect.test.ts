import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { TestClock } from "effect/testing"

// `connect claude-code` and `connect opencode`, black-box: the built binary in a sandbox, whose HOME
// stands in for the owner's. Only the paths that never ask are driven here,
// because the sandbox gives the binary no terminal to answer in; confirming,
// declining and the `.bak` are covered in-process with a controlled terminal.

const StateFile = Schema.fromJsonString(Schema.Struct({ address: Schema.String }))

const sandboxed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
  const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
  const agentProxy = (args: ReadonlyArray<string>) =>
    runCli(sandbox, defaultRepo.cliBuilt, args, { cwd: root })
  // Registered after the sandbox, so it runs before the sandbox is removed.
  yield* Effect.addFinalizer(() => agentProxy(["daemon", "stop"]).pipe(Effect.ignore))
  const address = fs.readFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`).pipe(
    Effect.flatMap(Schema.decodeEffect(StateFile)),
    Effect.map((state) => state.address),
  )
  const claudeDir = `${sandbox.home}/.claude`
  return { sandbox, agentProxy, address, claudeDir, settings: `${claudeDir}/settings.json` }
})

/** The key helper the compiled binary writes: its own absolute path, which a GUI client finds without PATH. */
const KEY_HELPER = `${defaultRepo.cliBuilt} key`

const settingsFor = (address: string) =>
  `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "${address}"\n  },\n  "apiKeyHelper": "${KEY_HELPER}"\n}\n`

layer(BunServices.layer)("agent-proxy connect claude-code (built binary)", (it) => {
  it.effect("needs the daemon running to learn an address the config leaves open", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { agentProxy, claudeDir } = yield* sandboxed
        const result = yield* agentProxy(["connect", "claude-code"])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain(
          "The agent-proxy daemon is not running, and config.toml lets it listen on any free port",
        )
        expect(yield* fs.exists(claudeDir)).toBe(false)
      }),
    ),
  )

  it.effect(
    "--print prints the daemon's settings, a valid file is reported connected, and invalid JSON is refused",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { agentProxy, address, claudeDir, settings } = yield* sandboxed
          expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
          const proxy = yield* address

          const printed = yield* agentProxy(["connect", "claude-code", "--print"])
          expect(printed.exitCode).toBe(0)
          expect(printed.stdout).toBe(settingsFor(proxy))
          expect(printed.stderr).toBe("Add these settings to ~/.claude/settings.json:\n")
          expect(yield* fs.exists(claudeDir)).toBe(false)

          yield* fs.makeDirectory(claudeDir)
          const connected = `{ "model": "opus", "env": { "ANTHROPIC_BASE_URL": "${proxy}" }, "apiKeyHelper": "${KEY_HELPER}" }\n`
          yield* fs.writeFileString(settings, connected)
          const again = yield* agentProxy(["connect", "claude-code"])
          expect(again.exitCode).toBe(0)
          expect(again.stdout).toBe(
            `Claude Code is already connected to the proxy at ${proxy}; ~/.claude/settings.json is unchanged.\n`,
          )
          expect(yield* fs.readFileString(settings)).toBe(connected)

          yield* fs.writeFileString(settings, "{ not json\n")
          const refused = yield* agentProxy(["connect", "claude-code"])
          expect(refused.exitCode).toBe(1)
          expect(refused.stderr).toContain("~/.claude/settings.json is not valid JSON (")
          expect(yield* fs.readFileString(settings)).toBe("{ not json\n")
          expect(yield* fs.readDirectory(claudeDir)).toStrictEqual(["settings.json"])
        }),
      ),
    60_000,
  )
})

layer(BunServices.layer)("agent-proxy connect opencode (built binary)", (it) => {
  it.effect(
    "--print names the sandbox's key file, and a file that already holds it is reported connected",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const { sandbox, agentProxy, address } = yield* sandboxed
          expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
          const proxy = yield* address
          const opencodeDir = `${sandbox.configHome}/opencode`
          const config = `${opencodeDir}/opencode.json`

          const printed = yield* agentProxy(["connect", "opencode", "--print"])
          expect(printed.exitCode).toBe(0)
          expect(printed.stderr).toContain(`Add these settings to ${config}:\n`)
          expect(yield* fs.exists(opencodeDir)).toBe(false)
          // The sandbox's XDG_DATA_HOME lies outside its HOME: the key file by its absolute path.
          const keyFile = `${sandbox.dataHome}/agent-proxy/key`
          const providers = JSON.parse(printed.stdout).providers
          expect(providers["claude-agent"].settings).toStrictEqual({
            baseURL: proxy,
            apiKey: `{file:${keyFile}}`,
          })
          expect(providers["agent-proxy-codex"].settings).toStrictEqual({
            baseURL: `${proxy}/backend-api/codex`,
            apiKey: `{file:${keyFile}}`,
          })
          const key = yield* agentProxy(["key"])
          expect((yield* fs.readFileString(keyFile)).trim()).toBe(key.stdout.trim())

          yield* fs.makeDirectory(opencodeDir, { recursive: true })
          const connected = `// connected by hand\n${printed.stdout}`
          yield* fs.writeFileString(config, connected)
          const again = yield* agentProxy(["connect", "opencode"])
          expect(again.exitCode).toBe(0)
          expect(again.stdout).toBe(
            `opencode is already connected to the proxy at ${proxy}; ${config} is unchanged.\n`,
          )
          expect(yield* fs.readFileString(config)).toBe(connected)
        }),
      ),
    60_000,
  )
})
