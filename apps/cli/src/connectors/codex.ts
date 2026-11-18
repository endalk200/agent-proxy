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
 * `disconnect` removes the same two the same way.
 *
 * Codex profiles are never edited: a `[profiles.<name>]` that sets its own
 * `model_provider` wins over the root one, so connect warns about it instead.
 */

const PROVIDER = "agent-proxy"

/** The provider table, as it is written. */
const providerTable = (target: ProxyTarget) => `[model_providers.${PROVIDER}]
name = "OpenAI"
base_url = "${target.address}/backend-api/codex"
wire_api = "responses"
auth = { command = ${JSON.stringify(target.command)}, args = ["key"] }
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
  // Only the table's own settings go: the comments and blank lines after its
  // last setting stay, so no comment is ever lost.
  const end = skipBack(
    lines,
    next === -1 ? lines.length : next,
    (line) => isComment(line) || isBlank(line),
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

/** `lines` without the runs `[start, end)` in `blocks`, leaving one blank line where two would meet. */
const withoutBlocks = (
  lines: ReadonlyArray<string>,
  blocks: ReadonlyArray<readonly [number, number]>,
): Array<string> => {
  let kept = [...lines]
  // Last block first, so the earlier ones keep their indexes.
  for (const [start, end] of [...blocks].toSorted((a, b) => b[0] - a[0])) {
    let from = start
    let to = end
    const after = kept[to]
    if (after !== undefined && isBlank(after)) {
      if (from === 0) to++
      else if (isBlank(kept[from - 1] ?? "")) from--
    }
    kept = [...kept.slice(0, from), ...kept.slice(to)]
  }
  return kept
}

/** The `[model_providers.agent-proxy]` table's lines, as `[start, end)`, without the comments after it. */
const providerBlock = (lines: ReadonlyArray<string>): Option.Option<readonly [number, number]> => {
  const start = lines.findIndex(isProviderHeader)
  if (start === -1) return Option.none()
  const next = lines.findIndex((line, index) => index > start && isHeader(line))
  const end = skipBack(
    lines,
    next === -1 ? lines.length : next,
    (line) => isComment(line) || isBlank(line),
  )
  return Option.some([start, Math.max(end, start + 1)])
}

/** The root `model_provider = "agent-proxy"` line, if the file sets it there. */
const rootProviderLine = (lines: ReadonlyArray<string>): Option.Option<number> => {
  const firstHeader = lines.findIndex(isHeader)
  const root = lines.slice(0, firstHeader === -1 ? lines.length : firstHeader)
  const at = root.findIndex(
    (line) => ROOT_KEY.test(line) && /=\s*(?:"agent-proxy"|'agent-proxy')/.test(line),
  )
  return at === -1 ? Option.none() : Option.some(at)
}

/** The 1-based line `[profiles.<profile>]` sets `model_provider` on, when it is written as a table. */
const profileProviderLine = (lines: ReadonlyArray<string>, profile: string) => {
  const quoted = profile.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const header = new RegExp(
    String.raw`^\s*\[\s*profiles\s*\.\s*(?:${quoted}|"${quoted}"|'${quoted}')\s*\](?:\s*#.*)?\s*$`,
  )
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) return Option.none<number>()
  for (let index = start + 1; index < lines.length && !isHeader(lines[index] ?? ""); index++) {
    if (/^\s*(?:model_provider|"model_provider"|'model_provider')\s*=/.test(lines[index] ?? "")) {
      return Option.some(index + 1)
    }
  }
  return Option.none<number>()
}

/** Each profile that sets its own `model_provider`, with it. */
const profileProviders = (config: Table) => {
  const profiles = config["profiles"]
  if (!isTable(profiles)) return []
  return Object.entries(profiles).flatMap(([profile, settings]) =>
    isTable(settings) && typeof settings["model_provider"] === "string"
      ? [{ profile, provider: settings["model_provider"] }]
      : [],
  )
}

/**
 * What the owner should know about Codex's profiles (#22). Connected, a
 * profile that sets another provider bypasses the proxy: the active one
 * always, any other under `codex --profile`. Disconnected, a profile that
 * still names `agent-proxy` names a provider that is gone.
 */
const profileWarnings = (content: string, name: string, direction: "connect" | "disconnect") => {
  const parsed = parse(content)
  if (Result.isFailure(parsed)) return []
  const config = parsed.success
  const lines = content.split(/\r?\n/)
  const active = typeof config["profile"] === "string" ? config["profile"] : undefined
  const at = (profile: string) =>
    Option.match(profileProviderLine(lines, profile), {
      onNone: () => name,
      onSome: (line) => `${name}, line ${line}`,
    })
  const providers = profileProviders(config)

  if (direction === "disconnect") {
    return providers
      .filter(({ provider }) => provider === PROVIDER)
      .map(
        ({ profile }) =>
          `Codex profile ${profile} still sets model_provider = "${PROVIDER}" (${at(profile)}), a provider that no longer exists, so Codex fails${profile === active ? "" : ` with --profile ${profile}`}. Change that line to the provider you use, or delete it.`,
      )
  }
  const bypassing = providers.filter(({ provider }) => provider !== PROVIDER)
  const activeBypass = bypassing.find(({ profile }) => profile === active)
  const others = bypassing.filter(({ profile }) => profile !== active)
  return [
    ...(activeBypass === undefined
      ? []
      : [
          `Warning: Codex's active profile, ${activeBypass.profile}, sets model_provider = ${JSON.stringify(activeBypass.provider)} (${at(activeBypass.profile)}), which wins over the root one, so Codex does not use the proxy. To use it, change that line to model_provider = "${PROVIDER}", or delete it.`,
        ]),
    ...(others.length === 0
      ? []
      : [
          `These Codex profiles set their own model_provider, so codex --profile <name> bypasses the proxy: ${others.map(({ profile, provider }) => `${profile} (${JSON.stringify(provider)}, ${at(profile)})`).join(", ")}.`,
        ]),
  ]
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

    // A file written with CRLF keeps CRLF; the splice works on bare lines.
    const eol = text.includes("\r\n") ? "\r\n" : "\n"
    const next = withModelProvider(withProviderTable(text.split(eol), providerTable(target))).join(
      eol,
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
  remove: (current, _target, name) => {
    const parsed = parse(current)
    if (Result.isFailure(parsed)) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} is not valid TOML (${parsed.failure}), so it was left unchanged. Fix it, or move it aside, and run this again.`,
        }),
      )
    }
    const config = parsed.success
    const { modelProvider, provider } = managed(config)
    const ourRoot = modelProvider === PROVIDER
    if (!ourRoot && provider === undefined) return Result.succeed(Option.none())

    const removed = [
      ...(ourRoot ? ["model_provider"] : []),
      ...(provider === undefined ? [] : [`model_providers.${PROVIDER}`]),
    ]
    const kept =
      modelProvider !== undefined && !ourRoot
        ? [`model_provider (${JSON.stringify(modelProvider)})`]
        : []

    const eol = current.includes("\r\n") ? "\r\n" : "\n"
    const lines = current.split(eol)
    const blocks = [
      ...Option.toArray(Option.map(rootProviderLine(lines), (at) => [at, at + 1] as const)),
      ...Option.toArray(providerBlock(lines)),
    ]
    const next = withoutBlocks(lines, blocks).join(eol)
    const written = parse(next)
    // Compared as connect compares: everything it does not manage stays, an
    // empty `[model_providers]` of the owner's included, and of what it
    // manages, only a `model_provider` it did not write is left.
    if (
      Result.isFailure(written) ||
      !Equal.equals(unmanaged(written.success), unmanaged(config)) ||
      !Equal.equals(managed(written.success), {
        modelProvider: ourRoot ? undefined : modelProvider,
        provider: undefined,
      })
    ) {
      return Result.fail(
        new ClientConfigError({
          message: `${name} sets model_provider or the ${PROVIDER} provider in a way disconnect cannot change safely, so it was left unchanged. Remove the root model_provider = "${PROVIDER}" and the [model_providers.${PROVIDER}] table by hand.`,
        }),
      )
    }
    return Result.succeed(Option.some({ next, removed, kept }))
  },
  ownedIn: (backup) => {
    const parsed = parse(backup)
    if (Result.isFailure(parsed)) return []
    const { modelProvider } = managed(parsed.success)
    return modelProvider !== undefined && modelProvider !== PROVIDER ? ["model_provider"] : []
  },
  warnings: profileWarnings,
}
