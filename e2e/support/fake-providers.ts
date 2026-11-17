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

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake")
      const [, provider, action] = url.pathname.split("/")
      if (provider !== "claude" && provider !== "codex") return send(response, 404, {})
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
      if (request.method === "GET" && action === "profile") {
        const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? ""
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
        authorizeUrl: `${origin}/claude/authorize`,
        tokenUrl: `${origin}/claude/token`,
        profileUrl: `${origin}/claude/profile`,
        callbackPort: 0,
      },
      codex: {
        authorizeUrl: `${origin}/codex/authorize`,
        tokenUrl: `${origin}/codex/token`,
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
