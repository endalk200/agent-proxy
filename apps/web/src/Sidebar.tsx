import { Menu } from "@base-ui/react/menu"
import { Popover } from "@base-ui/react/popover"
import type { ReactElement } from "react"

import type { AccountList, DaemonInfo } from "./daemon-api.ts"
import { clockText, countdown, hostOf, poolState, providerNames, uptimeText } from "./model.ts"
import { type ThemeChoice, useTheme } from "./theme.ts"
import {
  copyText,
  IconCheck,
  IconCopy,
  IconLaptop,
  IconLink,
  IconMonitor,
  IconMoon,
  IconSelector,
  IconSun,
  IconUsers,
  ProviderMark,
  useFlag,
} from "./ui.tsx"

/**
 * The app shell's sidebar: the daemon switcher, the pages (only Accounts is
 * built), the pool strip, Connect clients, and the theme.
 */
export function Sidebar(props: {
  list: AccountList | undefined
  info: DaemonInfo | undefined
  address: string
  reachable: boolean
  now: number
  onConnectClients: () => void
}) {
  const { list } = props
  const needSignIn = list?.accounts.filter((a) => a.status === "needs-sign-in").length ?? 0
  return (
    <nav className="side" aria-label="Dashboard">
      <DaemonSwitcher
        info={props.info}
        address={props.address}
        reachable={props.reachable}
        now={props.now}
      />

      <ul className="nav">
        <li>
          <a className="nav-item is-on" href="/" aria-current="page">
            <span className="nav-icon">
              <IconUsers size={15} />
            </span>
            <span className="nav-label">Accounts</span>
            {needSignIn > 0 ? (
              <span className="nav-badge">
                {needSignIn}
                <span className="sr-only">{needSignIn === 1 ? " needs" : " need"} sign-in</span>
              </span>
            ) : (
              list !== undefined &&
              list.accounts.length > 0 && <span className="nav-count">{list.accounts.length}</span>
            )}
          </a>
        </li>
      </ul>

      {list !== undefined && list.pools.length > 0 && (
        <div className="side-pools">
          <h2 className="side-heading" id="side-pools">
            Pools
          </h2>
          <ul aria-labelledby="side-pools">
            {list.pools.map((pool) => {
              const state = poolState(list, pool)
              const name = providerNames[pool.provider]
              const nextReset = state.kind === "blocked" ? state.nextReset : null
              const text =
                state.kind === "serving"
                  ? state.account.label
                  : nextReset !== null
                    ? `Back ${countdown(nextReset, props.now)}`
                    : state.kind === "blocked"
                      ? "Unavailable"
                      : "Off"
              const spoken =
                state.kind === "serving"
                  ? `${name}: new sessions go to ${state.account.label}`
                  : nextReset !== null
                    ? `${name}: no account can take new sessions until ${clockText(nextReset, props.now)}`
                    : state.kind === "blocked"
                      ? `${name}: no account can take new sessions`
                      : `${name}: every account is disabled`
              return (
                <li
                  key={pool.provider}
                  className={`side-pool is-${state.kind}`}
                  aria-label={spoken}
                >
                  <ProviderMark provider={pool.provider} size={13} />
                  <span className="side-pool-name">{name}</span>
                  <span className="side-pool-state">{text}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="side-foot">
        <button type="button" className="nav-item" onClick={props.onConnectClients}>
          <span className="nav-icon">
            <IconLink size={15} />
          </span>
          <span className="nav-label">Connect clients</span>
        </button>
        <ThemeMenu />
      </div>
    </nav>
  )
}

const themes: Record<
  ThemeChoice,
  { readonly name: string; readonly icon: (size: number) => ReactElement }
> = {
  system: { name: "System", icon: (size) => <IconMonitor size={size} /> },
  light: { name: "Light", icon: (size) => <IconSun size={size} /> },
  dark: { name: "Dark", icon: (size) => <IconMoon size={size} /> },
}
const themeOrder: ReadonlyArray<ThemeChoice> = ["system", "light", "dark"]

/** The theme menu: System, Light or Dark, kept by this browser. */
function ThemeMenu() {
  const [choice, choose] = useTheme()
  const current = themes[choice]
  return (
    <Menu.Root>
      <Menu.Trigger className="nav-item" aria-label={`Theme: ${current.name}`}>
        <span className="nav-icon">{current.icon(15)}</span>
        <span className="nav-label">Theme</span>
        <span className="nav-hint" aria-hidden="true">
          {current.name}
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="layer" side="top" align="start" sideOffset={6}>
          <Menu.Popup className="menu">
            <Menu.RadioGroup
              value={choice}
              onValueChange={(next: ThemeChoice) => choose(next)}
              aria-label="Theme"
            >
              {themeOrder.map((option) => (
                <Menu.RadioItem key={option} value={option} className="menu-item" closeOnClick>
                  <span className="menu-icon">{themes[option].icon(14)}</span>
                  {themes[option].name}
                  <Menu.RadioItemIndicator className="menu-check">
                    <IconCheck size={14} />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
    <Popover.Root>
      <Popover.Trigger className={`daemon ${props.reachable ? "is-up" : "is-down"}`}>
        <span className="daemon-icon" aria-hidden="true">
          <IconLaptop size={15} />
          <span className="daemon-dot" />
        </span>
        <span className="daemon-text">
          <span className="daemon-name">This Mac</span>
          <span className="daemon-addr">{props.reachable ? host : "Unreachable"}</span>
        </span>
        <IconSelector size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="layer" sideOffset={6} align="start">
          <Popover.Popup className="popover daemon-pop">
            <Popover.Title className="daemon-pop-status">
              <span className={`daemon-pop-dot ${props.reachable ? "is-up" : "is-down"}`} />
              {props.reachable ? "Running" : "Can't reach the daemon"}
            </Popover.Title>
            <dl className="daemon-pop-facts">
              <div>
                <dt>Address</dt>
                <dd>
                  <code>{host}</code>
                </dd>
              </div>
              {props.info !== undefined && (
                <div>
                  <dt>Version</dt>
                  <dd>
                    v{props.info.version}
                    {props.info.build !== undefined && ` (${props.info.build})`}
                  </dd>
                </div>
              )}
              {props.info !== undefined && props.reachable && (
                <div>
                  <dt>Uptime</dt>
                  <dd>{uptimeText(props.info.startedAt, props.now)}</dd>
                </div>
              )}
            </dl>
            <div className="popover-sep" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                void copyText(props.address).then((ok) => ok && flash())
              }}
            >
              <span className="menu-icon">
                {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              </span>
              {copied ? "Copied" : "Copy address"}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
