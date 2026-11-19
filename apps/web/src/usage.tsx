import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type {
  AccountLimits,
  DaemonClient,
  UsageEvent,
  UsageRange,
  UsageRecord,
} from "./daemon-api.ts"
import { useNotify } from "./Notices.tsx"
import { asFailure } from "./useDaemon.ts"

/**
 * Usage and limit windows as the pages read them: one shared copy of every
 * account's limit windows, kept current by `limits-changed` events, and
 * `useUsageQuery`, which loads a usage route and reloads it as requests
 * finish, at most once per throttle window.
 */

/** How often, at most, usage reloads as requests finish, in milliseconds. */
export interface UsageThrottle {
  /** The KPIs: about once a second. */
  readonly kpis: number
  /** Series and breakdowns: at most every 15 seconds. */
  readonly charts: number
}

export const DEFAULT_THROTTLE: UsageThrottle = { kpis: 1000, charts: 15_000 }

/** The viewer's IANA time zone, which every usage route is asked in. */
export const viewerTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** What a page needs to know that usage moved: a request finished, or the stream opened again. */
type Change = { readonly type: "recorded" } | { readonly type: "reopened" }

export interface Usage {
  readonly client: DaemonClient
  readonly tz: string
  readonly throttle: UsageThrottle
  /** Every account's limit windows by account id, once loaded. */
  readonly limits: ReadonlyMap<string, AccountLimits> | undefined
  /** Account ids whose limit windows are being refreshed; "*" while every account's are. */
  readonly refreshing: ReadonlySet<string>
  /** Reads fresh limit windows for one account, or every account. */
  readonly refresh: (accountId?: string) => void
  /** The latest request the daemon reported finishing since the page opened. */
  readonly lastRecorded: UsageRecord | undefined
  readonly subscribe: (listener: (change: Change) => void) => () => void
}

const UsageContext = createContext<Usage | undefined>(undefined)

export const UsageProvider = (props: { usage: Usage; children: ReactNode }) => (
  <UsageContext.Provider value={props.usage}>{props.children}</UsageContext.Provider>
)

export const useUsage = (): Usage => {
  const usage = useContext(UsageContext)
  if (usage === undefined) throw new Error("useUsage needs a UsageProvider.")
  return usage
}

/** True while `accountId`'s limit windows, or every account's, are being refreshed. */
export const isRefreshing = (usage: Usage, accountId: string) =>
  usage.refreshing.has(accountId) || usage.refreshing.has("*")

const byAccount = (all: ReadonlyArray<AccountLimits>) =>
  new Map(all.map((entry) => [entry.accountId, entry]))

/**
 * Follows usage for the whole page. `onUsage` goes to `useDaemon`, which
 * hands it each usage and limit event from the daemon's one event stream.
 */
export function useUsageFeed(
  client: DaemonClient,
  throttle: UsageThrottle,
): { readonly usage: Usage; readonly onUsage: (event: UsageEvent | { type: "opened" }) => void } {
  const notify = useNotify()
  const [limits, setLimits] = useState<ReadonlyMap<string, AccountLimits> | undefined>()
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(new Set())
  const [lastRecorded, setLastRecorded] = useState<UsageRecord | undefined>()
  const listeners = useRef(new Set<(change: Change) => void>())
  /** Bumped by each full read of the limits, so an older answer never replaces a newer one. */
  const limitsTurn = useRef(0)
  /** Accounts whose limits an event changed since the latest full read began: newer than its answer. */
  const changedSince = useRef(new Map<string, AccountLimits>())

  const loadLimits = useCallback(() => {
    const turn = ++limitsTurn.current
    changedSince.current = new Map()
    client.limits().then(
      (all) => {
        if (turn !== limitsTurn.current) return
        const loaded = byAccount(all)
        for (const [id, changed] of changedSince.current) loaded.set(id, changed)
        setLimits(loaded)
      },
      () => {},
    )
  }, [client])

  useEffect(loadLimits, [loadLimits])

  const onUsage = useCallback(
    (event: UsageEvent | { type: "opened" }) => {
      switch (event.type) {
        case "opened":
          // Whatever changed while the stream was closed went unheard.
          loadLimits()
          for (const listener of listeners.current) listener({ type: "reopened" })
          return
        case "limits-changed":
          changedSince.current.set(event.limits.accountId, event.limits)
          // Until the first full read answers, one account's limits are not all of them.
          setLimits((last) =>
            last === undefined ? last : new Map(last).set(event.limits.accountId, event.limits),
          )
          return
        case "usage-recorded":
          setLastRecorded(event.usage)
          for (const listener of listeners.current) listener({ type: "recorded" })
      }
    },
    [loadLimits],
  )

  const refresh = useCallback(
    (accountId?: string) => {
      const key = accountId ?? "*"
      setRefreshing((last) => new Set(last).add(key))
      // A full read, newer than any still on its way; what changes while it
      // is out is newer than its answer.
      const turn = ++limitsTurn.current
      changedSince.current = new Map()
      client
        .refreshLimits(accountId)
        .then(
          (all) => {
            if (turn !== limitsTurn.current) return
            const read = byAccount(all)
            for (const [id, changed] of changedSince.current) read.set(id, changed)
            setLimits(read)
          },
          (error: unknown) => {
            const failure = asFailure(error)
            notify.error(
              "Couldn't refresh limits",
              failure.kind === "unreachable" ? "The daemon is unreachable." : failure.message,
            )
          },
        )
        .finally(() =>
          setRefreshing((last) => {
            const next = new Set(last)
            next.delete(key)
            return next
          }),
        )
    },
    [client, notify],
  )

  const subscribe = useCallback((listener: (change: Change) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  const usage = useMemo(
    () => ({
      client,
      tz: viewerTimeZone(),
      throttle,
      limits,
      refreshing,
      refresh,
      lastRecorded,
      subscribe,
    }),
    [client, throttle, limits, refreshing, refresh, lastRecorded, subscribe],
  )
  return { usage, onUsage }
}

export interface UsageAnswer<A> {
  /** The latest answer, kept on screen while the next one loads. */
  readonly data: A | undefined
  /** True while the answer shown is for another key, such as the last range. */
  readonly stale: boolean
  /** Why the latest load failed, while no answer for this key has come. */
  readonly error: string | undefined
}

/**
 * Loads `load()`, and loads it again when `key` changes, when a request
 * finishes (at most once per `throttleMs`), and when the event stream opens
 * again.
 */
export function useUsageQuery<A>(
  key: string,
  load: (client: DaemonClient, tz: string) => Promise<A>,
  throttleMs: number,
): UsageAnswer<A> {
  const { client, tz, subscribe } = useUsage()
  const [state, setState] = useState<{
    readonly data: A | undefined
    /** The key `data` answers. */
    readonly key: string | undefined
    readonly error: { readonly key: string; readonly message: string } | undefined
  }>({ data: undefined, key: undefined, error: undefined })
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const lastRun = useRef(0)
  /** Numbers each load, so an answer older than the one shown never replaces it. */
  const turn = useRef(0)
  const shown = useRef(0)
  /** The key the page asks about now; an answer for another key is never shown. */
  const current = useRef(key)
  useEffect(() => {
    current.current = key
  }, [key])

  const run = useCallback(() => {
    lastRun.current = performance.now()
    const mine = ++turn.current
    // Any answer newer than the one shown is shown, even if a later load is
    // already on its way: while requests keep finishing, some load always is.
    const fresh = () => mine > shown.current && key === current.current
    loadRef.current(client, tz).then(
      (data) => {
        if (!fresh()) return
        shown.current = mine
        setState({ data, key, error: undefined })
      },
      (error: unknown) => {
        if (!fresh()) return
        const failure = asFailure(error)
        setState((last) => ({
          ...last,
          error: {
            key,
            message:
              failure.kind === "unreachable" ? "The daemon is unreachable." : failure.message,
          },
        }))
      },
    )
  }, [client, tz, key])

  useEffect(run, [run])

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined
    const stop = subscribe(() => {
      if (pending !== undefined) return
      const wait = Math.max(0, lastRun.current + throttleMs - performance.now())
      pending = setTimeout(() => {
        pending = undefined
        run()
      }, wait)
    })
    return () => {
      stop()
      clearTimeout(pending)
    }
  }, [subscribe, run, throttleMs])

  return {
    data: state.data,
    stale: state.key !== key,
    error: state.key !== key && state.error?.key === key ? state.error.message : undefined,
  }
}

/** A key that names `range`, for `useUsageQuery`. */
export const rangeKey = (range: UsageRange) =>
  range.key === "custom" ? `custom:${range.from}:${range.to}` : range.key
