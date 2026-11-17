import { Config, Effect, Equal, FileSystem, Option, Path, Predicate, Result } from "effect"
import { applyEdits, type FormattingOptions, modify, parse, type ParseError } from "jsonc-parser"

import { ClientConfigError, type ClientConnector, type ProxyTarget } from "./connector.ts"

/**
 * opencode, through its global config file. Two providers point at the
 * proxy, as the spike confirmed against opencode 2.3.0:
 *
 * - `claude-agent`, opencode's Claude Agent integration, which runs the real
 *   `claude` (ADR-0006). It ignores `~/.claude/settings.json`, so its base URL
 *   and key are set here; opencode hands them to `claude` as
 *   `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`.
 * - `agent-proxy-codex`, an OpenAI Responses provider at the proxy's Codex
 *   path. The Codex backend accepts what it sends unchanged, so the proxy
 *   needs no exception for it.
 *
 * opencode cannot run a command for its key, so both read the key file the
 * daemon keeps, with `{file:…}`: the file never holds the key (ADR-0005).
 * opencode reads it when it loads its config, so a rotated key needs a restart.
 *
 * The file is JSONC: opencode allows comments and trailing commas. It is
 * changed by editing the settings in place, so comments, order and layout
 * stay; only the line a new setting goes after may be laid out again. The
 * result is parsed again and must mean exactly the old file plus these
 * settings.
 */

const CLAUDE_AGENT = "claude-agent"
const CODEX = "agent-proxy-codex"

/**
 * The Codex models opencode offers, written only when the provider has none,
 * so a list the owner edits stays theirs. opencode lists only the models its
 * config names. They are GPT-6 models the Codex backend's catalog lists, the
 * ones the owner runs today. The list is fixed, not read from the catalog at
 * `/backend-api/codex/models`: that differs by the account serving it and
 * needs one, while `connect` works before any account is added, and a fixed
 * list keeps a repeat run a no-op.
 */
const CODEX_MODELS = {
  "gpt-6.1-sol": { name: "GPT-6.1 Sol" },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra" },
  "gpt-6-astra": { name: "GPT-6 Astra" },
  "gpt-6-luna": { name: "GPT-6 Luna" },
}

type JsonPath = ReadonlyArray<string>

/** Every setting `connect` manages, by path, with its value for `target`. */
const settings = (target: ProxyTarget): ReadonlyArray<readonly [JsonPath, unknown]> => {
  const apiKey = `{file:${target.keyFile}}`
  return [
    [["providers", CLAUDE_AGENT, "settings", "baseURL"], target.address],
    [["providers", CLAUDE_AGENT, "settings", "apiKey"], apiKey],
    [["providers", CODEX, "name"], "agent-proxy (Codex)"],
    [["providers", CODEX, "canonical"], "openai"],
    [["providers", CODEX, "package"], "@opencode/ai/providers/openai/responses"],
    [["providers", CODEX, "settings", "baseURL"], `${target.address}/backend-api/codex`],
    [["providers", CODEX, "settings", "apiKey"], apiKey],
  ]
}
const MODELS: JsonPath = ["providers", CODEX, "models"]

const snippet = (target: ProxyTarget) =>
  `${JSON.stringify(
    {
      providers: {
        [CLAUDE_AGENT]: {
          settings: { baseURL: target.address, apiKey: `{file:${target.keyFile}}` },
        },
        [CODEX]: {
          name: "agent-proxy (Codex)",
          canonical: "openai",
          package: "@opencode/ai/providers/openai/responses",
          settings: {
            baseURL: `${target.address}/backend-api/codex`,
            apiKey: `{file:${target.keyFile}}`,
          },
          models: CODEX_MODELS,
        },
      },
    },
    null,
    2,
  )}\n`

type JsonObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/** Parses JSONC as opencode does: comments and trailing commas allowed. */
const parseJsonc = (text: string): Result.Result<unknown, string> => {
  const errors: Array<ParseError> = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  return first === undefined
    ? Result.succeed(value)
    : Result.fail(`${parseErrorName(first.error)} at offset ${first.offset}`)
}

const PARSE_ERRORS: ReadonlyArray<string> = [
  "",
  "invalid symbol",
  "invalid number format",
  "property name expected",
  "value expected",
  "colon expected",
  "comma expected",
  "closing brace expected",
  "closing bracket expected",
  "end of file expected",
  "invalid comment token",
  "unexpected end of comment",
  "unexpected end of string",
  "unexpected end of number",
  "invalid unicode",
  "invalid escape character",
  "invalid character",
]
const parseErrorName = (code: number) => PARSE_ERRORS[code] ?? "syntax error"

const valueAt = (value: unknown, path: JsonPath): unknown =>
  path.reduce<unknown>((at, key) => (isObject(at) ? at[key] : undefined), value)

/**
 * Why `config` cannot hold the settings, if it cannot: each object on the way
 * to them must be an object, or missing.
 */
const unfit = (config: unknown): Option.Option<string> => {
  if (!isObject(config)) return Option.some("it is not a JSON object")
  for (const path of [
    ["providers"],
    ["providers", CLAUDE_AGENT],
    ["providers", CLAUDE_AGENT, "settings"],
    ["providers", CODEX],
    ["providers", CODEX, "settings"],
    MODELS,
  ]) {
    const value = valueAt(config, path)
    if (value !== undefined && !isObject(value)) {
      return Option.some(`its ${path.join(".")} is not an object`)
    }
  }
  return Option.none()
}

const hasModels = (config: unknown) => {
  const models = valueAt(config, MODELS)
  return isObject(models) && Object.keys(models).length > 0
}

/** The settings `connect` manages, as `config` has them. */
const managed = (config: unknown, target: ProxyTarget) => ({
  settings: settings(target).map(([path]) => valueAt(config, path)),
  hasModels: hasModels(config),
})

/** `config` without the settings `connect` manages, nor the objects that only held them. */
const unmanaged = (config: unknown, target: ProxyTarget): unknown => {
  const paths = [...settings(target).map(([path]) => path), MODELS]
  const strip = (value: unknown, at: JsonPath): unknown => {
    if (!isObject(value)) return value
    const kept = Object.entries(value).flatMap(([key, child]): ReadonlyArray<[string, unknown]> => {
      const path = [...at, key]
      if (paths.some((managedPath) => Equal.equals(managedPath, path))) return []
      const stripped = strip(child, path)
      const onTheWay = paths.some((managedPath) =>
        Equal.equals(managedPath.slice(0, path.length), path),
      )
      // An object that led to managed settings and holds nothing else was made for them.
      return onTheWay && isObject(stripped) && Object.keys(stripped).length === 0
        ? []
        : [[key, stripped]]
    })
    return Object.fromEntries(kept)
  }
  return strip(config, [])
}

/** How `text` is laid out, so a new setting matches it. */
const formatting = (text: string): FormattingOptions => {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  "
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  }
}

/** `text` with the setting at `path` set to `value`. */
const set = (text: string, path: JsonPath, value: unknown) =>
  applyEdits(text, modify(text, [...path], value, { formattingOptions: formatting(text) }))

export const opencode: ClientConnector = {
  name: "opencode",
  // opencode reads its global config from `$OPENCODE_CONFIG_DIR` when that is
  // set, else `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. It loads
  // both `opencode.json` and `opencode.jsonc` there, and the `.jsonc` wins, so
  // that is the file to change when it exists.
  file: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const configDir = yield* Config.option(Config.NonEmptyString("OPENCODE_CONFIG_DIR"))
    const xdgConfigHome = yield* Config.option(Config.NonEmptyString("XDG_CONFIG_HOME"))
    const dir = Option.isSome(configDir)
      ? configDir.value
      : path.join(
          Option.isSome(xdgConfigHome)
            ? xdgConfigHome.value
            : path.join(yield* Config.NonEmptyString("HOME"), ".config"),
          "opencode",
        )
    const jsonc = path.join(dir, "opencode.jsonc")
    // A link counts even when its target is missing, so it is refused, not passed over.
    const hasJsonc = Option.isSome(yield* fs.lstat(jsonc).pipe(Effect.option))
    return hasJsonc ? jsonc : path.join(dir, "opencode.json")
  }),
  snippet,
  note: "opencode shows the Claude Agent models once its Claude login is connected: run `opencode auth login claude-agent --method claude-login` if you have not.",
  change: (current, target, name) => {
    // opencode swaps `{file:…}` into the raw text before it parses the JSON,
    // so a path with a quote, backslash or `}` would be read back wrong and
    // every request would go out with an empty key.
    if (/["\\}]/.test(target.keyFile)) {
      return Result.fail(
        new ClientConfigError({
          message: `The proxy key file ${target.keyFile} has a quote, backslash or } in its path, so connect cannot name it in {file:…} for opencode, and ${name} was left unchanged. Point XDG_DATA_HOME at a plainer path, or set the key in opencode by hand.`,
        }),
      )
    }
    const text = Option.getOrElse(current, () => "")
    const parsed = text.trim() === "" ? Result.succeed<unknown>({}) : parseJsonc(text)
    if (Result.isFailure(parsed)) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} is not valid JSON (${parsed.failure}), so it was left unchanged. Fix it, or move it aside, and run this again.`,
        }),
      )
    }
    const config = parsed.success
    const why = unfit(config)
    if (Option.isSome(why)) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} does not hold opencode settings (${why.value}), so it was left unchanged.`,
        }),
      )
    }
    const wanted = managed(JSON.parse(snippet(target)), target)
    if (Equal.equals(managed(config, target), wanted)) {
      return Result.succeed(Option.none())
    }

    const withSettings = settings(target).reduce(
      (next, [path, value]) =>
        Equal.equals(valueAt(config, path), value) ? next : set(next, path, value),
      text.trim() === "" ? "{}" : text,
    )
    const withModels = hasModels(config) ? withSettings : set(withSettings, MODELS, CODEX_MODELS)
    const next = /\r?\n$/.test(withModels)
      ? withModels
      : `${withModels}${formatting(withModels).eol}`

    const written = parseJsonc(next)
    if (
      Result.isFailure(written) ||
      !Equal.equals(managed(written.success, target), wanted) ||
      !Equal.equals(unmanaged(written.success, target), unmanaged(config, target))
    ) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} sets the opencode providers in a way connect cannot change safely, so it was left unchanged. Add the settings \`agent-proxy connect opencode --print\` shows by hand.`,
        }),
      )
    }
    return Result.succeed(Option.some(next))
  },
}
