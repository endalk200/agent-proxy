import { Menu } from "@base-ui/react/menu"
import { Switch } from "@base-ui/react/switch"

import { CommandLine, ProxyKeyRow } from "./ConnectClients.tsx"
import type { Account, AccountList, DaemonClient, Pool, Provider } from "./daemon-api.ts"
import {
  accountsOf,
  clients,
  lastUsedText,
  planWeight,
  type PoolState,
  poolState,
  providerNames,
  statusLabels,
} from "./model.ts"
import {
  IconAlert,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconMore,
  IconPencil,
  IconTrash,
  ProviderMark,
  Tip,
} from "./ui.tsx"

/** Which clients spend a provider's pool, as "Claude Code and opencode". */
const clientsOf = (provider: Provider) =>
  clients
    .filter((client) => client.providers.includes(provider))
    .map((client) => client.name)
    .join(" and ")

/** The accounts page body: one table per pool, or the first-run guide. */
export function AccountsPage(props: {
  list: AccountList
  now: number
  address: string
  client: DaemonClient
  readOnly: boolean
}) {
  const { list } = props
  if (list.accounts.length === 0) {
    return <FirstRun address={props.address} client={props.client} />
  }
  return (
    <div className="sections">
      {list.pools.map((pool) => (
        <PoolSection
          key={pool.provider}
          list={list}
          pool={pool}
          now={props.now}
          readOnly={props.readOnly}
        />
      ))}
    </div>
  )
}

function PoolLine({ state, provider }: { state: PoolState; provider: Provider }) {
  switch (state.kind) {
    case "serving":
      return (
        <p className="pool-line is-ok">
          <span className="pool-dot" aria-hidden="true" />
          New sessions go to <b>{state.account.label}</b>
        </p>
      )
    case "blocked":
      return (
        <p className="pool-line is-warn">
          <IconAlert size={13} />
          No account can take new sessions
        </p>
      )
    case "off":
      return (
        <p className="pool-line is-muted">Every {providerNames[provider]} account is disabled</p>
      )
  }
}

function PoolSection(props: { list: AccountList; pool: Pool; now: number; readOnly: boolean }) {
  const { provider } = props.pool
  const name = providerNames[provider]
  const accounts = accountsOf(props.list, provider)
  const state = poolState(props.list, props.pool)
  const servingId = state.kind === "serving" ? state.account.id : undefined
  const headingId = `pool-${provider}`
  return (
    <section className="section" aria-labelledby={headingId}>
      <header className="section-head">
        <div className="section-title">
          <ProviderMark provider={provider} size={16} />
          <h2 id={headingId}>{name}</h2>
          <span className="count">
            {accounts.length}
            <span className="sr-only"> {accounts.length === 1 ? "account" : "accounts"}</span>
          </span>
        </div>
        <PoolLine state={state} provider={provider} />
      </header>

      {state.kind === "blocked" && (
        <div className="callout is-warn">
          <IconAlert size={15} />
          <span>
            Every enabled {name} account needs sign-in, so {clientsOf(provider)} get an error until
            you sign one in again.
          </span>
        </div>
      )}

      <div className="table-wrap">
        <table className="accounts" aria-label={`${name} accounts`}>
          <thead>
            <tr>
              <th scope="col" aria-label="Priority" className="col-prio">
                #
              </th>
              <th scope="col">Account</th>
              <th scope="col" className="col-plan">
                Plan
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="col-used">
                Last used
              </th>
              <th scope="col" className="col-enabled">
                Enabled
              </th>
              <th scope="col" aria-label="Actions" className="col-menu" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                serving={account.id === servingId}
                now={props.now}
                readOnly={props.readOnly}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AccountRow(props: { account: Account; serving: boolean; now: number; readOnly: boolean }) {
  const { account } = props
  return (
    <tr className={`row is-${account.status} ${props.serving ? "is-serving" : ""}`}>
      <td className="col-prio">
        <span className="prio">{account.priority}</span>
      </td>
      <td className="col-who">
        <span className="who-name">{account.label}</span>
        {props.serving && (
          <>
            {" "}
            <span className="serving">New sessions</span>
          </>
        )}
        <span className="who-email">{account.email}</span>
      </td>
      <td className="col-plan">
        <span className="plan" data-weight={planWeight(account.provider, account.plan)}>
          {account.plan}
        </span>
      </td>
      <td>
        <span className="status">
          <span className="sdot" aria-hidden="true" />
          {statusLabels[account.status]}
        </span>
      </td>
      <td className="col-used">
        <span className="used">{lastUsedText(account.lastUsedAt, props.now)}</span>
      </td>
      <td className="col-enabled">
        <Switch.Root
          className="switch"
          checked={account.enabled}
          readOnly
          aria-label={`${account.label} enabled`}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </td>
      <td className="col-menu">
        <RowMenu account={account} disabled={props.readOnly} />
      </td>
    </tr>
  )
}

/** The row's ⋯ menu. Its actions arrive with account management in the dashboard. */
function RowMenu({ account, disabled }: { account: Account; disabled: boolean }) {
  const items = [
    { label: "Open details", icon: <IconChevronRight size={14} /> },
    { label: "Rename", icon: <IconPencil size={14} /> },
    { label: "Move up", icon: <IconChevronUp size={14} />, separatorBefore: true },
    { label: "Move down", icon: <IconChevronDown size={14} /> },
    { label: "Remove…", icon: <IconTrash size={14} />, separatorBefore: true, danger: true },
  ]
  return (
    <Menu.Root>
      <Tip label="Actions">
        <Menu.Trigger
          className="iconbtn"
          aria-label={`Actions for ${account.label}`}
          disabled={disabled}
        >
          <IconMore size={16} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        <Menu.Positioner className="layer" sideOffset={4} align="end">
          <Menu.Popup className="menu">
            {items.map((item) => (
              <div key={item.label} className="menu-group">
                {item.separatorBefore === true && <Menu.Separator className="menu-sep" />}
                <Menu.Item
                  className={`menu-item ${item.danger === true ? "is-danger" : ""}`}
                  disabled
                >
                  <span className="menu-icon">{item.icon}</span>
                  {item.label}
                </Menu.Item>
              </div>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** The guided empty state, shown while the daemon holds no accounts. */
function FirstRun({ address, client }: { address: string; client: DaemonClient }) {
  return (
    <ol className="steps" aria-label="Get started">
      <li className="is-current">
        <span className="step-num" aria-hidden="true">
          1
        </span>
        <div className="step-body">
          <h2>Add an account</h2>
          <p>
            The daemon at <code>{address}</code> has no accounts yet. Run this, and sign in to
            Claude in the browser tab it opens.
          </p>
          <div className="step-cmds">
            <CommandLine command="agent-proxy accounts add claude" />
          </div>
        </div>
      </li>
      <li>
        <span className="step-num" aria-hidden="true">
          2
        </span>
        <div className="step-body">
          <h2>Connect your clients</h2>
          <p>
            Run one command per client. It points the client at this proxy and has it fetch the
            proxy key.
          </p>
          <div className="step-cmds">
            {clients.map((connectable) => (
              <div key={connectable.command} className="step-cmd">
                <span className="step-cmd-name">{connectable.name}</span>
                <CommandLine command={connectable.command} />
              </div>
            ))}
          </div>
          <div className="step-key">
            <ProxyKeyRow client={client} />
          </div>
        </div>
      </li>
      <li>
        <span className="step-num" aria-hidden="true">
          3
        </span>
        <div className="step-body">
          <h2>Add a fallback</h2>
          <p>
            Add a second account to a pool. When the first hits its limit, new sessions move to the
            next one by priority.
          </p>
        </div>
      </li>
    </ol>
  )
}
