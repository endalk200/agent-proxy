import { Config, Effect, Equal, Option, Path, Predicate, Result } from "effect"

import { ClientConfigError, type ClientConnector, type ProxyTarget } from "./connector.ts"

/**
 * Codex, through `config.toml` in its home (`$CODEX_HOME`, else `~/.codex`):
 * a provider named `agent-proxy`, set as `model_provider`, whose `auth`
 * command fetches the proxy key by running `agent-proxy key`, so the file
 * never holds the key (ADR-0005). The spike confirmed it against Codex 0.169.0:
 * `name` must be exactly `OpenAI` and `base_url` must end in
 * `/backend-api/codex`, which together turn on Codex's backend routes (the
 * model list, web search); `supports_websockets` stays unset, so Codex never
 * tries the WebSocket upgrade the proxy refuses.
 *
 * The owner's file is changed by splicing text, not by parsing and printing
 * it again, so comments, ordering and every other table stay byte for byte.
 * Only two things are touched: the root `model_provider` value, and the
 * `[model_providers.agent-proxy]` table, which is replaced whole (or appended).
 * The result is parsed again and must mean exactly the old file plus those
 * two settings; a file laid out in a way the splice gets wrong (the provider
 * in dotted keys or an inline table, say) is refused rather than guessed at.
 */

const PROVIDER = "agent-proxy"

/** The provider table, as it is written. */
const providerTable = (target: ProxyTarget) => `[model_providers.${PROVIDER}]
name = "OpenAI"
base_url = "${target.address}/backend-api/codex"
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }
`

const snippet = (target: ProxyTarget) =>
  `model_provider = "${PROVIDER}"\n\n${providerTable(target)}`

type Table = Readonly<Record<string, unknown>>

const isTable = (value: unknown): value is Table =>
  Predicate.isObject(value) && !Array.isArray(value)

const parse = (text: string): Result.Result<Table, string> => {
  try {
    const parsed: unknown = Bun.TOML.parse(text)
    return isTable(parsed) ? Result.succeed(parsed) : Result.fail("it is not a table")
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error))
  }
}

/** The two settings `connect` manages: the root `model_provider`, and the `agent-proxy` provider. */
const managed = (config: Table) => ({
  modelProvider: config["model_provider"],
  provider: isTable(config["model_providers"]) ? config["model_providers"][PROVIDER] : undefined,
})

/** Everything in `config` that `connect` does not manage. */
const unmanaged = (config: Table): Table => {
  const { model_provider: _modelProvider, model_providers: providers, ...rest } = config
  if (!isTable(providers)) {
    return providers === undefined ? rest : { ...rest, model_providers: providers }
  }
  const { [PROVIDER]: _provider, ...others } = providers
  return Object.keys(others).length === 0 ? rest : { ...rest, model_providers: others }
}

const isHeader = (line: string) => /^\s*\[/.test(line)
const isProviderHeader = (line: string) =>
  /^\s*\[\s*model_providers\s*\.\s*(?:agent-proxy|"agent-proxy"|'agent-proxy')\s*\](?:\s*#.*)?\s*$/.test(
    line,
  )
const isBlank = (line: string) => line.trim() === ""
const isComment = (line: string) => /^\s*#/.test(line)

/** The index of the first line of the run of `matches` lines that ends just before `index`. */
const skipBack = (
  lines: ReadonlyArray<string>,
  index: number,
  matches: (line: string) => boolean,
) => {
  let at = index
  while (at > 0 && matches(lines[at - 1] ?? "")) {
    at--
  }
  return at
}

/** Replaces the `[model_providers.agent-proxy]` table in `lines`, or appends it. */
const withProviderTable = (lines: ReadonlyArray<string>, table: string): Array<string> => {
  const tableLines = table.trimEnd().split("\n")
  const start = lines.findIndex(isProviderHeader)
  if (start === -1) {
    const kept = lines.at(-1) === "" ? lines.slice(0, -1) : [...lines]
    const gap = kept.length === 0 || kept.at(-1)?.trim() === "" ? [] : [""]
    return [...kept, ...gap, ...tableLines, ""]
  }
  const next = lines.findIndex((line, index) => index > start && isHeader(line))
  // The comments attached to the next table belong to it, and the blank
  // lines above them stay as the gap between the two tables.
  const end = skipBack(
    lines,
    skipBack(lines, next === -1 ? lines.length : next, isComment),
    isBlank,
  )
  return [...lines.slice(0, start), ...tableLines, ...lines.slice(Math.max(end, start + 1))]
}

const ROOT_KEY =
  /^(\s*(?:model_provider|"model_provider"|'model_provider')\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')(.*)$/

/** Sets the root `model_provider` in `lines`: in place when it is there, else after the last root setting. */
const withModelProvider = (lines: ReadonlyArray<string>): Array<string> => {
  const firstHeader = lines.findIndex(isHeader)
  const rootEnd = firstHeader === -1 ? lines.length : firstHeader
  const root = lines.slice(0, rootEnd)
  const existing = root.findIndex((line) => ROOT_KEY.test(line))
  if (existing !== -1) {
    return lines.map((line, index) =>
      index === existing ? line.replace(ROOT_KEY, `$1"${PROVIDER}"$2`) : line,
    )
  }
  const setting = `model_provider = "${PROVIDER}"`
  const lastSetting = root.findLastIndex((line) => !isBlank(line) && !isComment(line))
  if (lastSetting !== -1) {
    return [...lines.slice(0, lastSetting + 1), setting, ...lines.slice(lastSetting + 1)]
  }
  // No root settings: it goes just above the first table and the comments
  // attached to it, with a blank line between.
  const at = skipBack(lines, rootEnd, isComment)
  return [...lines.slice(0, at), setting, "", ...lines.slice(at)]
}

export const codex: ClientConnector = {
  name: "Codex",
  // Codex reads its config from `$CODEX_HOME` when that is set, so that is
  // the file that has to change.
  file: Effect.gen(function* () {
    const path = yield* Path.Path
    const codexHome = yield* Config.option(Config.NonEmptyString("CODEX_HOME"))
    if (Option.isSome(codexHome)) {
      return path.join(codexHome.value, "config.toml")
    }
    return path.join(yield* Config.NonEmptyString("HOME"), ".codex", "config.toml")
  }),
  snippet,
  change: (current, target, name) => {
    const text = Option.getOrElse(current, () => "")
    const parsed = parse(text)
    if (Result.isFailure(parsed)) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} is not valid TOML (${parsed.failure}), so it was left unchanged. Fix it, or move it aside, and run this again.`,
        }),
      )
    }
    const config = parsed.success
    const wanted = Result.getOrThrow(parse(snippet(target)))
    if (Equal.equals(managed(config), managed(wanted))) {
      return Result.succeed(Option.none())
    }

    const next = withModelProvider(withProviderTable(text.split("\n"), providerTable(target))).join(
      "\n",
    )
    const written = parse(next)
    if (
      Result.isFailure(written) ||
      !Equal.equals(managed(written.success), managed(wanted)) ||
      !Equal.equals(unmanaged(written.success), unmanaged(config))
    ) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} sets model_provider or the ${PROVIDER} provider in a way connect cannot change safely, so it was left unchanged. Add the settings \`agent-proxy connect codex --print\` shows by hand.`,
        }),
      )
    }
    return Result.succeed(Option.some(next))
  },
}
