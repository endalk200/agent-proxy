import { Context, Effect, Layer } from "effect"
import { type Headers, HttpClient } from "effect/http"

import type { LimitSignal } from "../accounts/router.ts"
import type { ObservedWindow } from "../usage/usage.ts"
import { ProviderEndpoints } from "./endpoints.ts"
import {
  asObject,
  bodyEvents,
  finite,
  forwardedHeaders,
  type Json,
  numberHeader,
  parseObject,
  type ProxiedRequest,
  readUsageEndpoint,
  retryAfterMs,
  sendUpstream,
  shareOf,
  type SpentTokens,
  type UpstreamApi,
  windowIdOfMinutes,
} from "./upstream.ts"

/**
 * The Codex adapter's upstream half: sends a client's request on to the Codex
 * backend at chatgpt.com as the chosen account. It changes only what ADR-0006
 * allows: the account's bearer token replaces the proxy key, and
 * `chatgpt-account-id` names the account's ChatGPT workspace.
 *
 * `x-codex-turn-state` passes through even when the session has just moved
 * accounts, though the account before issued it (spike #6). ADR-0006 names
 * everything the proxy may change, and a field the provider is not proven to
 * reject earns no exception. The answer carries the new account's turn state,
 * so a stale one lasts one request at most.
 */
/**
 * What the Codex backend's answer says about the account's limits. A 429
 * whose error is `usage_limit_reached` is the plan's usage running out for
 * the whole account, whichever model was asked for: the account cools down
 * until `resets_at` (epoch seconds), or for `resets_in_seconds`. Any other
 * 429 cools it down for `Retry-After` only.
 */
const codexLimits = (
  status: number,
  headers: Headers.Headers,
  body: string | undefined,
  now: number,
): LimitSignal => {
  if (status !== 429) return { _tag: "Within" }
  const error = asObject(parseObject(body ?? "")?.["error"])
  if (error?.["type"] === "usage_limit_reached") {
    const resetsAt = finite(error["resets_at"])
    const resetsIn = finite(error["resets_in_seconds"])
    const until =
      resetsAt !== undefined
        ? resetsAt * 1000
        : resetsIn !== undefined
          ? now + resetsIn * 1000
          : undefined
    if (until !== undefined) {
      return { _tag: "WindowLimited", resetsAt: until, window: "usage_limit_reached" }
    }
  }
  return { _tag: "RateLimited", retryAfterMs: retryAfterMs(headers, now) }
}

/**
 * The windows the Codex backend's headers report: `x-codex-primary-*` and
 * `x-codex-secondary-*`, each with its `-used-percent`, its length in
 * `-window-minutes`, which names it, and `-reset-at` (epoch seconds) or
 * `-reset-after-seconds`.
 */
const codexWindows = (headers: Headers.Headers, now: number): ReadonlyArray<ObservedWindow> =>
  ["primary", "secondary"].flatMap((slot) => {
    const header = (name: string) => numberHeader(headers, `x-codex-${slot}-${name}`)
    const id = windowIdOfMinutes(header("window-minutes"))
    const percent = header("used-percent")
    const resetAt = header("reset-at")
    const resetAfter = header("reset-after-seconds")
    const resetsAt =
      resetAt !== undefined
        ? resetAt * 1000
        : resetAfter !== undefined
          ? now + resetAfter * 1000
          : undefined
    return id === undefined || percent === undefined || resetsAt === undefined
      ? []
      : [{ id, usedShare: shareOf(percent / 100), resetsAt }]
  })

/**
 * What a Responses request spent, from its terminal event's
 * `response.usage`: `response.completed`, the final usage, or
 * `response.incomplete` or `response.failed`, which end it early. A JSON
 * body carries `usage` itself. Cached input is part of `input_tokens`, and
 * reasoning part of `output_tokens`.
 */
const codexUsage = (body: string): SpentTokens => {
  let usage: Json | undefined
  let complete = false
  for (const event of bodyEvents(body)) {
    const type = event["type"]
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      usage = asObject(asObject(event["response"])?.["usage"]) ?? usage
      complete = complete || type === "response.completed"
    } else if (event["object"] === "response") {
      usage = asObject(event["usage"]) ?? usage
      complete = true
    }
  }
  const input = finite(usage?.["input_tokens"]) ?? 0
  const cached = Math.min(
    input,
    finite(asObject(usage?.["input_tokens_details"])?.["cached_tokens"]) ?? 0,
  )
  return {
    tokens: {
      uncached: input - cached,
      cacheRead: cached,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: finite(usage?.["output_tokens"]) ?? 0,
      reasoning: finite(asObject(usage?.["output_tokens_details"])?.["reasoning_tokens"]) ?? 0,
    },
    complete,
  }
}

/**
 * The windows the Codex usage endpoint reports: `rate_limit.primary_window`
 * and `secondary_window`, each with `used_percent`, its length in
 * `limit_window_seconds`, which names it, and `reset_at` (epoch seconds) or
 * `reset_after_seconds`. An answer with a window it cannot read is not one
 * this reads.
 */
const codexEndpointWindows = (
  body: Json,
  now: number,
): ReadonlyArray<ObservedWindow> | undefined => {
  const limits = asObject(body["rate_limit"])
  if (limits === undefined) return undefined
  const windows = ["primary_window", "secondary_window"].map((slot) => {
    if (limits[slot] === undefined || limits[slot] === null) return []
    const window = asObject(limits[slot])
    const seconds = finite(window?.["limit_window_seconds"])
    const id = windowIdOfMinutes(seconds === undefined ? undefined : seconds / 60)
    const percent = finite(window?.["used_percent"])
    const resetAt = finite(window?.["reset_at"])
    const resetAfter = finite(window?.["reset_after_seconds"])
    const resetsAt =
      resetAt !== undefined
        ? resetAt * 1000
        : resetAfter !== undefined
          ? now + resetAfter * 1000
          : undefined
    // A window it cannot read makes the whole answer unreadable, so the
    // windows known before stay; one of a length it does not know is left out.
    if (percent === undefined || resetsAt === undefined || seconds === undefined) return undefined
    return id === undefined ? [] : [{ id, usedShare: shareOf(percent / 100), resetsAt }]
  })
  return windows.some((read) => read === undefined)
    ? undefined
    : windows.flatMap((read) => read ?? [])
}

/**
 * The session a request belongs to: Codex's `session-id` header, else the
 * body's `prompt_cache_key`, which opencode sends without the header (spike
 * #6). Codex sends both, and they are equal.
 */
const codexSession = (request: ProxiedRequest): string | undefined => {
  const header = request.headers["session-id"]?.trim()
  if (header) return header
  if (request.body.byteLength === 0) return undefined
  const key = parseObject(new TextDecoder().decode(request.body))?.["prompt_cache_key"]
  return typeof key === "string" && key.trim() !== "" ? key : undefined
}

export class CodexApi extends Context.Service<CodexApi, UpstreamApi>()("agent-proxy/CodexApi") {
  static readonly layer = Layer.effect(
    CodexApi,
    Effect.gen(function* () {
      const { codex: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient

      return CodexApi.of({
        send: Effect.fn("CodexApi.send")(function* (request, account, accessToken) {
          const headers = forwardedHeaders(request.headers, {
            authorization: `Bearer ${accessToken}`,
            "chatgpt-account-id": account.providerAccountId,
          })
          return yield* sendUpstream(http, "codex", endpoints.apiBaseUrl, request, headers)
        }),
        sessionOf: codexSession,
        limitsOf: (answer, now) => codexLimits(answer.status, answer.headers, answer.body, now),
        windowsOf: codexWindows,
        usageOf: codexUsage,
        readWindows: (account, accessToken, now) =>
          readUsageEndpoint(
            http,
            endpoints.usageUrl,
            {
              authorization: `Bearer ${accessToken}`,
              "chatgpt-account-id": account.providerAccountId,
            },
            now,
            (body) => codexEndpointWindows(body, now),
          ),
      })
    }),
  )
}
