import { Check, ChevronsUpDown, Copy, LayoutDashboard, Laptop, Link, Users } from "lucide-react"
import { type MouseEvent, useRef } from "react"

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

import type { AccountList, DaemonInfo } from "./daemon-api.ts"
import { clockText, countdown, hostOf, poolState, providerNames, uptimeText } from "./model.ts"
import { type Page, pageLink } from "./route.ts"
import { copyText, ProviderMark, useFlag } from "./ui.tsx"

/** The page names, as the sidebar and the top bar show them. */
export const pageNames: Readonly<Record<Page, string>> = {
  dashboard: "Dashboard",
  accounts: "Accounts",
}

/**
 * The app shell's sidebar: the brand, the pages (Dashboard and Accounts),
 * the pool strip, then Connect clients and the daemon this page talks to.
 * It collapses to icons, and becomes a drawer on narrow screens.
 */
export function Sidebar(props: {
  list: AccountList | undefined
  info: DaemonInfo | undefined
  address: string
  reachable: boolean
  now: number
  page: Page
  onConnectClients: () => void
}) {
  const { list } = props
  const { isMobile, setOpenMobile } = useSidebar()
  // Set when a link in the mobile drawer moves to another page, so the
  // drawer hands focus to that page's title as it closes, not to its toggle.
  const navigated = useRef(false)
  const link = (page: Page) => {
    const target = pageLink(page)
    return {
      ...target,
      "aria-current": props.page === page ? ("page" as const) : undefined,
      onClick: (event: MouseEvent) => {
        target.onClick(event)
        // A modified click opens the page elsewhere and leaves the drawer be.
        if (!event.defaultPrevented || !isMobile) return
        navigated.current = true
        setOpenMobile(false)
      },
    }
  }
  const mobileFinalFocus = () => {
    if (!navigated.current) return true
    navigated.current = false
    return document.getElementById("page-title") ?? true
  }
  const needSignIn = list?.accounts.filter((a) => a.status === "needs-sign-in").length ?? 0
  return (
    <SidebarRoot collapsible="icon" mobileFinalFocus={mobileFinalFocus}>
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-3 group-data-[collapsible=icon]:px-1">
        <Brand />
      </SidebarHeader>

      <SidebarContent className="py-2">
        <nav aria-label="Dashboard" className="flex flex-col">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={props.page === "dashboard"}
                    tooltip="Dashboard"
                    className="h-9"
                    render={<a {...link("dashboard")} />}
                  >
                    <LayoutDashboard aria-hidden="true" />
                    <span>Dashboard</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={props.page === "accounts"}
                    tooltip="Accounts"
                    className="h-9"
                    render={<a {...link("accounts")} />}
                  >
                    <Users aria-hidden="true" />
                    <span>Accounts</span>
                    {needSignIn > 0 ? (
                      <span className="ml-auto flex h-5 min-w-5 items-center justify-center bg-danger px-1.5 text-xs font-semibold text-primary-foreground tabular-nums group-data-[collapsible=icon]:sr-only">
                        {needSignIn}
                        <span className="sr-only">
                          {needSignIn === 1 ? " needs" : " need"} sign-in
                        </span>
                      </span>
                    ) : (
                      list !== undefined &&
                      list.accounts.length > 0 && (
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums group-data-[active]/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:sr-only">
                          {list.accounts.length}
                        </span>
                      )
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {list !== undefined && list.pools.length > 0 && (
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupLabel render={<h2 id="side-pools">Pools</h2>} />
              <SidebarGroupContent>
                <ul aria-labelledby="side-pools" className="flex flex-col gap-0.5">
                  {list.pools.map((pool) => (
                    <PoolLine key={pool.provider} list={list} pool={pool} now={props.now} />
                  ))}
                </ul>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </nav>
      </SidebarContent>

      <SidebarFooter className="gap-1 border-t border-sidebar-border p-2">
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Connect clients"
              className="h-9"
              onClick={() => {
                // On a phone the drawer gives way to the dialog rather than sitting under it.
                if (isMobile) setOpenMobile(false)
                props.onConnectClients()
              }}
            >
              <Link aria-hidden="true" />
              <span>Connect clients</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DaemonSwitcher
              info={props.info}
              address={props.address}
              reachable={props.reachable}
              now={props.now}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </SidebarRoot>
  )
}

/** The product's mark and name. */
function Brand() {
  return (
    <div className="flex items-center gap-2.5 overflow-hidden group-data-[collapsible=icon]:justify-center">
      <img src="/agent-proxy.svg" alt="" width={32} height={32} className="shrink-0" />
      <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:sr-only">
        <span className="truncate text-sm font-semibold tracking-wide">agent-proxy</span>
        <span className="truncate text-xs text-muted-foreground">Subscriptions, one endpoint</span>
      </span>
    </div>
  )
}

/** One pool in the strip: who gets its new sessions, or why no one does. */
function PoolLine(props: { list: AccountList; pool: AccountList["pools"][number]; now: number }) {
  const { list, pool, now } = props
  const state = poolState(list, pool)
  const name = providerNames[pool.provider]
  const nextReset = state.kind === "blocked" ? state.nextReset : null
  const text =
    state.kind === "serving"
      ? state.account.label
      : nextReset !== null
        ? `Back ${countdown(nextReset, now)}`
        : state.kind === "blocked"
          ? "Unavailable"
          : "Off"
  const spoken =
    state.kind === "serving"
      ? `${name}: new sessions go to ${state.account.label}`
      : nextReset !== null
        ? `${name}: no account can take new sessions until ${clockText(nextReset, now)}`
        : state.kind === "blocked"
          ? `${name}: no account can take new sessions`
          : `${name}: every account is disabled`
  return (
    <li
      aria-label={spoken}
      data-state={state.kind}
      className="flex h-9 items-center gap-2.5 px-2 text-sm"
    >
      <ProviderMark provider={pool.provider} size={14} />
      <span className="font-medium text-sidebar-foreground/90">{name}</span>
      <span
        className={cn(
          "ml-auto flex max-w-32 items-center gap-1.5 truncate text-xs",
          state.kind === "serving" && "text-muted-foreground",
          state.kind === "off" && "text-muted-foreground/70",
          state.kind === "blocked" && "font-medium text-warning tabular-nums",
        )}
      >
        {state.kind === "serving" && (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
        )}
        <span className="truncate">{text}</span>
      </span>
    </li>
  )
}

/** "This Mac · address": the daemon this dashboard talks to, where remote daemons will join it. */
function DaemonSwitcher(props: {
  info: DaemonInfo | undefined
  address: string
  reachable: boolean
  now: number
}) {
  const [copied, flash] = useFlag()
  const host = hostOf(props.address)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-foreground/10" />
        }
      >
        <span
          aria-hidden="true"
          className="relative grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border bg-sidebar-foreground/5"
        >
          <Laptop className="size-4" />
          <span
            className={cn(
              "absolute -right-1 -bottom-1 size-2.5 rounded-full border-2 border-sidebar",
              props.reachable ? "bg-success" : "bg-danger",
            )}
          />
        </span>
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-sm font-medium">This Mac</span>
          <span
            className={cn(
              "truncate text-xs",
              props.reachable ? "font-mono text-muted-foreground" : "font-medium text-danger",
            )}
          >
            {props.reachable ? host : "Unreachable"}
          </span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={10} className="w-72 gap-0 p-0">
        <PopoverTitle className="flex items-center gap-2 px-4 pt-4 pb-3 text-sm font-medium">
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", props.reachable ? "bg-success" : "bg-danger")}
          />
          {props.reachable ? "Running" : "Can't reach the daemon"}
        </PopoverTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 px-4 pb-4 text-sm">
          <dt className="text-muted-foreground">Address</dt>
          <dd className="truncate text-right">
            <code className="text-xs">{host}</code>
          </dd>
          {props.info !== undefined && (
            <>
              <dt className="text-muted-foreground">Version</dt>
              <dd className="truncate text-right tabular-nums">
                v{props.info.version}
                {props.info.build !== undefined && ` (${props.info.build})`}
              </dd>
            </>
          )}
          {props.info !== undefined && props.reachable && (
            <>
              <dt className="text-muted-foreground">Uptime</dt>
              <dd className="text-right tabular-nums">
                {uptimeText(props.info.startedAt, props.now)}
              </dd>
            </>
          )}
        </dl>
        <Separator />
        <div className="p-1.5">
          <button
            type="button"
            className="flex h-9 w-full items-center gap-2 px-2.5 text-sm outline-none hover:bg-foreground/10 focus-visible:bg-foreground/10"
            onClick={() => {
              void copyText(props.address).then((ok) => ok && flash())
            }}
          >
            {copied ? (
              <Check aria-hidden="true" className="size-4 text-success" />
            ) : (
              <Copy aria-hidden="true" className="size-4 text-muted-foreground" />
            )}
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
