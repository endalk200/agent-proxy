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
import {
  applyEdits,
  findNodeAtLocation,
  type FormattingOptions,
  modify,
  parseTree,
} from "jsonc-parser"

import { writeFileAtomic } from "../atomic-file.ts"
import { asUserError, userError } from "../commands/errors.ts"
import { loadConfigFile } from "../config.ts"
import { fetchDaemonInfo } from "../daemon/client.ts"
import { clientAddress } from "../daemon/daemon.ts"
import { displayPath, resolveProxyKeyFile } from "../paths.ts"
import { RuntimeInfo } from "../runtime-info.ts"

/**
 * Pointing a client at the proxy by changing the client's own config file,
 * and pointing it back.
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
  /**
   * The proxy key file, for a client that reads the key from a file rather
   * than running `agent-proxy key`: `~/…` when it lies under the home
   * directory, else its absolute path.
   */
  readonly keyFile: string
  /**
   * The command a client runs for the proxy key: the installed binary's
   * absolute path, since a client started from a GUI or by launchd may not
   * have `~/.local/bin` on its PATH, or `agent-proxy` when running from source.
   */
  readonly command: string
}

/** What `disconnect` recognizes as connect's: the proxy key file, as `ProxyTarget` names it. */
export interface KeyFiles {
  /** Every way the key file may be named in a client config: `~/…` and absolute. */
  readonly keyFiles: ReadonlyArray<string>
}

/** A client config file the connector cannot change safely, with the reason to show the owner. */
export class ClientConfigError extends Data.TaggedError("ClientConfigError")<{
  readonly message: string
}> {}

/** What `disconnect` does to a file that holds connect's settings. */
export interface Removal {
  /** The file without them. */
  readonly next: string
  /** The settings it removes, as the client names them, such as `apiKeyHelper`. */
  readonly removed: ReadonlyArray<string>
  /**
   * The settings connect writes that it leaves alone because they no longer
   * hold what connect wrote, each with why, such as `apiKeyHelper ("op read …")`.
   */
  readonly kept: ReadonlyArray<string>
}

export interface ClientConnector {
  /** The client's name as the owner knows it, such as "Claude Code". */
  readonly name: string
  /** The client's config file. */
  readonly file: Effect.Effect<string, Config.ConfigError, Path.Path | FileSystem.FileSystem>
  /** The settings to add by hand, as `--print` shows them. */
  readonly snippet: (target: ProxyTarget) => string
  /** What the owner may still have to do in the client itself, shown after connecting and with `--print`. */
  readonly note?: string
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
  /**
   * The inverse of `change`: `current` without the settings connect writes,
   * as long as they still hold what it wrote, or `None` when it holds none.
   */
  readonly remove: (
    current: string,
    target: KeyFiles,
    name: string,
  ) => Result.Result<Option.Option<Removal>, ClientConfigError>
  /**
   * Which of the settings connect manages hold a value of the owner's in
   * `backup`, an earlier copy of the file: what connect may have replaced.
   */
  readonly ownedIn: (backup: string, target: KeyFiles) => ReadonlyArray<string>
  /**
   * What the owner should know about `content`, the file as it is once
   * connected (or disconnected), that no change of connect's fixes.
   */
  readonly warnings?: (
    content: string,
    name: string,
    direction: "connect" | "disconnect",
  ) => ReadonlyArray<string>
}

/**
 * Where the proxy listens: the running daemon's address, which it reports
 * through its API. When no daemon runs, the address `config.toml` makes it
 * listen on, unless that is any free port. `running` says which it was.
 */
const proxyAddress = fetchDaemonInfo.pipe(
  Effect.map((info) => ({ address: info.address, running: true })),
  Effect.catchTag("DaemonNotRunning", () =>
    Effect.gen(function* () {
      const { config } = yield* loadConfigFile.pipe(Effect.mapError(asUserError))
      if (config.listen.port === 0) {
        return yield* userError(
          "The agent-proxy daemon is not running, and config.toml lets it listen on any free port, so its address is not known yet. Start it with `agent-proxy daemon start`, then run this again.",
        )
      }
      return { address: clientAddress(config.listen.host, config.listen.port), running: false }
    }),
  ),
)

/** How the JSON `text` is laid out, so a setting `jsonc-parser` adds or removes matches it. */
export const formatting = (text: string): FormattingOptions => {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  "
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  }
}

/** The index just past the comma after `from`, skipping whitespace only; `undefined` when no comma follows. */
const commaAfter = (text: string, from: number) => {
  let at = from
  while (at < text.length && /\s/.test(text[at] ?? "")) at++
  return text[at] === "," ? at + 1 : undefined
}

/**
 * `text` without the property at `path`, removing only the property's own
 * text and one comma, so the comments around it, and those of the settings
 * that stay, are kept as they were. A property alone on its lines takes
 * those lines with it. `text` is unchanged when it has no such property.
 */
export const removeJsonProperty = (text: string, path: ReadonlyArray<string>): string => {
  const root = parseTree(text, [], { allowTrailingComma: true })
  const value = root === undefined ? undefined : findNodeAtLocation(root, [...path])
  const property = value?.parent
  const siblings = property?.parent?.children ?? []
  if (property === undefined || property.type !== "property") return text
  const index = siblings.indexOf(property)
  const end = property.offset + property.length

  // Its own lines: from the start of its first line, when only indentation
  // precedes it, to the end of its last, when only its comma follows.
  const lineStart = text.lastIndexOf("\n", property.offset - 1) + 1
  const start = text.slice(lineStart, property.offset).trim() === "" ? lineStart : property.offset
  const trimLine = (from: number) => {
    const newline = text.indexOf("\n", from)
    const lineEnd = newline === -1 ? text.length : newline + 1
    return text.slice(from, lineEnd).trim() === "" && start === lineStart ? lineEnd : from
  }

  const following = commaAfter(text, end)
  if (following !== undefined) {
    return text.slice(0, start) + text.slice(trimLine(following))
  }
  // The last property: the comma that goes is the one after the property before it.
  const previous = siblings[index - 1]
  const before =
    previous === undefined ? undefined : commaAfter(text, previous.offset + previous.length)
  const removed = text.slice(0, start) + text.slice(trimLine(end))
  if (before === undefined) {
    // An only property, or a comma behind a comment: let the parser's own edit decide.
    return previous === undefined
      ? removed
      : applyEdits(
          text,
          modify(text, [...path], undefined, { formattingOptions: formatting(text) }),
        )
  }
  return removed.slice(0, before - 1) + removed.slice(before)
}

/** A command as a shell reads it: quoted only when it has to be. */
const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

/** The command clients run for the proxy key, as `ProxyTarget.command` describes it. */
const keyCommand = Effect.gen(function* () {
  return Option.match((yield* RuntimeInfo).binary, {
    onNone: () => "agent-proxy",
    onSome: (binary) => binary.path,
  })
})

/** The proxy key file, by every name a client config may give it. */
const keyFiles = Effect.gen(function* () {
  const keyFile = yield* resolveProxyKeyFile
  const shown = yield* displayPath(keyFile)
  const target: KeyFiles = { keyFiles: shown === keyFile ? [keyFile] : [shown, keyFile] }
  return target
})

/**
 * What the client is pointed at. The key file is the one the daemon keeps,
 * found the way the daemon finds it, from the same environment.
 */
const proxyTarget = Effect.gen(function* () {
  const { address, running } = yield* proxyAddress
  const keyFile = yield* displayPath(yield* resolveProxyKeyFile)
  const command = yield* keyCommand
  const target: ProxyTarget = { address, keyFile, command }
  return { target, running }
})

/** `command` as a shell word, for a client that runs the key helper through a shell. */
export const keyHelper = (target: ProxyTarget) => `${shellWord(target.command)} key`

const notRunningNote = (name: string) =>
  `The daemon is not running, so ${name} will fail until you start it with \`agent-proxy daemon start\`.`

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
export const confirm = (question: string) =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal
    yield* terminal.display(`${question} [y/N] `)
    const answer = yield* terminal.readLine.pipe(
      Effect.catchTag("QuitError", () => Effect.succeed("")),
    )
    return ["y", "yes"].includes(answer.trim().toLowerCase())
  })

/** A client's config file: where it is, how the owner names it, and what it holds now. */
interface ClientFile {
  readonly file: string
  readonly shown: string
  readonly current: Option.Option<string>
}

/**
 * Reads `connector`'s file. A link whose target is missing (a dotfiles repo
 * not checked out) is refused: writing there would replace the link with a
 * plain file.
 */
const readClientFile = (connector: ClientConnector) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* connector.file
    const shown = yield* displayPath(file)
    const current = yield* readIfExists(file)
    if (Option.isNone(current)) {
      const entry = yield* fs.lstat(file).pipe(Effect.option)
      if (Option.isSome(entry) && entry.value.type === "SymbolicLink") {
        const linkTarget = yield* fs.readLink(file).pipe(Effect.orElseSucceed(() => "its target"))
        return yield* userError(
          `${shown} is a link to ${linkTarget}, which does not exist. Create that file, or remove the link, then run this again.`,
        )
      }
    }
    const found: ClientFile = { file, shown, current }
    return found
  })

/**
 * Writes `next` over `file`, which the owner saw as `current`. With `backup`,
 * the old content goes to `.bak` first, replacing any earlier one.
 */
const writeClientFile = (file: ClientFile, next: string, options: { readonly backup: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // The client may have rewritten its file while the owner read the diff.
    // Checked again after the backup, right before the replace, so the
    // window for a lost edit is as small as it can be.
    const unchanged = Effect.gen(function* () {
      if (!Equal.equals(yield* readIfExists(file.file), file.current)) {
        return yield* userError(
          `${file.shown} changed while you were deciding, so nothing was written. Run this again to see the change against it.`,
        )
      }
    })
    yield* unchanged
    if (Option.isSome(file.current)) {
      // A link into a dotfiles repo stays a link: the file it names is
      // replaced, keeping its mode, and the backup sits beside the link.
      const real = yield* fs.realPath(file.file)
      const mode = (yield* fs.stat(real)).mode & 0o777
      if (options.backup) {
        yield* writeFileAtomic(`${file.file}.bak`, file.current.value, { mode })
        yield* unchanged
      }
      yield* writeFileAtomic(real, next, { mode })
    } else {
      yield* fs.makeDirectory(path.dirname(file.file), { recursive: true })
      yield* writeFileAtomic(file.file, next)
    }
  })

const warningsFor = (
  connector: ClientConnector,
  content: Option.Option<string>,
  shown: string,
  direction: "connect" | "disconnect",
) =>
  connector.warnings === undefined || Option.isNone(content)
    ? []
    : connector.warnings(content.value, shown, direction)

/**
 * `agent-proxy connect <client>`: shows the change to the client's config
 * file as a diff, asks, and writes it. With `print`, it prints the snippet
 * only and touches nothing.
 */
export const connect = (connector: ClientConnector, options: { readonly print: boolean }) =>
  Effect.gen(function* () {
    const { target, running } = yield* proxyTarget
    const file = yield* connector.file
    const shown = yield* displayPath(file)
    if (options.print) {
      yield* Console.error(`Add these settings to ${shown}:`)
      yield* Console.log(connector.snippet(target).trimEnd())
      if (connector.note !== undefined) {
        yield* Console.error(connector.note)
      }
      if (!running) {
        yield* Console.error(notRunningNote(connector.name))
      }
      const current = yield* readIfExists(file).pipe(Effect.orElseSucceed(() => Option.none()))
      for (const warning of warningsFor(connector, current, shown, "connect")) {
        yield* Console.error(warning)
      }
      return
    }

    const client = yield* readClientFile(connector)
    const change = yield* Effect.fromResult(connector.change(client.current, target, shown)).pipe(
      Effect.mapError((error) => userError(error.message)),
    )
    if (Option.isNone(change)) {
      yield* Console.log(
        `${connector.name} is already connected to the proxy at ${target.address}; ${shown} is unchanged.`,
      )
      for (const warning of warningsFor(connector, client.current, shown, "connect")) {
        yield* Console.log(warning)
      }
      return
    }
    const next = change.value

    yield* Console.log(
      `Connecting ${connector.name} to the proxy at ${target.address} changes ${shown}:\n`,
    )
    yield* Console.log(diff(client.current, next, shown))
    if (!(yield* confirm(`Write ${shown}?`))) {
      return yield* userError(`Nothing written; ${shown} is unchanged.`)
    }
    yield* writeClientFile(client, next, { backup: true })
    yield* Console.log(
      `Connected ${connector.name} to the proxy at ${target.address}.${Option.isSome(client.current) ? ` The old settings are in ${shown}.bak.` : ""}`,
    )
    if (connector.note !== undefined) {
      yield* Console.log(connector.note)
    }
    if (!running) {
      yield* Console.log(notRunningNote(connector.name))
    }
    for (const warning of warningsFor(connector, Option.some(next), shown, "connect")) {
      yield* Console.log(warning)
    }
  })

/** What disconnecting one client does: its file, the removal, and what to tell the owner after. */
export interface DisconnectPlan {
  readonly connector: ClientConnector
  readonly client: ClientFile & { readonly current: Option.Some<string> }
  readonly removal: Removal
  /** The removed settings `.bak` holds a value of the owner's for: what connect replaced. */
  readonly replaced: ReadonlyArray<string>
  /** Whether a `.bak` already exists, which disconnect keeps rather than replaces. */
  readonly hasBackup: boolean
}

/**
 * What `disconnect` would do to `connector`'s file: `None` when the file does
 * not exist or holds none of connect's settings.
 */
export const planDisconnect = (connector: ClientConnector) =>
  Effect.gen(function* () {
    const client = yield* readClientFile(connector)
    if (Option.isNone(client.current)) return Option.none<DisconnectPlan>()
    const target = yield* keyFiles
    const removal = yield* Effect.fromResult(
      connector.remove(client.current.value, target, client.shown),
    ).pipe(Effect.mapError((error) => userError(error.message)))
    if (Option.isNone(removal)) return Option.none<DisconnectPlan>()
    const backup = yield* readIfExists(`${client.file}.bak`).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    )
    const owned: ReadonlyArray<string> = Option.match(backup, {
      onNone: () => [],
      onSome: (content) => connector.ownedIn(content, target),
    })
    const plan: DisconnectPlan = {
      connector,
      client: { ...client, current: client.current },
      removal: removal.value,
      replaced: removal.value.removed.filter((setting) => owned.includes(setting)),
      hasBackup: Option.isSome(backup),
    }
    return Option.some(plan)
  })

/** Shows the plan's change as a diff, under a line saying what it is. */
export const showDisconnect = (plan: DisconnectPlan) =>
  Effect.gen(function* () {
    yield* Console.log(
      `Disconnecting ${plan.connector.name} from the proxy changes ${plan.client.shown}:\n`,
    )
    yield* Console.log(diff(plan.client.current, plan.removal.next, plan.client.shown))
  })

/**
 * Writes the plan and says what happened. A `.bak` that exists is kept:
 * it is the copy connect took of the owner's settings, while the settings
 * disconnect removes are only connect's own.
 */
export const applyDisconnect = (plan: DisconnectPlan) =>
  Effect.gen(function* () {
    const { connector, client, removal } = plan
    yield* writeClientFile(client, removal.next, { backup: !plan.hasBackup })
    yield* Console.log(`Disconnected ${connector.name} from the proxy.`)
    if (removal.kept.length > 0) {
      yield* Console.log(
        `Kept, since connect did not write it, or it was changed since: ${removal.kept.join(", ")}.`,
      )
    }
    if (plan.replaced.length > 0) {
      yield* Console.log(
        `connect had replaced your ${plan.replaced.join(" and ")}; the earlier value is in ${client.shown}.bak, to restore by hand.`,
      )
    }
    for (const warning of warningsFor(
      connector,
      Option.some(removal.next),
      client.shown,
      "disconnect",
    )) {
      yield* Console.log(warning)
    }
  })

/**
 * `agent-proxy disconnect <client>`: removes what connect wrote to the
 * client's config file, showing it as a diff and asking first, and only
 * where it still holds what connect wrote.
 */
export const disconnect = (connector: ClientConnector) =>
  Effect.gen(function* () {
    const plan = yield* planDisconnect(connector)
    if (Option.isNone(plan)) {
      const client = yield* readClientFile(connector)
      yield* Console.log(
        Option.isNone(client.current)
          ? `${connector.name} is not connected to the proxy; ${client.shown} does not exist.`
          : `${connector.name} is not connected to the proxy; ${client.shown} is unchanged.`,
      )
      for (const warning of warningsFor(connector, client.current, client.shown, "disconnect")) {
        yield* Console.log(warning)
      }
      return
    }
    yield* showDisconnect(plan.value)
    if (!(yield* confirm(`Write ${plan.value.client.shown}?`))) {
      return yield* userError(`Nothing written; ${plan.value.client.shown} is unchanged.`)
    }
    yield* applyDisconnect(plan.value)
  })
