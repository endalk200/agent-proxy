/**
 * The daemon API as the dashboard reads it: the JSON shapes it relies on and
 * one function per route. The dashboard is served by the daemon, so every
 * path is relative to the page's own origin.
 *
 * Answers are checked by hand rather than with Effect Schema, which would
 * double the size of the page for a few small shapes.
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
  readonly addedAt: string
  readonly lastUsedAt: string | null
}

/** The settings the owner changes on an account; each one left out stays as it is. */
export interface AccountSettings {
  readonly label?: string
  /** A place in the account's pool, 1 first; the others shift to make room. */
  readonly priority?: number
  readonly enabled?: boolean
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

/**
 * Where a login stands: waiting for the owner to sign in (`pending`), or
 * finished, whether it added or updated an account (`succeeded`) or not.
 */
export type LoginStatus = "pending" | "succeeded" | "failed" | "cancelled" | "expired"

/** A login the daemon runs to add an account or sign in to one again (ADR-0007). */
export interface Login {
  readonly id: string
  readonly provider: Provider
  /** The provider's sign-in page, to open in a browser. */
  readonly authorizeUrl: string
  readonly status: LoginStatus
  /** Why a `failed` login failed. */
  readonly error?: string
  /** The account a `succeeded` login added or updated. */
  readonly account?: Account
  /** True when a `succeeded` login added a new account, false when it updated one. */
  readonly created?: boolean
}

/** Why a call to the daemon failed. */
export type DaemonFailure =
  /** Nothing answered: the daemon is stopped, or the network is down. */
  | { readonly kind: "unreachable" }
  /**
   * The daemon answered with an error (`status` is its HTTP status), or with
   * something the dashboard cannot read.
   */
  | { readonly kind: "error"; readonly message: string; readonly status?: number }

export class DaemonCallError extends Error {
  constructor(readonly failure: DaemonFailure) {
    super(failure.kind === "unreachable" ? "The daemon is unreachable." : failure.message)
  }
}

export interface DaemonClient {
  readonly accounts: (signal?: AbortSignal) => Promise<AccountList>
  readonly daemon: (signal?: AbortSignal) => Promise<DaemonInfo>
  readonly key: () => Promise<string>
  /** `PATCH /api/accounts/:id`. */
  readonly updateAccount: (id: string, settings: AccountSettings) => Promise<Account>
  /** `DELETE /api/accounts/:id`. */
  readonly removeAccount: (id: string) => Promise<Account>
  /** `POST /api/logins`: starts a login, listening for the provider's redirect. */
  readonly startLogin: (provider: Provider) => Promise<Login>
  /** `GET /api/logins/:id`. */
  readonly login: (id: string, signal?: AbortSignal) => Promise<Login>
  /** `POST /api/logins/:id/callback`: finishes a login with a pasted callback URL. */
  readonly submitCallback: (id: string, url: string) => Promise<Login>
  /** `DELETE /api/logins/:id`: cancels a waiting login. */
  readonly cancelLogin: (id: string) => Promise<Login>
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
const LOGIN_STATUSES: ReadonlyArray<LoginStatus> = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]

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
    addedAt: string(json["addedAt"]),
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

const decodeLogin = (value: unknown): Login => {
  const json = object(value)
  const created = json["created"]
  if (created !== undefined && typeof created !== "boolean") throw new Unreadable()
  return {
    id: string(json["id"]),
    provider: oneOf(PROVIDERS, json["provider"]),
    authorizeUrl: string(json["authorizeUrl"]),
    status: oneOf(LOGIN_STATUSES, json["status"]),
    ...(json["error"] === undefined ? {} : { error: string(json["error"]) }),
    ...(json["account"] === undefined ? {} : { account: decodeAccount(json["account"]) }),
    ...(created === undefined ? {} : { created }),
  }
}

const errorMessage = (value: unknown): string | undefined => {
  try {
    return string(object(value)["error"])
  } catch {
    return undefined
  }
}

// -------------------------------------------------------------------- client

const accountPath = (id: string) => `/api/accounts/${encodeURIComponent(id)}`
const loginPath = (id: string) => `/api/logins/${encodeURIComponent(id)}`

export const createDaemonClient = (fetchImpl: typeof fetch): DaemonClient => {
  const call = async <A>(
    path: string,
    decode: (body: unknown) => A,
    options: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<A> => {
    const { method = "GET", signal } = options
    let response: Response
    try {
      response = await fetchImpl(path, {
        method,
        headers:
          options.body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      throw new DaemonCallError({ kind: "unreachable" })
    }
    const body: unknown = await response.json().catch(() => undefined)
    // A body cut off by the deadline is a daemon that stopped answering.
    if (signal?.aborted === true) throw new DaemonCallError({ kind: "unreachable" })
    if (!response.ok) {
      const message =
        errorMessage(body) ?? `The daemon answered ${method} ${path} with HTTP ${response.status}.`
      throw new DaemonCallError({ kind: "error", message, status: response.status })
    }
    try {
      return decode(body)
    } catch {
      throw new DaemonCallError({
        kind: "error",
        message: `The daemon's answer to ${method} ${path} is not what this dashboard expects.`,
      })
    }
  }

  return {
    accounts: (signal) => call("/api/accounts", decodeAccountList, { signal }),
    daemon: (signal) => call("/api/daemon", decodeDaemonInfo, { signal }),
    key: () => call("/api/key", decodeKey),
    updateAccount: (id, settings) =>
      call(accountPath(id), decodeAccount, { method: "PATCH", body: settings }),
    removeAccount: (id) => call(accountPath(id), decodeAccount, { method: "DELETE" }),
    startLogin: (provider) =>
      call("/api/logins", decodeLogin, { method: "POST", body: { provider } }),
    login: (id, signal) => call(loginPath(id), decodeLogin, { signal }),
    submitCallback: (id, url) =>
      call(`${loginPath(id)}/callback`, decodeLogin, { method: "POST", body: { url } }),
    cancelLogin: (id) => call(loginPath(id), decodeLogin, { method: "DELETE" }),
  }
}
