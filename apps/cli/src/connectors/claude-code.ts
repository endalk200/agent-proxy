import { Config, Effect, Option, Path, Predicate, Result } from "effect"

import { ClientConfigError, type ClientConnector, type ProxyTarget } from "./connector.ts"

/**
 * Claude Code, through `~/.claude/settings.json`: `env.ANTHROPIC_BASE_URL`
 * sends its requests to the proxy, and `apiKeyHelper` fetches the proxy key
 * by running `agent-proxy key`, so the file never holds the key (ADR-0005).
 * The spike confirmed both against Claude Code 2.1.326.
 */

const KEY_HELPER = "agent-proxy key"

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

export const claudeCode: ClientConnector = {
  name: "Claude Code",
  file: Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(yield* Config.NonEmptyString("HOME"), ".claude", "settings.json")
  }),
  snippet: (target) =>
    toJson({ env: { ANTHROPIC_BASE_URL: target.address }, apiKeyHelper: KEY_HELPER }),
  change: (current, target: ProxyTarget, name) => {
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
    if (env?.["ANTHROPIC_BASE_URL"] === target.address && settings["apiKeyHelper"] === KEY_HELPER) {
      return Result.succeed(Option.none())
    }
    return Result.succeed(
      Option.some(
        toJson({
          ...settings,
          env: { ...env, ANTHROPIC_BASE_URL: target.address },
          apiKeyHelper: KEY_HELPER,
        }),
      ),
    )
  },
}
