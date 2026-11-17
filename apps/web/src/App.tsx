import { Tooltip } from "@base-ui/react/tooltip"
import { useMemo, useState } from "react"

import "./styles.css"
import { AccountSheet } from "./AccountSheet.tsx"
import { type AccountControls, AccountsPage } from "./AccountsPage.tsx"
import { ConnectClientsDialog } from "./ConnectClients.tsx"
import { type Account, createDaemonClient } from "./daemon-api.ts"
import { accountsOf, hostOf } from "./model.ts"
import { NoticeProvider } from "./Notices.tsx"
import { RemoveAccountDialog } from "./RemoveAccount.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { type SignInRequest, SignInDialog } from "./SignIn.tsx"
import { IconPlus, IconPower } from "./ui.tsx"
import { useAccountActions } from "./useAccountActions.ts"
import { useDaemon, useNow } from "./useDaemon.ts"

/** The browser's own fetch, called through so it keeps `window` as `this`. */
const browserFetch: typeof fetch = (input, init) => window.fetch(input, init)

/**
 * The dashboard: a sidebar app shell around the Accounts page, reading the
 * daemon API of the daemon that serves it. `fetch`, `pollInterval`, `requestTimeout` and
 * `loginPollInterval` exist for tests.
 */
export function App(props: {
  fetch?: typeof fetch
  pollInterval?: number
  requestTimeout?: number
  loginPollInterval?: number
}) {
  return (
    <NoticeProvider>
      <Dashboard {...props} />
    </NoticeProvider>
  )
}

function Dashboard(props: {
  fetch?: typeof fetch
  pollInterval?: number
  requestTimeout?: number
  loginPollInterval?: number
}) {
  const fetchImpl = props.fetch ?? browserFetch
  const client = useMemo(() => createDaemonClient(fetchImpl), [fetchImpl])
  const view = useDaemon(client, props.pollInterval ?? 3000, props.requestTimeout ?? 5000)
  const actions = useAccountActions(view, client)
  // A cooldown's countdown ticks each second; otherwise times move by the minute.
  const cooling = view.accounts?.accounts.some((account) => account.status === "cooling-down")
  const now = useNow(cooling === true ? 1000 : 15_000)
  const [connecting, setConnecting] = useState(false)
  const [openId, setOpenId] = useState<string | undefined>()
  const [removing, setRemoving] = useState<Account | undefined>()
  const [signingIn, setSigningIn] = useState<SignInRequest | undefined>()
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
    signIn: setSigningIn,
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
              <div className="pagehead-text">
                <h1 id="page-title" tabIndex={-1}>
                  Accounts
                </h1>
                <p>
                  Each client spends only its own provider's accounts. Within a pool, the
                  highest-priority account that is Active gets new sessions.
                </p>
              </div>
              {list !== undefined && list.accounts.length > 0 && (
                <button
                  type="button"
                  className="btn is-primary"
                  disabled={!reachable}
                  onClick={() => setSigningIn({ kind: "add" })}
                >
                  <IconPlus size={14} />
                  Add account
                </button>
              )}
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
          covered={removing !== undefined || connecting || signingIn !== undefined}
          onClose={() => setOpenId(undefined)}
        />

        <RemoveAccountDialog
          account={removing}
          list={list}
          remove={actions.remove}
          onClose={() => setRemoving(undefined)}
        />

        <SignInDialog
          request={signingIn}
          client={client}
          pollInterval={props.loginPollInterval ?? 1000}
          onSignedIn={view.refresh}
          rename={actions.rename}
          onClose={() => setSigningIn(undefined)}
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
