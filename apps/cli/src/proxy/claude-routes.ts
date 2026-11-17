import { Effect } from "effect"
import { type HttpRouter, HttpServerResponse } from "effect/http"

import { ClaudeApi } from "../providers/claude-api.ts"
import { type ErrorKind, forward } from "./forward.ts"

/**
 * The proxy's Claude routes: what Claude Code (and opencode's Claude Agent,
 * which runs it) sends to `ANTHROPIC_BASE_URL`, per spike #6.
 *
 * - `POST /v1/messages` and `POST /v1/messages/count_tokens`, query string
 *   and all, go to Claude as the highest-priority Active Claude account.
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

const toClaude = forward({ provider: "claude", upstream: ClaudeApi, error: anthropicError })

/** Adds the routes to `router`. */
export const claudeRoutes = (router: HttpRouter.HttpRouter) =>
  Effect.all([
    router.add("POST", "/v1/messages", toClaude),
    router.add("POST", "/v1/messages/count_tokens", toClaude),
    // HEAD requests are served by GET routes.
    router.add("GET", "/api/hello", HttpServerResponse.empty({ status: 200 })),
  ])
