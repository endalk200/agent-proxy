import { Command } from "effect/cli"

import packageJson from "../package.json" with { type: "json" }
import { accountsCommand } from "./commands/accounts.ts"
import { daemonCommand } from "./commands/daemon.ts"
import { infoCommand } from "./commands/info.ts"
import { keyCommand } from "./commands/key.ts"

export const cli = Command.make("agent-proxy").pipe(
  Command.withDescription("Run and control the agent-proxy daemon and its accounts"),
  Command.withSubcommands([accountsCommand, daemonCommand, infoCommand, keyCommand]),
)

/** Parses `argv` and runs the matching command. Used by tests to drive the CLI in-process. */
export const runCli = Command.runWith(cli, { version: packageJson.version })

/** Runs the CLI with the arguments of the current process. */
export const main = Command.run(cli, { version: packageJson.version })
