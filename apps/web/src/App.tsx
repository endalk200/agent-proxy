import { Plus, RefreshCw, Unplug } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { PageContent, PageHeader } from "@/components/page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import "./styles.css"
import { AccountSheet } from "./AccountSheet.tsx"
import { type AccountControls, AccountsPage } from "./AccountsPage.tsx"
import { ConnectClientsDialog } from "./ConnectClients.tsx"
import { type Account, createDaemonClient, type OpenEventStream } from "./daemon-api.ts"
import { DashboardPage } from "./DashboardPage.tsx"
import { useLiveUpdates } from "./LiveUpdates.ts"
import { accountsOf, hostOf, labelsText, place, priorityCount } from "./model.ts"
import { NoticeProvider } from "./Notices.tsx"
import { RemoveAccountDialog } from "./RemoveAccount.tsx"
import { usePage } from "./route.ts"
import { pageNames, Sidebar } from "./Sidebar.tsx"
import { type SignInRequest, SignInDialog } from "./SignIn.tsx"
import { Spinner } from "./ui.tsx"
import {
  DEFAULT_THROTTLE,
  isRefreshing,
  UsageProvider,
  type UsageThrottle,
  useUsageFeed,
} from "./usage.tsx"
import { useAccountActions } from "./useAccountActions.ts"
import { useDaemon, useNow } from "./useDaemon.ts"

/** Whether the sidebar starts expanded: as the owner last left it, kept in a cookie by the sidebar. */
const sidebarOpenAtStart = () => !document.cookie.split("; ").includes("sidebar_state=false")

/** The browser's own fetch, called through so it keeps `window` as `this`. */
const browserFetch: typeof fetch = (input, init) => window.fetch(input, init)

interface DashboardProps {
  fetch?: typeof fetch
  openEvents?: OpenEventStream
  checkInterval?: number
  requestTimeout?: number
  reopenDelay?: number
  loginPollInterval?: number
  usageThrottle?: UsageThrottle
}

/**
 * The dashboard: a sidebar app shell around the Dashboard and Accounts
 * pages, following the daemon API of the daemon that serves it. Every prop
 * exists for tests.
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
  const mutationTimeout = (props.requestTimeout ?? 5000) * 2
  const client = useMemo(
    () => createDaemonClient(fetchImpl, openEvents, mutationTimeout),
    [fetchImpl, openEvents, mutationTimeout],
  )
  const [signingIn, setSigningIn] = useState<SignInRequest | undefined>()
  const live = useLiveUpdates(signingIn !== undefined)
  const { usage, onUsage } = useUsageFeed(client, props.usageThrottle ?? DEFAULT_THROTTLE)
  const view = useDaemon(
    client,
    {
      // The stream brings every change; the check only notices a daemon gone silent.
      checkInterval: props.checkInterval ?? 15_000,
      requestTimeout: props.requestTimeout ?? 5000,
      reopenDelay: props.reopenDelay ?? 3000,
    },
    live.onEvent,
    onUsage,
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
  const page = usePage()
  const firstRun = list !== undefined && list.accounts.length === 0
  const refreshingAll = isRefreshing(usage, "*")

  // Moving to another page puts focus on its title, as a page load would.
  const shownPage = useRef(page)
  useEffect(() => {
    if (shownPage.current === page) return
    shownPage.current = page
    document.getElementById("page-title")?.focus()
  }, [page])

  const controls: AccountControls = {
    readOnly: !reachable,
    openId,
    open: (account) => setOpenId(account.id),
    setEnabled: actions.setEnabled,
    rename: actions.rename,
    move: (account, placement) => {
      actions.move(account, placement)
      if (list === undefined) return
      const pool = place(accountsOf(list, account.provider), account.id, placement)
      const moved = pool?.find((other) => other.id === account.id)
      if (pool === undefined || moved === undefined) return
      const sharing = pool.filter(
        (other) => other.priority === moved.priority && other.id !== account.id,
      )
      const count = priorityCount({ ...list, accounts: pool }, account.provider)
      setAnnouncement(
        sharing.length === 0
          ? `${account.label} moved to priority ${moved.priority} of ${count}.`
          : `${account.label} now shares priority ${moved.priority} with ${labelsText(sharing)}.`,
      )
    },
    askRemove: setRemoving,
    flashes: live.flashes,
    signIn: setSigningIn,
  }

  const title = firstRun && page === "dashboard" ? "Get started" : pageNames[page]

  return (
    <UsageProvider usage={usage}>
      <TooltipProvider delay={400}>
        <SidebarProvider
          defaultOpen={sidebarOpenAtStart()}
          data-sheet-open={sheetOpen ? "" : undefined}
          className="[--sheet-w:30rem]"
        >
          <Sidebar
            list={view.accounts}
            info={view.info}
            address={address}
            reachable={reachable}
            now={now}
            page={page}
            onConnectClients={() => setConnecting(true)}
          />

          <SidebarInset
            className={cn(
              "min-w-0 transition-[padding] duration-200 ease-out",
              sheetOpen && "xl:pr-(--sheet-w)",
            )}
          >
            <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur supports-backdrop-filter:bg-background/75 lg:px-6">
              <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground" />
              <Separator
                orientation="vertical"
                className="data-vertical:h-5 data-vertical:self-center"
              />
              <span className="truncate text-sm font-medium">{title}</span>
            </header>

            <div className="mx-auto flex w-full max-w-[110rem] flex-col gap-8 px-6 py-8 lg:px-10 lg:py-10">
              {failure !== undefined && (
                <output className="block">
                  <Alert role={undefined} className="border-danger/50 bg-danger/10">
                    <Unplug aria-hidden="true" className="text-danger" />
                    {failure.kind === "unreachable" ? (
                      <>
                        <AlertTitle className="font-semibold">
                          Can't reach the daemon at {hostOf(address)}.{" "}
                        </AlertTitle>
                        <AlertDescription className="text-foreground/80">
                          <p>
                            Run <code className="text-foreground">agent-proxy daemon status</code>{" "}
                            to see why, or{" "}
                            <code className="text-foreground">agent-proxy daemon start</code> to
                            start it.
                            {view.accounts !== undefined &&
                              " This is what it last reported; it updates when the daemon answers again."}
                          </p>
                        </AlertDescription>
                      </>
                    ) : (
                      <>
                        <AlertTitle className="font-semibold">
                          The daemon answered with an error.{" "}
                        </AlertTitle>
                        <AlertDescription className="text-foreground/80">
                          <p>
                            {failure.message}
                            {view.accounts !== undefined &&
                              " This is what it last reported; it updates when the daemon answers again."}
                          </p>
                        </AlertDescription>
                      </>
                    )}
                  </Alert>
                </output>
              )}

              {page === "dashboard" && !firstRun ? (
                <DashboardPage
                  list={list}
                  reachable={reachable}
                  openId={openId}
                  openAccount={(account) => setOpenId(account.id)}
                />
              ) : (
                <>
                  <PageHeader
                    title={title}
                    description={
                      firstRun && page === "dashboard"
                        ? "Add an account and connect a client, and this page shows what goes through the proxy."
                        : "Each client spends only its own provider's accounts. Within a pool, the highest-priority account that is Active gets new sessions; accounts sharing a priority take turns, by the room left in their limits."
                    }
                    {...(list !== undefined && list.accounts.length > 0
                      ? {
                          actions: (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={!reachable || refreshingAll}
                                onClick={() => usage.refresh()}
                              >
                                {refreshingAll ? (
                                  <Spinner size={14} />
                                ) : (
                                  <RefreshCw aria-hidden="true" />
                                )}
                                Refresh limits
                              </Button>
                              <Button
                                type="button"
                                disabled={!reachable}
                                onClick={() => setSigningIn({ kind: "add" })}
                              >
                                <Plus aria-hidden="true" />
                                Add account
                              </Button>
                            </>
                          ),
                        }
                      : {})}
                  />

                  {view.accounts !== undefined && (
                    <PageContent stale={!reachable}>
                      <AccountsPage
                        list={view.accounts}
                        now={now}
                        address={hostOf(address)}
                        client={client}
                        controls={controls}
                      />
                    </PageContent>
                  )}
                </>
              )}
            </div>
          </SidebarInset>

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
            requestTimeout={props.requestTimeout ?? 5000}
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
        </SidebarProvider>
      </TooltipProvider>
    </UsageProvider>
  )
}
