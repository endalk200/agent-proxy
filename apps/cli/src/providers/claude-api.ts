import { Context, Effect, Layer } from "effect"
import { type Headers, HttpClient } from "effect/http"

import type { LimitSignal } from "../accounts/router.ts"
import { noTokens, type ObservedWindow, type TokenCounts } from "../usage/usage.ts"
import { ProviderEndpoints } from "./endpoints.ts"
import {
  asObject,
  bodyEvents,
  finite,
  type Json,
  numberHeader,
  readUsageEndpoint,
  retryAfterMs,
  sendUpstream,
  shareOf,
  type SpentTokens,
  forwardedHeaders,
  type UpstreamApi,
} from "./upstream.ts"

/**
 * The Claude adapter's upstream half: sends a client's request on to Claude's
 * API as the chosen account. It changes only what ADR-0006 allows: the
 * account's bearer token replaces the proxy key, and Claude's OAuth beta flag
 * is added when the client did not send it.
 */

/** The beta flag that lets an OAuth token call the API. */
const OAUTH_BETA = "oauth-2025-04-20"

/** `anthropic-beta` with the OAuth flag added, unless the client already sent it. */
const withOAuthBeta = (beta: string | undefined): string => {
  const flags = (beta ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag !== "")
  return beta !== undefined && flags.includes(OAUTH_BETA) ? beta : [...flags, OAUTH_BETA].join(",")
}

/**
 * Claude's limit windows: the prefix of their `anthropic-ratelimit-unified-*`
 * headers, their name in Claude's words, and the daemon's id for them.
 */
const WINDOWS = [
  { prefix: "5h", name: "five_hour", id: "five-hour" },
  { prefix: "7d", name: "seven_day", id: "weekly" },
] as const

const unified = (suffix: string) => `anthropic-ratelimit-unified-${suffix}`

/**
 * What Claude's answer says about the account's limits (spike #6). A 429 is a
 * usage window running out when the overall or a window's `-status` is
 * `rejected`, and the account then cools down until the latest such window's
 * `-reset` (epoch seconds). Any other 429, such as a per-minute rate limit,
 * cools it down for `Retry-After` only, even when the answer also carries
 * window resets.
 */
const claudeLimits = (status: number, headers: Headers.Headers, now: number): LimitSignal => {
  if (status !== 429) return { _tag: "Within" }
  const rejected = [
    ...WINDOWS.flatMap((window) =>
      headers[unified(`${window.prefix}-status`)] === "rejected"
        ? [{ name: window.name, reset: numberHeader(headers, unified(`${window.prefix}-reset`)) }]
        : [],
    ),
    ...(headers[unified("status")] === "rejected"
      ? [
          {
            name: headers[unified("representative-claim")],
            reset: numberHeader(headers, unified("reset")),
          },
        ]
      : []),
  ]
  const latest = rejected
    .flatMap(({ name, reset }) => (reset === undefined ? [] : [{ name, reset }]))
    .toSorted((a, b) => b.reset - a.reset)[0]
  return latest === undefined
    ? { _tag: "RateLimited", retryAfterMs: retryAfterMs(headers, now) }
    : { _tag: "WindowLimited", resetsAt: latest.reset * 1000, window: latest.name }
}

/** The windows Claude's headers report: each one's `-utilization` (0 to 1) and `-reset` (epoch seconds). */
const claudeWindows = (headers: Headers.Headers): ReadonlyArray<ObservedWindow> =>
  WINDOWS.flatMap((window) => {
    const used = numberHeader(headers, unified(`${window.prefix}-utilization`))
    const reset = numberHeader(headers, unified(`${window.prefix}-reset`))
    return used === undefined || reset === undefined
      ? []
      : [{ id: window.id, usedShare: shareOf(used), resetsAt: reset * 1000 }]
  })

/**
 * What a Messages response spent. A stream's `message_start` carries
 * `message.usage` and its `message_delta` the final `usage`; later counts
 * replace earlier ones. A JSON body carries `usage`. The final usage is the
 * `message_delta`, or the JSON body itself. `cache_creation` splits the
 * cache write by cache lifetime; only its 1-hour part is kept, as the rest
 * is the 5-minute cache.
 */
const claudeUsage = (body: string): SpentTokens => {
  const tokens = { ...noTokens }
  let complete = false
  const apply = (usage: Json | undefined) => {
    if (usage === undefined) return
    tokens.uncached = finite(usage["input_tokens"]) ?? tokens.uncached
    tokens.cacheRead = finite(usage["cache_read_input_tokens"]) ?? tokens.cacheRead
    tokens.cacheWrite = finite(usage["cache_creation_input_tokens"]) ?? tokens.cacheWrite
    tokens.cacheWrite1h =
      finite(asObject(usage["cache_creation"])?.["ephemeral_1h_input_tokens"]) ??
      tokens.cacheWrite1h
    tokens.output = finite(usage["output_tokens"]) ?? tokens.output
  }
  for (const event of bodyEvents(body)) {
    switch (event["type"]) {
      case "message":
        apply(asObject(event["usage"]))
        complete = true
        break
      case "message_start":
        apply(asObject(asObject(event["message"])?.["usage"]))
        break
      case "message_delta":
        apply(asObject(event["usage"]))
        complete = true
        break
    }
  }
  const spent: TokenCounts = {
    ...tokens,
    cacheWrite1h: Math.min(tokens.cacheWrite1h, tokens.cacheWrite),
  }
  return { tokens: spent, complete }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A time Claude's usage endpoint gives: an ISO string, or epoch seconds. */
const instant = (value: unknown) => {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const number = finite(value)
  return number === undefined ? undefined : number < 1e12 ? number * 1000 : number
}

/**
 * One window from Claude's usage endpoint: `utilization` is a percentage,
 * `resets_at` when it resets. A window nothing has used yet has no reset
 * time; it would start with the next request, so it resets a window's
 * length from now.
 */
const endpointWindow = (
  id: string,
  entry: Json | undefined,
  lengthMs: number,
  now: number,
): ReadonlyArray<ObservedWindow> | undefined => {
  if (entry === undefined) return []
  const utilization = finite(entry["utilization"])
  if (utilization === undefined) return undefined
  const resetsAt = instant(entry["resets_at"]) ?? (utilization === 0 ? now + lengthMs : undefined)
  return resetsAt === undefined
    ? undefined
    : [{ id, usedShare: shareOf(utilization / 100), resetsAt }]
}

/**
 * The windows Claude's usage endpoint reports: `five_hour`, `seven_day`, and
 * each active `weekly_scoped` limit, a per-model weekly window named by its
 * model. An answer with neither base window, or with a window it cannot
 * read, is not one this reads, so the windows known before stay.
 */
const claudeEndpointWindows = (
  body: Json,
  now: number,
): ReadonlyArray<ObservedWindow> | undefined => {
  const fiveHour = asObject(body["five_hour"])
  const sevenDay = asObject(body["seven_day"])
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  const scoped = (Array.isArray(body["limits"]) ? body["limits"] : []).map((value) => {
    const limit = asObject(value)
    const model = asObject(asObject(limit?.["scope"])?.["model"])?.["display_name"]
    if (limit?.["kind"] !== "weekly_scoped" || limit["is_active"] !== true) return []
    if (typeof model !== "string" || model.trim() === "") return undefined
    return endpointWindow(`weekly:${model.trim()}`, limit, 7 * DAY_MS, now)
  })
  const all = [
    endpointWindow("five-hour", fiveHour, 5 * 60 * 60 * 1000, now),
    endpointWindow("weekly", sevenDay, 7 * DAY_MS, now),
    ...scoped,
  ]
  return all.some((windows) => windows === undefined)
    ? undefined
    : all.flatMap((windows) => windows ?? [])
}

/** The session Claude Code (and opencode's Claude Agent, which runs it) names; subagents carry their parent's (spike #6). */
const SESSION_HEADER = "x-claude-code-session-id"

export class ClaudeApi extends Context.Service<ClaudeApi, UpstreamApi>()("agent-proxy/ClaudeApi") {
  static readonly layer = Layer.effect(
    ClaudeApi,
    Effect.gen(function* () {
      const { claude: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient

      return ClaudeApi.of({
        send: Effect.fn("ClaudeApi.send")(function* (request, _account, accessToken) {
          const headers = forwardedHeaders(request.headers, {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": withOAuthBeta(request.headers["anthropic-beta"]),
          })
          return yield* sendUpstream(http, "claude", endpoints.apiBaseUrl, request, headers)
        }),
        sessionOf: (request) => request.headers[SESSION_HEADER]?.trim() || undefined,
        limitsOf: (answer, now) => claudeLimits(answer.status, answer.headers, now),
        windowsOf: claudeWindows,
        usageOf: claudeUsage,
        readWindows: (_account, accessToken, now) =>
          readUsageEndpoint(
            http,
            endpoints.usageUrl,
            { authorization: `Bearer ${accessToken}`, "anthropic-beta": OAUTH_BETA },
            now,
            (body) => claudeEndpointWindows(body, now),
          ),
      })
    }),
  )
}
