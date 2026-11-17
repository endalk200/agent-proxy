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
    const n = accessTokens.size + 1
    const accessToken = `sk-ant-oat01-fake-${n}`
    accessTokens.set(accessToken, pending.user)
    return json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: `sk-ant-ort01-fake-${n}`,
      expires_in: 28_800,
      scope: SCOPES,
      organization: { uuid: pending.user.organizationUuid, name: "Org" },
      account: { uuid: pending.user.accountUuid, email_address: pending.user.email },
    })
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
          if (url.pathname.startsWith("/v1/messages")) {
            return api(request, url)
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
  }
  return fake
})
