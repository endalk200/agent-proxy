import { Console, Effect, FileSystem, Option, Path } from "effect"
import { Command } from "effect/cli"

import {
  applyDisconnect,
  confirm,
  planDisconnect,
  showDisconnect,
} from "../connectors/connector.ts"
import { displayPath, resolveConfigPath, resolveDataDir, resolveStateDir } from "../paths.ts"
import { RuntimeInfo } from "../runtime-info.ts"
import { connectors } from "./connect.ts"
import { ensureNoSilentDaemon, homes, removeLaunchAgent, stopRunningDaemon } from "./daemon.ts"
import { asUserError, userError } from "./errors.ts"

/** `path` as a shell word that still expands `~`. */
const word = (path: string) =>
  path.startsWith("~/") ? `"$HOME/${path.slice(2)}"` : `'${path.replaceAll("'", "'\\''")}'`

/**
 * `agent-proxy uninstall`: undoes the install (ADR-0008). It disconnects every
 * client whose file still holds connect's settings, removes the launch agent,
 * stops the daemon and deletes the binary, after one confirmation. Accounts,
 * the proxy key, the config and the logs stay, so a reinstall signs nothing
 * in again.
 */
export const uninstallCommand = Command.make(
  "uninstall",
  {},
  Effect.fn("uninstall")(function* () {
    const runtime = yield* RuntimeInfo
    const fs = yield* FileSystem.FileSystem
    if (Option.isNone(runtime.binary)) {
      return yield* userError(
        "`uninstall` removes the installed binary, and this is running from source, so there is none to remove. Run it as the installed `agent-proxy`.",
      )
    }
    const binary = runtime.binary.value.path
    const path = yield* Path.Path

    // A verify shell inherits PATH, so `agent-proxy` there may be the real
    // install; a sandbox may delete only a binary inside its own HOME.
    const { home, real, same } = yield* homes
    const insideHome = Option.isSome(home) && !path.relative(home.value, binary).startsWith("..")
    if (!same && !insideHome) {
      return yield* userError(
        `\`uninstall\` refuses to delete ${binary}, which is not under HOME (${Option.getOrElse(home, () => "unset")}), while HOME is not your home directory (${Option.getOrElse(real, () => "unknown")}): in a sandbox, it removes only a binary inside the sandbox.`,
      )
    }
    yield* ensureNoSilentDaemon("uninstall changed nothing")

    const plans = yield* Effect.forEach(Object.values(connectors), (connector) =>
      planDisconnect(connector).pipe(
        Effect.mapError((error) => (error._tag === "UserError" ? error : asUserError(error))),
      ),
    ).pipe(Effect.map((found) => found.flatMap(Option.toArray)))

    for (const plan of plans) {
      yield* showDisconnect(plan)
    }
    yield* Console.log(
      [
        "Uninstalling agent-proxy:",
        ...(plans.length === 0
          ? ["- disconnects no client: none is connected"]
          : [
              `- disconnects ${plans.map((plan) => plan.connector.name).join(", ")}, as shown above`,
            ]),
        "- removes the launch agent, if it is installed, and stops the daemon",
        `- deletes ${binary}`,
        "- keeps your accounts, usage, the proxy key, the config and the logs",
        "",
      ].join("\n"),
    )
    if (!(yield* confirm("Uninstall agent-proxy?"))) {
      return yield* userError("Nothing changed; agent-proxy is still installed.")
    }

    for (const plan of plans) {
      yield* applyDisconnect(plan).pipe(
        Effect.mapError((error) => (error._tag === "UserError" ? error : asUserError(error))),
      )
    }
    if (yield* removeLaunchAgent) {
      yield* Console.log("Removed the launch agent and stopped the daemon it ran.")
    }
    const stopped = yield* stopRunningDaemon
    if (Option.isSome(stopped)) {
      yield* Console.log(`Stopped the daemon (pid ${stopped.value}).`)
    }
    // It may have stopped answering meanwhile; the binary stays until it is gone.
    yield* ensureNoSilentDaemon("the binary was not deleted")
    yield* fs.remove(binary, { force: true }).pipe(Effect.mapError(asUserError))
    yield* Console.log(`Deleted ${binary}.`)

    const kept = yield* Effect.all({
      data: resolveDataDir,
      state: resolveStateDir,
      config: resolveConfigPath,
    }).pipe(Effect.mapError(asUserError))
    const data = yield* displayPath(kept.data)
    const state = yield* displayPath(kept.state)
    const config = yield* displayPath(kept.config)
    yield* Console.log(
      [
        "",
        "Kept, so a reinstall needs no sign-in:",
        `  accounts, usage, proxy key  ${data}`,
        `  logs                        ${state}`,
        `  config                      ${config}`,
        `Remove them with: rm -rf ${[data, state, config].map(word).join(" ")}`,
      ].join("\n"),
    )
  }),
).pipe(
  Command.withDescription(
    "Remove agent-proxy: disconnects every client, removes the launch agent, stops the daemon and deletes the binary; keeps accounts, usage, config and logs",
  ),
)
