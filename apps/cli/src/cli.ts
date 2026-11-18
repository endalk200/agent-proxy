import { Effect } from "effect"
import { Command } from "effect/cli"

import { accountsCommand } from "./commands/accounts.ts"
import { connectCommand, disconnectCommand } from "./commands/connect.ts"
import { daemonCommand } from "./commands/daemon.ts"
import { infoCommand } from "./commands/info.ts"
import { keyCommand } from "./commands/key.ts"
import { uninstallCommand } from "./commands/uninstall.ts"
import { RuntimeInfo, versionText } from "./runtime-info.ts"

export const cli = Command.make("agent-proxy").pipe(
  Command.withDescription("Run and control the agent-proxy daemon and its accounts"),
  Command.withSubcommands([
    accountsCommand,
    connectCommand,
    daemonCommand,
    disconnectCommand,
    infoCommand,
    keyCommand,
    uninstallCommand,
  ]),
)

/** The version `--version` prints, naming the build: `0.0.0 (abc1234)`, or `0.0.0 (source)`. */
const version = Effect.gen(function* () {
  return versionText((yield* RuntimeInfo).binary)
})

/** Parses `argv` and runs the matching command. Used by tests to drive the CLI in-process. */
export const runCli = (argv: ReadonlyArray<string>) =>
  Effect.flatMap(version, (text) => Command.runWith(cli, { version: text })(argv))

/** Runs the CLI with the arguments of the current process. */
export const main = Effect.flatMap(version, (text) => Command.run(cli, { version: text }))
