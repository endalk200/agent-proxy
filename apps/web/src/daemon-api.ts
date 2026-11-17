/**
 * The daemon API as the dashboard reads it: the JSON shapes it relies on and
 * one function per route. The dashboard is served by the daemon, so every
 * path is relative to the page's own origin.
 *
 * Answers are checked by hand rather than with Effect Schema, which would
 * double the size of the page for three small shapes.
 */

export type Provider = "claude" | "codex"

/**
 * Where an account stands with its pool (see GLOSSARY.md). `unknown` stands
 * for a status a newer daemon reports that this dashboard does not know.
 */
export type AccountStatus = "active" | "cooling-down" | "needs-sign-in" | "disabled" | "unknown"

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
  /** When a `cooling-down` account's cooldown ends, as an ISO 8601 timestamp. */
  readonly cooldownEndsAt: string | null
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

/**
 * A change to one account, from `GET /api/events`, with every pool as it is
 * after it. `status-changed` and `settings-changed` carry the account as it
 * was before in `previous`.
 */
export type AccountEvent =
  | {
      readonly type: "added" | "removed"
      readonly account: Account
      readonly pools: ReadonlyArray<Pool>
    }
  | {
      readonly type: "status-changed" | "settings-changed"
      readonly account: Account
      readonly previous: Account
      readonly pools: ReadonlyArray<Pool>
    }

/** A message on the daemon's event stream: the accounts as they are when it opens, then each change. */
export type StreamMessage = { readonly type: "snapshot"; readonly list: AccountList } | AccountEvent

/** What the dashboard does as its event stream opens, carries a message, or fails. */
export interface StreamHandlers {
  readonly message: (message: StreamMessage) => void
  /**
   * The stream failed. `closed` is true when it will not reconnect by
   * itself, as when the daemon refused it; otherwise it is reconnecting.
   */
  readonly error: (closed: boolean) => void
}

/** Opens an event stream at `url` that reports its raw `data`; the browser's EventSource by default. */
export type OpenEventStream = (
  url: string,
  handlers: {
    readonly data: (data: string) => void
    readonly error: (closed: boolean) => void
  },
) => { readonly close: () => void }

export interface DaemonClient {
  readonly accounts: (signal?: AbortSignal) => Promise<AccountList>
  /**
   * `GET /api/events`: subscribes to account changes until the returned
   * function is called. A message this dashboard cannot read is skipped.
   */
  readonly events: (handlers: StreamHandlers) => () => void
  readonly daemon: (signal?: AbortSignal) => Promise<DaemonInfo>
  readonly key: () => Promise<string>
  /** `PATCH /api/accounts/:id`. */
  readonly updateAccount: (id: string, settings: AccountSettings) => Promise<Account>
  /** `DELETE /api/accounts/:id`. */
  readonly removeAccount: (id: string) => Promise<Account>
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
const STATUSES: ReadonlyArray<AccountStatus> = [
  "active",
  "cooling-down",
  "needs-sign-in",
  "disabled",
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
    // One account in a status this dashboard does not know leaves the rest readable.
    status: STATUSES.find((status) => status === json["status"]) ?? "unknown",
    // A daemon from before cooldowns does not send it.
    cooldownEndsAt:
      json["cooldownEndsAt"] === undefined ? null : nullableString(json["cooldownEndsAt"]),
    addedAt: string(json["addedAt"]),
    lastUsedAt: nullableString(json["lastUsedAt"]),
  }
}

const decodePools = (value: unknown): ReadonlyArray<Pool> =>
  array(value).map((pool) => {
    const fields = object(pool)
    return {
      provider: oneOf(PROVIDERS, fields["provider"]),
      newSessionsAccountId: nullableString(fields["newSessionsAccountId"]),
    }
  })

const decodeAccountList = (value: unknown): AccountList => {
  const json = object(value)
  return { accounts: array(json["accounts"]).map(decodeAccount), pools: decodePools(json["pools"]) }
}

const decodeStreamMessage = (value: unknown): StreamMessage => {
  const json = object(value)
  const pools = () => decodePools(json["pools"])
  switch (json["type"]) {
    case "snapshot":
      return { type: "snapshot", list: decodeAccountList(json) }
    case "added":
    case "removed":
      return { type: json["type"], account: decodeAccount(json["account"]), pools: pools() }
    case "status-changed":
    case "settings-changed":
      return {
        type: json["type"],
        account: decodeAccount(json["account"]),
        previous: decodeAccount(json["previous"]),
        pools: pools(),
      }
    default:
      throw new Unreadable()
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

const accountPath = (id: string) => `/api/accounts/${encodeURIComponent(id)}`

/** The browser's EventSource, which reconnects by itself after a dropped connection. */
export const browserEventStream: OpenEventStream = (url, handlers) => {
  const source = new EventSource(url)
  source.addEventListener("message", (event: MessageEvent<unknown>) =>
    handlers.data(String(event.data)),
  )
  source.addEventListener("error", () => handlers.error(source.readyState === EventSource.CLOSED))
  return { close: () => source.close() }
}

export const createDaemonClient = (
  fetchImpl: typeof fetch,
  openEvents: OpenEventStream = browserEventStream,
): DaemonClient => {
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
    events: (handlers) => {
      const stream = openEvents("/api/events", {
        data: (data) => {
          let message: StreamMessage
          try {
            message = decodeStreamMessage(JSON.parse(data))
          } catch {
            return
          }
          handlers.message(message)
        },
        error: handlers.error,
      })
      return stream.close
    },
    daemon: (signal) => call("/api/daemon", decodeDaemonInfo, { signal }),
    key: () => call("/api/key", decodeKey),
    updateAccount: (id, settings) =>
      call(accountPath(id), decodeAccount, { method: "PATCH", body: settings }),
    removeAccount: (id) => call(accountPath(id), decodeAccount, { method: "DELETE" }),
  }
}
