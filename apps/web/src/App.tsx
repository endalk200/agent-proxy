import { Tooltip } from "@base-ui/react/tooltip"
import { useMemo, useState } from "react"

import "./styles.css"
import { AccountsPage } from "./AccountsPage.tsx"
import { ConnectClientsDialog } from "./ConnectClients.tsx"
import { createDaemonClient } from "./daemon-api.ts"
import { hostOf } from "./model.ts"
import { Sidebar } from "./Sidebar.tsx"
import { IconPower } from "./ui.tsx"
import { useDaemon, useNow } from "./useDaemon.ts"

/** The browser's own fetch, called through so it keeps `window` as `this`. */
const browserFetch: typeof fetch = (input, init) => window.fetch(input, init)

/**
 * The dashboard: a sidebar app shell around the Accounts page, reading the
 * daemon API of the daemon that serves it. `fetch` and `pollInterval` exist
 * for tests.
 */
export function App(props: { fetch?: typeof fetch; pollInterval?: number }) {
  const fetchImpl = props.fetch ?? browserFetch
  const client = useMemo(() => createDaemonClient(fetchImpl), [fetchImpl])
  const view = useDaemon(client, props.pollInterval ?? 3000)
  const now = useNow(15_000)
  const [connecting, setConnecting] = useState(false)

  const address = view.info?.address ?? window.location.origin
  const reachable = view.failure === undefined
  const failure = view.failure

  return (
    <Tooltip.Provider delay={400}>
      <div className="app">
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
              <h1>Accounts</h1>
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
                  readOnly={!reachable}
                />
              </div>
            )}
          </div>
        </main>

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
