import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import {
  ConfigProvider,
  Console,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schedule,
  Terminal,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { Browser } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"

// `connect claude-code` and `connect codex`, driven in-process through the
// real command tree, on a temporary HOME, against an in-process daemon
// (`daemon run`) whose address they write. The terminal the owner answers the confirmation in is the only fake.
// What the command did is read back from the files it leaves in that HOME.

const makeHome = (
  options: { readonly listen?: string; readonly env?: Readonly<Record<string, string>> } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-connect-cli-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.makeDirectory(`${root}/home`)
    yield* fs.writeFileString(
      `${root}/config/agent-proxy/config.toml`,
      `listen = "${options.listen ?? "127.0.0.1:0"}"\n`,
    )
    const home = `${root}/home`
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
      ...options.env,
    }
    const stateDir = `${root}/state/agent-proxy`
    const settings = `${home}/.claude/settings.json`
    const backup = `${settings}.bak`
    const codexConfig = `${home}/.codex/config.toml`
    const codexBackup = `${codexConfig}.bak`
    const output: Array<string> = []
    const errors: Array<string> = []
    const typed = yield* Queue.unbounded<string, Terminal.QuitError>()

    /** A terminal whose typed lines come from `typed`, and whose prompts collect in `output`. */
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Queue.take(typed).pipe(Effect.mapError(() => new Terminal.QuitError({}))),
      display: (text) =>
        Effect.sync(() => {
          output.push(text)
        }),
    })

    /** Runs `agent-proxy <argv>` in this home; stdout collects in `output`, stderr in `errors`. */
    const cli = (argv: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const start = output.length
        const console: Console.Console = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            output.push(`${args.join(" ")}\n`)
          },
          error: (...args: ReadonlyArray<unknown>) => {
            errors.push(`${args.join(" ")}\n`)
          },
        }
        yield* runCli(argv).pipe(
          Effect.provideService(Console.Console, console),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
          Effect.provideService(Terminal.Terminal, terminal),
        )
        return output.slice(start).join("")
      })

    /** Runs a command that should fail, and returns the message the owner sees. */
    const fails = (argv: ReadonlyArray<string>) =>
      Effect.map(Effect.flip(cli(argv)), (error) =>
        error._tag === "UserError" ? error.userMessage : String(error),
      )

    /** Runs `agent-proxy daemon run` in the background, and returns the address it listens on. */
    const runDaemon = Effect.gen(function* () {
      yield* Effect.forkScoped(cli(["daemon", "run"]))
      yield* fs.exists(`${stateDir}/daemon.json`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (exists) => exists,
          times: 250,
        }),
      )
      const state: unknown = JSON.parse(yield* fs.readFileString(`${stateDir}/daemon.json`))
      return typeof state === "object" && state !== null && "address" in state
        ? String(state.address)
        : ""
    })

    /** Waits until the CLI has asked the owner something, and returns all it printed so far. */
    const asked = Effect.sync(() => output.join("")).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("20 millis"),
        until: (text) => text.includes("[y/N]"),
        times: 250,
      }),
    )

    /** A file's content, or `None` when it does not exist. */
    const read = (file: string) =>
      Effect.gen(function* () {
        return (yield* fs.exists(file))
          ? Option.some(yield* fs.readFileString(file))
          : Option.none()
      })

    /** Runs `agent-proxy <argv>` and answers its confirmation with `answer`. */
    const answering = (argv: ReadonlyArray<string>, answer: string) =>
      Effect.gen(function* () {
        const run = yield* Effect.forkChild(cli(argv))
        // A command that ends without asking fails the test with what it did instead.
        yield* Effect.raceFirst(
          asked,
          Fiber.join(run).pipe(Effect.andThen(Effect.die("connect finished without asking"))),
        )
        yield* Queue.offer(typed, answer)
        return yield* Fiber.join(run)
      })

    /** Runs `connect claude-code <extra>` and answers its confirmation with `answer`. */
    const connect = (answer: string, extra: ReadonlyArray<string> = []) =>
      answering(["connect", "claude-code", ...extra], answer)

    /** Runs `connect codex <extra>` and answers its confirmation with `answer`. */
    const connectCodex = (answer: string, extra: ReadonlyArray<string> = []) =>
      answering(["connect", "codex", ...extra], answer)

    /** Writes `~/.codex/config.toml` as the owner had it before connecting. */
    const writeCodexConfig = (content: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${home}/.codex`, { recursive: true })
        yield* fs.writeFileString(codexConfig, content)
      })

    /** Writes `~/.claude/settings.json` as the owner had it before connecting. */
    const writeSettings = (content: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${home}/.claude`, { recursive: true })
        yield* fs.writeFileString(settings, content)
      })

    return {
      cli,
      fails,
      runDaemon,
      asked,
      read,
      connect,
      connectCodex,
      writeSettings,
      writeCodexConfig,
      typed,
      output,
      errors,
      home,
      settings,
      backup,
      codexConfig,
      codexBackup,
    }
  })

/** The settings `connect claude-code` writes into an empty file, for a daemon at `address`. */
const connectedSettings = (address: string) =>
  `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "${address}"\n  },\n  "apiKeyHelper": "agent-proxy key"\n}\n`

const services = Layer.mergeAll(
  BunServices.layer,
  RuntimeInfo.layerProcess,
  Processes.layerProcess,
  FetchHttpClient.layer,
  ProviderEndpoints.layer,
  Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
)

layer(services)("agent-proxy connect claude-code", (it) => {
  it.effect("creates a missing settings file after the owner confirms", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon

        const output = yield* home.connect("y")

        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(connectedSettings(address))
        expect(yield* home.read(home.backup)).toStrictEqual(Option.none())
        expect(output).toContain(`+    "ANTHROPIC_BASE_URL": "${address}"`)
        expect(output).toContain('+  "apiKeyHelper": "agent-proxy key"')
        expect(output).toContain(`Connected Claude Code to the proxy at ${address}.`)
      }),
    ),
  )

  it.effect("keeps every other setting, backs the file up, and writes only once confirmed", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        const before = `{
  "model": "opus",
  "env": {
    "DISABLE_TELEMETRY": "1"
  },
  "permissions": {
    "allow": ["Bash(git status)"]
  }
}
`
        yield* home.writeSettings(before)

        const run = yield* Effect.forkChild(home.cli(["connect", "claude-code"]))
        const shown = yield* home.asked
        expect(shown).toContain("--- ~/.claude/settings.json")
        expect(shown).toContain("+++ ~/.claude/settings.json")
        expect(shown).toContain(`+    "ANTHROPIC_BASE_URL": "${address}"`)
        expect(shown).toContain("Write ~/.claude/settings.json? [y/N]")
        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(before)
        expect(yield* home.read(home.backup)).toStrictEqual(Option.none())

        yield* Queue.offer(home.typed, "yes")
        const output = yield* Fiber.join(run)

        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(`{
  "model": "opus",
  "env": {
    "DISABLE_TELEMETRY": "1",
    "ANTHROPIC_BASE_URL": "${address}"
  },
  "permissions": {
    "allow": [
      "Bash(git status)"
    ]
  },
  "apiKeyHelper": "agent-proxy key"
}
`)
        expect(Option.getOrNull(yield* home.read(home.backup))).toBe(before)
        expect(output).toContain("The old settings are in ~/.claude/settings.json.bak.")
      }),
    ),
  )

  it.effect("says so and changes nothing when Claude Code is already connected", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        yield* home.writeSettings('{ "model": "opus" }\n')
        yield* home.connect("y")
        const settings = yield* home.read(home.settings)
        const backup = yield* home.read(home.backup)

        const output = yield* home.cli(["connect", "claude-code"])

        expect(output).toBe(
          `Claude Code is already connected to the proxy at ${address}; ~/.claude/settings.json is unchanged.\n`,
        )
        expect(yield* home.read(home.settings)).toStrictEqual(settings)
        expect(yield* home.read(home.backup)).toStrictEqual(backup)
      }),
    ),
  )

  it.effect("--print prints the settings to add, and writes nothing", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        const address = yield* home.runDaemon

        const output = yield* home.cli(["connect", "claude-code", "--print"])

        expect(output).toBe(connectedSettings(address))
        expect(home.errors.join("")).toBe("Add these settings to ~/.claude/settings.json:\n")
        expect(yield* fs.exists(`${home.home}/.claude`)).toBe(false)

        const before = '{ "model": "opus" }\n'
        yield* home.writeSettings(before)
        expect(yield* home.cli(["connect", "claude-code", "--print"])).toBe(
          connectedSettings(address),
        )
        expect(yield* fs.readDirectory(`${home.home}/.claude`)).toStrictEqual(["settings.json"])
        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(before)
      }),
    ),
  )

  it.effect("refuses a settings file that is not valid JSON, and leaves it as it was", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        yield* home.runDaemon
        const broken = '{ "model": "opus", }\n'
        yield* home.writeSettings(broken)

        const message = yield* home.fails(["connect", "claude-code"])

        expect(message).toMatch(
          /^~\/\.claude\/settings\.json is not valid JSON \(.+\), so it was left unchanged\. Fix it, or move it aside, and run this again\.$/,
        )
        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(broken)
        expect(yield* fs.readDirectory(`${home.home}/.claude`)).toStrictEqual(["settings.json"])

        yield* home.writeSettings('["not", "settings"]\n')
        expect(yield* home.fails(["connect", "claude-code"])).toBe(
          "~/.claude/settings.json does not hold Claude Code settings (it is not a JSON object), so it was left unchanged.",
        )
        yield* home.writeSettings('{ "env": "ANTHROPIC_BASE_URL=x" }\n')
        expect(yield* home.fails(["connect", "claude-code"])).toBe(
          "~/.claude/settings.json does not hold Claude Code settings (its env is not an object), so it was left unchanged.",
        )
      }),
    ),
  )

  it.effect("writes nothing when the owner does not confirm", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        yield* home.runDaemon
        const before = '{ "model": "opus" }\n'
        yield* home.writeSettings(before)

        for (const answer of ["", "n", "whatever"]) {
          const error = yield* Effect.flip(home.connect(answer))
          expect(error._tag === "UserError" && error.userMessage).toBe(
            "Nothing written; ~/.claude/settings.json is unchanged.",
          )
        }
        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(before)
        expect(yield* fs.readDirectory(`${home.home}/.claude`)).toStrictEqual(["settings.json"])
      }),
    ),
  )

  it.effect("takes the address from config.toml when the daemon is not running", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ listen: "0.0.0.0:9318" })

        const output = yield* home.connect("y")

        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(
          connectedSettings("http://127.0.0.1:9318"),
        )
        expect(output).toContain(
          "The daemon is not running, so Claude Code will fail until you start it with `agent-proxy daemon start`.",
        )
        expect(yield* home.cli(["connect", "claude-code", "--print"])).toBe(
          connectedSettings("http://127.0.0.1:9318"),
        )
      }),
    ),
  )

  it.effect("needs the daemon running when config.toml listens on any free port", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome({ listen: "127.0.0.1:0" })
        for (const extra of [[], ["--print"]]) {
          expect(yield* home.fails(["connect", "claude-code", ...extra])).toBe(
            "The agent-proxy daemon is not running, and config.toml lets it listen on any free port, so its address is not known yet. Start it with `agent-proxy daemon start`, then run this again.",
          )
        }
        expect(yield* home.read(home.settings)).toStrictEqual(Option.none())
      }),
    ),
  )

  it.effect("writes through a settings file linked from a dotfiles repo, and keeps its mode", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        const dotfiles = `${home.home}/dotfiles/claude`
        yield* fs.makeDirectory(dotfiles, { recursive: true })
        const before = '{ "model": "opus" }\n'
        yield* fs.writeFileString(`${dotfiles}/settings.json`, before)
        yield* fs.chmod(`${dotfiles}/settings.json`, 0o644)
        yield* fs.makeDirectory(`${home.home}/.claude`)
        yield* fs.symlink(`${dotfiles}/settings.json`, home.settings)

        yield* home.connect("y")

        expect((yield* fs.lstat(home.settings)).type).toBe("SymbolicLink")
        const linked = yield* fs.readFileString(`${dotfiles}/settings.json`)
        expect(linked).toContain(`"ANTHROPIC_BASE_URL": "${address}"`)
        expect((yield* fs.stat(`${dotfiles}/settings.json`)).mode & 0o777).toBe(0o644)
        expect(yield* fs.readDirectory(dotfiles)).toStrictEqual(["settings.json"])
        expect(Option.getOrNull(yield* home.read(home.backup))).toBe(before)
      }),
    ),
  )

  it.effect("refuses a settings link whose target does not exist, and keeps the link", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        yield* home.runDaemon
        const target = `${home.home}/dotfiles/claude/settings.json`
        yield* fs.makeDirectory(`${home.home}/.claude`, { recursive: true })
        yield* fs.symlink(target, home.settings)

        const message = yield* home.fails(["connect", "claude-code"])

        expect(message).toContain("does not exist")
        expect((yield* fs.lstat(home.settings)).type).toBe("SymbolicLink")
        expect(yield* fs.exists(target)).toBe(false)
      }),
    ),
  )

  it.effect("writes nothing when the settings file changes while the owner decides", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.runDaemon
        yield* home.writeSettings('{ "model": "opus" }\n')

        const run = yield* Effect.forkChild(home.fails(["connect", "claude-code"]))
        yield* home.asked
        const meanwhile = '{ "model": "sonnet" }\n'
        yield* home.writeSettings(meanwhile)
        yield* Queue.offer(home.typed, "y")

        expect(yield* Fiber.join(run)).toBe(
          "~/.claude/settings.json changed while you were deciding, so nothing was written. Run this again to see the change against it.",
        )
        expect(Option.getOrNull(yield* home.read(home.settings))).toBe(meanwhile)
        expect(yield* home.read(home.backup)).toStrictEqual(Option.none())
      }),
    ),
  )
})

/** The config `connect codex` writes into an empty file, for a daemon at `address`. */
const connectedCodexConfig = (address: string) => `model_provider = "agent-proxy"

[model_providers.agent-proxy]
name = "OpenAI"
base_url = "${address}/backend-api/codex"
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }
`

layer(services)("agent-proxy connect codex", (it) => {
  it.effect("creates a missing config.toml after the owner confirms", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon

        const output = yield* home.connectCodex("y")

        expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(
          connectedCodexConfig(address),
        )
        expect(yield* home.read(home.codexBackup)).toStrictEqual(Option.none())
        expect(output).toContain(
          `Connecting Codex to the proxy at ${address} changes ~/.codex/config.toml:`,
        )
        expect(output).toContain("--- /dev/null")
        expect(output).toContain('+model_provider = "agent-proxy"')
        expect(output).toContain("Write ~/.codex/config.toml? [y/N]")
        expect(output).toContain(`Connected Codex to the proxy at ${address}.`)
      }),
    ),
  )

  it.effect(
    "replaces model_provider, keeps the rest byte for byte, backs it up, and writes only once confirmed",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome()
          const address = yield* home.runDaemon
          const before = `# Codex settings, kept in dotfiles.
model = "gpt-5.5"   # the default model
model_provider = 'openai' # was the built-in provider
approval_policy = "on-request"

[model_providers.lmstudio-local]
name = "LM Studio"
base_url = "http://localhost:1234/v1"

# Project trust
[projects."/Users/me/src"]
trust_level = "trusted"
`
          yield* home.writeCodexConfig(before)

          const run = yield* Effect.forkChild(home.cli(["connect", "codex"]))
          const shown = yield* home.asked
          expect(shown).toContain("--- ~/.codex/config.toml")
          expect(shown).toContain("+++ ~/.codex/config.toml")
          expect(shown).toContain("-model_provider = 'openai' # was the built-in provider")
          expect(shown).toContain('+model_provider = "agent-proxy" # was the built-in provider')
          expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(before)

          yield* Queue.offer(home.typed, "y")
          const output = yield* Fiber.join(run)

          expect(Option.getOrNull(yield* home.read(home.codexConfig)))
            .toBe(`# Codex settings, kept in dotfiles.
model = "gpt-5.5"   # the default model
model_provider = "agent-proxy" # was the built-in provider
approval_policy = "on-request"

[model_providers.lmstudio-local]
name = "LM Studio"
base_url = "http://localhost:1234/v1"

# Project trust
[projects."/Users/me/src"]
trust_level = "trusted"

[model_providers.agent-proxy]
name = "OpenAI"
base_url = "${address}/backend-api/codex"
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }
`)
          expect(Option.getOrNull(yield* home.read(home.codexBackup))).toBe(before)
          expect(output).toContain("The old settings are in ~/.codex/config.toml.bak.")
        }),
      ),
  )

  it.effect(
    "replaces an agent-proxy provider table in place, and adds model_provider after the root settings",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome()
          const address = yield* home.runDaemon
          yield* home.writeCodexConfig(`model = "gpt-5.5"
# no model_provider yet

[model_providers.agent-proxy]   # set up by hand
name = "agent-proxy"
base_url = "http://127.0.0.1:9999/v1"
requires_openai_auth = true
# an old note

# Local models
[model_providers.lmstudio-local]
name = "LM Studio"
`)

          yield* home.connectCodex("y")

          expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(`model = "gpt-5.5"
model_provider = "agent-proxy"
# no model_provider yet

[model_providers.agent-proxy]
name = "OpenAI"
base_url = "${address}/backend-api/codex"
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }

# Local models
[model_providers.lmstudio-local]
name = "LM Studio"
`)
        }),
      ),
  )

  it.effect(
    "puts model_provider above the first table and its comments when there are no root settings",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome()
          const address = yield* home.runDaemon
          yield* home.writeCodexConfig(`# My Codex config

# MCP servers
[mcp_servers.docs]
command = "docs-mcp"
`)

          yield* home.connectCodex("y")

          expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(`# My Codex config

model_provider = "agent-proxy"

# MCP servers
[mcp_servers.docs]
command = "docs-mcp"

[model_providers.agent-proxy]
name = "OpenAI"
base_url = "${address}/backend-api/codex"
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }
`)
        }),
      ),
  )

  it.effect("says so and changes nothing when Codex is already connected", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        yield* home.writeCodexConfig('model = "gpt-5.5"\n')
        yield* home.connectCodex("y")
        const config = yield* home.read(home.codexConfig)
        const backup = yield* home.read(home.codexBackup)

        const output = yield* home.cli(["connect", "codex"])

        expect(output).toBe(
          `Codex is already connected to the proxy at ${address}; ~/.codex/config.toml is unchanged.\n`,
        )
        expect(yield* home.read(home.codexConfig)).toStrictEqual(config)
        expect(yield* home.read(home.codexBackup)).toStrictEqual(backup)
      }),
    ),
  )

  it.effect("--print prints the settings to add, and writes nothing", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        const address = yield* home.runDaemon

        const output = yield* home.cli(["connect", "codex", "--print"])

        expect(output).toBe(connectedCodexConfig(address))
        expect(home.errors.join("")).toBe("Add these settings to ~/.codex/config.toml:\n")
        expect(yield* fs.exists(`${home.home}/.codex`)).toBe(false)
      }),
    ),
  )

  it.effect("refuses a config.toml that is not valid TOML, and leaves it as it was", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        yield* home.runDaemon
        const broken = 'model = "gpt-5.5\n'
        yield* home.writeCodexConfig(broken)

        const message = yield* home.fails(["connect", "codex"])

        expect(message).toMatch(
          /^~\/\.codex\/config\.toml is not valid TOML \(.+\), so it was left unchanged\. Fix it, or move it aside, and run this again\.$/,
        )
        expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(broken)
        expect(yield* fs.readDirectory(`${home.home}/.codex`)).toStrictEqual(["config.toml"])
      }),
    ),
  )

  it.effect("refuses a provider it cannot change safely, and leaves the file as it was", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.runDaemon
        const unsafe = [
          // The provider in dotted keys: a second table would redefine it.
          `model_providers.agent-proxy.name = "agent-proxy"
model_providers.agent-proxy.base_url = "http://127.0.0.1:9999/v1"
`,
          // A subtable of the provider survives the table being replaced.
          `[model_providers.agent-proxy]
name = "agent-proxy"

[model_providers.agent-proxy.http_headers]
X-Team = "core"
`,
          // A line inside a multi-line string that looks like a table.
          `developer_instructions = """
Answer briefly.
[not a table]
"""
`,
        ]
        for (const before of unsafe) {
          yield* home.writeCodexConfig(before)

          expect(yield* home.fails(["connect", "codex"])).toBe(
            "~/.codex/config.toml sets model_provider or the agent-proxy provider in a way connect cannot change safely, so it was left unchanged. Add the settings `agent-proxy connect codex --print` shows by hand.",
          )
          expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(before)
        }
      }),
    ),
  )

  it.effect("changes the config.toml in $CODEX_HOME when that is set", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const probe = yield* makeHome()
        const codexHome = `${probe.home}/codex-home`
        const home = yield* makeHome({ env: { CODEX_HOME: codexHome } })
        const address = yield* home.runDaemon

        const output = yield* home.connectCodex("y")

        expect(output).toContain(`changes ${codexHome}/config.toml:`)
        expect(Option.getOrNull(yield* home.read(`${codexHome}/config.toml`))).toBe(
          connectedCodexConfig(address),
        )
        expect(yield* fs.exists(`${home.home}/.codex`)).toBe(false)
      }),
    ),
  )
})
