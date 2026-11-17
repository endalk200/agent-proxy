import { Console, Effect } from "effect"
import { Command, Flag } from "effect/cli"

import { getProxyKey, rotateProxyKey } from "../daemon/client.ts"
import { asUserError } from "./errors.ts"

/**
 * `agent-proxy key [--rotate]`: prints the proxy key (ADR-0005) and nothing
 * else on stdout, so clients can run it to fetch the key (Claude Code's
 * `apiKeyHelper`, Codex's `auth` command). opencode reads the key file instead.
 */
export const keyCommand = Command.make(
  "key",
  {
    rotate: Flag.Boolean("rotate").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Replace the key with a new one; the old key stops working at once"),
    ),
  },
  Effect.fn("key")(function* ({ rotate }) {
    if (!rotate) {
      const { key } = yield* getProxyKey.pipe(Effect.mapError(asUserError))
      return yield* Console.log(key)
    }
    const { key } = yield* rotateProxyKey.pipe(Effect.mapError(asUserError))
    yield* Console.log(key)
    // opencode reads the key with `{file:…}` when it loads its config, so it
    // keeps sending the old key until it loads it again (spike #6).
    yield* Console.error(
      "Rotated the proxy key; the old key no longer works. Clients that run `agent-proxy key` pick up the new one on their next request. opencode reads the key file only when it starts: restart it, or run `opencode reload`.",
    )
  }),
).pipe(Command.withDescription("Print the proxy key clients send, or replace it with --rotate"))
