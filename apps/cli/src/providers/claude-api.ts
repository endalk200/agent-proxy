import { Context, Effect, Layer } from "effect"
import { type Headers, HttpClient } from "effect/http"

import type { LimitSignal } from "../accounts/router.ts"
import { ProviderEndpoints } from "./endpoints.ts"
import {
  forwardedHeaders,
  headroomOf,
  numberHeader,
  retryAfterMs,
  sendUpstream,
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

/** Claude's usage windows: the prefix of their `anthropic-ratelimit-unified-*` headers, and their name. */
const WINDOWS = [
  { prefix: "5h", name: "five_hour" },
  { prefix: "7d", name: "seven_day" },
] as const

const unified = (suffix: string) => `anthropic-ratelimit-unified-${suffix}`

/**
 * What Claude's answer says about the account's limits (spike #6). A 429 is a
 * usage window running out when the overall or a window's `-status` is
 * `rejected`, and the account then cools down until the latest such window's
 * `-reset` (epoch seconds). Any other 429, such as a per-minute rate limit,
 * cools it down for `Retry-After` only, even when the answer also carries
 * window resets. Headroom comes from the windows' `-utilization` (0 to 1).
 */
const claudeLimits = (status: number, headers: Headers.Headers, now: number): LimitSignal => {
  const headroom = headroomOf(
    WINDOWS.map((window) => numberHeader(headers, unified(`${window.prefix}-utilization`))),
  )
  if (status !== 429) return { _tag: "Within", headroom }
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
      })
    }),
  )
}
