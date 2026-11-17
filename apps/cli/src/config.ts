import { Data, Effect, FileSystem, Option, Result, Schema, SchemaIssue } from "effect"

import { resolveConfigFile } from "./paths.ts"

/**
 * The owner's `config.toml` (ADR-0004): hand-edited, never written by agent-proxy.
 * A missing file means every default applies.
 */

/** Where the daemon listens: a host (IPv4, IPv6, or name) and a TCP port. Port 0 binds any free port. */
export interface ListenAddress {
  readonly host: string
  readonly port: number
}

export interface ProxyConfig {
  readonly listen: ListenAddress
}

export const defaultConfig: ProxyConfig = { listen: { host: "127.0.0.1", port: 8318 } }

export class ConfigFileError extends Data.TaggedError("ConfigFileError")<{
  readonly message: string
}> {}

const LISTEN_PATTERN = /^(?:\[([^\]\s]+)\]|([^:[\]\s]+)):(\d{1,5})$/

const parseListen = (value: string): Option.Option<ListenAddress> => {
  const match = LISTEN_PATTERN.exec(value)
  const host = match?.[1] ?? match?.[2]
  const port = Number(match?.[3])
  return host !== undefined && port <= 65_535 ? Option.some({ host, port }) : Option.none()
}

const ConfigFile = Schema.Struct({
  listen: Schema.optionalKey(
    Schema.String.check(Schema.makeFilter((value) => Option.isSome(parseListen(value)))),
  ),
})

/** What to tell the owner when a known key holds a bad value. */
const keyProblems: Readonly<Record<string, string>> = {
  listen: 'listen must be a "host:port" string, such as "127.0.0.1:8318"',
}

const knownKeys = Object.keys(ConfigFile.fields)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/**
 * The 1-based line where top-level `key` is defined, as `key = …`, `key.sub = …`,
 * or a `[key]` table header. Keys inside other tables are skipped.
 */
const lineOfKey = (lines: ReadonlyArray<string>, key: string): number | undefined => {
  const name = `(?:${escapeRegExp(key)}|"${escapeRegExp(key)}"|'${escapeRegExp(key)}')`
  const header = /^\s*\[/
  const tableHeader = new RegExp(String.raw`^\s*\[\[?\s*${name}\s*[\].]`)
  const assignment = new RegExp(String.raw`^\s*${name}\s*[=.]`)
  let inTable = false
  for (const [index, line] of lines.entries()) {
    if (header.test(line)) {
      if (tableHeader.test(line)) return index + 1
      inTable = true
    } else if (!inTable && assignment.test(line)) {
      return index + 1
    }
  }
  return undefined
}

const parseToml = (text: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(Bun.TOML.parse(text))
  } catch (error) {
    return Result.fail(String(error instanceof Error ? error.message : error))
  }
}

/**
 * Bun's TOML errors carry no position, so the line is found by parsing ever
 * longer prefixes: the error sits on the line after the longest prefix that
 * still parses. A value spanning lines (an array, a multi-line string) only
 * parses once complete, so lines inside it never count as that prefix's end.
 */
const lineOfSyntaxError = (lines: ReadonlyArray<string>): number => {
  let parsed = 0
  for (let count = 1; count <= lines.length; count++) {
    if (Result.isSuccess(parseToml(lines.slice(0, count).join("\n")))) parsed = count
  }
  return Math.min(parsed + 1, lines.length)
}

/** Parses the text of a config file at `path` (used only in messages). */
export const parseConfig = (
  path: string,
  text: string,
): Result.Result<ProxyConfig, ConfigFileError> => {
  const lines = text.split("\n")
  const fail = (line: number | undefined, problem: string) =>
    Result.fail(
      new ConfigFileError({
        message: `Invalid config file ${path}${line === undefined ? "" : `, line ${line}`}: ${problem}`,
      }),
    )

  const toml = parseToml(text)
  if (Result.isFailure(toml)) {
    return fail(lineOfSyntaxError(lines), toml.failure.replace(/^TOML Parse error: /, ""))
  }

  const decoded = Schema.decodeUnknownResult(ConfigFile)(toml.success, {
    onExcessProperty: "error",
  })
  if (Result.isFailure(decoded)) {
    const [issue] = formatIssues(decoded.failure.issue).issues
    const segment = issue?.path?.[0]
    const key = typeof segment === "object" ? String(segment.key) : String(segment ?? "")
    const problem = knownKeys.includes(key)
      ? (keyProblems[key] ?? `${key}: ${issue?.message}`)
      : `unknown key "${key}" (the only key is "listen")`
    return fail(lineOfKey(lines, key), problem)
  }

  const listen = Option.flatMap(Option.fromUndefinedOr(decoded.success.listen), parseListen)
  return Result.succeed({ listen: Option.getOrElse(listen, () => defaultConfig.listen) })
}

/**
 * Loads the config file at `path`. A missing file yields `defaultConfig`,
 * unless `explicit` says the owner named it, where a missing file is a mistake.
 */
export const loadConfig = Effect.fn("loadConfig")(function* (
  path: string,
  options?: { readonly explicit?: boolean },
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
    Effect.mapError(
      (error) =>
        new ConfigFileError({ message: `Could not read config file ${path}: ${error.message}` }),
    ),
  )
  if (Option.isNone(text)) {
    if (options?.explicit === true) {
      return yield* new ConfigFileError({
        message: `AGENT_PROXY_CONFIG names ${path}, which does not exist.`,
      })
    }
    return defaultConfig
  }
  return yield* Effect.fromResult(parseConfig(path, text.value))
})

/** Finds the config file (see `resolveConfigFile`) and loads it. */
export const loadConfigFile = Effect.gen(function* () {
  const file = yield* resolveConfigFile
  const config = yield* loadConfig(file.path, { explicit: file.explicit })
  return { path: file.path, config }
})
