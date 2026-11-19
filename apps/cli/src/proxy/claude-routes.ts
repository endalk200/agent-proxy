import { Effect } from "effect"
import { type HttpRouter, HttpServerResponse } from "effect/http"

import type { Cooldown } from "../accounts/router.ts"
import { ClaudeApi } from "../providers/claude-api.ts"
import { type ErrorKind, forward, untilText } from "./forward.ts"

/**
 * The proxy's Claude routes: what Claude Code (and opencode's Claude Agent,
 * which runs it) sends to `ANTHROPIC_BASE_URL`, per spike #6.
 *
 * - `POST /v1/messages` and `POST /v1/messages/count_tokens`, query string
 *   and all, go to Claude as the highest-priority Active Claude account.
 *   Only messages are recorded as usage.
 * - `HEAD /api/hello`, Claude Code's startup check, is answered here without
 *   the proxy key, which it does not send.
 */

const anthropicTypes: Readonly<Record<ErrorKind, string>> = {
  authentication: "authentication_error",
  invalid_request: "invalid_request_error",
  server: "api_error",
}

/** An error in the shape Anthropic's API returns, so Claude Code shows its message. */
const anthropicError = (status: number, kind: ErrorKind, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { type: "error", error: { type: anthropicTypes[kind], message } },
    { status },
  )

/** The `anthropic-ratelimit-unified-*` prefix of each usage window Claude Code names. */
const windowPrefixes: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "7d" }

/**
 * Anthropic's own limit answer: a 429 whose `anthropic-ratelimit-unified-*`
 * headers say the limit was reached and when it resets, so Claude Code shows
 * "limit reached" with the reset time (spike #6).
 */
const anthropicCoolingDown = (cooldown: Cooldown, now: number) => {
  const reset = String(Math.ceil(cooldown.until / 1000))
  const prefix = cooldown.window === undefined ? undefined : windowPrefixes[cooldown.window]
  return HttpServerResponse.jsonUnsafe(
    {
      type: "error",
      error: {
        type: "rate_limit_error",
        message: `agent-proxy: every Claude account is cooling down. The first is available again at ${untilText(cooldown.until)}.`,
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil((cooldown.until - now) / 1000))),
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": reset,
        ...(cooldown.window === undefined
          ? {}
          : { "anthropic-ratelimit-unified-representative-claim": cooldown.window }),
        ...(prefix === undefined
          ? {}
          : {
              [`anthropic-ratelimit-unified-${prefix}-status`]: "rejected",
              [`anthropic-ratelimit-unified-${prefix}-reset`]: reset,
            }),
      },
    },
  )
}

const claude = {
  provider: "claude",
  upstream: ClaudeApi,
  error: anthropicError,
  coolingDown: anthropicCoolingDown,
} as const

/** Messages spend usage, so they are recorded; counting tokens spends none. */
const toClaude = forward(claude, { recordsUsage: true })
const toClaudeUnrecorded = forward(claude)

/** Adds the routes to `router`. */
export const claudeRoutes = (router: HttpRouter.HttpRouter) =>
  Effect.all([
    router.add("POST", "/v1/messages", toClaude),
    router.add("POST", "/v1/messages/count_tokens", toClaudeUnrecorded),
    // HEAD requests are served by GET routes.
    router.add("GET", "/api/hello", HttpServerResponse.empty({ status: 200 })),
  ])
