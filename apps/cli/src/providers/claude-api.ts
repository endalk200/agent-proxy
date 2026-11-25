import { Context, Effect, Layer } from "effect"
import { type Headers, HttpClient } from "effect/http"

import type { LimitSignal } from "../accounts/router.ts"
import {
  noTokens,
  type ObservedReset,
  type ObservedWindow,
  type ResetsRead,
  type TokenCounts,
} from "../usage/usage.ts"
import { ProviderEndpoints } from "./endpoints.ts"
import {
  asObject,
  bodyEvents,
  finite,
  type Json,
  numberHeader,
  postRedeem,
  readUsageEndpoint,
  type RedeemAnswer,
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
 * One window from Claude's usage endpoint: its share used is the percentage
 * in field `used` (`utilization` in the top-level windows, `percent` in a
 * `limits` entry), and `resets_at` is when it resets. A window nothing has
 * used yet has no reset time; it would start with the next request, so it
 * resets a window's length from now.
 */
const endpointWindow = (
  id: string,
  entry: Json | undefined,
  used: "utilization" | "percent",
  lengthMs: number,
  now: number,
): ReadonlyArray<ObservedWindow> | undefined => {
  if (entry === undefined) return []
  const utilization = finite(entry[used])
  if (utilization === undefined) return undefined
  const resetsAt = instant(entry["resets_at"]) ?? (utilization === 0 ? now + lengthMs : undefined)
  return resetsAt === undefined
    ? undefined
    : [{ id, usedShare: shareOf(utilization / 100), resetsAt }]
}

/**
 * The per-model weekly limits in a usage answer's `limits`: each
 * `weekly_scoped` entry whose scope names a model, with that model. One
 * that names none limits something other than a model, which the daemon
 * does not show. `is_active` is not read: it marks the limit Claude
 * highlights, so a model's limit nothing has spent from yet is inactive
 * (confirmed live on 2026-11-25). Plans without a per-model limit list no
 * such entry.
 */
const scopedLimits = (
  body: Json,
): ReadonlyArray<{ readonly model: string; readonly limit: Json }> =>
  (Array.isArray(body["limits"]) ? body["limits"] : []).flatMap((value) => {
    const limit = asObject(value)
    if (limit?.["kind"] !== "weekly_scoped") return []
    const model = asObject(asObject(limit["scope"])?.["model"])?.["display_name"]
    return typeof model === "string" && model.trim() !== "" ? [{ model: model.trim(), limit }] : []
  })

/**
 * The windows Claude's usage endpoint reports: `five_hour`, `seven_day`, and
 * each per-model weekly limit, as a window named by its model. An answer
 * with neither base window, or with a window it cannot read, is not one
 * this reads, so the windows known before stay.
 */
const claudeEndpointWindows = (
  body: Json,
  now: number,
): ReadonlyArray<ObservedWindow> | undefined => {
  const fiveHour = asObject(body["five_hour"])
  const sevenDay = asObject(body["seven_day"])
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  const all = [
    endpointWindow("five-hour", fiveHour, "utilization", 5 * 60 * 60 * 1000, now),
    endpointWindow("weekly", sevenDay, "utilization", 7 * DAY_MS, now),
    ...scopedLimits(body).map(({ model, limit }) =>
      endpointWindow(`weekly:${model}`, limit, "percent", 7 * DAY_MS, now),
    ),
  ]
  return all.some((windows) => windows === undefined)
    ? undefined
    : all.flatMap((windows) => windows ?? [])
}

/** The models with their own weekly limit in a usage answer, such as "Fable". */
const scopedModels = (body: Json): ReadonlyArray<string> =>
  scopedLimits(body).map(({ model }) => model)

/** The windows a grant's `clears` names, in the daemon's ids; the others it clears are not windows the daemon shows. */
const CLEARED_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "five-hour",
  seven_day: "weekly",
}

/**
 * One grant of Claude's `cedar_ember` program as a limit reset, or none when
 * it is not in a shape this reads. A grant that `gives_back_weekly` gives
 * back the weekly usage spent on its model, which its label names: it
 * refills that model's per-model weekly window, when the answer has one.
 */
const claudeReset = (value: unknown, models: ReadonlyArray<string>): ObservedReset | undefined => {
  const grant = asObject(value)
  const id = grant?.["id"]
  const label = grant?.["label"]
  const clears = grant?.["clears"]
  const usable = grant?.["usable_now"]
  const reason = grant?.["unavailable_reason"]
  if (
    grant === undefined ||
    typeof id !== "string" ||
    id === "" ||
    typeof label !== "string" ||
    !Array.isArray(clears) ||
    typeof usable !== "boolean" ||
    (reason !== undefined && reason !== null && typeof reason !== "string")
  ) {
    return undefined
  }
  const named = label.toLowerCase()
  const givesBack =
    grant["gives_back_weekly"] === true
      ? models
          .filter((model) => named.includes(model.toLowerCase()))
          .map((model) => `weekly:${model}`)
      : []
  const refills = [
    ...new Set([
      ...clears.flatMap((clear) =>
        typeof clear === "string" && CLEARED_WINDOWS[clear] !== undefined
          ? [CLEARED_WINDOWS[clear]]
          : [],
      ),
      ...givesBack,
    ]),
  ]
  return {
    id,
    name: label.trim() === "" ? id : label.trim(),
    refills,
    grantedAt: instant(grant["starts_at"]),
    expiresAt: instant(grant["ends_at"]),
    usableNow: usable,
    unavailableReason: typeof reason === "string" && reason !== "" ? reason : undefined,
  }
}

/**
 * The limit resets Claude's usage endpoint lists in its `cedar_ember` block,
 * or none when it lists none it can be trusted on: the block is missing or
 * unreadable, or Claude did not take the daemon for Claude Code
 * (`ineligible_reason: "surface"`). Any other answer is the account's
 * resets, an empty list included.
 */
const claudeResets = (body: Json): ResetsRead | undefined => {
  const status = asObject(body["cedar_ember"])
  if (status === undefined || status["ineligible_reason"] === "surface") return undefined
  const grants = status["grants"]
  if (!Array.isArray(grants)) return undefined
  const models = scopedModels(body)
  const resets = grants.map((grant) => claudeReset(grant, models))
  return resets.every((reset) => reset !== undefined) ? { resets, canBuy: false } : undefined
}

/**
 * The version Claude Code's user agent names when no Claude Code request has
 * been proxied yet: the newest the daemon was checked against.
 */
const CLAUDE_CODE_VERSION = "2.1.330"

/** The version a Claude Code user agent names: `claude-cli/2.1.330 (external, cli)` names 2.1.330. */
const claudeCodeVersion = (agent: string | undefined) =>
  /^claude-cli\/(\d[\w.+-]*)/.exec(agent?.trim() ?? "")?.[1]

/** What Claude's `reset_rate_limits` answer's `result` says of a redeem. */
const claudeRedeemed = (answer: Json): RedeemAnswer | undefined => {
  switch (answer["result"]) {
    case "reset":
      return { _tag: "Redeemed" }
    case "already_used":
      return { _tag: "Refused", reason: "already-redeemed" }
    case "not_limited":
      return { _tag: "Refused", reason: "nothing-to-refill" }
    case "cooldown":
      return { _tag: "Refused", reason: "cooldown" }
    case "ineligible":
      return { _tag: "Refused", reason: "ineligible" }
    case "unavailable":
      return { _tag: "Refused", reason: "unavailable" }
    default:
      return undefined
  }
}

/** The organization half of a Claude account's provider id, `<account uuid>:<organization uuid>`. */
const organizationOf = (providerAccountId: string) => {
  const organization = providerAccountId.split(":")[1]?.trim()
  return organization === undefined || organization === "" ? undefined : organization
}

/** The session Claude Code (and opencode's Claude Agent, which runs it) names; subagents carry their parent's (spike #6). */
const SESSION_HEADER = "x-claude-code-session-id"

export class ClaudeApi extends Context.Service<ClaudeApi, UpstreamApi>()("agent-proxy/ClaudeApi") {
  static readonly layer = Layer.effect(
    ClaudeApi,
    Effect.gen(function* () {
      const { claude: endpoints } = yield* ProviderEndpoints
      const http = yield* HttpClient.HttpClient
      // Claude lists limit resets only to Claude Code (ADR-0010): the
      // daemon's own calls name the version of the newest one it proxied.
      let version = CLAUDE_CODE_VERSION
      const ownHeaders = (accessToken: string) => ({
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "user-agent": `claude-cli/${version} (external, cli)`,
      })
      const usageUrl = new URL(endpoints.usageUrl)
      usageUrl.searchParams.set("cedar_ember", "1")
      usageUrl.searchParams.set("skip_spend", "1")

      return ClaudeApi.of({
        send: Effect.fn("ClaudeApi.send")(function* (request, _account, accessToken) {
          version = claudeCodeVersion(request.headers["user-agent"]) ?? version
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
            usageUrl.toString(),
            ownHeaders(accessToken),
            now,
            (body) => claudeEndpointWindows(body, now),
            (body) => Effect.succeed(claudeResets(body)),
          ),
        redeemReset: (account, accessToken, resetId, requestId) => {
          const organization = organizationOf(account.providerAccountId)
          return organization === undefined
            ? Effect.succeed<RedeemAnswer>({
                _tag: "Refused",
                reason: "ineligible",
                detail: "the account names no organization; sign in to it again",
              })
            : postRedeem(
                http,
                `${endpoints.apiBaseUrl}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
                ownHeaders(accessToken),
                { program: "cedar_ember", grant_id: resetId, request_id: requestId },
                claudeRedeemed,
              )
        },
      })
    }),
  )
}
