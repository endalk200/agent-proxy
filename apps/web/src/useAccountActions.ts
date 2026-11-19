import { useMemo, useRef } from "react"

import type { Account, AccountSettings, DaemonClient, DaemonFailure } from "./daemon-api.ts"
import { type Placement, withSettings } from "./model.ts"
import { useNotify } from "./Notices.tsx"
import { asFailure, type Daemon } from "./useDaemon.ts"

/**
 * What the owner can do to an account from the dashboard. Each one goes
 * through the daemon API, shows its result at once, and says so in a notice
 * when the daemon refuses it or cannot be reached; the page then shows what
 * the daemon holds.
 */
export interface AccountActions {
  readonly setEnabled: (account: Account, enabled: boolean) => void
  readonly rename: (account: Account, label: string) => void
  /** Moves `account` within its pool, to a priority of its own or one it shares. */
  readonly move: (account: Account, placement: Placement) => void
  /** Removes `account`; resolves true once the daemon no longer holds it. */
  readonly remove: (account: Account) => Promise<boolean>
}

/** What went wrong, in words for a notice. */
const reason = (account: Account, failure: DaemonFailure): string => {
  if (failure.kind === "unreachable") {
    return "Can't reach the daemon. Is it running? Start it with agent-proxy daemon start."
  }
  if (failure.status === 404) {
    return `The daemon no longer holds ${account.label}. It was removed, perhaps from the CLI.`
  }
  return failure.message
}

export const useAccountActions = (daemon: Daemon, client: DaemonClient): AccountActions => {
  const notify = useNotify()
  const { change } = daemon
  // The last change sent; the next waits for it.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  return useMemo(() => {
    // Changes reach the daemon one at a time, in the order the owner made
    // them: two quick moves answered out of order must not leave the first.
    const inOrder = <A>(send: () => Promise<A>): Promise<A> => {
      const sent = queue.current.then(send, send)
      queue.current = sent.catch(() => undefined)
      return sent
    }
    const update = (account: Account, settings: AccountSettings, verb: string) => {
      change(
        (list) => withSettings(list, account.id, settings),
        () => inOrder(() => client.updateAccount(account.id, settings)),
        { id: account.id, settings },
      ).catch((error: unknown) =>
        notify.error(`Couldn't ${verb} ${account.label}`, reason(account, asFailure(error))),
      )
    }
    return {
      setEnabled: (account, enabled) =>
        update(account, { enabled }, enabled ? "enable" : "disable"),
      rename: (account, label) => update(account, { label }, "rename"),
      move: (account, placement) => update(account, placement, "move"),
      remove: (account) =>
        change(
          (list) => list,
          () => inOrder(() => client.removeAccount(account.id)),
          { id: account.id, removed: true },
        ).then(
          () => true,
          (error: unknown) => {
            const failure = asFailure(error)
            if (failure.kind === "error" && failure.status === 404) {
              notify.info(
                `${account.label} was already removed`,
                "The daemon no longer holds it, perhaps because it was removed from the CLI.",
              )
              return true
            }
            notify.error(`Couldn't remove ${account.label}`, reason(account, failure))
            return false
          },
        ),
    }
  }, [change, client, notify])
}
