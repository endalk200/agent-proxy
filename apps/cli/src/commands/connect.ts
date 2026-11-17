import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import { claudeCode } from "../connectors/claude-code.ts"
import { codex } from "../connectors/codex.ts"
import { type ClientConnector, connect } from "../connectors/connector.ts"
import { asUserError } from "./errors.ts"

const connectors: Readonly<Record<"claude-code" | "codex", ClientConnector>> = {
  "claude-code": claudeCode,
  codex,
}

/** `agent-proxy connect <client> [--print]`: points a client at the proxy through its own config file. */
export const connectCommand = Command.make(
  "connect",
  {
    client: Argument.Literals("client", ["claude-code", "codex"]).pipe(
      Argument.withDescription("The client to point at the proxy"),
    ),
    print: Flag.Boolean("print").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the settings to add yourself, and change nothing"),
    ),
  },
  Effect.fn("connect")(function* ({ client, print }) {
    yield* connect(connectors[client], { print }).pipe(
      Effect.mapError((error) => (error._tag === "UserError" ? error : asUserError(error))),
    )
  }),
).pipe(
  Command.withDescription(
    "Point a client at the proxy: shows the change to its config file, asks, and keeps a .bak",
  ),
)
