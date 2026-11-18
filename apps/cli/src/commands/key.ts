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
    // Claude Code runs `apiKeyHelper` again after a 401. Codex runs its `auth`
    // command once per process, and opencode reads the key with `{file:…}`
    // when it loads its config, so both keep sending the old key until they
    // start again (spike #6, #25).
    yield* Console.error(
      "Rotated the proxy key; the old key no longer works. Claude Code picks up the new one by itself, on its next request. Codex and opencode read the key only when they start: restart Codex, and restart opencode or run `opencode reload`.",
    )
  }),
).pipe(Command.withDescription("Print the proxy key clients send, or replace it with --rotate"))
