import type {
  AccountLimits,
  ClientName,
  LimitWindow,
  OpenEventStream,
  BreakdownAccount,
  TokenCounts,
  UsageStatus,
} from "../daemon-api.ts"

/**
 * A fake daemon API for component tests: it answers the routes the dashboard
 * calls with the JSON the daemon serves, streams account events the way
 * `GET /api/events` does, and can stop answering to stand in for a daemon
 * that went down. Tests read back what the dashboard changed through `PATCH`
 * and `DELETE`, which follow the daemon's rules: a move or a shared priority
 * renumbers the pool, a removal closes any gap, and the pool's new sessions
 * go to its Active accounts by priority (the fake knows no headroom: accounts
 * sharing a priority go in the order they were added).
 *
 * - `update`, `add` and `forget` change accounts as the daemon does on its
 *   own (a cooldown, a sign-in expiring, the CLI), and stream the events.
 * - Setting `accounts` changes what the daemon holds without streaming
 *   anything, as when an event has not reached the page yet.
 *
 * Logins follow the daemon's too: a login waits until the test plays the
 * provider's redirect reaching the daemon (`redirect`) or the dashboard posts
 * a callback URL, then signs in `signInAs`, updating the account the daemon
 * already holds for that identity or adding one at the bottom of its pool.
 *
 * Usage follows the daemon's routes too: `usage` holds the recorded requests,
 * which `/api/usage/*` add up over a range resolved to whole buckets in the
 * test's time zone, priced by `prices`. `limits` holds each account's last
 * known limit windows; a refresh reads `providerLimits`, as the daemon reads
 * each provider's usage endpoint. `record` and `setLimits` stream their event.
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
  /** A string the dashboard does not know stands in for a status a newer daemon reports. */
  readonly status: "active" | "cooling-down" | "needs-sign-in" | "disabled" | (string & {})
  /** When a `cooling-down` account's cooldown ends; a daemon from before cooldowns leaves it out. */
  readonly cooldownEndsAt?: string | null
  readonly addedAt: string
  readonly lastUsedAt: string | null
}

export interface FakePool {
  readonly provider: "claude" | "codex"
  readonly newSessionsAccountId: string | null
  /** A daemon from before shared priorities leaves it out. */
  readonly newSessionsOrder?: ReadonlyArray<string>
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

/** A request the proxy finished, as the daemon records it. */
export interface FakeUsageRow {
  readonly at: number
  readonly provider: "claude" | "codex"
  readonly accountId: string
  readonly model: string
  readonly client: ClientName
  readonly status: UsageStatus
  readonly tokens: TokenCounts
}

/** A successful Claude request now with no tokens; `overrides` sets what a test cares about. */
export const usageRow = (
  overrides: Partial<Omit<FakeUsageRow, "tokens">> & { tokens?: Partial<TokenCounts> },
): FakeUsageRow => ({
  at: Date.now(),
  provider: "claude",
  accountId: "a1",
  model: "claude-opus-5-5",
  client: "claude-code",
  status: "success",
  ...overrides,
  tokens: {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
    ...overrides.tokens,
  },
})

/** An account since removed, as the daemon remembers it. */
export interface FormerAccount extends BreakdownAccount {
  readonly id: string
}

/** USD per million tokens; a missing cache rate falls back to the input rate. */
export interface FakePrice {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** A limit window as a provider reports it, before the daemon stamps when. */
export type FakeWindow = Omit<LimitWindow, "asOf"> & { readonly asOf?: number }

export interface FakeDaemon {
  /** Serves the daemon API; hand it to the dashboard as its `fetch`. */
  readonly fetch: typeof fetch
  /**
   * Serves `GET /api/events`; hand it to the dashboard as its `openEvents`.
   * Like a browser's EventSource, a stream reconnects by itself a moment
   * after it drops, except one the daemon refused.
   */
  readonly openEvents: OpenEventStream
  /** How many event streams are open now. */
  readonly streams: number
  /** Changes account `id` as the daemon does on its own, and streams the change. */
  readonly update: (id: string, changes: Partial<FakeAccount>) => void
  /** Adds an account at the bottom of its pool, as a login does, and streams it. */
  readonly add: (account: FakeAccount) => void
  /** Forgets account `id`, as `accounts remove` from the CLI does, and streams it. */
  readonly forget: (id: string) => void
  /** Sets the pools without changing an account, as headroom moving does, and streams `pools-changed`. */
  readonly setPools: (pools: ReadonlyArray<FakePool>) => void
  accounts: ReadonlyArray<FakeAccount>
  pools: ReadonlyArray<FakePool>
  key: string
  address: string
  /**
   * While false, every request fails the way `fetch` does when nothing
   * listens, and open event streams drop.
   */
  reachable: boolean
  /** While set, every request is refused with this 403 error message. */
  refusal: string | undefined
  /** While true, only the event stream is refused, as by a daemon from before live updates. */
  eventsRefused: boolean
  /**
   * While true, every request hangs, as a suspended daemon's would, until its
   * signal aborts it, and event streams bring nothing.
   */
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
  /** While set, a started login reports this as its sign-in page instead of the provider's. */
  authorizeUrlOverride: string | undefined
  /** How many of the next `GET /api/logins/:id` hang, as a stuck daemon's would, until aborted. */
  stallLoginPolls: number
  /** The provider redirects the browser to the daemon: the latest waiting login signs in `signInAs`. */
  readonly redirect: () => void
  /** The latest waiting login ends without signing in, as `status`, with `error` for a failure. */
  readonly endLogin: (status: "failed" | "expired" | "cancelled", error?: string) => void
  /** Every request recorded, in any order; setting it streams nothing. */
  usage: Array<FakeUsageRow>
  /** Accounts removed whose names the daemon remembers; removing an account adds it. */
  formerAccounts: Array<FormerAccount>
  /** List prices by model id; a model left out is unpriced. */
  prices: Record<string, FakePrice>
  /** Each account's last known limit windows; setting it streams nothing. */
  limits: Array<AccountLimits>
  /** What each account's provider usage endpoint reports when read; an account left out fails its read. */
  providerLimits: Record<string, ReadonlyArray<FakeWindow>>
  /** Records a request the proxy finished, and streams `usage-recorded`. */
  readonly record: (row: FakeUsageRow) => void
  /** Sets account `accountId`'s limit windows (each `asOf` now unless given), and streams `limits-changed`. */
  readonly setLimits: (accountId: string, windows: ReadonlyArray<FakeWindow>) => void
  /** Each `/api/usage/*` call the dashboard made, as "summary?range=7d&tz=…". */
  readonly usageCalls: Array<string>
  /** Each `POST /api/limits/refresh`, as "all" or the account id. */
  readonly refreshes: Array<string>
  /** While true, `POST /api/limits/refresh` waits until it is set false again. */
  holdRefresh: boolean
  /** While true, `GET /api/limits` waits until it is set false again, then answers the limits as they are then. */
  holdLimitsRead: boolean
  /** How long each `/api/usage/*` answer takes, in milliseconds; it answers what it held when asked. */
  usageDelayMs: number
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Settings = {
  label?: string
  priority?: number
  sharePriorityWith?: string
  enabled?: boolean
}

const settingsOf = (body: unknown): Settings | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const fields: Record<string, unknown> = { ...body }
  const settings: Settings = {}
  if (typeof fields["label"] === "string" && fields["label"].trim() !== "") {
    settings.label = fields["label"].trim()
  } else if ("label" in fields) return undefined
  if (typeof fields["priority"] === "number") settings.priority = fields["priority"]
  else if ("priority" in fields) return undefined
  if (typeof fields["sharePriorityWith"] === "string") {
    settings.sharePriorityWith = fields["sharePriorityWith"]
  } else if ("sharePriorityWith" in fields) return undefined
  if (settings.priority !== undefined && settings.sharePriorityWith !== undefined) return undefined
  if (typeof fields["enabled"] === "boolean") settings.enabled = fields["enabled"]
  else if ("enabled" in fields) return undefined
  return settings
}

/** A pool's accounts by priority, each level the accounts of one priority, gaps closed. */
const levelsOf = (pool: ReadonlyArray<FakeAccount>): Array<Array<FakeAccount>> => {
  const priorities = [...new Set(pool.map((held) => held.priority))].toSorted((a, b) => a - b)
  return priorities.map((priority) => pool.filter((held) => held.priority === priority))
}

/** `accounts` with each account in `levels` at its level's priority: the first level is 1. */
const renumbered = (
  accounts: ReadonlyArray<FakeAccount>,
  levels: ReadonlyArray<ReadonlyArray<FakeAccount>>,
): ReadonlyArray<FakeAccount> =>
  accounts.map((held) => {
    const index = levels.findIndex((level) => level.some((other) => other.id === held.id))
    return index === -1 ? held : { ...held, priority: index + 1 }
  })

const poolsOf = (accounts: ReadonlyArray<FakeAccount>): ReadonlyArray<FakePool> =>
  [...new Set(accounts.map((held) => held.provider))].map((provider) => {
    const order = accounts
      .filter((held) => held.provider === provider && held.status === "active")
      .toSorted((a, b) => a.priority - b.priority)
      .map((held) => held.id)
    return { provider, newSessionsAccountId: order[0] ?? null, newSessionsOrder: order }
  })

/** How long a dropped fake stream waits before it reconnects. */
const RECONNECT_MS = 10

type StreamEvent = Readonly<Record<string, unknown>>

/** The events that take `before` to `after`, as the daemon streams them. */
const eventsBetween = (
  before: ReadonlyArray<FakeAccount>,
  after: ReadonlyArray<FakeAccount>,
  pools: ReadonlyArray<FakePool>,
): Array<StreamEvent> => {
  const was = new Map(before.map((held) => [held.id, held]))
  const kept = new Set(after.map((held) => held.id))
  const events: Array<StreamEvent> = before
    .filter((held) => !kept.has(held.id))
    .map((held) => ({ type: "removed", account: held, pools }))
  for (const held of after) {
    if (!was.has(held.id)) events.push({ type: "added", account: held, pools })
  }
  for (const held of after) {
    const previous = was.get(held.id)
    if (previous === undefined) continue
    if (
      previous.status !== held.status ||
      (previous.cooldownEndsAt ?? null) !== (held.cooldownEndsAt ?? null)
    ) {
      events.push({ type: "status-changed", account: held, previous, pools })
    } else if (
      (["label", "priority", "enabled", "email", "plan"] as const).some(
        (key) => previous[key] !== held[key],
      )
    ) {
      events.push({ type: "settings-changed", account: held, previous, pools })
    } else if (previous.lastUsedAt !== held.lastUsedAt) {
      events.push({ type: "used", account: held, pools })
    }
  }
  return events
}

interface Stream {
  readonly data: (data: string) => void
  readonly error: (closed: boolean) => void
  /** Open and bringing events; false while connecting, and once closed. */
  live: boolean
  closed: boolean
}

export const fakeDaemon = (
  initial: { accounts?: ReadonlyArray<FakeAccount>; pools?: ReadonlyArray<FakePool> } = {},
): FakeDaemon => {
  const streams = new Set<Stream>()
  let reachable = true
  let stalled = false

  /** Connects `stream` once the daemon answers, as EventSource keeps trying to. */
  const connect = (stream: Stream) =>
    setTimeout(() => {
      if (stream.closed) return
      if (!reachable) {
        stream.error(false)
        connect(stream)
      } else if (stalled) {
        connect(stream)
      } else if (daemon.refusal !== undefined || daemon.eventsRefused) {
        stream.closed = true
        streams.delete(stream)
        stream.error(true)
      } else {
        stream.live = true
        const { accounts, pools } = daemon
        stream.data(JSON.stringify({ type: "snapshot", accounts, pools }))
      }
    }, RECONNECT_MS)

  const broadcast = (event: StreamEvent) => {
    for (const stream of streams) {
      if (stream.live && !stalled) stream.data(JSON.stringify(event))
    }
  }

  /** Holds `accounts` from now on, and streams how they moved. */
  const commit = (accounts: ReadonlyArray<FakeAccount>) => {
    const before = daemon.accounts
    daemon.accounts = accounts
    daemon.pools = poolsOf(accounts)
    for (const event of eventsBetween(before, accounts, daemon.pools)) broadcast(event)
  }

  /** Holds `windows` as account `accountId`'s limits, and streams the change. */
  const holdLimits = (accountId: string, windows: ReadonlyArray<FakeWindow>) => {
    const now = Date.now()
    const stamped = windows.map((window) => ({ ...window, asOf: window.asOf ?? now }))
    const limits: AccountLimits = {
      accountId,
      asOf: stamped.length === 0 ? null : Math.max(...stamped.map((window) => window.asOf)),
      windows: stamped,
    }
    daemon.limits = [...daemon.limits.filter((held) => held.accountId !== accountId), limits]
    broadcast({ type: "limits-changed", limits })
  }

  const daemon: FakeDaemon = {
    accounts: initial.accounts ?? [],
    pools: initial.pools ?? [],
    key: "ap-Zx81Qm0T4vY2bWc9sLr7HnKd3fGa6eJp5uXi1oNq8Bs",
    address: "http://127.0.0.1:8318",
    get reachable() {
      return reachable
    },
    set reachable(value) {
      reachable = value
      if (value) return
      for (const stream of streams) {
        if (!stream.live) continue
        stream.live = false
        stream.error(false)
        connect(stream)
      }
    },
    get stalled() {
      return stalled
    },
    set stalled(value) {
      stalled = value
    },
    get streams() {
      return [...streams].filter((stream) => !stream.closed).length
    },
    refusal: undefined,
    eventsRefused: false,
    rejection: undefined,
    changes: [],
    openEvents: (url, handlers) => {
      if (url !== "/api/events") throw new Error(`No event stream at ${url}`)
      const stream: Stream = { ...handlers, live: false, closed: false }
      streams.add(stream)
      connect(stream)
      return {
        close: () => {
          stream.closed = true
          stream.live = false
          streams.delete(stream)
        },
      }
    },
    update: (id, changes) =>
      commit(daemon.accounts.map((held) => (held.id === id ? { ...held, ...changes } : held))),
    add: (added) => {
      const pool = daemon.accounts.filter((held) => held.provider === added.provider)
      commit([...daemon.accounts, { ...added, priority: levelsOf(pool).length + 1 }])
    },
    setPools: (pools) => {
      daemon.pools = pools
      broadcast({ type: "pools-changed", pools })
    },
    forget: (id) => {
      remove(id)
    },
    usage: [],
    formerAccounts: [],
    prices: {},
    limits: [],
    providerLimits: {},
    usageCalls: [],
    refreshes: [],
    holdRefresh: false,
    holdLimitsRead: false,
    usageDelayMs: 0,
    record: (row) => {
      daemon.usage.push(row)
      const { at, provider, accountId, model, client, status, tokens } = row
      broadcast({
        type: "usage-recorded",
        usage: { at, provider, accountId, model, client, status, tokens },
      })
    },
    setLimits: holdLimits,
    logins: [],
    signInAs: { providerAccountId: "acct-new", email: "new@example.com", plan: "Max 5x" },
    loginRefusal: undefined,
    authorizeUrlOverride: undefined,
    stallLoginPolls: 0,
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
      if (loginRoute !== null && method === "GET" && daemon.stallLoginPolls > 0) {
        daemon.stallLoginPolls--
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          )
        })
      }
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
      if (url.pathname.startsWith("/api/usage/")) {
        const answer = usageCall(url)
        if (daemon.usageDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, daemon.usageDelayMs))
        }
        return answer
      }
      if (url.pathname === "/api/limits" && method === "GET") {
        // Read before waiting: an answer reflects the moment the request arrived.
        const answer = limitsList()
        await new Promise<void>((resolve) => {
          const wait = () => (daemon.holdLimitsRead ? setTimeout(wait, 5) : resolve())
          wait()
        })
        return json(answer)
      }
      if (url.pathname === "/api/limits/refresh" && method === "POST") {
        return refreshCall(typeof init?.body === "string" ? init.body : "{}")
      }
      switch (url.pathname) {
        case "/api/accounts":
          return json({ accounts: daemon.accounts, pools: daemon.pools })
        case "/api/daemon":
          return json({
            pid: 4242,
            address: daemon.address,
            version: "0.0.0",
            build: "abc1234",
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
      // The daemon reports a cooldown only while it decides the status.
      cooldownEndsAt: enabled ? (existing.cooldownEndsAt ?? null) : null,
    }
    const accounts = daemon.accounts.map((held) => (held.id === id ? changed : held))
    const pool = accounts.filter((held) => held.provider === existing.provider)
    const others = levelsOf(pool.filter((held) => held.id !== id))
    let levels: ReadonlyArray<ReadonlyArray<FakeAccount>> = levelsOf(pool)
    if (settings.priority !== undefined) {
      const position = settings.priority
      if (position < 1 || position > others.length + 1) {
        return json({ error: `A priority is 1 to ${others.length + 1}.` }, 400)
      }
      levels = [...others.slice(0, position - 1), [changed], ...others.slice(position - 1)]
    } else if (settings.sharePriorityWith !== undefined && settings.sharePriorityWith !== id) {
      const partner = settings.sharePriorityWith
      const at = others.findIndex((level) => level.some((held) => held.id === partner))
      if (at === -1) return json({ error: `No account ${partner} to share a priority with.` }, 400)
      levels = others.map((level, index) => (index === at ? level.concat(changed) : level))
    }
    commit(renumbered(accounts, levels))
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
      commit(daemon.accounts.map((other) => (other.id === held.id ? signedIn : other)))
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
        priority: levelsOf(pool).length + 1,
        enabled: true,
        status: "active",
        addedAt: "2026-11-17T09:00:00.000Z",
        lastUsedAt: null,
      }
      commit([...daemon.accounts, signedIn])
    }
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
        authorizeUrl: daemon.authorizeUrlOverride ?? authorize.toString(),
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

  /** Every account's limits, in the order the daemon holds its accounts. */
  function limitsList(): ReadonlyArray<AccountLimits> {
    return daemon.accounts.map(
      (held) =>
        daemon.limits.find((limits) => limits.accountId === held.id) ?? {
          accountId: held.id,
          asOf: null,
          windows: [],
        },
    )
  }

  async function refreshCall(body: string): Promise<Response> {
    const fields: Record<string, unknown> = { ...JSON.parse(body === "" ? "{}" : body) }
    const accountId = typeof fields["accountId"] === "string" ? fields["accountId"] : undefined
    if (accountId !== undefined && !daemon.accounts.some((held) => held.id === accountId)) {
      return json({ error: `No account ${accountId}.` }, 404)
    }
    daemon.refreshes.push(accountId ?? "all")
    for (const held of daemon.accounts) {
      if (accountId !== undefined && held.id !== accountId) continue
      // A read that fails leaves the last known windows as they were.
      const read = daemon.providerLimits[held.id]
      if (read !== undefined) holdLimits(held.id, read)
    }
    // The reads are done; the answer is on its way, held as long as the test says.
    const answer = limitsList()
    await new Promise<void>((resolve) => {
      const wait = () => (daemon.holdRefresh ? setTimeout(wait, 5) : resolve())
      wait()
    })
    return json(answer)
  }

  function usageCall(url: URL): Response {
    daemon.usageCalls.push(`${url.pathname.replace("/api/usage/", "")}${url.search}`)
    const range = resolveRange(url.searchParams, daemon.usage)
    if (range === undefined) return json({ error: "Bad range." }, 400)
    const accountId = url.searchParams.get("account")
    const rows = daemon.usage.filter(
      (row) =>
        row.at >= range.from &&
        row.at < range.to &&
        (accountId === null || row.accountId === accountId),
    )
    const bucketOf = (at: number) => range.starts.findLastIndex((start) => start <= at)
    switch (url.pathname) {
      case "/api/usage/summary": {
        const group = Math.ceil(range.starts.length / 24)
        const spark = range.starts.flatMap((t, i) => {
          if (i % group !== 0) return []
          const inPoint = rows.filter((row) => {
            const bucket = bucketOf(row.at)
            return bucket >= i && bucket < i + group
          })
          const sum = sumOf(inPoint, daemon.prices)
          return [
            {
              t,
              requests: inPoint.length,
              tokens: totalOf(sum.tokens),
              cacheHitRate: hitRateOf(sum.tokens),
              costUsd: sum.costUsd,
            },
          ]
        })
        const sum = sumOf(rows, daemon.prices)
        return json({
          from: range.from,
          to: range.to,
          requests: sum.requests,
          tokens: sum.tokens,
          cacheHitRate: hitRateOf(sum.tokens),
          costUsd: sum.costUsd,
          unpricedModels: [
            ...new Set(rows.map((row) => row.model).filter((model) => !(model in daemon.prices))),
          ],
          spark,
        })
      }
      case "/api/usage/series": {
        if (url.searchParams.get("by") !== "model") return json({ error: "Bad by." }, 400)
        const metric = url.searchParams.get("metric") ?? "tokens"
        if (metric !== "tokens" && metric !== "cost") return json({ error: "Bad metric." }, 400)
        const valueOf = (row: FakeUsageRow) => {
          if (metric === "tokens") return totalOf(row.tokens)
          const price = daemon.prices[row.model]
          return price === undefined ? 0 : costOf(row, price)
        }
        const byModel = new Map<string, number>()
        for (const row of rows) {
          byModel.set(row.model, (byModel.get(row.model) ?? 0) + valueOf(row))
        }
        const keys = [...byModel]
          .filter(([, total]) => total > 0)
          .toSorted((a, b) => b[1] - a[1])
          .map(([model]) => model)
        return json({
          from: range.from,
          to: range.to,
          bucketMs: range.bucketMs,
          metric,
          keys,
          buckets: range.starts.map((t, i) => {
            const values: Record<string, number> = {}
            for (const row of rows) {
              const value = valueOf(row)
              if (bucketOf(row.at) === i && value > 0) {
                values[row.model] = (values[row.model] ?? 0) + value
              }
            }
            return { t, values }
          }),
        })
      }
      case "/api/usage/breakdown": {
        const by = url.searchParams.get("by")
        if (by !== "model" && by !== "account") return json({ error: "Bad by." }, 400)
        const groups = new Map<string, Array<FakeUsageRow>>()
        for (const row of rows) {
          const key = by === "model" ? row.model : row.accountId
          groups.set(key, [...(groups.get(key) ?? []), row])
        }
        const all = totalOf(sumOf(rows, daemon.prices).tokens)
        const out = [...groups].map(([key, group]) => {
          const sum = sumOf(group, daemon.prices)
          const priced = group.filter((row) => row.model in daemon.prices)
          const unpriced = group.filter(
            (row) => !(row.model in daemon.prices) && totalOf(row.tokens) > 0,
          )
          const totalTokens = totalOf(sum.tokens)
          return {
            key,
            requests: sum.requests,
            tokens: sum.tokens,
            totalTokens,
            costUsd: priced.length === 0 ? null : sum.costUsd,
            partlyUnpriced: priced.length > 0 && unpriced.length > 0,
            share: all === 0 ? 0 : totalTokens / all,
            account: by === "account" ? accountOf(key) : undefined,
          }
        })
        return json({
          from: range.from,
          to: range.to,
          by,
          rows: out.toSorted((a, b) => b.totalTokens - a.totalTokens),
        })
      }
      default:
        return json({ error: "Not found" }, 404)
    }
  }

  /** Account `id` as a breakdown names it: held, or remembered since its removal. */
  function accountOf(id: string): BreakdownAccount | null {
    const held = daemon.accounts.find((candidate) => candidate.id === id)
    if (held !== undefined) {
      const { provider, label, email, plan } = held
      return { provider, label, email, plan, removedAt: null }
    }
    const former = daemon.formerAccounts.findLast((candidate) => candidate.id === id)
    if (former === undefined) return null
    const { provider, label, email, plan, removedAt } = former
    return { provider, label, email, plan, removedAt }
  }

  function remove(id: string): Response {
    const removed = daemon.accounts.find((held) => held.id === id)
    if (removed === undefined) return json({ error: `No held ${id}.` }, 404)
    daemon.formerAccounts.push({
      id,
      provider: removed.provider,
      label: removed.label,
      email: removed.email,
      plan: removed.plan,
      removedAt: Date.now(),
    })
    const accounts = daemon.accounts.filter((held) => held.id !== id)
    commit(
      renumbered(accounts, levelsOf(accounts.filter((held) => held.provider === removed.provider))),
    )
    return json(removed)
  }

  return daemon
}

// --------------------------------------------------------------------- usage

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Local midnight of the day `t` falls in, in the time zone the tests run in. */
const startOfDay = (t: number) => {
  const day = new Date(t)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}
const addDays = (t: number, days: number) => {
  const day = new Date(t)
  day.setDate(day.getDate() + days)
  return day.getTime()
}
const parseDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getTime()
}

interface Resolved {
  readonly from: number
  readonly to: number
  readonly bucketMs: number
  /** Each bucket's start, oldest first. */
  readonly starts: ReadonlyArray<number>
}

/** Whole buckets of `bucketMs` from `first` up to `end`; days follow the calendar. */
const bucketsBetween = (first: number, end: number, bucketMs: number): Resolved => {
  const starts: Array<number> = []
  for (let t = first; t < end; t = bucketMs >= DAY ? addDays(t, 1) : t + bucketMs) starts.push(t)
  return { from: first, to: end, bucketMs, starts }
}

/** The range a usage call asks for, resolved as the daemon does: whole buckets ending with the current one. */
const resolveRange = (
  params: URLSearchParams,
  usage: ReadonlyArray<FakeUsageRow>,
): Resolved | undefined => {
  const now = Date.now()
  const key = params.get("range") ?? "7d"
  const recent = (bucketMs: number, count: number) => {
    const today = startOfDay(now)
    const current =
      bucketMs >= DAY ? today : today + Math.floor((now - today) / bucketMs) * bucketMs
    const first = bucketMs >= DAY ? addDays(today, 1 - count) : current - (count - 1) * bucketMs
    return bucketsBetween(first, bucketMs >= DAY ? addDays(today, 1) : current + bucketMs, bucketMs)
  }
  switch (key) {
    case "6h":
      return recent(15 * 60_000, 24)
    case "24h":
      return recent(HOUR, 24)
    case "7d":
      return recent(3 * HOUR, 56)
    case "30d":
      return recent(DAY, 30)
    case "90d":
      return recent(DAY, 90)
    case "lifetime": {
      const first = Math.min(now, ...usage.map((row) => row.at))
      return bucketsBetween(startOfDay(first), addDays(startOfDay(now), 1), DAY)
    }
    case "custom": {
      const from = params.get("from")
      const to = params.get("to")
      const day = /^\d{4}-\d{2}-\d{2}$/
      if (from === null || to === null || !day.test(from) || !day.test(to) || from > to) {
        return undefined
      }
      const start = parseDay(from)
      const end = addDays(parseDay(to), 1)
      const days = Math.round((end - start) / DAY)
      return bucketsBetween(start, end, days <= 2 ? HOUR : days <= 10 ? 6 * HOUR : DAY)
    }
    default:
      return undefined
  }
}

const totalOf = (tokens: TokenCounts) =>
  tokens.uncached + tokens.cacheRead + tokens.cacheWrite + tokens.output

const hitRateOf = (tokens: TokenCounts) => {
  const input = tokens.uncached + tokens.cacheRead + tokens.cacheWrite
  return input === 0 ? null : tokens.cacheRead / input
}

const costOf = (row: FakeUsageRow, price: FakePrice) =>
  (row.tokens.uncached * price.input +
    row.tokens.cacheRead * (price.cacheRead ?? price.input) +
    (row.tokens.cacheWrite - row.tokens.cacheWrite1h) * (price.cacheWrite ?? price.input) +
    row.tokens.cacheWrite1h * price.input * 2 +
    row.tokens.output * price.output) /
  1_000_000

const sumOf = (rows: ReadonlyArray<FakeUsageRow>, prices: Readonly<Record<string, FakePrice>>) => {
  const tokens = {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
  }
  const requests = { total: 0, success: 0, failed: 0, limited: 0, incomplete: 0 }
  let costUsd = 0
  for (const row of rows) {
    for (const kind of [
      "uncached",
      "cacheRead",
      "cacheWrite",
      "cacheWrite1h",
      "output",
      "reasoning",
    ] as const) {
      tokens[kind] += row.tokens[kind]
    }
    requests.total += 1
    requests[row.status] += 1
    const price = prices[row.model]
    if (price !== undefined) costUsd += costOf(row, price)
  }
  return { tokens, requests, costUsd }
}
