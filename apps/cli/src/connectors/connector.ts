import {
  Config,
  Console,
  Data,
  Effect,
  Equal,
  FileSystem,
  Option,
  Path,
  Terminal,
  TextDiff,
} from "effect"
import type { Result } from "effect"

import { writeFileAtomic } from "../atomic-file.ts"
import { asUserError, userError } from "../commands/errors.ts"
import { loadConfigFile } from "../config.ts"
import { fetchDaemonInfo } from "../daemon/client.ts"
import { clientAddress } from "../daemon/daemon.ts"

/**
 * Pointing a client at the proxy by changing the client's own config file.
 *
 * What every client shares lives here: finding the proxy's address, showing
 * the change as a diff, asking before writing, keeping a `.bak`, `--print`,
 * and saying so when there is nothing to change. A `ClientConnector` holds
 * only what differs per client: where its file is, and how to change it.
 */

/** What a client is pointed at. */
export interface ProxyTarget {
  /** The base URL the client sends its requests to, such as `http://127.0.0.1:8318`. */
  readonly address: string
}

/** A client config file the connector cannot change safely, with the reason to show the owner. */
export class ClientConfigError extends Data.TaggedError("ClientConfigError")<{
  readonly message: string
}> {}

export interface ClientConnector {
  /** The client's name as the owner knows it, such as "Claude Code". */
  readonly name: string
  /** The client's config file. */
  readonly file: Effect.Effect<string, Config.ConfigError, Path.Path>
  /** The settings to add by hand, as `--print` shows them. */
  readonly snippet: (target: ProxyTarget) => string
  /**
   * The file's new content, given its current content (`None` when it does
   * not exist yet), or `None` when it already points at `target`. `name` is
   * how the file is named in error messages.
   */
  readonly change: (
    current: Option.Option<string>,
    target: ProxyTarget,
    name: string,
  ) => Result.Result<Option.Option<string>, ClientConfigError>
}

/**
 * Where the proxy listens: the running daemon's address, which it reports
 * through its API. When no daemon runs, the address `config.toml` makes it
 * listen on, unless that is any free port. `running` says which it was.
 */
const proxyTarget = fetchDaemonInfo.pipe(
  Effect.map((info) => ({ target: { address: info.address }, running: true })),
  Effect.catchTag("DaemonNotRunning", () =>
    Effect.gen(function* () {
      const { config } = yield* loadConfigFile.pipe(Effect.mapError(asUserError))
      if (config.listen.port === 0) {
        return yield* userError(
          "The agent-proxy daemon is not running, and config.toml lets it listen on any free port, so its address is not known yet. Start it with `agent-proxy daemon start`, then run this again.",
        )
      }
      return {
        target: { address: clientAddress(config.listen.host, config.listen.port) },
        running: false,
      }
    }),
  ),
)

const notRunningNote = (name: string) =>
  `The daemon is not running, so ${name} will fail until you start it with \`agent-proxy daemon start\`.`

/** `file` as the owner would type it: `~/…` when it lies under their home directory. */
const displayPath = (file: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = yield* Config.NonEmptyString("HOME")
    const relative = path.relative(home, file)
    return relative.startsWith("..") || path.isAbsolute(relative) ? file : `~/${relative}`
  })

/** A file's content, or `None` when it does not exist. */
const readIfExists = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    )
  })

/**
 * The change from `current` to `next` as a unified diff, like `diff -u`.
 * A file that does not exist yet is shown as `/dev/null`.
 */
const diff = (current: Option.Option<string>, next: string, name: string) =>
  // TextDiff is experimental; a change to its API breaks only this display.
  // oxlint-disable-next-line effecttsgo/experimental-api-usage
  TextDiff.unified(
    // oxlint-disable-next-line effecttsgo/experimental-api-usage
    TextDiff.lines(
      Option.getOrElse(current, () => ""),
      next,
    ),
    { fromFile: Option.isSome(current) ? name : "/dev/null", toFile: name },
  )

/** Asks a yes-or-no question; only "y" or "yes" is yes, and closed input is no. */
const confirm = (question: string) =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal
    yield* terminal.display(`${question} [y/N] `)
    const answer = yield* terminal.readLine.pipe(
      Effect.catchTag("QuitError", () => Effect.succeed("")),
    )
    return ["y", "yes"].includes(answer.trim().toLowerCase())
  })

/**
 * `agent-proxy connect <client>`: shows the change to the client's config
 * file as a diff, asks, and writes it. With `print`, it prints the snippet
 * only and touches nothing.
 */
export const connect = (connector: ClientConnector, options: { readonly print: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { target, running } = yield* proxyTarget
    const file = yield* connector.file
    const shown = yield* displayPath(file)
    if (options.print) {
      yield* Console.error(`Add these settings to ${shown}:`)
      yield* Console.log(connector.snippet(target).trimEnd())
      if (!running) {
        yield* Console.error(notRunningNote(connector.name))
      }
      return
    }

    const current = yield* readIfExists(file)
    if (Option.isNone(current)) {
      // A link whose target is missing (a dotfiles repo not checked out) is
      // refused: writing here would replace the link with a plain file.
      const entry = yield* fs.lstat(file).pipe(Effect.option)
      if (Option.isSome(entry) && entry.value.type === "SymbolicLink") {
        const linkTarget = yield* fs.readLink(file).pipe(Effect.orElseSucceed(() => "its target"))
        return yield* userError(
          `${shown} is a link to ${linkTarget}, which does not exist. Create that file, or remove the link, then run this again.`,
        )
      }
    }
    const change = yield* Effect.fromResult(connector.change(current, target, shown)).pipe(
      Effect.mapError((error) => userError(error.message)),
    )
    if (Option.isNone(change)) {
      return yield* Console.log(
        `${connector.name} is already connected to the proxy at ${target.address}; ${shown} is unchanged.`,
      )
    }
    const next = change.value

    yield* Console.log(
      `Connecting ${connector.name} to the proxy at ${target.address} changes ${shown}:\n`,
    )
    yield* Console.log(diff(current, next, shown))
    if (!(yield* confirm(`Write ${shown}?`))) {
      return yield* userError(`Nothing written; ${shown} is unchanged.`)
    }
    // The client may have rewritten its file while the owner read the diff.
    // Checked again after the backup, right before the replace, so the
    // window for a lost edit is as small as it can be.
    const unchanged = Effect.gen(function* () {
      if (!Equal.equals(yield* readIfExists(file), current)) {
        return yield* userError(
          `${shown} changed while you were deciding, so nothing was written. Run this again to see the change against it.`,
        )
      }
    })
    yield* unchanged
    if (Option.isSome(current)) {
      // A link into a dotfiles repo stays a link: the file it names is
      // replaced, keeping its mode, and the backup sits beside the link.
      const real = yield* fs.realPath(file)
      const mode = (yield* fs.stat(real)).mode & 0o777
      yield* writeFileAtomic(`${file}.bak`, current.value, { mode })
      yield* unchanged
      yield* writeFileAtomic(real, next, { mode })
    } else {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* writeFileAtomic(file, next)
    }
    yield* Console.log(
      `Connected ${connector.name} to the proxy at ${target.address}.${Option.isSome(current) ? ` The old settings are in ${shown}.bak.` : ""}`,
    )
    if (!running) {
      yield* Console.log(notRunningNote(connector.name))
    }
  })
