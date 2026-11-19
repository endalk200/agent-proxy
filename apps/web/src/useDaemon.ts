import { useCallback, useEffect, useRef, useState } from "react"

import {
  type Account,
  type AccountEvent,
  type AccountList,
  type AccountSettings,
  type DaemonClient,
  DaemonCallError,
  type DaemonFailure,
  type DaemonInfo,
  type UsageEvent,
} from "./daemon-api.ts"
import { applyEvent } from "./model.ts"

/** What the dashboard knows about its daemon. */
export interface DaemonView {
  /** The last account list the daemon reported; it outlives the daemon going away. */
  readonly accounts: AccountList | undefined
  /** The last daemon info the daemon reported. */
  readonly info: DaemonInfo | undefined
  /** Why the daemon can't be followed right now, while that lasts. */
  readonly failure: DaemonFailure | undefined
}

/** A change this dashboard makes: to account `id`'s settings, or its removal. */
export type OwnChange =
  | { readonly id: string; readonly settings: AccountSettings }
  | { readonly id: string; readonly removed: true }

export interface Daemon extends DaemonView {
  /** Asks the daemon for its accounts again now, as after something changed them elsewhere. */
  readonly refresh: () => void
  /**
   * Shows `preview` of the account list at once, runs `call`, then asks the
   * daemon for its accounts again, whether `call` succeeded or not, so the
   * page ends on what the daemon holds. When `call` fails, the page goes back
   * to what the daemon holds at once. Settles as `call` does. The events
   * `own` makes reach `onEvent` marked as this dashboard's own.
   */
  readonly change: <A>(
    preview: (list: AccountList) => AccountList,
    call: () => Promise<A>,
    own?: OwnChange,
  ) => Promise<A>
}

export interface DaemonTiming {
  /** How often to check that the daemon still answers, in milliseconds. */
  readonly checkInterval: number
  /** How long a request may take before the daemon counts as unreachable, in milliseconds. */
  readonly requestTimeout: number
  /** How long to wait before asking again for an event stream the daemon refused, in milliseconds. */
  readonly reopenDelay: number
}

export const asFailure = (error: unknown): DaemonFailure =>
  error instanceof DaemonCallError
    ? error.failure
    : { kind: "error", message: error instanceof Error ? error.message : String(error) }

interface Preview {
  readonly apply: (list: AccountList) => AccountList
  /** The count of settled changes once this one's call settled. */
  settled: number | undefined
}

/** How long after a change settles its events still count as this dashboard's own. */
const OWN_EVENT_WINDOW_MS = 5000

/** True when `own` explains every way `event` moved its account. */
const explains = (own: OwnChange, event: AccountEvent): boolean => {
  if (event.account.id !== own.id) return false
  if ("removed" in own) return event.type === "removed"
  if (event.type !== "status-changed" && event.type !== "settings-changed") return false
  const { previous: before, account: after } = event
  const { settings } = own
  const kept = (key: keyof Account) => before[key] === after[key]
  return (
    (kept("label") || settings.label === after.label) &&
    (kept("enabled") || settings.enabled === after.enabled) &&
    (kept("priority") || settings.priority !== undefined) &&
    // Turning an account off or on moves its status to or from Disabled, and
    // hides or shows a cooldown still running, which the daemon reports only
    // while it decides the status.
    (kept("status") || !kept("enabled")) &&
    (kept("cooldownEndsAt") || !kept("enabled")) &&
    kept("email") &&
    kept("plan")
  )
}

/**
 * Follows the daemon: its accounts through its event stream, which starts
 * with every account as it is and then brings each change, and its info
 * through a check every `checkInterval` milliseconds.
 *
 * - The stream reconnects by itself when it drops, and each reconnection
 *   starts again from the accounts as they are, so nothing missed lingers.
 * - A stream the daemon refuses is asked for again every `reopenDelay`, and
 *   meanwhile the list is asked for each time instead.
 * - The check is how a daemon that stops answering without closing its
 *   stream is noticed: the stream's keep-alives are comments, which a
 *   browser never reports. A check that fails or takes longer than
 *   `requestTimeout` shows the daemon as unreachable and opens the stream
 *   again.
 *
 * `onEvent` hears each change as it arrives, with whether this dashboard
 * made it through `change`. `onUsage` hears each usage and limit-window event,
 * and `opened` each time the stream starts again, since events it missed
 * meanwhile are gone.
 */
export const useDaemon = (
  client: DaemonClient,
  timing: DaemonTiming,
  onEvent: (event: AccountEvent, own: boolean) => void,
  onUsage: (event: UsageEvent | { readonly type: "opened" }) => void = () => {},
): Daemon => {
  const [view, setView] = useState<DaemonView>({
    accounts: undefined,
    info: undefined,
    failure: undefined,
  })
  /** The account list as the daemon last reported it, without any preview. */
  const confirmed = useRef<AccountList | undefined>(undefined)
  /** Changes shown ahead of the daemon. */
  const previews = useRef<ReadonlyArray<Preview>>([])
  /** Changes this dashboard made, and until when their events count as its own. */
  const owned = useRef<Array<{ readonly change: OwnChange; until: number }>>([])
  /** Bumped by each message on the stream. */
  const messages = useRef(0)
  /** Bumped as each change settles. */
  const settles = useRef(0)
  const handleEvent = useRef(onEvent)
  const handleUsage = useRef(onUsage)
  useEffect(() => {
    handleEvent.current = onEvent
    handleUsage.current = onUsage
  }, [onEvent, onUsage])
  const refreshNow = useRef<() => void>(() => {})
  const { checkInterval, requestTimeout, reopenDelay } = timing

  /** Shows the daemon's list with every preview still pending laid over it. */
  const show = useCallback((patch: Partial<DaemonView> = {}) => {
    const base = confirmed.current
    const accounts =
      base === undefined ? undefined : previews.current.reduce((list, p) => p.apply(list), base)
    setView((last) => ({ ...last, ...patch, accounts: accounts ?? last.accounts }))
  }, [])

  useEffect(() => {
    let stopped = false
    let closeStream: (() => void) | undefined
    /** True from the stream's first message until it fails. */
    let streaming = false
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    let checkTimer: ReturnType<typeof setTimeout> | undefined
    /** The check whose answer counts. */
    let checking: object | undefined
    /** How many times the stream has started from a snapshot. */
    let snapshots = 0

    /** Runs `request`, aborted after `requestTimeout` or once settled. */
    const withDeadline = async <A>(request: (signal: AbortSignal) => Promise<A>) => {
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), requestTimeout)
      try {
        return await request(controller.signal)
      } finally {
        clearTimeout(deadline)
        controller.abort()
      }
    }

    /** Asks for the daemon's info, and again every `checkInterval`; a new check replaces one waiting. */
    const check = async () => {
      clearTimeout(checkTimer)
      const run = {}
      checking = run
      let outcome: { readonly info: DaemonInfo } | { readonly error: unknown }
      try {
        outcome = { info: await withDeadline((signal) => client.daemon(signal)) }
      } catch (error) {
        outcome = { error }
      }
      if (stopped || checking !== run) return
      if ("info" in outcome) {
        const { info } = outcome
        setView((last) => ({ ...last, info, failure: streaming ? undefined : last.failure }))
      } else {
        const failure = asFailure(outcome.error)
        setView((last) => ({ ...last, failure }))
        // A stream that stopped bringing anything is opened again.
        if (streaming) open()
      }
      checkTimer = setTimeout(() => void check(), checkInterval)
    }

    const open = () => {
      closeStream?.()
      clearTimeout(reopenTimer)
      streaming = false
      closeStream = client.events({
        message: (message) => {
          if (stopped) return
          messages.current += 1
          if (message.type === "snapshot") {
            streaming = true
            confirmed.current = message.list
            show({ failure: undefined })
            // A reconnection may be to a restarted daemon: its info changed.
            snapshots += 1
            if (snapshots > 1) void check()
            handleUsage.current({ type: "opened" })
            return
          }
          if (message.type === "usage-recorded" || message.type === "limits-changed") {
            handleUsage.current(message)
            return
          }
          if (confirmed.current === undefined) return
          confirmed.current = applyEvent(confirmed.current, message)
          show()
          const now = Date.now()
          owned.current = owned.current.filter((own) => own.until > now)
          handleEvent.current(
            message,
            owned.current.some((own) => explains(own.change, message)),
          )
        },
        error: (closed) => {
          if (stopped) return
          streaming = false
          if (closed) {
            // The daemon refused the stream. Until it takes it again, which
            // is asked every `reopenDelay`, the page shows the list as the
            // daemon answers it, or why it can't.
            const messagesAtStart = messages.current
            withDeadline((signal) => client.accounts(signal)).then(
              (list) => {
                if (stopped || messages.current !== messagesAtStart) return
                confirmed.current = list
                show({ failure: undefined })
              },
              (error: unknown) => {
                if (!stopped) setView((last) => ({ ...last, failure: asFailure(error) }))
              },
            )
            reopenTimer = setTimeout(open, reopenDelay)
          } else {
            setView((last) => ({ ...last, failure: { kind: "unreachable" } }))
          }
        },
      })
    }

    refreshNow.current = () => {
      const messagesAtStart = messages.current
      const settledAtStart = settles.current
      withDeadline((signal) => client.accounts(signal))
        .then(
          (list) => {
            // Anything the stream brought meanwhile is at least as new.
            if (!stopped && messages.current === messagesAtStart) confirmed.current = list
          },
          () => {},
        )
        .finally(() => {
          if (stopped) return
          previews.current = previews.current.filter(
            (preview) => preview.settled === undefined || preview.settled > settledAtStart,
          )
          show()
        })
    }

    open()
    void check()
    return () => {
      stopped = true
      refreshNow.current = () => {}
      closeStream?.()
      clearTimeout(reopenTimer)
      clearTimeout(checkTimer)
    }
  }, [client, checkInterval, requestTimeout, reopenDelay, show])

  const change = useCallback(
    async <A>(
      preview: (list: AccountList) => AccountList,
      call: () => Promise<A>,
      own?: OwnChange,
    ) => {
      const entry: Preview = { apply: preview, settled: undefined }
      const record = own === undefined ? undefined : { change: own, until: Infinity }
      previews.current = [...previews.current, entry]
      if (record !== undefined) owned.current = [...owned.current, record]
      show()
      try {
        return await call()
      } catch (error) {
        previews.current = previews.current.filter((p) => p !== entry)
        show()
        throw error
      } finally {
        settles.current += 1
        entry.settled = settles.current
        if (record !== undefined) record.until = Date.now() + OWN_EVENT_WINDOW_MS
        refreshNow.current()
      }
    },
    [show],
  )

  const refresh = useCallback(() => refreshNow.current(), [])

  return { ...view, change, refresh }
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
