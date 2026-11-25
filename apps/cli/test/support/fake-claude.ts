import { createHash, randomBytes } from "node:crypto"

import { Effect } from "effect"

import type { ClaudeEndpoints } from "../../src/providers/endpoints.ts"

/**
 * A fake of Claude's OAuth login and API, standing in for claude.com
 * (authorize), platform.claude.com (token) and api.anthropic.com (profile and
 * messages).
 *
 * It holds the daemon to the login parameters the spike confirmed against
 * Claude Code 2.1.326: an authorize request missing one is refused, the token
 * exchange checks the PKCE verifier, and every authorization code works once.
 * Refresh tokens are single-use, as Claude's are: refreshing with one issues
 * a new pair, and presenting it again is refused with `invalid_grant`.
 */

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins user:privacy_consents:write"

/** A person signing in, and the organization (subscription) they pick. */
export interface ClaudeUser {
  readonly accountUuid: string
  readonly organizationUuid: string
  readonly email: string
  readonly organizationType: string
  readonly rateLimitTier: string | null
  /** The profile's `seat_tier`, such as `enterprise_usage_based`; none for a personal plan. */
  readonly seatTier?: string
}

export const alice: ClaudeUser = {
  accountUuid: "0b5c1f7e-1111-4a1a-9a1a-000000000001",
  organizationUuid: "7d3e2a90-aaaa-4b2b-8b2b-000000000001",
  email: "alice@example.com",
  organizationType: "claude_max",
  rateLimitTier: "default_claude_max_20x",
}

export const bob: ClaudeUser = {
  accountUuid: "0b5c1f7e-2222-4a1a-9a1a-000000000002",
  organizationUuid: "7d3e2a90-bbbb-4b2b-8b2b-000000000002",
  email: "bob@example.com",
  organizationType: "claude_pro",
  rateLimitTier: "default_claude_ai",
}

/** A seat in an Enterprise organization that pays for each request, as confirmed live on 2026-11-25. */
export const carol: ClaudeUser = {
  accountUuid: "0b5c1f7e-3333-4a1a-9a1a-000000000003",
  organizationUuid: "7d3e2a90-cccc-4b2b-8b2b-000000000003",
  email: "carol@example.com",
  organizationType: "claude_enterprise",
  rateLimitTier: "default_claude_zero",
  seatTier: "enterprise_usage_based",
}

interface PendingCode {
  readonly user: ClaudeUser
  readonly challenge: string
  readonly redirectUri: string
  readonly state: string
}

const base64url = (bytes: Buffer) => bytes.toString("base64url")

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** A request that reached the fake's API, as it arrived. */
export interface ApiRequest {
  readonly method: string
  /** The path and query string. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Answers an API request; the default answers like a short, successful message. */
export type ApiHandler = (request: Request) => Response | Promise<Response>

/** The limit headers a real response carries (spike #6), with fixed values. */
export const limitHeaders: Readonly<Record<string, string>> = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-reset": "1795000000",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1795000000",
  "anthropic-ratelimit-unified-5h-utilization": "0.12",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1795500000",
  "anthropic-ratelimit-unified-7d-utilization": "0.34",
}

const answerMessage: ApiHandler = () =>
  Response.json(
    {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "Hello from the fake." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 5 },
    },
    { headers: { ...limitHeaders, "request-id": "req_fake" } },
  )

/**
 * A streamed message as Claude sends it: `message_start` with the input
 * usage, a text delta, `message_delta` with the final usage, `message_stop`.
 */
export const streamedMessage = (usage: {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** The part of `cacheWrite` written to the 1-hour cache; reported only in `message_start`, as the API does. */
  readonly cacheWrite1h?: number
  readonly output: number
}) =>
  [
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        usage: {
          input_tokens: usage.input,
          cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: usage.cacheWrite,
          ...(usage.cacheWrite1h === undefined
            ? {}
            : {
                cache_creation: {
                  ephemeral_5m_input_tokens: usage.cacheWrite - usage.cacheWrite1h,
                  ephemeral_1h_input_tokens: usage.cacheWrite1h,
                },
              }),
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello." } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: usage.input,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheWrite,
        output_tokens: usage.output,
      },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

/** The `spend` a personal plan's usage answer carries, as confirmed live on 2026-11-25: none allowed. */
export const noSpend = {
  used: { amount_minor: 0, currency: "USD", exponent: 2 },
  limit: null,
  percent: 0,
  severity: "normal",
  enabled: false,
  disabled_reason: null,
}

/** What Claude's usage endpoint answers by default: the same windows as `limitHeaders`, in percent. */
export const usageAnswer = {
  five_hour: { utilization: 12, resets_at: new Date(1_795_000_000_000).toISOString() },
  seven_day: { utilization: 34, resets_at: new Date(1_795_500_000_000).toISOString() },
  limits: [],
  spend: noSpend,
}

/**
 * One entry of the usage endpoint's `limits` list, as confirmed live on
 * 2026-11-25: its share used is `percent`, not `utilization`, and
 * `is_active` marks the limit Claude highlights, not one the account has.
 * Only `weekly_scoped` entries, one per model with its own weekly limit,
 * name a model.
 */
export const claudeLimit = (
  fields: Readonly<{ kind: "session" | "weekly_all" | "weekly_scoped" } & Record<string, unknown>>,
) => ({
  group: "session",
  percent: 0,
  severity: "normal",
  resets_at: null,
  scope: null,
  is_active: false,
  ...fields,
})

/** A `weekly_scoped` entry of the usage endpoint's `limits` for `model`, `percent` used. */
export const modelLimit = (model: string, percent: number, resetsAt: string) =>
  claudeLimit({
    kind: "weekly_scoped",
    group: "weekly",
    percent,
    resets_at: resetsAt,
    scope: { model: { id: null, display_name: model }, surface: null },
  })

/**
 * What Claude's usage endpoint answers, without `skip_spend=1`, for a seat
 * that pays for each request up to a monthly spend limit, as confirmed live
 * on 2026-11-25: no 5-hour or weekly window, and the money spent this month
 * and the limit in `spend`, in cents. `extra_usage` says the same in other
 * words; the daemon reads `spend`.
 */
export const usageBasedAnswer = (usedCents: number, limitCents: number) => ({
  five_hour: null,
  seven_day: null,
  limits: [],
  extra_usage: {
    is_enabled: true,
    monthly_limit: limitCents,
    used_credits: usedCents,
    utilization: (usedCents / limitCents) * 100,
    currency: "USD",
    decimal_places: 2,
    spend_limit_reached: usedCents >= limitCents,
  },
  spend: {
    used: { amount_minor: usedCents, currency: "USD", exponent: 2 },
    limit: { amount_minor: limitCents, currency: "USD", exponent: 2 },
    percent: Math.round((usedCents / limitCents) * 100),
    severity: "normal",
    enabled: true,
    disabled_reason: null,
  },
})

const answerUsageDefault: ApiHandler = () => json(usageAnswer)

/**
 * Claude's limit reset status, the `cedar_ember` block its usage endpoint
 * adds when asked with `?cedar_ember=1`, as confirmed live on 2026-11-23.
 * Claude lists grants only to Claude Code, which it knows by its
 * `claude-cli/<version> (external, cli)` user agent; to anything else it
 * answers `ineligible_reason: "surface"`.
 */
export const limitResetStatus = (
  request: Request,
  grants: ReadonlyArray<Readonly<Record<string, unknown>>>,
  options: { readonly ineligibleReason?: string } = {},
) =>
  (request.headers.get("user-agent") ?? "").startsWith("claude-cli/")
    ? {
        eligible: options.ineligibleReason === undefined,
        ineligible_reason: options.ineligibleReason ?? null,
        at_limit: false,
        exhausted: [],
        grants,
        next_grant_id: null,
        weekly_resets_at: null,
        cooldown_until: null,
      }
    : {
        eligible: false,
        ineligible_reason: "surface",
        at_limit: false,
        exhausted: [],
        grants: [],
        next_grant_id: null,
        weekly_resets_at: null,
        cooldown_until: null,
      }

/** One grant in `cedar_ember.grants`, shaped like the November 2026 full reset; `fields` override it. */
export const resetGrant = (fields: Readonly<Record<string, unknown>> = {}) => ({
  id: "full-reset-2611",
  label: "Full reset",
  resets_total: 1,
  resets_left: 1,
  starts_at: "2026-11-10T18:00:00+00:00",
  ends_at: "2026-12-10T22:00:00+00:00",
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  percent_used: { five_hour: 12, seven_day: 34, seven_day_overage_included: 0 },
  blocking: [],
  arm: null,
  type: "full",
  unavailable_reason: null,
  gives_back_weekly: false,
  ...fields,
})

const answerRedeemDefault: ApiHandler = () =>
  json({ result: "reset", reason: null, resets_left: 0, cleared: ["five_hour", "seven_day"] })

/** How the fake answers one refresh request instead of refreshing. */
type RefreshTrouble =
  | { readonly _tag: "Hold"; readonly arrived: () => void; readonly released: Promise<void> }
  | { readonly _tag: "Drop" }
  | { readonly _tag: "SpendAndDrop" }
  | { readonly _tag: "Refuse"; readonly status: number; readonly body: unknown }

/** A refresh request held by `holdNextRefresh`. */
export interface HeldRefresh {
  /** Resolves once the refresh request has arrived. */
  readonly arrived: Promise<void>
  /** Lets the held refresh succeed. */
  readonly release: () => void
}

export interface FakeClaude {
  readonly endpoints: ClaudeEndpoints
  /** Who signs in at the next authorize request. */
  readonly signInAs: (user: ClaudeUser) => void
  /** The next authorize request is denied, the way a user clicking "Deny" is. */
  readonly denyNext: () => void
  /** The access tokens issued so far, oldest first. */
  readonly issuedAccessTokens: () => ReadonlyArray<string>
  /**
   * The next token request never gets an answer. The returned promise
   * resolves once that request has arrived.
   */
  readonly hangNextToken: () => Promise<void>
  /** The requests the API received so far, oldest first. */
  readonly apiRequests: () => ReadonlyArray<ApiRequest>
  /** Answers every later API request with `handler`. */
  readonly answerApiWith: (handler: ApiHandler) => void
  /**
   * Issues a token pair to `user` as an earlier sign-in would have, for
   * seeding an account file the daemon holds before it starts.
   */
  readonly grant: (user: ClaudeUser) => {
    readonly accessToken: string
    readonly refreshToken: string
  }
  /** The refresh tokens presented to the token endpoint so far, oldest first. */
  readonly refreshRequests: () => ReadonlyArray<string>
  /** Resolves once `count` refresh requests have arrived in all. */
  readonly refreshesArrived: (count: number) => Promise<void>
  /** The next refresh request waits until released, then succeeds. */
  readonly holdNextRefresh: () => HeldRefresh
  /** The next refresh request is taken in, then its connection drops with no answer. */
  readonly dropNextRefresh: () => void
  /**
   * The next refresh request spends its refresh token, as a provider that
   * issued a new pair does, then its connection drops before the answer.
   */
  readonly spendAndDropNextRefresh: () => void
  /** The next refresh request gets `status` and `body` instead of new tokens. */
  readonly refuseNextRefresh: (status: number, body: unknown) => void
  /** The requests the usage endpoint received so far, oldest first. */
  readonly usageRequests: () => ReadonlyArray<ApiRequest>
  /** Answers every later usage endpoint request with `handler`; the default answers `usageAnswer`. */
  readonly answerUsageWith: (handler: ApiHandler) => void
  /** The most usage endpoint requests that were ever in flight at once. */
  readonly peakUsageInFlight: () => number
  /** The requests to redeem a limit reset received so far, oldest first; `path` names the organization. */
  readonly redeemRequests: () => ReadonlyArray<ApiRequest>
  /** Answers every later redeem request with `handler`; the default answers `{ result: "reset" }`. */
  readonly answerRedeemWith: (handler: ApiHandler) => void
}

/** Starts the fake on a free loopback port until the scope closes. */
export const fakeClaude = Effect.gen(function* () {
  let user: ClaudeUser = alice
  let deny = false
  let hang: (() => void) | undefined
  const codes = new Map<string, PendingCode>()
  const accessTokens = new Map<string, ClaudeUser>()
  const apiRequests: Array<ApiRequest> = []
  let answerApi: ApiHandler = answerMessage
  /** Refresh tokens that still work, each usable once. */
  const refreshTokens = new Map<string, ClaudeUser>()
  const refreshRequests: Array<string> = []
  const refreshWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  let refreshTrouble: RefreshTrouble | undefined
  const usageRequests: Array<ApiRequest> = []
  let answerUsage: ApiHandler = answerUsageDefault
  let usageInFlight = 0
  let peakUsageInFlight = 0
  const redeemRequests: Array<ApiRequest> = []
  let answerRedeem: ApiHandler = answerRedeemDefault

  /** Issues a new token pair to `owner`. */
  const grant = (owner: ClaudeUser) => {
    const n = accessTokens.size + 1
    const accessToken = `sk-ant-oat01-fake-${n}`
    const refreshToken = `sk-ant-ort01-fake-${n}`
    accessTokens.set(accessToken, owner)
    refreshTokens.set(refreshToken, owner)
    return { accessToken, refreshToken }
  }

  /** Answers with a new token pair for `owner`, as both the exchange and a refresh do. */
  const issueTokens = (owner: ClaudeUser) => {
    const { accessToken, refreshToken } = grant(owner)
    return json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 28_800,
      scope: SCOPES,
      organization: { uuid: owner.organizationUuid, name: "Org" },
      account: { uuid: owner.accountUuid, email_address: owner.email },
    })
  }

  const refresh = async (body: Readonly<Record<string, unknown>>) => {
    const presented = typeof body["refresh_token"] === "string" ? body["refresh_token"] : ""
    refreshRequests.push(presented)
    for (const waiter of refreshWaiters.filter((w) => refreshRequests.length >= w.count)) {
      waiter.resolve()
    }
    const trouble = refreshTrouble
    refreshTrouble = undefined
    if (trouble?._tag === "SpendAndDrop") refreshTokens.delete(presented)
    if (trouble?._tag === "Drop" || trouble?._tag === "SpendAndDrop") {
      // Taken in, then the connection closes before any answer.
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error("connection dropped by the fake")
          },
        }),
      )
    }
    if (trouble?._tag === "Refuse") return json(trouble.body, trouble.status)
    if (trouble?._tag === "Hold") {
      trouble.arrived()
      await trouble.released
    }
    const owner = refreshTokens.get(presented)
    if (body["client_id"] !== CLIENT_ID || owner === undefined) {
      return json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400)
    }
    refreshTokens.delete(presented)
    return issueTokens(owner)
  }

  const authorize = (url: URL) => {
    const params = url.searchParams
    const expected: Record<string, string> = {
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      scope: SCOPES,
      code_challenge_method: "S256",
    }
    for (const [key, value] of Object.entries(expected)) {
      if (params.get(key) !== value) {
        return json({ error: "invalid_request", error_description: `bad ${key}` }, 400)
      }
    }
    const redirectUri = params.get("redirect_uri") ?? ""
    const state = params.get("state") ?? ""
    const challenge = params.get("code_challenge") ?? ""
    if (!/^http:\/\/localhost:\d+\/callback$/.test(redirectUri) || !state || !challenge) {
      return json({ error: "invalid_request" }, 400)
    }
    const location = new URL(redirectUri)
    location.searchParams.set("state", state)
    if (deny) {
      deny = false
      location.searchParams.set("error", "access_denied")
      location.searchParams.set("error_description", "The user denied access")
    } else {
      const code = base64url(randomBytes(16))
      codes.set(code, { user, challenge, redirectUri, state })
      location.searchParams.set("code", code)
    }
    return Response.redirect(location.toString(), 302)
  }

  const token = async (request: Request) => {
    if (hang !== undefined) {
      hang()
      hang = undefined
      return new Promise<Response>(() => {})
    }
    const parsed: unknown = await request.json()
    const body: Readonly<Record<string, unknown>> = Object.fromEntries(
      typeof parsed === "object" && parsed !== null ? Object.entries(parsed) : [],
    )
    if (body["grant_type"] === "refresh_token") return refresh(body)
    const pending = typeof body["code"] === "string" ? codes.get(body["code"]) : undefined
    const verifier = typeof body["code_verifier"] === "string" ? body["code_verifier"] : ""
    if (
      body["grant_type"] !== "authorization_code" ||
      body["client_id"] !== CLIENT_ID ||
      pending === undefined ||
      body["redirect_uri"] !== pending.redirectUri ||
      body["state"] !== pending.state ||
      base64url(createHash("sha256").update(verifier).digest()) !== pending.challenge
    ) {
      return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400)
    }
    codes.delete(String(body["code"]))
    return issueTokens(pending.user)
  }

  const profile = (request: Request) => {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    const owner = accessTokens.get(bearer)
    if (owner === undefined) {
      return json({ type: "error", error: { type: "authentication_error" } }, 401)
    }
    return json({
      account: {
        uuid: owner.accountUuid,
        email: owner.email,
        full_name: "Test User",
        display_name: "Test",
      },
      organization: {
        uuid: owner.organizationUuid,
        name: "Org",
        organization_type: owner.organizationType,
        rate_limit_tier: owner.rateLimitTier,
        ...(owner.seatTier === undefined ? {} : { seat_tier: owner.seatTier }),
        billing_type: "stripe_subscription",
      },
    })
  }

  const api = async (request: Request, url: URL) => {
    apiRequests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: await request.clone().text(),
    })
    return answerApi(request)
  }

  const usage = async (request: Request, url: URL) => {
    usageRequests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: "",
    })
    usageInFlight++
    peakUsageInFlight = Math.max(peakUsageInFlight, usageInFlight)
    try {
      return await answerUsage(request)
    } finally {
      usageInFlight--
    }
  }

  const redeem = async (request: Request, url: URL) => {
    redeemRequests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: await request.clone().text(),
    })
    return answerRedeem(request)
  }

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const url = new URL(request.url)
          if (request.method === "GET" && url.pathname === "/cai/oauth/authorize") {
            return authorize(url)
          }
          if (request.method === "POST" && url.pathname === "/v1/oauth/token") {
            return token(request)
          }
          if (request.method === "GET" && url.pathname === "/api/oauth/profile") {
            return profile(request)
          }
          if (request.method === "GET" && url.pathname === "/api/oauth/usage") {
            return usage(request, url)
          }
          if (url.pathname.startsWith("/v1/messages")) {
            return api(request, url)
          }
          if (
            request.method === "POST" &&
            /^\/api\/organizations\/[^/]+\/reset_rate_limits$/.test(url.pathname)
          ) {
            return redeem(request, url)
          }
          return json({ error: "not_found" }, 404)
        },
      }),
    ),
    (running) => Effect.promise(() => running.stop(true)),
  )

  const origin = `http://127.0.0.1:${server.port}`
  const fake: FakeClaude = {
    endpoints: {
      apiBaseUrl: origin,
      authorizeUrl: `${origin}/cai/oauth/authorize`,
      tokenUrl: `${origin}/v1/oauth/token`,
      profileUrl: `${origin}/api/oauth/profile`,
      usageUrl: `${origin}/api/oauth/usage`,
      callbackPort: 0,
    },
    signInAs: (next) => {
      user = next
    },
    denyNext: () => {
      deny = true
    },
    issuedAccessTokens: () => [...accessTokens.keys()],
    hangNextToken: () =>
      new Promise<void>((resolve) => {
        hang = resolve
      }),
    apiRequests: () => [...apiRequests],
    answerApiWith: (handler) => {
      answerApi = handler
    },
    grant,
    refreshRequests: () => [...refreshRequests],
    refreshesArrived: (count) =>
      refreshRequests.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            refreshWaiters.push({ count, resolve })
          }),
    holdNextRefresh: () => {
      const arrived = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      refreshTrouble = {
        _tag: "Hold",
        arrived: arrived.resolve,
        released: released.promise,
      }
      return { arrived: arrived.promise, release: released.resolve }
    },
    dropNextRefresh: () => {
      refreshTrouble = { _tag: "Drop" }
    },
    spendAndDropNextRefresh: () => {
      refreshTrouble = { _tag: "SpendAndDrop" }
    },
    refuseNextRefresh: (status, body) => {
      refreshTrouble = { _tag: "Refuse", status, body }
    },
    usageRequests: () => [...usageRequests],
    answerUsageWith: (handler) => {
      answerUsage = handler
    },
    peakUsageInFlight: () => peakUsageInFlight,
    redeemRequests: () => [...redeemRequests],
    answerRedeemWith: (handler) => {
      answerRedeem = handler
    },
  }
  return fake
})
