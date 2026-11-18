import { Config, Effect, Option, Path, Predicate, Result } from "effect"

import {
  ClientConfigError,
  type ClientConnector,
  removeJsonProperty,
  keyHelper,
  type ProxyTarget,
} from "./connector.ts"

/**
 * Claude Code, through `~/.claude/settings.json`: `env.ANTHROPIC_BASE_URL`
 * sends its requests to the proxy, and `apiKeyHelper` fetches the proxy key
 * by running `agent-proxy key`, so the file never holds the key (ADR-0005).
 * The spike confirmed both against Claude Code 2.1.326.
 */

const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) && !Array.isArray(value)

const parse = (text: string): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(text))
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : String(error))
  }
}

type Settings = Readonly<Record<string, unknown>>

/** The file's settings, or why it holds none connect can read. */
const readSettings = (
  current: Option.Option<string>,
  name: string,
): Result.Result<
  { readonly settings: Settings; readonly env: Settings | undefined },
  ClientConfigError
> => {
  const parsed = Option.match(current, {
    onNone: () => Result.succeed<unknown>({}),
    onSome: parse,
  })
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new ClientConfigError({
        message: `${name} is not valid JSON (${parsed.failure}), so it was left unchanged. Fix it, or move it aside, and run this again.`,
      }),
    )
  }
  const settings = parsed.success
  const env = isObject(settings) ? settings["env"] : undefined
  if (!isObject(settings) || (env !== undefined && !isObject(env))) {
    return Result.fail(
      new ClientConfigError({
        message: `${name} does not hold Claude Code settings (${isObject(settings) ? "its env is not an object" : "it is not a JSON object"}), so it was left unchanged.`,
      }),
    )
  }
  return Result.succeed({ settings, env })
}

/** True when `url` names a proxy on this machine, as connect writes it whatever the port. */
const isLoopbackProxy = (url: unknown) => {
  if (typeof url !== "string") return false
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]" ||
        /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname)) &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    )
  } catch {
    return false
  }
}

/**
 * True when `helper` runs `agent-proxy key`: by its bare name, or by an
 * absolute path, bare or single-quoted as `keyHelper` quotes it (an
 * apostrophe inside written `'\''`).
 */
const isKeyHelper = (helper: unknown) =>
  typeof helper === "string" &&
  /^(?:agent-proxy|\/\S*\/agent-proxy|'\/(?:[^']|'\\'')*\/agent-proxy') key$/.test(helper)

const BASE_URL = "env.ANTHROPIC_BASE_URL"
const KEY_HELPER = "apiKeyHelper"

export const claudeCode: ClientConnector = {
  name: "Claude Code",
  file: Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* Config.NonEmptyString("HOME"), ".claude", "settings.json")
  }),
  snippet: (target) =>
    toJson({ env: { ANTHROPIC_BASE_URL: target.address }, apiKeyHelper: keyHelper(target) }),
  change: (current, target: ProxyTarget, name) => {
    const read = readSettings(current, name)
    if (Result.isFailure(read)) return Result.fail(read.failure)
    const { settings, env } = read.success
    const helper = keyHelper(target)
    if (env?.["ANTHROPIC_BASE_URL"] === target.address && settings["apiKeyHelper"] === helper) {
      return Result.succeed(Option.none())
    }
    return Result.succeed(
      Option.some(
        toJson({
          ...settings,
          env: { ...env, ANTHROPIC_BASE_URL: target.address },
          apiKeyHelper: helper,
        }),
      ),
    )
  },
  remove: (current, _target, name) => {
    const read = readSettings(Option.some(current), name)
    if (Result.isFailure(read)) return Result.fail(read.failure)
    const { settings, env } = read.success
    const baseUrl = env?.["ANTHROPIC_BASE_URL"]
    const helper = settings["apiKeyHelper"]
    const removed: Array<string> = []
    const kept: Array<string> = []
    let next = current
    const drop = (path: ReadonlyArray<string>) => {
      next = removeJsonProperty(next, path)
    }
    if (isLoopbackProxy(baseUrl)) {
      removed.push(BASE_URL)
      drop(["env", "ANTHROPIC_BASE_URL"])
      // An env that held only the proxy's address was made for it.
      if (env !== undefined && Object.keys(env).length === 1) drop(["env"])
    } else if (baseUrl !== undefined) {
      kept.push(`${BASE_URL} (${JSON.stringify(baseUrl)})`)
    }
    if (isKeyHelper(helper)) {
      removed.push(KEY_HELPER)
      drop(["apiKeyHelper"])
    } else if (helper !== undefined) {
      kept.push(`${KEY_HELPER} (${JSON.stringify(helper)})`)
    }
    if (removed.length === 0) return Result.succeed(Option.none())
    return Result.succeed(Option.some({ next, removed, kept }))
  },
  ownedIn: (backup) => {
    const parsed = parse(backup)
    if (Result.isFailure(parsed) || !isObject(parsed.success)) return []
    const settings = parsed.success
    const env = isObject(settings["env"]) ? settings["env"] : {}
    return [
      ...(env["ANTHROPIC_BASE_URL"] !== undefined && !isLoopbackProxy(env["ANTHROPIC_BASE_URL"])
        ? [BASE_URL]
        : []),
      ...(settings["apiKeyHelper"] !== undefined && !isKeyHelper(settings["apiKeyHelper"])
        ? [KEY_HELPER]
        : []),
    ]
  },
}
