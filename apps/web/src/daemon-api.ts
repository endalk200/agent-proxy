/**
 * The daemon API as the dashboard reads it: the JSON shapes it relies on and
 * one function per route. The dashboard is served by the daemon, so every
 * path is relative to the page's own origin.
 *
 * Answers are checked by hand rather than with Effect Schema, which would
 * double the size of the page for three small shapes.
 */

export type Provider = "claude" | "codex"

/** Where an account stands with its pool (see GLOSSARY.md). */
export type AccountStatus = "active" | "needs-sign-in" | "disabled"

export interface Account {
  readonly id: string
  readonly provider: Provider
  readonly label: string
  readonly email: string
  readonly plan: string
  /** The account's place in its pool: 1 gets new sessions first. */
  readonly priority: number
  readonly enabled: boolean
  readonly status: AccountStatus
  readonly lastUsedAt: string | null
}

export interface Pool {
  readonly provider: Provider
  /** The account a new session goes to now, or null when none in the pool is Active. */
  readonly newSessionsAccountId: string | null
}

/** `GET /api/accounts`: every account, and a pool for each provider that has one. */
export interface AccountList {
  readonly accounts: ReadonlyArray<Account>
  readonly pools: ReadonlyArray<Pool>
}

/** `GET /api/daemon`. */
export interface DaemonInfo {
  readonly address: string
  readonly version: string
  readonly startedAt: string
}

/** Why a call to the daemon failed. */
export type DaemonFailure =
  /** Nothing answered: the daemon is stopped, or the network is down. */
  | { readonly kind: "unreachable" }
  /** The daemon answered with an error, or with something the dashboard cannot read. */
  | { readonly kind: "error"; readonly message: string }

export class DaemonCallError extends Error {
  constructor(readonly failure: DaemonFailure) {
    super(failure.kind === "unreachable" ? "The daemon is unreachable." : failure.message)
  }
}

export interface DaemonClient {
  readonly accounts: () => Promise<AccountList>
  readonly daemon: () => Promise<DaemonInfo>
  readonly key: () => Promise<string>
}

// ------------------------------------------------------------------ decoding

class Unreadable extends Error {}

type Json = Readonly<Record<string, unknown>>

const object = (value: unknown): Json => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Unreadable()
  return Object.fromEntries(Object.entries(value))
}
const array = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Unreadable()
  return value
}
const string = (value: unknown): string => {
  if (typeof value !== "string") throw new Unreadable()
  return value
}
const nullableString = (value: unknown): string | null => (value === null ? null : string(value))
const oneOf = <A extends string>(options: ReadonlyArray<A>, value: unknown): A => {
  const found = options.find((option) => option === value)
  if (found === undefined) throw new Unreadable()
  return found
}
const PROVIDERS: ReadonlyArray<Provider> = ["claude", "codex"]
const STATUSES: ReadonlyArray<AccountStatus> = ["active", "needs-sign-in", "disabled"]

const decodeAccount = (value: unknown): Account => {
  const json = object(value)
  if (typeof json["priority"] !== "number" || typeof json["enabled"] !== "boolean") {
    throw new Unreadable()
  }
  return {
    id: string(json["id"]),
    provider: oneOf(PROVIDERS, json["provider"]),
    label: string(json["label"]),
    email: string(json["email"]),
    plan: string(json["plan"]),
    priority: json["priority"],
    enabled: json["enabled"],
    status: oneOf(STATUSES, json["status"]),
    lastUsedAt: nullableString(json["lastUsedAt"]),
  }
}

const decodeAccountList = (value: unknown): AccountList => {
  const json = object(value)
  return {
    accounts: array(json["accounts"]).map(decodeAccount),
    pools: array(json["pools"]).map((pool) => {
      const fields = object(pool)
      return {
        provider: oneOf(PROVIDERS, fields["provider"]),
        newSessionsAccountId: nullableString(fields["newSessionsAccountId"]),
      }
    }),
  }
}

const decodeDaemonInfo = (value: unknown): DaemonInfo => {
  const json = object(value)
  return {
    address: string(json["address"]),
    version: string(json["version"]),
    startedAt: string(json["startedAt"]),
  }
}

const decodeKey = (value: unknown): string => string(object(value)["key"])

const errorMessage = (value: unknown): string | undefined => {
  try {
    return string(object(value)["error"])
  } catch {
    return undefined
  }
}

// -------------------------------------------------------------------- client

export const createDaemonClient = (fetchImpl: typeof fetch): DaemonClient => {
  const get = async <A>(path: string, decode: (body: unknown) => A): Promise<A> => {
    let response: Response
    try {
      response = await fetchImpl(path, { headers: { accept: "application/json" } })
    } catch {
      throw new DaemonCallError({ kind: "unreachable" })
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message =
        errorMessage(body) ?? `The daemon answered ${path} with HTTP ${response.status}.`
      throw new DaemonCallError({ kind: "error", message })
    }
    try {
      return decode(body)
    } catch {
      throw new DaemonCallError({
        kind: "error",
        message: `The daemon's answer to ${path} is not what this dashboard expects.`,
      })
    }
  }

  return {
    accounts: () => get("/api/accounts", decodeAccountList),
    daemon: () => get("/api/daemon", decodeDaemonInfo),
    key: () => get("/api/key", decodeKey),
  }
}
