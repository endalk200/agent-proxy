import { useCallback, useEffect, useRef, useState } from "react"

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

export interface Daemon extends DaemonView {
  /**
   * Shows `preview` of the account list at once, runs `call`, then asks the
   * daemon for its accounts again, whether `call` succeeded or not, so the
   * page ends on what the daemon holds. When `call` fails, the page goes back
   * to the daemon's last list at once. Settles as `call` does.
   */
  readonly change: <A>(
    preview: (list: AccountList) => AccountList,
    call: () => Promise<A>,
  ) => Promise<A>
}

export const asFailure = (error: unknown): DaemonFailure =>
  error instanceof DaemonCallError
    ? error.failure
    : { kind: "error", message: error instanceof Error ? error.message : String(error) }

/**
 * Asks the daemon for its accounts and info now and every `pollInterval`
 * milliseconds after each answer, keeping the last answer when one fails.
 * Each refresh gets `requestTimeout` milliseconds: a daemon that stops
 * answering mid-request counts as unreachable, and a refresh never overlaps
 * the next one or outlives the component.
 *
 * A change made through `change` refreshes at once when it settles. An
 * answer to a refresh that started before a change settled is dropped, so a
 * slow poll never puts back what the change replaced.
 */
export const useDaemon = (
  client: DaemonClient,
  pollInterval: number,
  requestTimeout: number,
): Daemon => {
  const [view, setView] = useState<DaemonView>({
    accounts: undefined,
    info: undefined,
    failure: undefined,
  })
  /** Bumped as each change starts and settles. */
  const changes = useRef(0)
  /** How many changes are waiting on the daemon. */
  const pending = useRef(0)
  const refreshNow = useRef<() => void>(() => {})
  /** The account list as the daemon last reported it, without any preview. */
  const confirmed = useRef<AccountList | undefined>(undefined)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: AbortController | undefined
    const refresh = async () => {
      clearTimeout(timer)
      // A refresh started now replaces one still waiting for its answer.
      current?.abort()
      const controller = new AbortController()
      current = controller
      const changesAtStart = changes.current
      const deadline = setTimeout(() => controller.abort(), requestTimeout)
      let outcome:
        | { readonly ok: true; readonly accounts: AccountList; readonly info: DaemonInfo }
        | { readonly ok: false; readonly error: unknown }
      try {
        const [accounts, info] = await Promise.all([
          client.accounts(controller.signal),
          client.daemon(controller.signal),
        ])
        outcome = { ok: true, accounts, info }
      } catch (error) {
        outcome = { ok: false, error }
      } finally {
        clearTimeout(deadline)
        // Whichever request is still pending after a failure is not needed.
        controller.abort()
      }
      if (stopped || current !== controller) return
      if (!outcome.ok) {
        setView((last) => ({ ...last, failure: asFailure(outcome.error) }))
      } else if (pending.current === 0 && changes.current === changesAtStart) {
        confirmed.current = outcome.accounts
        setView({ accounts: outcome.accounts, info: outcome.info, failure: undefined })
      }
      timer = setTimeout(() => void refresh(), pollInterval)
    }
    refreshNow.current = () => void refresh()
    void refresh()
    return () => {
      stopped = true
      refreshNow.current = () => {}
      clearTimeout(timer)
      current?.abort()
    }
  }, [client, pollInterval, requestTimeout])

  const change = useCallback(
    async <A>(preview: (list: AccountList) => AccountList, call: () => Promise<A>) => {
      changes.current += 1
      pending.current += 1
      setView((last) =>
        last.accounts === undefined ? last : { ...last, accounts: preview(last.accounts) },
      )
      try {
        return await call()
      } catch (error) {
        setView((last) => ({ ...last, accounts: confirmed.current ?? last.accounts }))
        throw error
      } finally {
        changes.current += 1
        pending.current -= 1
        refreshNow.current()
      }
    },
    [],
  )

  return { ...view, change }
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
