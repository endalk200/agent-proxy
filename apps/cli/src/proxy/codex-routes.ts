import { Effect } from "effect"
import { type HttpRouter, HttpServerResponse } from "effect/http"

import { CodexApi } from "../providers/codex-api.ts"
import { type ErrorKind, forward } from "./forward.ts"

/**
 * The proxy's Codex routes: what Codex (as a custom provider named "OpenAI"
 * whose base URL ends in `/backend-api/codex`) and opencode's OpenAI Responses
 * provider send, per spike #6.
 *
 * - `POST /backend-api/codex/responses` (streamed), `GET
 *   /backend-api/codex/models` (with `?client_version=`) and `POST
 *   /backend-api/codex/alpha/search` (standalone web search) go to the Codex
 *   backend as the highest-priority Active Codex account.
 * - `GET /backend-api/codex/responses`, the WebSocket upgrade Codex and
 *   opencode try first, is refused with 426, after which both fall back to
 *   HTTP.
 */

const openAiTypes: Readonly<Record<ErrorKind, string>> = {
  authentication: "invalid_request_error",
  invalid_request: "invalid_request_error",
  server: "server_error",
}

/** An error in the shape OpenAI's API returns, so Codex and opencode show its message. */
const openAiError = (status: number, kind: ErrorKind, message: string) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        message,
        type: openAiTypes[kind],
        param: null,
        code: kind === "authentication" ? "invalid_api_key" : null,
      },
    },
    { status },
  )

const toCodex = forward({ provider: "codex", upstream: CodexApi, error: openAiError })

/** No WebSocket: the proxy serves the Responses API over HTTP only. */
const noWebSocket = openAiError(
  426,
  "invalid_request",
  "agent-proxy: WebSocket is not supported. Send the request over HTTP.",
)

/** Adds the routes to `router`. */
export const codexRoutes = (router: HttpRouter.HttpRouter) =>
  Effect.all([
    router.add("POST", "/backend-api/codex/responses", toCodex),
    router.add("GET", "/backend-api/codex/responses", noWebSocket),
    router.add("GET", "/backend-api/codex/models", toCodex),
    router.add("POST", "/backend-api/codex/alpha/search", toCodex),
  ])
