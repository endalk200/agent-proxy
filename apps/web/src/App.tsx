import { Tooltip } from "@base-ui/react/tooltip"
import { useMemo, useState } from "react"

import "./styles.css"
import { AccountSheet } from "./AccountSheet.tsx"
import { type AccountControls, AccountsPage } from "./AccountsPage.tsx"
import { ConnectClientsDialog } from "./ConnectClients.tsx"
import { type Account, createDaemonClient, type OpenEventStream } from "./daemon-api.ts"
import { useLiveUpdates } from "./LiveUpdates.ts"
import { accountsOf, hostOf } from "./model.ts"
import { NoticeProvider } from "./Notices.tsx"
import { RemoveAccountDialog } from "./RemoveAccount.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { IconPower } from "./ui.tsx"
import { useAccountActions } from "./useAccountActions.ts"
import { useDaemon, useNow } from "./useDaemon.ts"

/** The browser's own fetch, called through so it keeps `window` as `this`. */
const browserFetch: typeof fetch = (input, init) => window.fetch(input, init)

interface DashboardProps {
  fetch?: typeof fetch
  openEvents?: OpenEventStream
  checkInterval?: number
  requestTimeout?: number
  reopenDelay?: number
}

/**
 * The dashboard: a sidebar app shell around the Accounts page, following the
 * daemon API of the daemon that serves it. Every prop exists for tests.
 */
export function App(props: DashboardProps) {
  return (
    <NoticeProvider>
      <Dashboard {...props} />
    </NoticeProvider>
  )
}

function Dashboard(props: DashboardProps) {
  const fetchImpl = props.fetch ?? browserFetch
  const { openEvents } = props
  const client = useMemo(() => createDaemonClient(fetchImpl, openEvents), [fetchImpl, openEvents])
  const live = useLiveUpdates()
  const view = useDaemon(
    client,
    {
      // The stream brings every change; the check only notices a daemon gone silent.
      checkInterval: props.checkInterval ?? 15_000,
      requestTimeout: props.requestTimeout ?? 5000,
      reopenDelay: props.reopenDelay ?? 3000,
    },
    live.onEvent,
  )
  const actions = useAccountActions(view, client)
  // A cooldown's countdown ticks each second; otherwise times move by the minute.
  const cooling = view.accounts?.accounts.some((account) => account.status === "cooling-down")
  const now = useNow(cooling === true ? 1000 : 15_000)
  const [connecting, setConnecting] = useState(false)
  const [openId, setOpenId] = useState<string | undefined>()
  const [removing, setRemoving] = useState<Account | undefined>()
  const [announcement, setAnnouncement] = useState("")

  const address = view.info?.address ?? window.location.origin
  const reachable = view.failure === undefined
  const failure = view.failure
  const list = view.accounts
  const sheetOpen = list?.accounts.some((account) => account.id === openId) ?? false

  const controls: AccountControls = {
    readOnly: !reachable,
    openId,
    open: (account) => setOpenId(account.id),
    setEnabled: actions.setEnabled,
    rename: actions.rename,
    move: (account, priority) => {
      actions.move(account, priority)
      const poolSize = list === undefined ? priority : accountsOf(list, account.provider).length
      setAnnouncement(`${account.label} moved to priority ${priority} of ${poolSize}.`)
    },
    askRemove: setRemoving,
    flashes: live.flashes,
  }

  return (
    <Tooltip.Provider delay={400}>
      <div className={`app ${sheetOpen ? "has-sheet" : ""}`}>
        <Sidebar
          list={view.accounts}
          info={view.info}
          address={address}
          reachable={reachable}
          now={now}
          onConnectClients={() => setConnecting(true)}
        />

        <main className="main">
          <div className="page">
            {failure !== undefined && (
              <output className="banner">
                <IconPower size={16} />
                <span>
                  {failure.kind === "unreachable" ? (
                    <>
                      <b>Can't reach the daemon at {hostOf(address)}.</b> Is it running? Start it
                      with <code>agent-proxy daemon start</code>.
                    </>
                  ) : (
                    <>
                      <b>The daemon answered with an error.</b> {failure.message}
                    </>
                  )}
                  {view.accounts !== undefined &&
                    " This is what it last reported; it updates when the daemon answers again."}
                </span>
              </output>
            )}

            <header className="pagehead">
              <h1 id="page-title" tabIndex={-1}>
                Accounts
              </h1>
              <p>
                Each client spends only its own provider's accounts. Within a pool, the
                highest-priority account that is Active gets new sessions.
              </p>
            </header>

            {view.accounts !== undefined && (
              <div className={`content ${reachable ? "" : "is-stale"}`}>
                <AccountsPage
                  list={view.accounts}
                  now={now}
                  address={hostOf(address)}
                  client={client}
                  controls={controls}
                />
              </div>
            )}
          </div>
        </main>

        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>

        <AccountSheet
          list={list}
          now={now}
          controls={controls}
          covered={removing !== undefined || connecting}
          onClose={() => setOpenId(undefined)}
        />

        <RemoveAccountDialog
          account={removing}
          list={list}
          remove={actions.remove}
          onClose={() => setRemoving(undefined)}
        />

        <ConnectClientsDialog
          open={connecting}
          onOpenChange={setConnecting}
          list={view.accounts}
          client={client}
        />
      </div>
    </Tooltip.Provider>
  )
}
