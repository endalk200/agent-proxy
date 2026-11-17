import type { Account, AccountList, AccountStatus, Pool, Provider } from "./daemon-api.ts"

/** The dashboard's words for what the daemon reports, in GLOSSARY.md's vocabulary. */

export const providerNames: Readonly<Record<Provider, string>> = {
  claude: "Claude",
  codex: "Codex",
}

export const statusLabels: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  "needs-sign-in": "Needs sign-in",
  disabled: "Disabled",
}

export interface Client {
  readonly name: string
  readonly command: string
  /** The pools the client spends: each client uses only its own provider's accounts. */
  readonly providers: ReadonlyArray<Provider>
}

export const clients: ReadonlyArray<Client> = [
  { name: "Claude Code", command: "agent-proxy connect claude-code", providers: ["claude"] },
  { name: "Codex", command: "agent-proxy connect codex", providers: ["codex"] },
  { name: "opencode", command: "agent-proxy connect opencode", providers: ["claude", "codex"] },
]

/** A pool's accounts, highest priority first. */
export const accountsOf = (list: AccountList, provider: Provider): ReadonlyArray<Account> =>
  list.accounts
    .filter((account) => account.provider === provider)
    .toSorted((a, b) => a.priority - b.priority)

/**
 * What a pool does with a new session:
 * - `serving`: `account` gets it;
 * - `off`: every account in the pool is disabled;
 * - `blocked`: no enabled account can take it, as each one needs sign-in.
 */
export type PoolState =
  | { readonly kind: "serving"; readonly account: Account }
  | { readonly kind: "off" }
  | { readonly kind: "blocked" }

export const poolState = (list: AccountList, pool: Pool): PoolState => {
  const accounts = accountsOf(list, pool.provider)
  const serving = accounts.find((account) => account.id === pool.newSessionsAccountId)
  if (serving !== undefined) return { kind: "serving", account: serving }
  return accounts.every((account) => !account.enabled) ? { kind: "off" } : { kind: "blocked" }
}

/** How much a plan carries, for its badge's weight: 1 the smallest. */
export const planWeight = (provider: Provider, plan: string): 1 | 2 | 3 => {
  if (provider === "codex") return plan === "Pro" ? 3 : 1
  if (plan === "Max 20x") return 3
  return plan.startsWith("Max") || plan === "Team" || plan === "Enterprise" ? 2 : 1
}

/** "just now", "4 min ago", "2 hr ago", "yesterday", "3 days ago", or "Never". */
export const lastUsedText = (lastUsedAt: string | null, now: number): string => {
  if (lastUsedAt === null) return "Never"
  const seconds = Math.max(0, (now - Date.parse(lastUsedAt)) / 1000)
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  return days === 1 ? "yesterday" : `${days} days ago`
}

/** "45m", "3h 12m", "2d 4h": how long the daemon has been up. */
export const uptimeText = (startedAt: string, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "127.0.0.1:8318" for "http://127.0.0.1:8318". */
export const hostOf = (address: string): string => address.replace(/^https?:\/\//, "")
