import { useEffect, useState } from "react"

import {
  type AccountList,
  type DaemonClient,
  DaemonCallError,
  type DaemonFailure,
  type DaemonInfo,
} from "./daemon-api.ts"

/** What the dashboard knows about its daemon. */
export interface DaemonView {
  /** The last account list the daemon reported; it outlives the daemon going away. */
  readonly accounts: AccountList | undefined
  /** The last daemon info the daemon reported. */
  readonly info: DaemonInfo | undefined
  /** Why the latest refresh failed, while it keeps failing. */
  readonly failure: DaemonFailure | undefined
}

const asFailure = (error: unknown): DaemonFailure =>
  error instanceof DaemonCallError
    ? error.failure
    : { kind: "error", message: error instanceof Error ? error.message : String(error) }

/**
 * Asks the daemon for its accounts and info now and every `pollInterval`
 * milliseconds after each answer, keeping the last answer when one fails.
 */
export const useDaemon = (client: DaemonClient, pollInterval: number): DaemonView => {
  const [view, setView] = useState<DaemonView>({
    accounts: undefined,
    info: undefined,
    failure: undefined,
  })

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const [accounts, info] = await Promise.all([client.accounts(), client.daemon()])
        if (!stopped) setView({ accounts, info, failure: undefined })
      } catch (error) {
        if (!stopped) setView((last) => ({ ...last, failure: asFailure(error) }))
      }
      if (!stopped) timer = setTimeout(() => void refresh(), pollInterval)
    }
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [client, pollInterval])

  return view
}

/** The current time, updated every `interval` milliseconds. */
export const useNow = (interval: number): number => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(timer)
  }, [interval])
  return now
}
