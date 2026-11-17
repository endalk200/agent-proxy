/**
 * A fake daemon API for component tests: it answers the routes the dashboard
 * calls with the JSON the daemon serves, and can stop answering to stand in
 * for a daemon that went down. Tests set the state it reports directly, and
 * read back what the dashboard changed through `PATCH` and `DELETE`, which
 * follow the daemon's rules: a move renumbers the pool, a removal closes the
 * gap, and the pool's new sessions go to its highest-priority Active account.
 *
 * Logins follow the daemon's too: a login waits until the test plays the
 * provider's redirect reaching the daemon (`redirect`) or the dashboard posts
 * a callback URL, then signs in `signInAs`, updating the account the daemon
 * already holds for that identity or adding one at the bottom of its pool.
 */

export interface FakeAccount {
  readonly id: string
  readonly provider: "claude" | "codex"
  readonly providerAccountId: string
  readonly label: string
  readonly email: string
  readonly plan: string
  readonly priority: number
  readonly enabled: boolean
  readonly status: "active" | "needs-sign-in" | "disabled"
  readonly addedAt: string
  readonly lastUsedAt: string | null
}

export interface FakePool {
  readonly provider: "claude" | "codex"
  readonly newSessionsAccountId: string | null
}

/** A Claude account with plausible defaults; `overrides` sets what a test cares about. */
export const account = (overrides: Partial<FakeAccount> & Pick<FakeAccount, "id" | "label">) => ({
  provider: "claude" as const,
  providerAccountId: `account-${overrides.id}:org-${overrides.id}`,
  email: `${overrides.label.toLowerCase().replaceAll(" ", ".")}@example.com`,
  plan: "Pro",
  priority: 1,
  enabled: true,
  status: "active" as const,
  addedAt: "2026-11-01T12:00:00.000Z",
  lastUsedAt: null,
  ...overrides,
})

export type FakeLoginStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired"

/** A login as the daemon reports it. */
export interface FakeLogin {
  readonly id: string
  readonly provider: "claude" | "codex"
  readonly authorizeUrl: string
  readonly status: FakeLoginStatus
  readonly error?: string
  readonly account?: FakeAccount
  readonly created?: boolean
}

/** Who signs in at the provider's page. */
export interface FakeIdentity {
  readonly providerAccountId: string
  readonly email: string
  readonly plan: string
}

const providerNames = { claude: "Claude", codex: "Codex" } as const

/** Where each provider's redirect returns to, as the daemon's real logins use. */
const redirects = {
  claude: "http://localhost:54545/callback",
  codex: "http://127.0.0.1:1455/auth/callback",
} as const

const authorizePages = {
  claude: "https://claude.com/cai/oauth/authorize",
  codex: "https://auth.openai.com/oauth/authorize",
} as const

/** The callback URL the provider redirects `login`'s browser to. */
export const callbackUrl = (login: FakeLogin, params: Record<string, string> = {}): string => {
  const url = new URL(new URL(login.authorizeUrl).searchParams.get("redirect_uri") ?? "")
  url.searchParams.set("code", "code-from-provider")
  url.searchParams.set("state", new URL(login.authorizeUrl).searchParams.get("state") ?? "")
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

export interface FakeDaemon {
  /** Serves the daemon API; hand it to the dashboard as its `fetch`. */
  readonly fetch: typeof fetch
  accounts: ReadonlyArray<FakeAccount>
  pools: ReadonlyArray<FakePool>
  key: string
  address: string
  /** While false, every request fails the way `fetch` does when nothing listens. */
  reachable: boolean
  /** While set, every request is refused with this 403 error message. */
  refusal: string | undefined
  /** While true, every request hangs, as a suspended daemon's would, until its signal aborts it. */
  stalled: boolean
  /** While set, every `PATCH` or `DELETE` is answered with this error message and status. */
  rejection: { readonly status: number; readonly message: string } | undefined
  /** Each `PATCH` and `DELETE` the dashboard sent, as "PATCH aa01 {...}" or "DELETE aa01". */
  readonly changes: Array<string>
  /** Every login started, oldest first, as the daemon holds it now. */
  readonly logins: Array<FakeLogin>
  /** Who signs in at the provider's page next. */
  signInAs: FakeIdentity
  /** While set, starting a login fails with this 409 error message, as when its port is taken. */
  loginRefusal: string | undefined
  /** The provider redirects the browser to the daemon: the latest waiting login signs in `signInAs`. */
  readonly redirect: () => void
  /** The latest waiting login ends without signing in, as `status`, with `error` for a failure. */
  readonly endLogin: (status: "failed" | "expired" | "cancelled", error?: string) => void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Settings = { label?: string; priority?: number; enabled?: boolean }

const settingsOf = (body: unknown): Settings | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const fields: Record<string, unknown> = { ...body }
  const settings: Settings = {}
  if (typeof fields["label"] === "string" && fields["label"].trim() !== "") {
    settings.label = fields["label"].trim()
  } else if ("label" in fields) return undefined
  if (typeof fields["priority"] === "number") settings.priority = fields["priority"]
  else if ("priority" in fields) return undefined
  if (typeof fields["enabled"] === "boolean") settings.enabled = fields["enabled"]
  else if ("enabled" in fields) return undefined
  return settings
}

/** `accounts` with `provider`'s pool numbered 1, 2, 3… in the order given. */
const renumbered = (
  accounts: ReadonlyArray<FakeAccount>,
  pool: ReadonlyArray<FakeAccount>,
): ReadonlyArray<FakeAccount> =>
  accounts.map((held) => {
    const index = pool.findIndex((other) => other.id === held.id)
    return index === -1 ? held : { ...held, priority: index + 1 }
  })

const poolsOf = (accounts: ReadonlyArray<FakeAccount>): ReadonlyArray<FakePool> =>
  [...new Set(accounts.map((held) => held.provider))].map((provider) => ({
    provider,
    newSessionsAccountId:
      accounts
        .filter((held) => held.provider === provider && held.status === "active")
        .toSorted((a, b) => a.priority - b.priority)[0]?.id ?? null,
  }))

export const fakeDaemon = (
  initial: { accounts?: ReadonlyArray<FakeAccount>; pools?: ReadonlyArray<FakePool> } = {},
): FakeDaemon => {
  const daemon: FakeDaemon = {
    accounts: initial.accounts ?? [],
    pools: initial.pools ?? [],
    key: "ap-Zx81Qm0T4vY2bWc9sLr7HnKd3fGa6eJp5uXi1oNq8Bs",
    address: "http://127.0.0.1:8318",
    reachable: true,
    refusal: undefined,
    stalled: false,
    rejection: undefined,
    changes: [],
    logins: [],
    signInAs: { providerAccountId: "acct-new", email: "new@example.com", plan: "Max 5x" },
    loginRefusal: undefined,
    redirect: () => {
      const login = waiting()
      if (login === undefined) throw new Error("No login is waiting.")
      signIn(login)
    },
    endLogin: (status, error) => {
      const login = waiting()
      if (login === undefined) throw new Error("No login is waiting.")
      setLogin({ ...login, status, ...(error === undefined ? {} : { error }) })
    },
    fetch: async (input, init) => {
      if (!daemon.reachable) throw new TypeError("Failed to fetch")
      if (daemon.stalled) {
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          )
        })
      }
      if (daemon.refusal !== undefined) return json({ error: daemon.refusal }, 403)
      const url = new URL(input instanceof Request ? input.url : String(input), "http://dashboard")
      const method = init?.method ?? "GET"
      const loginRoute = /^\/api\/logins(?:\/([^/]+))?(\/callback)?$/.exec(url.pathname)
      if (loginRoute !== null) return loginCall(method, loginRoute[1], loginRoute[2], init?.body)
      const accountId = /^\/api\/accounts\/([^/]+)$/.exec(url.pathname)?.[1]
      if (accountId !== undefined && (method === "PATCH" || method === "DELETE")) {
        const body: unknown =
          method === "PATCH"
            ? JSON.parse(typeof init?.body === "string" ? init.body : "null")
            : undefined
        daemon.changes.push(
          method === "PATCH" ? `PATCH ${accountId} ${JSON.stringify(body)}` : `DELETE ${accountId}`,
        )
        if (daemon.rejection !== undefined) {
          return json({ error: daemon.rejection.message }, daemon.rejection.status)
        }
        return method === "PATCH" ? update(accountId, body) : remove(accountId)
      }
      switch (url.pathname) {
        case "/api/accounts":
          return json({ accounts: daemon.accounts, pools: daemon.pools })
        case "/api/daemon":
          return json({
            pid: 4242,
            address: daemon.address,
            version: "0.0.0",
            // Ninety and a half minutes ago: "1h 30m" for as long as a test runs.
            startedAt: new Date(Date.now() - (90 * 60 + 30) * 1000).toISOString(),
            uptimeSeconds: 90 * 60,
          })
        case "/api/key":
          return json({ key: daemon.key })
        default:
          return json({ error: "Not found" }, 404)
      }
    },
  }

  function update(id: string, body: unknown): Response {
    const existing = daemon.accounts.find((held) => held.id === id)
    if (existing === undefined) return json({ error: `No held ${id}.` }, 404)
    const settings = settingsOf(body)
    if (settings === undefined) return json({ error: "Expected a JSON body." }, 400)
    const enabled = settings.enabled ?? existing.enabled
    const changed: FakeAccount = {
      ...existing,
      label: settings.label ?? existing.label,
      enabled,
      status: !enabled ? "disabled" : existing.status === "disabled" ? "active" : existing.status,
    }
    const pool = daemon.accounts
      .filter((held) => held.provider === existing.provider)
      .toSorted((a, b) => a.priority - b.priority)
    const position = settings.priority ?? existing.priority
    if (position < 1 || position > pool.length) {
      return json({ error: `The pool has ${pool.length} accounts.` }, 400)
    }
    const others = pool.filter((held) => held.id !== id)
    const order = [...others.slice(0, position - 1), changed, ...others.slice(position - 1)]
    const accounts = daemon.accounts.map((held) => (held.id === id ? changed : held))
    daemon.accounts = renumbered(accounts, order)
    daemon.pools = poolsOf(daemon.accounts)
    return json(daemon.accounts.find((held) => held.id === id))
  }

  function waiting(): FakeLogin | undefined {
    return daemon.logins.findLast((login) => login.status === "pending")
  }

  function setLogin(login: FakeLogin): FakeLogin {
    const index = daemon.logins.findIndex((held) => held.id === login.id)
    daemon.logins[index] = login
    return login
  }

  /** Signs `login` in as `signInAs`, updating the account held for that identity or adding one. */
  function signIn(login: FakeLogin): FakeLogin {
    const identity = daemon.signInAs
    const held = daemon.accounts.find(
      (other) =>
        other.provider === login.provider && other.providerAccountId === identity.providerAccountId,
    )
    let signedIn: FakeAccount
    if (held !== undefined) {
      signedIn = {
        ...held,
        email: identity.email,
        plan: identity.plan,
        status: held.enabled ? "active" : "disabled",
      }
      daemon.accounts = daemon.accounts.map((other) => (other.id === held.id ? signedIn : other))
    } else {
      const pool = daemon.accounts.filter((other) => other.provider === login.provider)
      const base = identity.email.split("@")[0] ?? identity.email
      let label = base
      for (let n = 2; pool.some((other) => other.label === label); n++) label = `${base} ${n}`
      signedIn = {
        id: `added-${daemon.accounts.length + 1}`,
        provider: login.provider,
        ...identity,
        label,
        priority: pool.length + 1,
        enabled: true,
        status: "active",
        addedAt: "2026-11-17T09:00:00.000Z",
        lastUsedAt: null,
      }
      daemon.accounts = [...daemon.accounts, signedIn]
    }
    daemon.pools = poolsOf(daemon.accounts)
    return setLogin({
      ...login,
      status: "succeeded",
      account: signedIn,
      created: held === undefined,
    })
  }

  function loginCall(
    method: string,
    id: string | undefined,
    callback: string | undefined,
    body: BodyInit | null | undefined,
  ): Response {
    const fields: Record<string, unknown> = {
      ...JSON.parse(typeof body === "string" ? body : "{}"),
    }
    if (id === undefined && method === "POST") {
      const provider = fields["provider"]
      if (provider !== "claude" && provider !== "codex") {
        return json({ error: "Expected a JSON body." }, 400)
      }
      if (daemon.loginRefusal !== undefined) return json({ error: daemon.loginRefusal }, 409)
      // Starting a login cancels one still waiting for the same provider.
      for (const other of daemon.logins) {
        if (other.provider === provider && other.status === "pending") {
          setLogin({ ...other, status: "cancelled" })
        }
      }
      const n = daemon.logins.length + 1
      const authorize = new URL(authorizePages[provider])
      authorize.searchParams.set("redirect_uri", redirects[provider])
      authorize.searchParams.set("state", `state-${n}`)
      const login: FakeLogin = {
        id: `login-${n}`,
        provider,
        authorizeUrl: authorize.toString(),
        status: "pending",
      }
      daemon.logins.push(login)
      return json(login, 201)
    }
    const login = daemon.logins.find((held) => held.id === id)
    if (login === undefined) {
      return json({ error: `No login ${id}. It may have finished more than 10 minutes ago.` }, 404)
    }
    if (method === "GET" && callback === undefined) return json(login)
    if (method === "DELETE" && callback === undefined) {
      return json(login.status === "pending" ? setLogin({ ...login, status: "cancelled" }) : login)
    }
    if (method === "POST" && callback !== undefined) {
      if (login.status !== "pending") return json(login)
      const ended = pasted(login, typeof fields["url"] === "string" ? fields["url"] : "")
      return ended instanceof Response ? ended : json(ended)
    }
    return json({ error: "Not found" }, 404)
  }

  /** Finishes `login` with a pasted callback URL, as the daemon reads one. */
  function pasted(login: FakeLogin, text: string): FakeLogin | Response {
    let url: URL
    try {
      url = new URL(text.trim())
    } catch {
      return json(
        { error: "That is not a URL. Paste the whole address from the browser's address bar." },
        400,
      )
    }
    const name = providerNames[login.provider]
    if (url.searchParams.get("state") !== new URL(login.authorizeUrl).searchParams.get("state")) {
      return json(
        { error: `That URL belongs to another ${name} sign-in, not the one in progress.` },
        400,
      )
    }
    const denied = url.searchParams.get("error")
    if (denied !== null) {
      return setLogin({
        ...login,
        status: "failed",
        error: `${name} did not grant access: ${url.searchParams.get("error_description") ?? denied}`,
      })
    }
    if (!url.searchParams.get("code")) {
      return json({ error: "That URL has no authorization code in it." }, 400)
    }
    return signIn(login)
  }

  function remove(id: string): Response {
    const removed = daemon.accounts.find((held) => held.id === id)
    if (removed === undefined) return json({ error: `No held ${id}.` }, 404)
    const accounts = daemon.accounts.filter((held) => held.id !== id)
    daemon.accounts = renumbered(
      accounts,
      accounts
        .filter((held) => held.provider === removed.provider)
        .toSorted((a, b) => a.priority - b.priority),
    )
    daemon.pools = poolsOf(daemon.accounts)
    return json(removed)
  }

  return daemon
}
