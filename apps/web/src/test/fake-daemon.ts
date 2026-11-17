/**
 * A fake daemon API for component tests: it answers the routes the dashboard
 * calls with the JSON the daemon serves, and can stop answering to stand in
 * for a daemon that went down. Tests set the state it reports directly.
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
  addedAt: "2026-11-01T00:00:00.000Z",
  lastUsedAt: null,
  ...overrides,
})

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
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

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
  return daemon
}
