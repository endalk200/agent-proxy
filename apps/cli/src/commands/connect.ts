import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import { claudeCode } from "../connectors/claude-code.ts"
import { codex } from "../connectors/codex.ts"
import { type ClientConnector, connect, disconnect } from "../connectors/connector.ts"
import { opencode } from "../connectors/opencode.ts"
import { asUserError } from "./errors.ts"

/** Every client `connect` points at the proxy, by the name the owner types. */
export const connectors: Readonly<Record<"claude-code" | "codex" | "opencode", ClientConnector>> = {
  "claude-code": claudeCode,
  codex,
  opencode,
}

const clientArgument = (description: string) =>
  Argument.Literals("client", ["claude-code", "codex", "opencode"]).pipe(
    Argument.withDescription(description),
  )

/** A failure the owner reads: its own message, without a stack trace. */
const shown = <E extends { readonly _tag: string; readonly message: string }>(error: E) =>
  error._tag === "UserError" ? error : asUserError(error)

/** `agent-proxy connect <client> [--print]`: points a client at the proxy through its own config file. */
export const connectCommand = Command.make(
  "connect",
  {
    client: clientArgument("The client to point at the proxy"),
    print: Flag.Boolean("print").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the settings to add yourself, and change nothing"),
    ),
  },
  Effect.fn("connect")(function* ({ client, print }) {
    yield* connect(connectors[client], { print }).pipe(Effect.mapError(shown))
  }),
).pipe(
  Command.withDescription(
    "Point a client at the proxy: shows the change to its config file, asks, and keeps a .bak",
  ),
)

/** `agent-proxy disconnect <client>`: removes what `connect` wrote, and only that. */
export const disconnectCommand = Command.make(
  "disconnect",
  { client: clientArgument("The client to point back at its provider") },
  Effect.fn("disconnect")(function* ({ client }) {
    yield* disconnect(connectors[client]).pipe(Effect.mapError(shown))
  }),
).pipe(
  Command.withDescription(
    "Point a client back at its provider: removes what connect wrote to its config file, after showing the change and asking",
  ),
)
