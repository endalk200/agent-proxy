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
 * Each refresh gets `requestTimeout` milliseconds: a daemon that stops
 * answering mid-request counts as unreachable, and a refresh never overlaps
 * the next one or outlives the component.
 */
export const useDaemon = (
  client: DaemonClient,
  pollInterval: number,
  requestTimeout: number,
): DaemonView => {
  const [view, setView] = useState<DaemonView>({
    accounts: undefined,
    info: undefined,
    failure: undefined,
  })

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight: AbortController | undefined
    const refresh = async () => {
      const controller = new AbortController()
      inFlight = controller
      const deadline = setTimeout(() => controller.abort(), requestTimeout)
      try {
        const [accounts, info] = await Promise.all([
          client.accounts(controller.signal),
          client.daemon(controller.signal),
        ])
        if (!stopped) setView({ accounts, info, failure: undefined })
      } catch (error) {
        if (!stopped) setView((last) => ({ ...last, failure: asFailure(error) }))
      } finally {
        clearTimeout(deadline)
        // Whichever request is still pending after a failure is not needed.
        controller.abort()
      }
      if (!stopped) timer = setTimeout(() => void refresh(), pollInterval)
    }
    void refresh()
    return () => {
      stopped = true
      clearTimeout(timer)
      inFlight?.abort()
    }
  }, [client, pollInterval, requestTimeout])

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
