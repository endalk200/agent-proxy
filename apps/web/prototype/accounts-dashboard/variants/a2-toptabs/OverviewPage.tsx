// PROTOTYPE round 2 variant A2: Overview, the home page. Today: daemon, pools, what needs you, recent activity,
// connect commands. Later it grows usage summaries (the dashed "Usage" strip marks where).

import type { ReactNode } from "react"

import { IconAlert, IconArrowRight, IconCheck, IconClock, IconLogIn, IconPlus, IconPower, ProviderMark } from "../../shared/icons.tsx"
import {
  CLIENTS,
  PROVIDERS,
  type Provider,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  poolState,
  providerName,
  statusOf,
} from "../../shared/model.ts"
import type { DashboardState } from "../../shared/store.ts"
import { CommandLine, ProxyKeyRow } from "../a-console/ConnectClients.tsx"
import { PAGES } from "../kit/future.tsx"
import { clientsFor } from "./AccountsPage.tsx"
import { StatusPill, eventTitle, eventTone, uptime } from "./bits.tsx"

interface Attention {
  key: string
  tone: "red" | "amber"
  icon: ReactNode
  title: string
  body: string
  action?: { label: string; run: () => void }
}

export function OverviewPage(props: {
  s: DashboardState
  now: number
  onOpen: (id: string) => void
  onReauth: (id: string) => void
  onAdd: (p: Provider | undefined) => void
  onAccounts: () => void
}) {
  const { s, now } = props
  const running = s.daemon.running

  const attention: Attention[] = []
  if (!running)
    attention.push({
      key: "daemon",
      tone: "red",
      icon: <IconPower size={15} />,
      title: `Can't reach the daemon at ${s.daemon.address}`,
      body: "Clients can't get new sessions until it's running again.",
    })
  for (const p of PROVIDERS) {
    const ps = poolState(s.accounts, p)
    if (ps.kind === "blocked")
      attention.push({
        key: `pool-${p}`,
        tone: "amber",
        icon: <IconClock size={15} />,
        title: ps.allCooling ? `Every ${providerName[p]} account is cooling down` : `No ${providerName[p]} account can take new sessions`,
        body:
          ps.nextReset !== null
            ? `New ${clientsFor(p)} sessions wait until ${formatClock(ps.nextReset)} (${countdown(ps.nextReset, now)}).`
            : "Sign in again to put an account back in the pool.",
      })
  }
  for (const a of s.accounts.filter((x) => x.enabled && x.health.kind === "signin"))
    attention.push({
      key: a.id,
      tone: "red",
      icon: <IconLogIn size={15} />,
      title: `${a.label} needs sign-in`,
      body: `Its ${providerName[a.provider]} login expired, so agent-proxy skips it.`,
      action: { label: "Sign in again", run: () => props.onReauth(a.id) },
    })

  const headline = !running
    ? "The daemon is unreachable."
    : s.accounts.length === 0
      ? "Add an account to get started."
      : attention.length === 0
        ? "Everything is working."
        : `${attention.length} ${attention.length === 1 ? "thing needs" : "things need"} you.`

  return (
    <>
      <div className="vA2-pagehead">
        <div>
          <h1>Overview</h1>
          <p>
            <span className={`vA2-headline ${attention.length > 0 || !running ? "is-warn" : "is-ok"}`}>{headline}</span>{" "}
            {PAGES.overview.blurb}
          </p>
        </div>
      </div>

      <div className="vA2-ov-grid">
        {PROVIDERS.map((p) => (
          <PoolCard key={p} s={s} now={now} provider={p} onOpen={props.onOpen} onAdd={() => props.onAdd(p)} />
        ))}
        <DaemonCard s={s} now={now} />
      </div>

      <div className="vA2-ov-cols">
        <section className="vA2-card">
          <div className="vA2-card-head">
            <h2>Needs attention</h2>
          </div>
          {attention.length === 0 ? (
            <div className="vA2-allgood">
              <span>
                <IconCheck size={14} />
              </span>
              Nothing needs you. Every pool has an account taking new sessions.
            </div>
          ) : (
            <ul className="vA2-attn">
              {attention.map((x) => (
                <li key={x.key} className={`is-${x.tone}`}>
                  <span className="vA2-attn-icon">{x.icon}</span>
                  <div>
                    <b>{x.title}</b>
                    <p>{x.body}</p>
                  </div>
                  {x.action !== undefined && (
                    <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={x.action.run}>
                      {x.action.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="vA2-card">
          <div className="vA2-card-head">
            <h2>Recent activity</h2>
          </div>
          {s.events.length === 0 ? (
            <div className="vA2-feed-empty">Quiet so far. Cooldowns, expired sign-ins and your changes show up here live.</div>
          ) : (
            <ol className="vA2-feed">
              {s.events.slice(0, 7).map((e) => (
                <li key={e.id} className={`is-${eventTone(e.kind)}`}>
                  <span className="vA2-feed-dot" />
                  <div>
                    <b>{eventTitle(e.kind)}</b> <span>{e.message}</span>
                  </div>
                  <time>{lastUsedText(e.at, now)}</time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="vA2-card vA2-ov-connect">
        <div className="vA2-card-head">
          <h2>Connect clients</h2>
          <p>Run one command per client. It points the client at this proxy and gives it the proxy key.</p>
        </div>
        <div className="vA2-ov-cmds">
          {CLIENTS.map((c) => (
            <div key={c.id}>
              <div className="vA2-ov-cmd-name">
                {c.name}
                <span>
                  {c.providers.map((p) => (
                    <ProviderMark key={p} provider={p} size={12} />
                  ))}
                </span>
              </div>
              <CommandLine command={c.command} />
            </div>
          ))}
        </div>
        <div className="vA2-ov-key">
          <ProxyKeyRow />
        </div>
      </section>

      <div className="vA2-ov-planned">
        <span className="vK-planned">Planned</span>
        Usage summaries land here: requests and tokens per pool, and how close each account is to its limit.
      </div>
    </>
  )
}

function PoolCard(props: {
  s: DashboardState
  now: number
  provider: Provider
  onOpen: (id: string) => void
  onAdd: () => void
}) {
  const { s, now, provider } = props
  const list = accountsOf(s.accounts, provider)
  const ps = poolState(s.accounts, provider)
  const count = (k: string) => list.filter((a) => statusOf(a).kind === k).length
  return (
    <section className={`vA2-card vA2-pool is-${ps.kind}`}>
      <header className="vA2-pool-head">
        <ProviderMark provider={provider} size={16} />
        <h2>{providerName[provider]} pool</h2>
        <span className="vA2-pool-n">
          {list.filter((a) => a.enabled).length} of {list.length} enabled
        </span>
      </header>
      <div className="vA2-pool-route">
        {ps.kind === "serving" && (
          <>
            <span className="vA2-pool-k">New sessions</span>
            <button type="button" className="vA2-pool-v" onClick={() => props.onOpen(ps.account.id)}>
              <IconArrowRight size={14} /> {ps.account.label}
            </button>
          </>
        )}
        {ps.kind === "blocked" && (
          <>
            <span className="vA2-pool-k is-warn">
              <IconAlert size={12} /> {ps.allCooling ? "All cooling down" : "No account available"}
            </span>
            <span className="vA2-pool-v is-warn">
              {ps.nextReset !== null ? `Next reset ${formatClock(ps.nextReset)}` : "Needs sign-in"}
              {ps.nextReset !== null && <small>{countdown(ps.nextReset, now)}</small>}
            </span>
          </>
        )}
        {ps.kind === "off" && (
          <>
            <span className="vA2-pool-k">New sessions</span>
            <span className="vA2-pool-v is-muted">Every account is disabled</span>
          </>
        )}
        {ps.kind === "empty" && (
          <>
            <span className="vA2-pool-k">No accounts</span>
            <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={props.onAdd}>
              <IconPlus size={13} /> Add {providerName[provider]} account
            </button>
          </>
        )}
      </div>
      {list.length > 0 && (
        <>
          <ol className="vA2-pool-list">
            {list.map((a) => (
              <li key={a.id}>
                <span className="vA2-order-n">{a.priority}</span>
                <button type="button" onClick={() => props.onOpen(a.id)}>
                  {a.label}
                </button>
                <StatusPill status={statusOf(a)} size="sm" />
              </li>
            ))}
          </ol>
          <footer className="vA2-pool-counts">
            <span className="is-active">{count("active")} active</span>
            <span className="is-cooling">{count("cooling")} cooling</span>
            <span className="is-signin">{count("signin")} sign-in</span>
            <span className="is-disabled">{count("disabled")} off</span>
          </footer>
        </>
      )}
    </section>
  )
}

function DaemonCard({ s, now }: { s: DashboardState; now: number }) {
  const up = s.daemon.running
  return (
    <section className={`vA2-card vA2-dcard ${up ? "is-up" : "is-down"}`}>
      <header className="vA2-pool-head">
        <span className="vA2-ddot" />
        <h2>Daemon</h2>
        <span className="vA2-pool-n">This Mac</span>
      </header>
      <div className="vA2-pool-route">
        <span className="vA2-pool-k">{up ? "Running" : "Unreachable"}</span>
        <span className="vA2-pool-v">
          <code>{s.daemon.address}</code>
        </span>
      </div>
      <dl className="vA2-dcard-props">
        <div>
          <dt>Uptime</dt>
          <dd>{up ? uptime(s.daemon.startedAt, now) : "—"}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>v{s.daemon.version}</dd>
        </div>
        <div>
          <dt>Accounts</dt>
          <dd>{s.accounts.length}</dd>
        </div>
      </dl>
      <footer className="vA2-dcard-foot">
        <span>Remote daemons</span>
        <span className="vK-planned">Planned</span>
      </footer>
    </section>
  )
}
