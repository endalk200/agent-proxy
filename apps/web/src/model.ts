import type {
  Account,
  AccountEvent,
  AccountList,
  AccountSettings,
  AccountStatus,
  Pool,
  Provider,
} from "./daemon-api.ts"

/** The dashboard's words for what the daemon reports, in GLOSSARY.md's vocabulary. */

export const providerNames: Readonly<Record<Provider, string>> = {
  claude: "Claude",
  codex: "Codex",
}

export const statusLabels: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  "cooling-down": "Cooling down",
  "needs-sign-in": "Needs sign-in",
  disabled: "Disabled",
  unknown: "Unknown",
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

/** Which clients spend a provider's pool, as "Claude Code and opencode". */
export const clientsOf = (provider: Provider): string =>
  clients
    .filter((client) => client.providers.includes(provider))
    .map((client) => client.name)
    .join(" and ")

/**
 * A pool's accounts, highest priority first, and in the daemon's order among
 * those sharing a priority: the first added first.
 */
export const accountsOf = (list: AccountList, provider: Provider): ReadonlyArray<Account> =>
  list.accounts
    .filter((account) => account.provider === provider)
    .toSorted(
      (a, b) =>
        a.priority - b.priority || a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id),
    )

/**
 * `pool` by priority, highest first: each level holds the accounts that share
 * one priority, in `pool`'s order. Gaps between priorities close.
 */
export const levelsOf = (pool: ReadonlyArray<Account>): ReadonlyArray<ReadonlyArray<Account>> => {
  const levels: Array<Array<Account>> = []
  for (const account of pool.toSorted((a, b) => a.priority - b.priority)) {
    const last = levels.at(-1)
    if (last !== undefined && last[0]?.priority === account.priority) last.push(account)
    else levels.push([account])
  }
  return levels
}

/** Where the owner puts an account in its pool, as the daemon API takes it. */
export type Placement =
  /** Alone at `priority`; the accounts from that priority down move down one. */
  | { readonly priority: number }
  /** At the priority account `sharePriorityWith` holds, sharing it. */
  | { readonly sharePriorityWith: string }

/**
 * `pool` (highest priority first) as the daemon leaves it once account `id`
 * is placed as `placement` says, numbered 1, 2, 3… by level; undefined when
 * the daemon would refuse it.
 */
export const place = (
  pool: ReadonlyArray<Account>,
  id: string,
  placement: Placement,
): ReadonlyArray<Account> | undefined => {
  const moving = pool.find((account) => account.id === id)
  if (moving === undefined) return undefined
  const others = levelsOf(pool.filter((account) => account.id !== id))
  let levels: ReadonlyArray<ReadonlyArray<Account>>
  if ("priority" in placement) {
    const { priority } = placement
    if (!Number.isInteger(priority) || priority < 1 || priority > others.length + 1) {
      return undefined
    }
    levels = [...others.slice(0, priority - 1), [moving], ...others.slice(priority - 1)]
  } else if (placement.sharePriorityWith === id) {
    levels = levelsOf(pool)
  } else {
    const at = others.findIndex((level) =>
      level.some((account) => account.id === placement.sharePriorityWith),
    )
    if (at === -1) return undefined
    levels = others.map((level, index) => (index === at ? level.concat(moving) : level))
  }
  return levels.flatMap((level, index) =>
    level.map((account) =>
      account.priority === index + 1 ? account : { ...account, priority: index + 1 },
    ),
  )
}

/**
 * The placement one step up (-1) or down (1) from where account `id` is in
 * `pool`, as the arrow keys and Move up or down step: an account alone at its
 * priority joins the next one over, and an account sharing one takes that
 * side of it alone. Undefined at either end of the pool.
 */
export const step = (
  pool: ReadonlyArray<Account>,
  id: string,
  direction: -1 | 1,
): Placement | undefined => {
  const levels = levelsOf(pool)
  const at = levels.findIndex((level) => level.some((account) => account.id === id))
  const level = levels[at]
  if (level === undefined) return undefined
  if (level.length > 1) return { priority: direction === -1 ? at + 1 : at + 2 }
  const neighbour = levels[at + direction]?.[0]
  return neighbour === undefined ? undefined : { sharePriorityWith: neighbour.id }
}

/** The other accounts in `account`'s pool at its priority. */
export const sharingWith = (list: AccountList, account: Account): ReadonlyArray<Account> =>
  accountsOf(list, account.provider).filter(
    (other) => other.priority === account.priority && other.id !== account.id,
  )

/** How many priorities `provider`'s pool has: accounts sharing one count once. */
export const priorityCount = (list: AccountList, provider: Provider): number =>
  levelsOf(accountsOf(list, provider)).length

/** "Work", "Work and Home", "Work, Home and Spare". */
export const labelsText = (accounts: ReadonlyArray<Account>): string => {
  const labels = accounts.map((account) => account.label)
  const last = labels.pop()
  return labels.length === 0 ? (last ?? "") : `${labels.join(", ")} and ${last}`
}

/**
 * `list` as it will be once the daemon applies `settings` to account `id`:
 * a new or shared priority moves the account within its pool and renumbers
 * the rest, and turning an account off makes it Disabled. Which account gets
 * new sessions is left to the daemon to say.
 */
export const withSettings = (
  list: AccountList,
  id: string,
  settings: AccountSettings,
): AccountList => {
  const changed = list.accounts.find((account) => account.id === id)
  if (changed === undefined) return list
  const placement: Placement | undefined =
    settings.sharePriorityWith !== undefined
      ? { sharePriorityWith: settings.sharePriorityWith }
      : settings.priority !== undefined
        ? { priority: settings.priority }
        : undefined
  const placed =
    placement === undefined ? undefined : place(accountsOf(list, changed.provider), id, placement)
  const priorities = new Map(placed?.map((account) => [account.id, account.priority]))
  return {
    ...list,
    accounts: list.accounts.map((account) => {
      const priority = priorities.get(account.id) ?? account.priority
      if (account.id !== id)
        return priority === account.priority ? account : { ...account, priority }
      const enabled = settings.enabled ?? account.enabled
      return {
        ...account,
        label: settings.label ?? account.label,
        enabled,
        status: enabled ? account.status : "disabled",
        priority,
      }
    }),
  }
}

/** `list` once `event` has happened: its account added, replaced or gone, and the pools as the event says. */
export const applyEvent = (list: AccountList, event: AccountEvent): AccountList => {
  const others = list.accounts.filter((account) => account.id !== event.account.id)
  if (event.type === "removed") return { accounts: others, pools: event.pools }
  const at = list.accounts.findIndex((account) => account.id === event.account.id)
  return {
    accounts:
      at === -1
        ? [...list.accounts, event.account]
        : list.accounts.map((account, index) => (index === at ? event.account : account)),
    pools: event.pools,
  }
}

/**
 * What a pool does with a new session:
 * - `serving`: `account` gets it;
 * - `off`: every account in the pool is disabled;
 * - `blocked`: no enabled account can take it, as each one is cooling down or
 *   needs sign-in. `nextReset` is when the first cooldown ends (epoch
 *   milliseconds), if any is running, and `allCooling` says every enabled
 *   account is cooling down.
 */
export type PoolState =
  | { readonly kind: "serving"; readonly account: Account }
  | { readonly kind: "off" }
  | { readonly kind: "blocked"; readonly nextReset: number | null; readonly allCooling: boolean }

/** When `account`'s cooldown ends, in epoch milliseconds, if it is cooling down. */
export const cooldownEnd = (account: Account): number | null =>
  account.status === "cooling-down" && account.cooldownEndsAt !== null
    ? Date.parse(account.cooldownEndsAt)
    : null

export const poolState = (list: AccountList, pool: Pool): PoolState => {
  const accounts = accountsOf(list, pool.provider)
  const serving = accounts.find((account) => account.id === pool.newSessionsAccountId)
  if (serving !== undefined) return { kind: "serving", account: serving }
  const enabled = accounts.filter((account) => account.enabled)
  if (enabled.length === 0) return { kind: "off" }
  const resets = enabled.flatMap((account) => {
    const end = cooldownEnd(account)
    return end === null ? [] : [end]
  })
  return {
    kind: "blocked",
    nextReset: resets.length === 0 ? null : Math.min(...resets),
    allCooling: resets.length === enabled.length,
  }
}

/** Times as the owner's browser shows them, with plain spaces so they wrap like the text around them. */
const localTime = (options: Intl.DateTimeFormatOptions) => {
  const format = new Intl.DateTimeFormat(undefined, options)
  return (at: number) => format.format(at).replaceAll("\u202f", " ")
}
const timeOfDay = localTime({ hour: "numeric", minute: "2-digit" })
const day = localTime({ month: "short", day: "numeric" })

/** "3:47 PM" for a time later today, else "Nov 20, 10:30 AM". */
export const clockText = (at: number, now: number): string =>
  new Date(at).toDateString() === new Date(now).toDateString()
    ? timeOfDay(at)
    : `${day(at)}, ${timeOfDay(at)}`

/** "in 30s", "in 47m", "in 1h 12m", "in 2d 19h": how long until `at`. */
export const countdown = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
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

/** "1st", "2nd", "3rd", "4th", … "11th", "12th", "13th", "21st". */
export const ordinal = (n: number): string => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th"
  return `${n}${suffix}`
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
