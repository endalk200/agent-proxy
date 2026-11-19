import { createHash, randomBytes } from "node:crypto"

import { Effect } from "effect"

import type { CodexEndpoints } from "../../src/providers/endpoints.ts"

/**
 * A fake of OpenAI's OAuth login and the Codex backend, standing in for
 * auth.openai.com (authorize and token) and chatgpt.com (`/backend-api/codex`).
 *
 * It holds the daemon to the login parameters the spike confirmed against
 * codex-cli 0.169.0 and codex-rs `login/`: an authorize request missing one
 * is refused, the code exchange is form-encoded and checks the PKCE verifier,
 * and every authorization code works once. Identity travels only in the
 * id_token's claims. Refresh tokens are single-use: refreshing with one
 * issues a new pair, and presenting it again is refused with
 * `refresh_token_reused`.
 */

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke"

/** A person signing in to ChatGPT, and the workspace (subscription) they pick. */
export interface CodexUser {
  readonly accountId: string
  readonly email: string
  readonly planType: string
  /** The id_token carries the email only in its `https://api.openai.com/profile` claim. */
  readonly emailInProfile?: boolean
}

export const carol: CodexUser = {
  accountId: "5e1d1c3a-cccc-4c4c-8c8c-000000000003",
  email: "carol@example.com",
  planType: "pro",
}

export const erin: CodexUser = {
  accountId: "5e1d1c3a-eeee-4e4e-8e8e-000000000005",
  email: "erin@example.com",
  planType: "plus",
  emailInProfile: true,
}

export const dave: CodexUser = {
  accountId: "5e1d1c3a-dddd-4d4d-8d8d-000000000004",
  email: "dave@example.com",
  planType: "plus",
}

interface PendingCode {
  readonly user: CodexUser
  readonly challenge: string
  readonly redirectUri: string
}

/** How long the fake's access tokens last unless a test says otherwise. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 10 * 24 * 60 * 60

const base64url = (bytes: Buffer) => bytes.toString("base64url")

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** An unsigned JWT carrying `claims`, shaped like the ones OpenAI issues. */
const jwt = (claims: Readonly<Record<string, unknown>>) =>
  [{ alg: "RS256", typ: "JWT" }, claims, "signature"]
    .map((part) =>
      typeof part === "string" ? part : Buffer.from(JSON.stringify(part)).toString("base64url"),
    )
    .join(".")

/** A request that reached the fake's Codex backend, as it arrived. */
export interface ApiRequest {
  readonly method: string
  /** The path and query string. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Answers a backend request; the default answers like a short, successful response. */
export type ApiHandler = (request: Request) => Response | Promise<Response>

/** The limit headers a real response carries (spike #6), with fixed values. */
export const codexHeaders: Readonly<Record<string, string>> = {
  "x-codex-plan-type": "pro",
  "x-codex-active-limit": "codex",
  "x-codex-primary-used-percent": "12",
  "x-codex-primary-reset-at": "1795000000",
  "x-codex-primary-reset-after-seconds": "3600",
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-used-percent": "34",
  "x-codex-secondary-reset-at": "1795500000",
  "x-codex-secondary-reset-after-seconds": "86400",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-credits-has-credits": "false",
  "x-codex-credits-unlimited": "false",
  "x-codex-turn-state": "ts_fake_account_bound",
}

const answerResponse: ApiHandler = () =>
  new Response(
    'event: response.created\ndata: {"type":"response.created"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { ...codexHeaders, "content-type": "text/event-stream" } },
  )

/** A streamed response whose `response.completed` carries `usage`, as the Codex backend sends it. */
export const streamedResponse = (usage: {
  readonly input: number
  readonly cached: number
  readonly output: number
  readonly reasoning: number
}) =>
  [
    { type: "response.created", response: { id: "resp_fake", status: "in_progress" } },
    { type: "response.output_text.delta", delta: "Hello." },
    {
      type: "response.completed",
      response: {
        id: "resp_fake",
        status: "completed",
        usage: {
          input_tokens: usage.input,
          input_tokens_details: { cached_tokens: usage.cached },
          output_tokens: usage.output,
          output_tokens_details: { reasoning_tokens: usage.reasoning },
          total_tokens: usage.input + usage.output,
        },
      },
    },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

/** What the Codex usage endpoint answers by default: the same windows as `codexHeaders`. */
export const usageAnswer = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3600,
      reset_at: 1_795_000_000,
    },
    secondary_window: {
      used_percent: 34,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      reset_at: 1_795_500_000,
    },
  },
}

const answerUsageDefault: ApiHandler = () => json(usageAnswer)

/** How the fake answers one refresh request instead of refreshing. */
type RefreshTrouble =
  | { readonly _tag: "Drop" }
  | { readonly _tag: "Refuse"; readonly status: number; readonly body: unknown }
  | { readonly _tag: "Redirect"; readonly location: string }

export interface FakeCodex {
  readonly endpoints: CodexEndpoints
  /** Who signs in at the next authorize request. */
  readonly signInAs: (user: CodexUser) => void
  /** The next authorize request is denied, the way a user clicking "Cancel" is. */
  readonly denyNext: () => void
  /** The access tokens issued so far, oldest first. */
  readonly issuedAccessTokens: () => ReadonlyArray<string>
  /** The requests the backend received so far, oldest first. */
  readonly apiRequests: () => ReadonlyArray<ApiRequest>
  /** Answers every later backend request with `handler`. */
  readonly answerApiWith: (handler: ApiHandler) => void
  /** The refresh tokens presented to the token endpoint so far, oldest first. */
  readonly refreshRequests: () => ReadonlyArray<string>
  /** Resolves once `count` refresh requests have arrived in all. */
  readonly refreshesArrived: (count: number) => Promise<void>
  /** The next refresh request is taken in, then its connection drops with no answer. */
  readonly dropNextRefresh: () => void
  /** The next refresh request gets `status` and `body` instead of new tokens. */
  readonly refuseNextRefresh: (status: number, body: unknown) => void
  /** The next refresh request is redirected (307) to `location`, as a misbehaving endpoint might. */
  readonly redirectNextRefresh: (location: string) => void
  /**
   * Later token answers leave out `expires_in`, so the access token's own
   * `exp` claim is the only word on when it expires.
   */
  readonly omitExpiresIn: () => void
  /** Later access tokens last `seconds` from when they are issued. */
  readonly issueTokensLasting: (seconds: number) => void
  /** The requests the usage endpoint received so far, oldest first. */
  readonly usageRequests: () => ReadonlyArray<ApiRequest>
  /** Answers every later usage endpoint request with `handler`; the default answers `usageAnswer`. */
  readonly answerUsageWith: (handler: ApiHandler) => void
}

/** Starts the fake on a free loopback port until the scope closes. */
export const fakeCodex = Effect.gen(function* () {
  let user: CodexUser = carol
  let deny = false
  let withExpiresIn = true
  let lifetimeSeconds = DEFAULT_TOKEN_LIFETIME_SECONDS
  const codes = new Map<string, PendingCode>()
  const accessTokens: Array<string> = []
  const apiRequests: Array<ApiRequest> = []
  let answerApi: ApiHandler = answerResponse
  /** Refresh tokens that still work, each usable once. */
  const refreshTokens = new Map<string, CodexUser>()
  const refreshRequests: Array<string> = []
  const refreshWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  let refreshTrouble: RefreshTrouble | undefined
  const usageRequests: Array<ApiRequest> = []
  let answerUsage: ApiHandler = answerUsageDefault

  /** Answers with a new token pair for `owner`, as both the exchange and a refresh do. */
  const issueTokens = (owner: CodexUser) => {
    const n = accessTokens.length + 1
    const exp = Math.floor(Date.now() / 1000) + lifetimeSeconds
    const accessToken = jwt({ n, exp, "https://api.openai.com/auth": { user_id: "user-x" } })
    const refreshToken = `rt_fake_${n}`
    accessTokens.push(accessToken)
    refreshTokens.set(refreshToken, owner)
    return json({
      id_token: jwt({
        ...(owner.emailInProfile === true
          ? { "https://api.openai.com/profile": { email: owner.email } }
          : { email: owner.email }),
        exp,
        "https://api.openai.com/auth": {
          chatgpt_account_id: owner.accountId,
          chatgpt_plan_type: owner.planType,
          chatgpt_user_id: "user-x",
        },
      }),
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(withExpiresIn ? { expires_in: lifetimeSeconds } : {}),
      token_type: "Bearer",
      scope: SCOPES,
    })
  }

  const refresh = (body: Readonly<Record<string, unknown>>) => {
    const presented = typeof body["refresh_token"] === "string" ? body["refresh_token"] : ""
    refreshRequests.push(presented)
    for (const waiter of refreshWaiters.filter((w) => refreshRequests.length >= w.count)) {
      waiter.resolve()
    }
    const trouble = refreshTrouble
    refreshTrouble = undefined
    if (trouble?._tag === "Drop") {
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error("connection dropped by the fake")
          },
        }),
      )
    }
    if (trouble?._tag === "Refuse") return json(trouble.body, trouble.status)
    if (trouble?._tag === "Redirect") {
      return new Response(null, { status: 307, headers: { location: trouble.location } })
    }
    const owner = refreshTokens.get(presented)
    if (body["client_id"] !== CLIENT_ID || owner === undefined) {
      return json(
        {
          error: {
            message: "Your refresh token has already been used to generate a new access token.",
            type: "invalid_request_error",
            code: "refresh_token_reused",
          },
        },
        401,
      )
    }
    refreshTokens.delete(presented)
    return issueTokens(owner)
  }

  const authorize = (url: URL) => {
    const params = url.searchParams
    const expected: Record<string, string> = {
      response_type: "code",
      client_id: CLIENT_ID,
      scope: SCOPES,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    }
    for (const [key, value] of Object.entries(expected)) {
      if (params.get(key) !== value) {
        return json({ error: "invalid_request", error_description: `bad ${key}` }, 400)
      }
    }
    const redirectUri = params.get("redirect_uri") ?? ""
    const state = params.get("state") ?? ""
    const challenge = params.get("code_challenge") ?? ""
    if (
      !/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri) ||
      !state ||
      !challenge ||
      !params.get("originator")
    ) {
      return json({ error: "invalid_request" }, 400)
    }
    const location = new URL(redirectUri)
    if (deny) {
      deny = false
      location.searchParams.set("error", "access_denied")
      location.searchParams.set("error_description", "The user cancelled the sign-in")
    } else {
      const code = base64url(randomBytes(16))
      codes.set(code, { user, challenge, redirectUri })
      location.searchParams.set("code", code)
    }
    location.searchParams.set("state", state)
    return Response.redirect(location.toString(), 302)
  }

  const token = async (request: Request) => {
    const type = request.headers.get("content-type") ?? ""
    if (type.startsWith("application/json")) {
      const parsed: unknown = await request.json()
      const body: Readonly<Record<string, unknown>> = Object.fromEntries(
        typeof parsed === "object" && parsed !== null ? Object.entries(parsed) : [],
      )
      if (body["grant_type"] === "refresh_token") return refresh(body)
      return json({ error: "unsupported_grant_type" }, 400)
    }
    if (!type.startsWith("application/x-www-form-urlencoded")) {
      return json({ error: "invalid_request", error_description: "bad content-type" }, 400)
    }
    const body = new URLSearchParams(await request.text())
    const pending = codes.get(body.get("code") ?? "")
    const verifier = body.get("code_verifier") ?? ""
    if (
      body.get("grant_type") !== "authorization_code" ||
      body.get("client_id") !== CLIENT_ID ||
      pending === undefined ||
      body.get("redirect_uri") !== pending.redirectUri ||
      base64url(createHash("sha256").update(verifier).digest()) !== pending.challenge
    ) {
      return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400)
    }
    codes.delete(body.get("code") ?? "")
    return issueTokens(pending.user)
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

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const url = new URL(request.url)
          if (request.method === "GET" && url.pathname === "/oauth/authorize") {
            return authorize(url)
          }
          if (request.method === "POST" && url.pathname === "/oauth/token") {
            return token(request)
          }
          if (url.pathname.startsWith("/backend-api/codex/")) {
            return api(request, url)
          }
          if (request.method === "GET" && url.pathname === "/backend-api/wham/usage") {
            usageRequests.push({
              method: request.method,
              path: url.pathname + url.search,
              headers: Object.fromEntries(request.headers),
              body: "",
            })
            return answerUsage(request)
          }
          return json({ error: "not_found" }, 404)
        },
      }),
    ),
    (running) => Effect.promise(() => running.stop(true)),
  )

  const origin = `http://127.0.0.1:${server.port}`
  const fake: FakeCodex = {
    endpoints: {
      apiBaseUrl: origin,
      authorizeUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      usageUrl: `${origin}/backend-api/wham/usage`,
      callbackPort: 0,
    },
    signInAs: (next) => {
      user = next
    },
    denyNext: () => {
      deny = true
    },
    issuedAccessTokens: () => [...accessTokens],
    apiRequests: () => [...apiRequests],
    answerApiWith: (handler) => {
      answerApi = handler
    },
    refreshRequests: () => [...refreshRequests],
    refreshesArrived: (count) =>
      refreshRequests.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            refreshWaiters.push({ count, resolve })
          }),
    dropNextRefresh: () => {
      refreshTrouble = { _tag: "Drop" }
    },
    refuseNextRefresh: (status, body) => {
      refreshTrouble = { _tag: "Refuse", status, body }
    },
    redirectNextRefresh: (location) => {
      refreshTrouble = { _tag: "Redirect", location }
    },
    omitExpiresIn: () => {
      withExpiresIn = false
    },
    issueTokensLasting: (seconds) => {
      lifetimeSeconds = seconds
    },
    usageRequests: () => [...usageRequests],
    answerUsageWith: (handler) => {
      answerUsage = handler
    },
  }
  return fake
})
