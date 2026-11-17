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
  Schema,
  Terminal,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { TestClock } from "effect/testing"

import { Browser, BrowserError } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { AccountList } from "../../src/daemon/api.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { alice, bob, type ClaudeUser, type FakeClaude, fakeClaude } from "../support/fake-claude.ts"

// `accounts` and `accounts add`, driven in-process through the real command
// tree against an in-process daemon (`daemon run`) whose Claude logins go to a
// fake Claude OAuth server. The browser and the terminal the owner pastes into
// are the only other fakes. Each test runs on real time: sockets are real.

const notRunning =
  "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`."

/** What the owner's browser does: sign in at Claude and follow the redirect to the daemon. */
const browserThatSignsIn = Browser.of({
  open: (url) =>
    Effect.tryPromise({
      try: () => fetch(url),
      catch: (cause) => new BrowserError({ message: "could not load", cause }),
    }),
})

/** A browser opener that signs in but never exits, as `xdg-open` can stay attached to a terminal browser. */
const browserThatSignsInAndLingers = Browser.of({
  open: (url) => Effect.promise(() => fetch(url)).pipe(Effect.andThen(Effect.never)),
})

/** A browser that is never seen: opening it does nothing. */
const browserThatIdles = Browser.of({ open: () => Effect.void })

/** A terminal whose typed lines come from `lines`. */
const terminalTyping = (lines: Queue.Queue<string>) =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    size: Effect.die("unused"),
    readInput: Effect.die("unused"),
    readLine: Queue.take(lines),
    display: () => Effect.void,
  })

/** The URL a browser that cannot reach the daemon ends up on after signing in. */
const signInWithoutReachingDaemon = (authorizeUrl: string) =>
  Effect.promise(() => fetch(authorizeUrl, { redirect: "manual" })).pipe(
    Effect.map((response) => response.headers.get("location") ?? ""),
  )

/**
 * `endpoints: "env"` leaves the real `ProviderEndpoints.layer` in place and points
 * it at the fake through `AGENT_PROXY_PROVIDER_ENDPOINTS`, the way the sandbox does.
 */
const makeHome = (
  claude: FakeClaude,
  options: { readonly endpoints?: "service" | "env"; readonly endpointsJson?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-accounts-cli-" })
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
      ...(options.endpoints === "env"
        ? {
            AGENT_PROXY_PROVIDER_ENDPOINTS:
              options.endpointsJson ?? JSON.stringify({ claude: claude.endpoints }),
          }
        : {}),
    }
    const stateDir = `${root}/state/agent-proxy`
    const output: Array<string> = []
    const typed = yield* Queue.unbounded<string>()

    /** Runs `agent-proxy <argv>` in this home; its stdout lines collect in `output`. */
    const cli = (argv: ReadonlyArray<string>, browser: Browser["Service"] = browserThatSignsIn) =>
      Effect.gen(function* () {
        const start = output.length
        const console: Console.Console = {
          ...globalThis.console,
          log: (...args: ReadonlyArray<unknown>) => {
            output.push(args.join(" "))
          },
        }
        yield* runCli(argv).pipe(
          options.endpoints === "env"
            ? Effect.provide(ProviderEndpoints.layer)
            : Effect.provideService(
                ProviderEndpoints,
                ProviderEndpoints.of({ claude: claude.endpoints }),
              ),
          Effect.provideService(Console.Console, console),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
          Effect.provideService(Browser, browser),
          Effect.provideService(Terminal.Terminal, terminalTyping(typed)),
        )
        return output.slice(start).join("\n")
      })

    /** Runs `agent-proxy daemon run` in the background until the test's scope closes. */
    const runDaemon = Effect.gen(function* () {
      yield* Effect.forkScoped(cli(["daemon", "run"]))
      yield* fs.exists(`${stateDir}/daemon.json`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (exists) => exists,
          times: 250,
        }),
      )
    })

    /** Waits until the CLI has printed a line matching `pattern`, and returns the match. */
    const printed = (pattern: RegExp) =>
      Effect.sync(() => output.join("\n").match(pattern)?.[0]).pipe(
        Effect.map(Option.fromUndefinedOr),
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: Option.isSome,
          times: 250,
        }),
        Effect.map(Option.getOrElse(() => "")),
      )

    /** Signs `user` in with `accounts add claude` and the browser. */
    const add = (user: ClaudeUser, extra: ReadonlyArray<string> = []) => {
      claude.signInAs(user)
      return cli(["accounts", "add", "claude", ...extra])
    }

    return { cli, runDaemon, printed, typed, add }
  })

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    FetchHttpClient.layer,
  ),
)("agent-proxy accounts", (it) => {
  it.effect("accounts fails with a one-line hint when no daemon runs", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        const error = yield* Effect.flip(home.cli(["accounts"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(notRunning)
        const addError = yield* Effect.flip(home.cli(["accounts", "add", "claude"]))
        expect(addError._tag === "UserError" && addError.userMessage).toBe(notRunning)
      }),
    ),
  )

  it.effect("accounts says how to add one when there are none", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        expect(yield* home.cli(["accounts"])).toBe(
          "No accounts yet. Add one with `agent-proxy accounts add claude`.",
        )
      }),
    ),
  )

  it.effect("accounts add claude signs in through the browser and adds the account", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        const output = yield* home.add(alice)
        expect(output).toContain("Opening your browser to sign in to Claude.")
        expect(output).toMatch(/^ {2}http:\/\/127\.0\.0\.1:\d+\/cai\/oauth\/authorize\?/m)
        expect(output).toMatch(
          /Added Claude account "alice" \(alice@example\.com, Max 20x\) at priority 1\.$/,
        )
      }),
    ),
  )

  it.effect("accounts add claude finishes even when the browser opener never exits", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.runDaemon
        claude.signInAs(alice)
        const output = yield* home.cli(["accounts", "add", "claude"], browserThatSignsInAndLingers)
        expect(output).toMatch(/Added Claude account "alice" \(alice@example\.com, Max 20x\)/)
      }),
    ),
  )

  it.effect("AGENT_PROXY_PROVIDER_ENDPOINTS points a sign-in at other Claude endpoints", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude, { endpoints: "env" })
        yield* home.runDaemon
        const output = yield* home.add(alice)
        expect(output).toMatch(/^ {2}http:\/\/127\.0\.0\.1:\d+\/cai\/oauth\/authorize\?/m)
        expect(output).toMatch(/Added Claude account "alice" \(alice@example\.com, Max 20x\)/)
      }),
    ),
  )

  it.effect("AGENT_PROXY_PROVIDER_ENDPOINTS that is not valid fails with a message naming it", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude, {
          endpoints: "env",
          endpointsJson: '{"claude":{"tokenUrl":1}}',
        })
        const error = yield* Effect.flip(home.cli(["daemon", "run"]))
        expect(String(error)).toContain("AGENT_PROXY_PROVIDER_ENDPOINTS")
      }),
    ),
  )

  it.effect("accounts lists provider, label, email, plan, priority and status", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        yield* home.add(alice, ["--label", "Personal Max"])
        yield* home.add(bob)
        expect(yield* home.cli(["accounts"])).toBe(
          [
            "PROVIDER  LABEL         EMAIL              PLAN     PRIORITY  STATUS",
            "claude    Personal Max  alice@example.com  Max 20x  1         Active",
            "claude    bob           bob@example.com    Pro      2         Active",
          ].join("\n"),
        )
      }),
    ),
  )

  it.effect("accounts --json lists the same accounts as JSON", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        yield* home.add(alice)
        const list = yield* Schema.decodeEffect(Schema.fromJsonString(AccountList))(
          yield* home.cli(["accounts", "--json"]),
        )
        expect(list.accounts).toEqual([
          expect.objectContaining({
            provider: "claude",
            label: "alice",
            email: "alice@example.com",
            plan: "Max 20x",
            priority: 1,
            status: "active",
            providerAccountId: `${alice.accountUuid}:${alice.organizationUuid}`,
          }),
        ])
      }),
    ),
  )

  it.effect("signing in again says the account was updated, and adds no duplicate", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        yield* home.add(alice, ["--label", "Work"])
        const again = yield* home.add(alice)
        expect(again).toMatch(
          /Signed in again to Claude account "Work" \(alice@example\.com, Max 20x\); its credentials are updated\.$/,
        )
        expect((yield* home.cli(["accounts"])).split("\n")).toHaveLength(2)
      }),
    ),
  )

  it.effect("accounts add claude --no-browser prints the URL and takes the pasted callback", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        const command = yield* Effect.forkScoped(
          home.cli(["accounts", "add", "claude", "--no-browser"], browserThatIdles),
        )
        const url = yield* home.printed(/http:\/\/127\.0\.0\.1:\d+\/cai\/oauth\/authorize\?\S+/)
        yield* home.printed(/paste it here:$/)

        yield* Queue.offer(home.typed, "not a url")
        yield* home.printed(/That is not a URL\. .* Try again:$/)
        yield* Queue.offer(home.typed, yield* signInWithoutReachingDaemon(url))

        const output = yield* Fiber.join(command)
        expect(output).not.toContain("Opening your browser")
        expect(output).toContain("After you sign in, the browser is sent to http://localhost:")
        expect(output).toMatch(
          /Added Claude account "alice" \(alice@example\.com, Max 20x\) at priority 1\.$/,
        )
      }),
    ),
  )

  it.effect("a sign-in the owner denies fails with Claude's reason and adds nothing", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const claude = yield* fakeClaude
        const home = yield* makeHome(claude)
        yield* home.runDaemon
        claude.denyNext()
        const error = yield* Effect.flip(home.cli(["accounts", "add", "claude"]))
        expect(error._tag === "UserError" && error.userMessage).toBe(
          "Sign-in failed: Claude did not grant access: The user denied access",
        )
        expect(yield* home.cli(["accounts"])).toMatch(/^No accounts yet/)
      }),
    ),
  )

  it.effect("interrupting accounts add cancels the login in the daemon", () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* makeHome(yield* fakeClaude)
        yield* home.runDaemon
        const command = yield* Effect.forkScoped(
          home.cli(["accounts", "add", "claude"], browserThatIdles),
        )
        const url = yield* home.printed(/http:\/\/127\.0\.0\.1:\d+\/cai\/oauth\/authorize\?\S+/)
        yield* Fiber.interrupt(command)
        // The daemon stopped listening, so a browser coming back late reaches nothing.
        const late = yield* Effect.exit(
          Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url)),
        )
        expect(late._tag).toBe("Failure")
        expect(yield* home.cli(["accounts"])).toMatch(/^No accounts yet/)
      }),
    ),
  )
})
