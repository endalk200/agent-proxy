// PROTOTYPE: the dashboard's vocabulary as types, plus pure helpers every variant may use.
// Words follow the design session: Provider, Account, Plan, Pool, Account status, Priority, Client, Proxy key.

export type Provider = "claude" | "codex"

export const PROVIDERS: ReadonlyArray<Provider> = ["claude", "codex"]

export const providerName: Record<Provider, string> = { claude: "Claude", codex: "Codex" }

/** Where the provider's login lives, shown while the add-account dialog waits. */
export const providerLoginHost: Record<Provider, string> = {
  claude: "claude.ai",
  codex: "auth.openai.com",
}

export type Plan = "Claude Pro" | "Claude Max 5x" | "Claude Max 20x" | "ChatGPT Plus" | "ChatGPT Pro"

/** Short text for a plan badge: "Max 20x", "Pro", "Plus". */
export const planShort = (plan: Plan): string => plan.replace(/^(Claude|ChatGPT) /, "")

/** Relative weight of a plan, for badge emphasis (1 = smallest). */
export const planTier = (plan: Plan): 1 | 2 | 3 => {
  switch (plan) {
    case "Claude Pro":
    case "ChatGPT Plus":
      return 1
    case "Claude Max 5x":
    case "ChatGPT Pro":
      return plan === "ChatGPT Pro" ? 3 : 2
    case "Claude Max 20x":
      return 3
  }
}

/** What the daemon knows about an account's login, independent of the owner's enable switch. */
export type Health = { kind: "active" } | { kind: "cooling"; until: number } | { kind: "signin" }

export interface Account {
  id: string
  provider: Provider
  label: string
  email: string
  plan: Plan
  /** false = the owner turned it off (status Disabled). */
  enabled: boolean
  health: Health
  /** 1 = highest. Contiguous within a provider; disabled accounts keep their place but are skipped. */
  priority: number
  lastUsedAt: number | null
  addedAt: number
  /** Last time the status changed, for variants that want to animate a change landing. */
  changedAt: number
}

/** Account status: exactly one of these. */
export type Status =
  | { kind: "active" }
  | { kind: "cooling"; until: number }
  | { kind: "signin" }
  | { kind: "disabled" }

export const statusOf = (a: Account): Status => (a.enabled ? a.health : { kind: "disabled" })

export const statusLabel = (s: Status): "Active" | "Cooling down" | "Needs sign-in" | "Disabled" => {
  switch (s.kind) {
    case "active":
      return "Active"
    case "cooling":
      return "Cooling down"
    case "signin":
      return "Needs sign-in"
    case "disabled":
      return "Disabled"
  }
}

/** "3:42 PM" */
export const formatClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

/** "until 3:42 PM" */
export const untilText = (until: number): string => `until ${formatClock(until)}`

/** "in 47m", "in 1h 12m", "in 30s" */
export const countdown = (until: number, now: number): string => {
  const s = Math.max(0, Math.round((until - now) / 1000))
  if (s < 60) return `in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  return `in ${h}h ${m % 60}m`
}

/** "just now", "4 min ago", "2 hr ago", "yesterday", "3 days ago", "Never" */
export const lastUsedText = (ts: number | null, now: number): string => {
  if (ts === null) return "Never"
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 45) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  return d === 1 ? "yesterday" : `${d} days ago`
}

/** A provider's accounts, highest priority first. */
export const accountsOf = (accounts: ReadonlyArray<Account>, provider: Provider): Account[] =>
  accounts.filter((a) => a.provider === provider).sort((x, y) => x.priority - y.priority)

/** The pool: every enabled account of the provider, in priority order. */
export const poolOf = (accounts: ReadonlyArray<Account>, provider: Provider): Account[] =>
  accountsOf(accounts, provider).filter((a) => a.enabled)

/**
 * What the pool is doing right now.
 * - empty: no accounts of this provider at all
 * - off: accounts exist but every one is disabled
 * - serving: `account` (highest priority, enabled, Active) gets new sessions
 * - blocked: every enabled account is cooling down or needs sign-in; `nextReset` is the soonest cooldown end
 */
export type PoolState =
  | { kind: "empty" }
  | { kind: "off" }
  | { kind: "serving"; account: Account }
  | { kind: "blocked"; allCooling: boolean; nextReset: number | null }

export const poolState = (accounts: ReadonlyArray<Account>, provider: Provider): PoolState => {
  const all = accountsOf(accounts, provider)
  if (all.length === 0) return { kind: "empty" }
  const pool = all.filter((a) => a.enabled)
  if (pool.length === 0) return { kind: "off" }
  const serving = pool.find((a) => a.health.kind === "active")
  if (serving !== undefined) return { kind: "serving", account: serving }
  const resets = pool.flatMap((a) => (a.health.kind === "cooling" ? [a.health.until] : []))
  return {
    kind: "blocked",
    allCooling: resets.length === pool.length,
    nextReset: resets.length > 0 ? Math.min(...resets) : null,
  }
}

/** The account that gets the provider's new sessions, if any. */
export const servingAccountId = (accounts: ReadonlyArray<Account>, provider: Provider): string | null => {
  const s = poolState(accounts, provider)
  return s.kind === "serving" ? s.account.id : null
}

export interface Client {
  id: "claude-code" | "codex" | "opencode"
  name: string
  command: string
  /** Which pools the client can draw from. */
  providers: ReadonlyArray<Provider>
}

export const CLIENTS: ReadonlyArray<Client> = [
  { id: "claude-code", name: "Claude Code", command: "agent-proxy connect claude-code", providers: ["claude"] },
  { id: "codex", name: "Codex", command: "agent-proxy connect codex", providers: ["codex"] },
  { id: "opencode", name: "opencode", command: "agent-proxy connect opencode", providers: ["claude", "codex"] },
]

export const PLANS: Record<Provider, ReadonlyArray<Plan>> = {
  claude: ["Claude Pro", "Claude Max 5x", "Claude Max 20x"],
  codex: ["ChatGPT Plus", "ChatGPT Pro"],
}
