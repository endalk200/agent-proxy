import type { OpenEventStream } from "../daemon-api.ts"

/**
 * A fake daemon API for component tests: it answers the routes the dashboard
 * calls with the JSON the daemon serves, streams account events the way
 * `GET /api/events` does, and can stop answering to stand in for a daemon
 * that went down. Tests read back what the dashboard changed through `PATCH`
 * and `DELETE`, which follow the daemon's rules: a move renumbers the pool, a
 * removal closes the gap, and the pool's new sessions go to its
 * highest-priority Active account.
 *
 * - `update`, `add` and `forget` change accounts as the daemon does on its
 *   own (a cooldown, a sign-in expiring, the CLI), and stream the events.
 * - Setting `accounts` changes what the daemon holds without streaming
 *   anything, as when an event has not reached the page yet.
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

  /** Holds `accounts` from now on, and streams how they moved. */
  const commit = (accounts: ReadonlyArray<FakeAccount>) => {
    const before = daemon.accounts
    daemon.accounts = accounts
    daemon.pools = poolsOf(accounts)
    for (const event of eventsBetween(before, accounts, daemon.pools)) {
      for (const stream of streams) {
        if (stream.live && !stalled) stream.data(JSON.stringify(event))
      }
    }
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
      commit([...daemon.accounts, { ...added, priority: pool.length + 1 }])
    },
    forget: (id) => {
      remove(id)
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
    commit(renumbered(accounts, order))
    return json(daemon.accounts.find((held) => held.id === id))
  }

  function remove(id: string): Response {
    const removed = daemon.accounts.find((held) => held.id === id)
    if (removed === undefined) return json({ error: `No held ${id}.` }, 404)
    const accounts = daemon.accounts.filter((held) => held.id !== id)
    commit(
      renumbered(
        accounts,
        accounts
          .filter((held) => held.provider === removed.provider)
          .toSorted((a, b) => a.priority - b.priority),
      ),
    )
    return json(removed)
  }

  return daemon
}
