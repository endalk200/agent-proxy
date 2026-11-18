import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Console, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { Browser } from "../../src/browser.ts"
import { runCli } from "../../src/cli.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"
import { noLaunchd } from "../support/no-launchd.ts"

// Drives the real command tree in-process with the real Bun platform services.
// Only the environment and the console are controlled, so the test can assert
// on exactly what the user would see.
const runCapturing = (argv: ReadonlyArray<string>, env: Record<string, string>) =>
  Effect.gen(function* () {
    const lines: Array<string> = []
    const console: Console.Console = {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        lines.push(args.join(" "))
      },
    }
    yield* runCli(argv).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
    )
    return lines.join("\n")
  })

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    noLaunchd,
    FetchHttpClient.layer,
    ProviderEndpoints.layer,
    Layer.succeed(Browser, Browser.of({ open: () => Effect.die("no browser in this test") })),
  ),
)("agent-proxy info", (it) => {
  it.effect("prints runtime and config details as JSON", () =>
    Effect.gen(function* () {
      const output = yield* runCapturing(["info", "--json"], { XDG_CONFIG_HOME: "/xdg" })
      const info: unknown = JSON.parse(output)
      expect(info).toMatchObject({
        runtime: "bun",
        runtimeVersion: Bun.version,
        platform: process.platform,
        configPath: "/xdg/agent-proxy/config.toml",
      })
    }),
  )

  it.effect("fails with a user error when no config location can be derived", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runCapturing(["info"], {}))
      expect(error._tag).toBe("UserError")
    }),
  )

  it.effect("rejects unknown subcommands and shows help", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runCapturing(["bogus"], {}))
      expect(error._tag).toBe("ShowHelp")
      expect(error._tag === "ShowHelp" && error.errors.map((e) => e._tag)).toEqual([
        "UnknownSubcommand",
      ])
    }),
  )
})
