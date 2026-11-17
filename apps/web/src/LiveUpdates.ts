import { useCallback, useEffect, useRef, useState } from "react"

import type { AccountEvent, AccountStatus } from "./daemon-api.ts"
import { clockText, cooldownEnd, providerNames } from "./model.ts"
import { type Notice, useNotify } from "./Notices.tsx"

/**
 * Live updates: each change the daemon streams that this page did not make
 * flashes its row in the account's new status colour and gets a notice. A
 * change made on this page gets neither, as the page already shows it, and a
 * move gets no notice, as the order on the page says it.
 */

/** A row flashing: in the colour of `status`. `turn` flips each flash, so a second one replays. */
export interface Flash {
  readonly status: AccountStatus
  readonly turn: 0 | 1
}

/** How long a row's flash lasts, in milliseconds, matching its animation in the styles. */
const FLASH_MS = 2600

/** What a notice says about `event`, or nothing for a change the page shows by itself. */
export const noticeFor = (event: AccountEvent, now: number): Notice | undefined => {
  const { account } = event
  const { label } = account
  const pool = `the ${providerNames[account.provider]} pool`
  switch (event.type) {
    case "added":
      return {
        tone: "ok",
        title: `${label} was added`,
        description: `It joins ${pool} at priority ${account.priority}.`,
      }
    case "removed":
      return {
        tone: "info",
        title: `${label} was removed`,
        description: "agent-proxy no longer holds it or its sign-in.",
      }
    case "settings-changed": {
      const { previous } = event
      if (previous.label !== label) {
        return {
          tone: "info",
          title: `${previous.label} is now ${label}`,
          description: "It was renamed outside this page.",
        }
      }
      if (previous.plan !== account.plan) {
        return {
          tone: "info",
          title: `${label} is on ${account.plan}`,
          description: "Its plan changed.",
        }
      }
      return undefined
    }
    case "status-changed":
      switch (account.status) {
        case "cooling-down": {
          const end = cooldownEnd(account)
          return {
            tone: "warn",
            title: `${label} is cooling down`,
            description: `It hit its plan's limit. agent-proxy skips it until ${end === null ? "the limit resets" : clockText(end, now)}.`,
          }
        }
        case "needs-sign-in":
          return {
            tone: "error",
            title: `${label} needs sign-in`,
            description: "Its sign-in expired, so agent-proxy skips it until you sign in again.",
          }
        case "disabled":
          return {
            tone: "info",
            title: `${label} was turned off`,
            description: `It sits out of ${pool} and keeps its priority.`,
          }
        case "active":
          switch (event.previous.status) {
            case "cooling-down":
              return {
                tone: "ok",
                title: `${label} is back`,
                description: `Its cooldown ended, so it's in ${pool} again.`,
              }
            case "needs-sign-in":
              return {
                tone: "ok",
                title: `${label} is signed in again`,
                description: `It's in ${pool} again.`,
              }
            case "disabled":
              return {
                tone: "ok",
                title: `${label} was turned on`,
                description: `It's in ${pool} again at priority ${account.priority}.`,
              }
            default:
              return { tone: "ok", title: `${label} is active`, description: `It's in ${pool}.` }
          }
        case "unknown":
          return {
            tone: "info",
            title: `${label} changed status`,
            description: "The daemon reports a status this dashboard does not know.",
          }
      }
  }
}

/** Flashes rows and adds notices for live changes; hand `onEvent` to the daemon. */
export const useLiveUpdates = () => {
  const notify = useNotify()
  const [flashes, setFlashes] = useState<ReadonlyMap<string, Flash>>(new Map())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
    }
  }, [])

  const onEvent = useCallback(
    (event: AccountEvent, own: boolean) => {
      if (own) return
      const notice = noticeFor(event, Date.now())
      if (notice === undefined) return
      notify.show(notice)
      if (event.type === "removed") return
      const { id, status } = event.account
      setFlashes((last) => {
        const turn = last.get(id)?.turn === 0 ? 1 : 0
        return new Map(last).set(id, { status, turn })
      })
      clearTimeout(timers.current.get(id))
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id)
          setFlashes((last) => {
            const next = new Map(last)
            next.delete(id)
            return next
          })
        }, FLASH_MS),
      )
    },
    [notify],
  )

  return { flashes, onEvent }
}
