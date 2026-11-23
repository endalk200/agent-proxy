import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

/**
 * Fake Claude and OpenAI sign-in pages and token endpoints, for driving the
 * daemon's logins end to end through a real browser. Each provider's
 * authorize page lists the people who can sign in, as links: following one
 * redirects to the daemon's callback with a code, as the provider would after
 * the owner approved agent-proxy, and the token endpoint then answers for that
 * person. Tokens last long enough that the daemon never refreshes them during
 * a test.
 *
 * Each provider's usage endpoint answers limit windows, and its API answers
 * a short streamed message or response with usage events and limit headers,
 * so the daemon never reaches a real provider and its usage dashboard has
 * something to show. Both answer any bearer token, seeded ones included.
 *
 * Each token also holds limit resets: a Claude one a full reset and a Fable
 * reset (the latter expiring within a week), listed only to Claude Code's
 * user agent as Claude does, and a Codex one a full reset, with an instant
 * reset offered to buy. Redeeming one spends it and refills that token's
 * windows to 0% used.
 *
 * It runs on Node's HTTP server, so Playwright (under Node) and verification
 * runs (under Bun) can both start it.
 */

export type FakeProvider = "claude" | "codex"

/** Someone who can sign in at a fake provider. */
export interface FakePerson {
  readonly provider: FakeProvider
  /** The provider's id for the account: Claude's `<account>:<organization>`, Codex's account id. */
  readonly providerAccountId: string
  readonly email: string
  /** The plan the daemon reads, such as "Max 20x" or "Pro". */
  readonly plan: string
}

export const people: ReadonlyArray<FakePerson> = [
  {
    provider: "claude",
    providerAccountId: "acct-alice:org-alice",
    email: "alice@example.com",
    plan: "Max 20x",
  },
  {
    provider: "claude",
    providerAccountId: "acct-bob:org-bob",
    email: "bob@example.com",
    plan: "Pro",
  },
  { provider: "codex", providerAccountId: "acct-carol", email: "carol@example.com", plan: "Pro" },
  { provider: "codex", providerAccountId: "acct-dave", email: "dave@example.com", plan: "Plus" },
]

export interface FakeProviders {
  readonly origin: string
  /** The value of `AGENT_PROXY_PROVIDER_ENDPOINTS` for a daemon that signs in here. */
  readonly endpoints: string
  /** The redirect a provider sends the browser on after `email` approves, for pasting by hand. */
  readonly approve: (authorizeUrl: string, email: string) => Promise<string>
  readonly close: () => Promise<void>
}

const escapeHtml = (text: string) =>
  text.replaceAll(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`)

/** The profile the daemon reads a Claude account's identity and plan from. */
const claudeProfile = (person: FakePerson) => {
  const [account, organization] = person.providerAccountId.split(":")
  const max = person.plan.startsWith("Max")
  return {
    account: { uuid: account, email: person.email },
    organization: {
      uuid: organization,
      organization_type: max ? "claude_max" : "claude_pro",
      rate_limit_tier: max ? `default_claude_max_${person.plan.split(" ")[1] ?? "5x"}` : null,
    },
  }
}

const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

/** An unsigned JWT carrying the claims the daemon reads a Codex account from. */
const codexIdToken = (person: FakePerson) =>
  [
    jwtPart({ alg: "none", typ: "JWT" }),
    jwtPart({
      email: person.email,
      "https://api.openai.com/auth": {
        chatgpt_account_id: person.providerAccountId,
        chatgpt_plan_type: person.plan.toLowerCase(),
      },
    }),
    "unsigned",
  ].join(".")

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/** How used each token's windows are: a little different per token, the same every time. */
const usedFor = (token: string) => {
  let hash = 0
  for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return { fiveHour: 5 + (hash % 90), weekly: 10 + ((hash >>> 8) % 80) }
}

const HOUR_MS = 60 * 60 * 1000

const DAY_MS = 24 * HOUR_MS

/** The limit resets every token starts with, by provider; each expires that many days after the fake starts. */
const RESETS: Readonly<
  Record<FakeProvider, ReadonlyArray<{ id: string; name: string; days: number }>>
> = {
  claude: [
    { id: "full-reset-2611", name: "Full reset", days: 17 },
    { id: "launch-2610-fable", name: "New model launch: one Fable reset", days: 5 },
  ],
  codex: [{ id: "RateLimitResetCredit_fake", name: "Full reset", days: 19 }],
}

/** Claude's usage endpoint: 5-hour, weekly and a Fable weekly window, and the `cedar_ember` block when asked as Claude Code. */
const claudeUsage = (
  token: string,
  resets: ReadonlyArray<{ id: string; name: string; endsAt: number }>,
  refilled: boolean,
  claudeCode: boolean,
) => {
  const used = refilled ? { fiveHour: 0, weekly: 0 } : usedFor(token)
  const now = Date.now()
  return {
    cedar_ember: {
      eligible: claudeCode,
      ineligible_reason: claudeCode ? null : "surface",
      grants: claudeCode
        ? resets.map((reset) => ({
            id: reset.id,
            label: reset.name,
            ends_at: new Date(reset.endsAt).toISOString(),
            clears: reset.id.includes("fable")
              ? ["five_hour", "seven_day_overage_included"]
              : ["five_hour", "seven_day", "seven_day_overage_included"],
            usable_now: true,
            unavailable_reason: null,
            gives_back_weekly: reset.id.includes("fable"),
            type: "full",
          }))
        : [],
      cooldown_until: null,
    },
    five_hour: { utilization: used.fiveHour, resets_at: new Date(now + 2 * HOUR_MS).toISOString() },
    seven_day: { utilization: used.weekly, resets_at: new Date(now + 80 * HOUR_MS).toISOString() },
    limits: [
      {
        kind: "weekly_scoped",
        is_active: true,
        scope: { model: { display_name: "Fable" } },
        utilization: Math.min(100, used.weekly + 15),
        resets_at: new Date(now + 80 * HOUR_MS).toISOString(),
      },
    ],
  }
}

/** The Codex usage endpoint: 5-hour and weekly windows, and how many limit resets the token holds. */
const codexUsage = (token: string, resets: number, refilled: boolean) => {
  const used = refilled ? { fiveHour: 0, weekly: 0 } : usedFor(token)
  const now = Math.floor(Date.now() / 1000)
  return {
    rate_limit_reset_credits: { available_count: resets },
    rate_limit: {
      primary_window: {
        used_percent: used.fiveHour,
        limit_window_seconds: 18_000,
        reset_at: now + 7200,
      },
      secondary_window: {
        used_percent: used.weekly,
        limit_window_seconds: 604_800,
        reset_at: now + 288_000,
      },
    },
  }
}

const sseOf = (events: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  events
    .map((event) => `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")

/** A streamed Claude message with usage events, for `model`. */
const claudeMessage = (model: string) => {
  const input = 200 + Math.floor(Math.random() * 800)
  const usage = {
    input_tokens: input,
    cache_read_input_tokens: input * 20,
    cache_creation_input_tokens: input * 2,
  }
  return sseOf([
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model,
        content: [],
        // Half the cache write goes to the 1-hour cache, which only `message_start` splits out.
        usage: {
          ...usage,
          cache_creation: { ephemeral_5m_input_tokens: input, ephemeral_1h_input_tokens: input },
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello from the fake." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { ...usage, output_tokens: 50 + Math.floor(Math.random() * 400) },
    },
    { type: "message_stop" },
  ])
}

/** A streamed Codex response with usage, for `model`. */
const codexResponse = (model: string) => {
  const input = 2000 + Math.floor(Math.random() * 6000)
  return sseOf([
    { type: "response.created", response: { id: "resp_fake", model, status: "in_progress" } },
    { type: "response.output_text.delta", delta: "Hello from the fake." },
    {
      type: "response.completed",
      response: {
        id: "resp_fake",
        model,
        status: "completed",
        usage: {
          input_tokens: input,
          input_tokens_details: { cached_tokens: Math.floor(input * 0.8) },
          output_tokens: 300,
          output_tokens_details: { reasoning_tokens: 120 },
        },
      },
    },
  ])
}

/** The limit headers each provider's answers carry, for `token`'s windows. */
const limitHeaders = (provider: FakeProvider, token: string): Record<string, string> => {
  const used = usedFor(token)
  const now = Math.floor(Date.now() / 1000)
  return provider === "claude"
    ? {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": String(used.fiveHour / 100),
        "anthropic-ratelimit-unified-5h-reset": String(now + 7200),
        "anthropic-ratelimit-unified-7d-utilization": String(used.weekly / 100),
        "anthropic-ratelimit-unified-7d-reset": String(now + 288_000),
      }
    : {
        "x-codex-primary-used-percent": String(used.fiveHour),
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(now + 7200),
        "x-codex-secondary-used-percent": String(used.weekly),
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": String(now + 288_000),
      }
}

/** The `model` a request body names. */
const modelIn = (body: string, fallback: string) => {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === "object" &&
      parsed !== null &&
      "model" in parsed &&
      typeof parsed.model === "string"
      ? parsed.model
      : fallback
  } catch {
    return fallback
  }
}

/** The fake sign-in page: a link per person who can sign in, and Deny. */
const authorizePage = (provider: FakeProvider, url: URL) => {
  const name = provider === "claude" ? "Claude" : "ChatGPT"
  const redirect = url.searchParams.get("redirect_uri") ?? ""
  const state = url.searchParams.get("state") ?? ""
  const link = (as: string) =>
    `/${provider}/approve?${new URLSearchParams({ as, redirect_uri: redirect, state }).toString()}`
  const choices = people
    .filter((person) => person.provider === provider)
    .map(
      (person) =>
        `<li><a href="${escapeHtml(link(person.email))}">Sign in as ${escapeHtml(person.email)} (${escapeHtml(person.plan)})</a></li>`,
    )
    .join("")
  return (
    `<!doctype html><meta charset="utf-8"><title>Sign in to ${name} (fake)</title>` +
    `<body style="font:15px system-ui,sans-serif;margin:4rem auto;max-width:28rem">` +
    `<h1 style="font-size:1.25rem">agent-proxy wants to use your ${name} account</h1>` +
    `<p>A fake ${name} sign-in page, for tests.</p><ul>${choices}</ul>` +
    `<p><a href="${escapeHtml(link("deny"))}">Deny</a></p></body>`
  )
}

/** Starts the fake providers on a free loopback port. */
export const startFakeProviders = async (port = 0): Promise<FakeProviders> => {
  /** Codes and access tokens issued, each naming who they were issued to. */
  const codes = new Map<string, FakePerson>()
  const tokens = new Map<string, FakePerson>()

  const approve = (provider: FakeProvider, url: URL) => {
    const location = new URL(url.searchParams.get("redirect_uri") ?? "")
    location.searchParams.set("state", url.searchParams.get("state") ?? "")
    const person = people.find(
      (candidate) =>
        candidate.provider === provider && candidate.email === url.searchParams.get("as"),
    )
    if (person === undefined) {
      location.searchParams.set("error", "access_denied")
      location.searchParams.set("error_description", "The user denied access")
    } else {
      const code = randomBytes(12).toString("base64url")
      codes.set(code, person)
      location.searchParams.set("code", code)
    }
    return location.toString()
  }

  /** Answers a code exchange for whoever the code was issued to. */
  const exchange = (provider: FakeProvider, code: string | null, response: ServerResponse) => {
    const person = code === null ? undefined : codes.get(code)
    if (person === undefined || person.provider !== provider) {
      return send(response, 400, { error: "invalid_grant", error_description: "Bad code" })
    }
    codes.delete(code ?? "")
    const accessToken = `fake-access-${randomBytes(8).toString("hex")}`
    tokens.set(accessToken, person)
    return send(response, 200, {
      access_token: accessToken,
      refresh_token: `fake-refresh-${randomBytes(8).toString("hex")}`,
      // Ten days: neither provider's keeper refreshes it during a test.
      expires_in: 864_000,
      ...(provider === "codex" ? { id_token: codexIdToken(person) } : {}),
    })
  }

  const startedAt = Date.now()
  /** Each token's limit resets not yet redeemed, by provider and token. */
  const held = new Map<string, Array<{ id: string; name: string; endsAt: number }>>()
  /** Tokens that redeemed a limit reset, whose windows read 0% used since. */
  const refilled = new Set<string>()
  const resetsOf = (provider: FakeProvider, token: string) => {
    const key = `${provider} ${token}`
    let resets = held.get(key)
    if (resets === undefined) {
      resets = RESETS[provider].map((reset) => ({
        id: reset.id,
        name: reset.name,
        endsAt: startedAt + reset.days * DAY_MS,
      }))
      held.set(key, resets)
    }
    return resets
  }
  /** Spends `token`'s limit reset `id`; false when it holds none by that id. */
  const redeem = (provider: FakeProvider, token: string, id: unknown) => {
    const resets = resetsOf(provider, token)
    const index = resets.findIndex((reset) => reset.id === id)
    if (index === -1) return false
    resets.splice(index, 1)
    refilled.add(`${provider} ${token}`)
    return true
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake")
      const [, provider, action] = url.pathname.split("/")
      if (provider !== "claude" && provider !== "codex") return send(response, 404, {})
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? ""
      if (
        request.method === "POST" &&
        provider === "claude" &&
        /^\/claude\/api\/organizations\/[^/]+\/reset_rate_limits$/.test(url.pathname)
      ) {
        const body: unknown = JSON.parse(await readBody(request))
        const id =
          typeof body === "object" && body !== null && "grant_id" in body
            ? body.grant_id
            : undefined
        return send(response, 200, {
          result: redeem("claude", token, id) ? "reset" : "unavailable",
        })
      }
      if (url.pathname === "/codex/backend-api/wham/rate-limit-reset-credits") {
        return send(response, 200, {
          credits: resetsOf("codex", token).map((reset) => ({
            id: reset.id,
            reset_type: "codex_rate_limits",
            is_supported_by_plan: true,
            status: "available",
            expires_at: new Date(reset.endsAt).toISOString(),
            title: reset.name,
          })),
          available_count: resetsOf("codex", token).length,
          immediate_reset_purchase_eligible: true,
        })
      }
      if (
        request.method === "POST" &&
        url.pathname === "/codex/backend-api/wham/rate-limit-reset-credits/consume"
      ) {
        const body: unknown = JSON.parse(await readBody(request))
        const id =
          typeof body === "object" && body !== null && "credit_id" in body
            ? body.credit_id
            : undefined
        return send(response, 200, { code: redeem("codex", token, id) ? "reset" : "no_credit" })
      }
      if (request.method === "GET" && action === "authorize") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return response.end(authorizePage(provider, url))
      }
      if (request.method === "GET" && action === "approve") {
        response.writeHead(302, { location: approve(provider, url) })
        return response.end()
      }
      if (request.method === "POST" && action === "token") {
        const body = await readBody(request)
        // Codex sends the code exchange form-encoded, Claude as JSON.
        const fields: unknown = provider === "codex" ? null : JSON.parse(body)
        const code =
          provider === "codex"
            ? new URLSearchParams(body).get("code")
            : typeof fields === "object" && fields !== null && "code" in fields
              ? String(fields.code)
              : null
        return exchange(provider, code, response)
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? ""
      if (request.method === "GET" && action === "usage") {
        const fresh = refilled.has(`${provider} ${bearer}`)
        return send(
          response,
          200,
          provider === "claude"
            ? claudeUsage(
                bearer,
                resetsOf("claude", bearer),
                fresh,
                (request.headers["user-agent"] ?? "").startsWith("claude-cli/"),
              )
            : codexUsage(bearer, resetsOf("codex", bearer).length, fresh),
        )
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/claude/v1/messages" ||
          url.pathname === "/codex/backend-api/codex/responses")
      ) {
        const body = await readBody(request)
        response.writeHead(200, {
          "content-type": "text/event-stream",
          ...limitHeaders(provider, bearer),
        })
        return response.end(
          provider === "claude"
            ? claudeMessage(modelIn(body, "claude-sonnet-4-5"))
            : codexResponse(modelIn(body, "gpt-5.4")),
        )
      }
      if (request.method === "GET" && action === "profile") {
        const person = tokens.get(bearer)
        return person === undefined
          ? send(response, 401, { error: "unauthorized" })
          : send(response, 200, claudeProfile(person))
      }
      return send(response, 404, {})
    })()
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("No port to listen on.")
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    endpoints: JSON.stringify({
      claude: {
        apiBaseUrl: `${origin}/claude`,
        authorizeUrl: `${origin}/claude/authorize`,
        tokenUrl: `${origin}/claude/token`,
        profileUrl: `${origin}/claude/profile`,
        usageUrl: `${origin}/claude/usage`,
        callbackPort: 0,
      },
      codex: {
        apiBaseUrl: `${origin}/codex`,
        authorizeUrl: `${origin}/codex/authorize`,
        tokenUrl: `${origin}/codex/token`,
        usageUrl: `${origin}/codex/usage`,
        callbackPort: 0,
      },
    }),
    approve: async (authorizeUrl, email) => {
      const authorize = new URL(authorizeUrl)
      const provider = authorize.pathname.split("/")[1] === "codex" ? "codex" : "claude"
      const link = new URL(`${origin}/${provider}/approve`)
      link.searchParams.set("as", email)
      link.searchParams.set("redirect_uri", authorize.searchParams.get("redirect_uri") ?? "")
      link.searchParams.set("state", authorize.searchParams.get("state") ?? "")
      const answer = await fetch(link, { redirect: "manual" })
      return answer.headers.get("location") ?? ""
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
