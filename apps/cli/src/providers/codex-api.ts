import { Context, Effect, Layer } from "effect"
import { type Headers, HttpClient } from "effect/http"

import type { LimitSignal } from "../accounts/router.ts"
import { ProviderEndpoints } from "./endpoints.ts"
import {
  forwardedHeaders,
  headroomOf,
  numberHeader,
  type ProxiedRequest,
  retryAfterMs,
  sendUpstream,
  type UpstreamApi,
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
type Json = Readonly<Record<string, unknown>>

const asObject = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

/** `text` parsed as a JSON object, if it is one. */
const parseObject = (text: string): Json | undefined => {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/**
 * What the Codex backend's answer says about the account's limits. A 429
 * whose error is `usage_limit_reached` is the plan's usage running out for
 * the whole account, whichever model was asked for: the account cools down
 * until `resets_at` (epoch seconds), or for `resets_in_seconds`. Any other
 * 429 cools it down for `Retry-After` only. Headroom comes from
 * `x-codex-primary-used-percent` and `x-codex-secondary-used-percent`.
 */
const codexLimits = (
  status: number,
  headers: Headers.Headers,
  body: string | undefined,
  now: number,
): LimitSignal => {
  const headroom = headroomOf(
    ["primary", "secondary"].map((window) => {
      const percent = numberHeader(headers, `x-codex-${window}-used-percent`)
      return percent === undefined ? undefined : percent / 100
    }),
  )
  if (status !== 429) return { _tag: "Within", headroom }
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
      })
    }),
  )
}
