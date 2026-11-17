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

// `connect claude-code`, `connect codex` and `connect opencode`, driven in-process through the
// real command tree, on a temporary HOME, against an in-process daemon
// (`daemon run`) whose address they write. The terminal the owner answers the confirmation in is the only fake.
// What the command did is read back from the files it leaves in that HOME.

const makeHome = (
  options: {
    readonly listen?: string
    /** Extra variables; a function gets the new HOME, for paths under it. */
    readonly env?:
      | Readonly<Record<string, string>>
      | ((home: string) => Readonly<Record<string, string>>)
    /** Variables left out of the environment, such as `XDG_DATA_HOME` to use its default. */
    readonly unset?: ReadonlyArray<string>
  } = {},
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
    const env = Object.fromEntries(
      Object.entries({
        HOME: home,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
        XDG_DATA_HOME: `${root}/data`,
        ...(typeof options.env === "function" ? options.env(home) : options.env),
      }).filter(([name]) => !options.unset?.includes(name)),
    )
    const stateDir = `${root}/state/agent-proxy`
    const settings = `${home}/.claude/settings.json`
    const backup = `${settings}.bak`
    const codexConfig = `${home}/.codex/config.toml`
    const codexBackup = `${codexConfig}.bak`
    const opencodeDir = `${root}/config/opencode`
    const opencodeConfig = `${opencodeDir}/opencode.json`
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

    /** Runs `connect opencode <extra>` and answers its confirmation with `answer`. */
    const connectOpencode = (answer: string, extra: ReadonlyArray<string> = []) =>
      answering(["connect", "opencode", ...extra], answer)

    /** Writes `name` (`opencode.json` by default) in opencode's config directory, as the owner had it. */
    const writeOpencodeConfig = (content: string, name = "opencode.json") =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(opencodeDir, { recursive: true })
        yield* fs.writeFileString(`${opencodeDir}/${name}`, content)
      })

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
      connectOpencode,
      writeSettings,
      writeCodexConfig,
      writeOpencodeConfig,
      typed,
      output,
      errors,
      home,
      settings,
      backup,
      codexConfig,
      codexBackup,
      root,
      opencodeDir,
      opencodeConfig,
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
# an old note

# Local models
[model_providers.lmstudio-local]
name = "LM Studio"
`)
        }),
      ),
  )

  it.effect("keeps a comment the replaced table is followed by, even across a blank line", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        yield* home.writeCodexConfig(`model_provider = "agent-proxy"

[model_providers.agent-proxy]
name = "Old"

# Local model settings; keep these separate.

[model_providers.local]
name = "Local"
`)

        yield* home.connectCodex("y")

        expect(Option.getOrNull(yield* home.read(home.codexConfig)))
          .toBe(`model_provider = "agent-proxy"

[model_providers.agent-proxy]
name = "OpenAI"
base_url = "${address}/backend-api/codex"
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }

# Local model settings; keep these separate.

[model_providers.local]
name = "Local"
`)
      }),
    ),
  )

  it.effect("connects a config.toml written with CRLF line endings, and keeps them", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        yield* home.writeCodexConfig('model = "gpt-5.5"\r\nmodel_provider = "openai" # default\r\n')

        yield* home.connectCodex("y")

        expect(Option.getOrNull(yield* home.read(home.codexConfig))).toBe(
          [
            'model = "gpt-5.5"',
            'model_provider = "agent-proxy" # default',
            "",
            "[model_providers.agent-proxy]",
            'name = "OpenAI"',
            `base_url = "${address}/backend-api/codex"`,
            'wire_api = "responses"',
            'auth = { command = "agent-proxy", args = ["key"] }',
            "",
          ].join("\r\n"),
        )
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

/** The models `connect opencode` lists for the Codex provider, until the owner edits them. */
const codexModels = {
  "gpt-6.1-sol": { name: "GPT-6.1 Sol" },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra" },
  "gpt-6-astra": { name: "GPT-6 Astra" },
  "gpt-6-luna": { name: "GPT-6 Luna" },
}

/** The providers `connect opencode` adds, for a daemon at `address` whose key opencode reads from `keyFile`. */
const opencodeProviders = (address: string, keyFile: string) => ({
  "claude-agent": {
    settings: { baseURL: address, apiKey: `{file:${keyFile}}` },
  },
  "agent-proxy-codex": {
    name: "agent-proxy (Codex)",
    canonical: "openai",
    package: "@opencode/ai/providers/openai/responses",
    settings: { baseURL: `${address}/backend-api/codex`, apiKey: `{file:${keyFile}}` },
    models: codexModels,
  },
})

/** The file a `{file:…}` reference names, with `~/` expanded as opencode does. */
const fileReference = (reference: unknown, home: string) => {
  const match = /^\{file:(.+)\}$/.exec(String(reference))
  const file = match?.[1] ?? ""
  return file.startsWith("~/") ? `${home}/${file.slice(2)}` : file
}

const claudeAgentLogin =
  "opencode shows the Claude Agent models once its Claude login is connected: run `opencode auth login claude-agent --method claude-login` if you have not."

layer(services)("agent-proxy connect opencode", (it) => {
  it.effect(
    "creates opencode.json with both providers, reading the key from the daemon's key file",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          // XDG_DATA_HOME at its default, so the key file lies under home.
          const home = yield* makeHome({ unset: ["XDG_DATA_HOME"] })
          const address = yield* home.runDaemon

          const output = yield* home.connectOpencode("y")

          const written = Option.getOrThrow(yield* home.read(home.opencodeConfig))
          expect(JSON.parse(written)).toStrictEqual({
            providers: opencodeProviders(address, "~/.local/share/agent-proxy/key"),
          })
          expect(written.endsWith("}\n")).toBe(true)
          const keyFile = fileReference(
            JSON.parse(written).providers["claude-agent"].settings.apiKey,
            home.home,
          )
          expect((yield* fs.readFileString(keyFile)).trim()).toBe((yield* home.cli(["key"])).trim())
          expect(output).toContain(
            `Connecting opencode to the proxy at ${address} changes ${home.opencodeConfig}:`,
          )
          expect(output).toContain("--- /dev/null")
          expect(output).toContain(`Connected opencode to the proxy at ${address}.`)
          expect(output).toContain(claudeAgentLogin)
          expect(yield* home.read(`${home.opencodeConfig}.bak`)).toStrictEqual(Option.none())
        }),
      ),
  )

  it.effect(
    "names the key file by its real path when XDG_DATA_HOME is not the default, with ~/ only under home",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          // Outside home: the absolute path.
          const outside = yield* makeHome()
          const outsideAddress = yield* outside.runDaemon
          yield* outside.connectOpencode("y")
          const outsideConfig = JSON.parse(
            Option.getOrThrow(yield* outside.read(outside.opencodeConfig)),
          )
          expect(outsideConfig.providers).toStrictEqual(
            opencodeProviders(outsideAddress, `${outside.root}/data/agent-proxy/key`),
          )

          // Under home, but not the default: `~/` and the rest of the real path.
          const underHome = yield* makeHome({
            env: (home) => ({ XDG_DATA_HOME: `${home}/xdg/data` }),
          })
          const underAddress = yield* underHome.runDaemon
          yield* underHome.connectOpencode("y")
          const underConfig = JSON.parse(
            Option.getOrThrow(yield* underHome.read(underHome.opencodeConfig)),
          )
          expect(underConfig.providers["agent-proxy-codex"].settings).toStrictEqual({
            baseURL: `${underAddress}/backend-api/codex`,
            apiKey: "{file:~/xdg/data/agent-proxy/key}",
          })

          for (const [home, config] of [
            [outside, outsideConfig],
            [underHome, underConfig],
          ] as const) {
            const keyFile = fileReference(
              config.providers["agent-proxy-codex"].settings.apiKey,
              home.home,
            )
            expect((yield* fs.readFileString(keyFile)).trim()).toBe(
              (yield* home.cli(["key"])).trim(),
            )
          }
        }),
      ),
  )

  it.effect(
    "keeps comments and every other setting byte for byte, backs the file up, and writes only once confirmed",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome({ unset: ["XDG_DATA_HOME"] })
          const address = yield* home.runDaemon
          const before = `{
  "$schema": "https://opencode.ai/config.json",
  // the default model
  "model": "cliproxy-codex/gpt-6-luna",
  "providers": {
    "cliproxy-codex": {
      "name": "CLI Proxy (Codex)",
      "settings": { "baseURL": "http://127.0.0.1:8317/v1" }
    }
  },
  "mcp": {}, // none yet
}
`
          yield* home.writeOpencodeConfig(before)

          const run = yield* Effect.forkChild(home.cli(["connect", "opencode"]))
          const shown = yield* home.asked
          expect(shown).toContain(`--- ${home.opencodeConfig}`)
          expect(shown).toContain(`+++ ${home.opencodeConfig}`)
          expect(shown).toContain(`+        "baseURL": "${address}",`)
          expect(shown).toContain(`Write ${home.opencodeConfig}? [y/N]`)
          expect(Option.getOrNull(yield* home.read(home.opencodeConfig))).toBe(before)

          yield* Queue.offer(home.typed, "y")
          const output = yield* Fiber.join(run)

          expect(Option.getOrNull(yield* home.read(home.opencodeConfig))).toBe(`{
  "$schema": "https://opencode.ai/config.json",
  // the default model
  "model": "cliproxy-codex/gpt-6-luna",
  "providers": {
    "cliproxy-codex": {
      "name": "CLI Proxy (Codex)",
      "settings": { "baseURL": "http://127.0.0.1:8317/v1" }
    },
    "claude-agent": {
      "settings": {
        "baseURL": "${address}",
        "apiKey": "{file:~/.local/share/agent-proxy/key}"
      }
    },
    "agent-proxy-codex": {
      "name": "agent-proxy (Codex)",
      "canonical": "openai",
      "package": "@opencode/ai/providers/openai/responses",
      "settings": {
        "baseURL": "${address}/backend-api/codex",
        "apiKey": "{file:~/.local/share/agent-proxy/key}"
      },
      "models": {
        "gpt-6.1-sol": {
          "name": "GPT-6.1 Sol"
        },
        "gpt-6.1-terra": {
          "name": "GPT-6.1 Terra"
        },
        "gpt-6-astra": {
          "name": "GPT-6 Astra"
        },
        "gpt-6-luna": {
          "name": "GPT-6 Luna"
        }
      }
    }
  },
  "mcp": {}, // none yet
}
`)
          expect(Option.getOrNull(yield* home.read(`${home.opencodeConfig}.bak`))).toBe(before)
          expect(output).toContain(`The old settings are in ${home.opencodeConfig}.bak.`)
        }),
      ),
  )

  it.effect(
    "replaces only the settings it manages in providers already there, keeping the models the owner listed",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const home = yield* makeHome()
          const address = yield* home.runDaemon
          const keyFile = `${home.root}/data/agent-proxy/key`
          // The lines next to a new setting are laid out again (settings, and
          // models, which canonical goes after); nothing else moves.
          yield* home.writeOpencodeConfig(`{
  "providers": {
    "claude-agent": {
      "settings": {
        "baseURL": "http://127.0.0.1:9999",
        "apiKey": "{file:~/old-key}",
        "headerTimeout": 30000
      }
    },
    "agent-proxy-codex": {
      "name": "Codex via the proxy",
      "package": "@opencode/ai/providers/openai/responses",
      "settings": { "baseURL": "http://127.0.0.1:9999/backend-api/codex" },
      "models": { "gpt-7": { "name": "GPT-7" } }
    }
  }
}
`)

          yield* home.connectOpencode("y")

          expect(Option.getOrNull(yield* home.read(home.opencodeConfig))).toBe(`{
  "providers": {
    "claude-agent": {
      "settings": {
        "baseURL": "${address}",
        "apiKey": "{file:${keyFile}}",
        "headerTimeout": 30000
      }
    },
    "agent-proxy-codex": {
      "name": "agent-proxy (Codex)",
      "package": "@opencode/ai/providers/openai/responses",
      "settings": {
        "baseURL": "${address}/backend-api/codex",
        "apiKey": "{file:${keyFile}}"
      },
      "models": {
        "gpt-7": {
          "name": "GPT-7"
        }
      },
      "canonical": "openai"
    }
  }
}
`)
        }),
      ),
  )

  it.effect("says so and changes nothing when opencode is already connected", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        yield* home.writeOpencodeConfig('{ "model": "claude-agent/opus" }\n')
        yield* home.connectOpencode("y")
        const config = yield* home.read(home.opencodeConfig)
        const backup = yield* home.read(`${home.opencodeConfig}.bak`)

        const output = yield* home.cli(["connect", "opencode"])

        expect(output).toBe(
          `opencode is already connected to the proxy at ${address}; ${home.opencodeConfig} is unchanged.\n`,
        )
        expect(yield* home.read(home.opencodeConfig)).toStrictEqual(config)
        expect(yield* home.read(`${home.opencodeConfig}.bak`)).toStrictEqual(backup)
      }),
    ),
  )

  it.effect("--print prints the providers to add and the login note, and writes nothing", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome({ unset: ["XDG_DATA_HOME"] })
        const address = yield* home.runDaemon

        const output = yield* home.cli(["connect", "opencode", "--print"])

        expect(JSON.parse(output)).toStrictEqual({
          providers: opencodeProviders(address, "~/.local/share/agent-proxy/key"),
        })
        expect(output.startsWith('{\n  "providers": {\n    "claude-agent": {')).toBe(true)
        expect(home.errors.join("")).toBe(
          `Add these settings to ${home.opencodeConfig}:\n${claudeAgentLogin}\n`,
        )
        expect(yield* fs.exists(home.opencodeDir)).toBe(false)
      }),
    ),
  )

  it.effect("changes opencode.jsonc when it exists, since opencode lets it win", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        const json = '{ "model": "claude-agent/opus" }\n'
        yield* home.writeOpencodeConfig(json)
        const jsonc = '// mine\n{ "theme": "system", }\n'
        yield* home.writeOpencodeConfig(jsonc, "opencode.jsonc")

        const output = yield* home.connectOpencode("y")

        const changed = `${home.opencodeDir}/opencode.jsonc`
        expect(output).toContain(`changes ${changed}:`)
        expect(Option.getOrNull(yield* home.read(home.opencodeConfig))).toBe(json)
        const written = Option.getOrThrow(yield* home.read(changed))
        // The comment and the trailing comma stay; the one-line object the
        // providers go into is laid out on lines.
        expect(written.startsWith('// mine\n{\n  "theme": "system",\n  "providers": {\n')).toBe(
          true,
        )
        expect(written.endsWith("  },\n}\n")).toBe(true)
        expect(written).toContain(`"baseURL": "${address}/backend-api/codex"`)
        expect(Option.getOrNull(yield* home.read(`${changed}.bak`))).toBe(jsonc)
      }),
    ),
  )

  it.effect("changes the opencode.json in $OPENCODE_CONFIG_DIR when that is set", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome({
          env: (dir) => ({ OPENCODE_CONFIG_DIR: `${dir}/opencode-config` }),
        })
        const address = yield* home.runDaemon

        const output = yield* home.connectOpencode("y")

        expect(output).toContain("changes ~/opencode-config/opencode.json:")
        const written = Option.getOrThrow(
          yield* home.read(`${home.home}/opencode-config/opencode.json`),
        )
        expect(JSON.parse(written).providers["claude-agent"].settings.baseURL).toBe(address)
        expect(yield* fs.exists(home.opencodeDir)).toBe(false)
      }),
    ),
  )

  it.effect("refuses a file it cannot read or change safely, and leaves it as it was", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        yield* home.runDaemon
        const shown = home.opencodeConfig

        const broken = '{ "model": "claude-agent/opus"\n'
        yield* home.writeOpencodeConfig(broken)
        expect(yield* home.fails(["connect", "opencode"])).toBe(
          `${shown} is not valid JSON (closing brace expected at offset 31), so it was left unchanged. Fix it, or move it aside, and run this again.`,
        )
        expect(Option.getOrNull(yield* home.read(shown))).toBe(broken)

        const unfit = [
          ["[]\n", "it is not a JSON object"],
          ['{ "providers": [] }\n', "its providers is not an object"],
          [
            '{ "providers": { "claude-agent": { "settings": "x" } } }\n',
            "its providers.claude-agent.settings is not an object",
          ],
          [
            '{ "providers": { "agent-proxy-codex": { "models": ["gpt-6-luna"] } } }\n',
            "its providers.agent-proxy-codex.models is not an object",
          ],
        ]
        for (const [before, why] of unfit) {
          yield* home.writeOpencodeConfig(before ?? "")
          expect(yield* home.fails(["connect", "opencode"])).toBe(
            `${shown} does not hold opencode settings (${why}), so it was left unchanged.`,
          )
          expect(Option.getOrNull(yield* home.read(shown))).toBe(before)
        }

        // A second "providers" key: opencode reads the last, an edit would land in the first.
        const duplicate = '{ "providers": {}, "providers": { "other": {} } }\n'
        yield* home.writeOpencodeConfig(duplicate)
        expect(yield* home.fails(["connect", "opencode"])).toBe(
          `${shown} sets the opencode providers in a way connect cannot change safely, so it was left unchanged. Add the settings \`agent-proxy connect opencode --print\` shows by hand.`,
        )
        expect(Option.getOrNull(yield* home.read(shown))).toBe(duplicate)
        expect(yield* fs.readDirectory(home.opencodeDir)).toStrictEqual(["opencode.json"])
      }),
    ),
  )

  it.effect("writes through an opencode.json linked from a dotfiles repo", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* makeHome()
        const address = yield* home.runDaemon
        const dotfiles = `${home.home}/.dotfiles/opencode`
        yield* fs.makeDirectory(dotfiles, { recursive: true })
        const before = '{ "model": "claude-agent/opus" }\n'
        yield* fs.writeFileString(`${dotfiles}/opencode.json`, before)
        yield* fs.makeDirectory(home.opencodeDir, { recursive: true })
        yield* fs.symlink(`${dotfiles}/opencode.json`, home.opencodeConfig)

        yield* home.connectOpencode("y")

        expect((yield* fs.lstat(home.opencodeConfig)).type).toBe("SymbolicLink")
        expect(yield* fs.readFileString(`${dotfiles}/opencode.json`)).toContain(
          `"baseURL": "${address}"`,
        )
        expect(yield* fs.readDirectory(dotfiles)).toStrictEqual(["opencode.json"])
        expect(Option.getOrNull(yield* home.read(`${home.opencodeConfig}.bak`))).toBe(before)

        // With the link's target gone, it is refused and the link kept.
        yield* fs.remove(`${dotfiles}/opencode.json`)
        expect(yield* home.fails(["connect", "opencode"])).toContain("which does not exist")
        expect((yield* fs.lstat(home.opencodeConfig)).type).toBe("SymbolicLink")
      }),
    ),
  )
})
