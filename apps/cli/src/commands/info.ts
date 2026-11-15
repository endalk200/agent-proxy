import { Console, Effect } from "effect"
import { CliError, Command, Flag } from "effect/cli"

import packageJson from "../../package.json" with { type: "json" }
import { resolveConfigPath } from "../config-path.ts"
import { RuntimeInfo } from "../runtime-info.ts"

export interface Info {
  readonly version: string
  readonly runtime: string
  readonly runtimeVersion: string
  readonly platform: string
  readonly arch: string
  readonly configPath: string
}

export const gatherInfo = Effect.gen(function* () {
  const runtime = yield* RuntimeInfo
  const configPath = yield* resolveConfigPath.pipe(
    Effect.mapError(
      (cause) =>
        new CliError.UserError({
          cause,
          userMessage:
            "Could not resolve the config file path. Set AGENT_PROXY_CONFIG, XDG_CONFIG_HOME, or HOME.",
        }),
    ),
  )
  const info: Info = {
    version: packageJson.version,
    runtime: runtime.runtime,
    runtimeVersion: runtime.runtimeVersion,
    platform: runtime.platform,
    arch: runtime.arch,
    configPath,
  }
  return info
})

export const formatInfo = (info: Info, options: { readonly json: boolean }): string =>
  options.json
    ? JSON.stringify(info, null, 2)
    : [
        `agent-proxy ${info.version}`,
        `runtime   ${info.runtime} ${info.runtimeVersion}`,
        `platform  ${info.platform}-${info.arch}`,
        `config    ${info.configPath}`,
      ].join("\n")

export const infoCommand = Command.make(
  "info",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print machine-readable JSON"),
    ),
  },
  Effect.fn("info")(function* ({ json }) {
    const info = yield* gatherInfo
    yield* Console.log(formatInfo(info, { json }))
  }),
).pipe(Command.withDescription("Show version, runtime, and configuration details"))
