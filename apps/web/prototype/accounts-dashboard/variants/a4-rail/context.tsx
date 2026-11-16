// PROTOTYPE variant A4: the right-hand context column. Persistent panels instead of popovers:
// the selected account's inspector, the pools, Connect clients, and a live Activity feed (no toasts).

import { useState } from "react"

import {
  IconAlert,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
  IconLogIn,
  IconPencil,
  IconPower,
  IconTrash,
  IconX,
  ProviderMark,
} from "../../shared/icons.tsx"
import {
  type Account,
  CLIENTS,
  PROVIDERS,
  type Provider,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  planShort,
  planTier,
  poolState,
  providerName,
  statusLabel,
  statusOf,
} from "../../shared/model.ts"
import { type DashboardState, type LiveEvent, actions } from "../../shared/store.ts"
import { CommandLine, ProxyKeyRow } from "../a-console/ConnectClients.tsx"
import { Switch } from "../a-console/ui.tsx"
import { RenameInput } from "./accounts.tsx"
import { IconActivity, IconLayers } from "./icons.tsx"

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`

// -----------------------------------------------------------------------------------------------
// Inspector

export function Inspector(props: {
  account: Account
  accounts: ReadonlyArray<Account>
  now: number
  editing: boolean
  onEdit: (on: boolean) => void
  onClose: () => void
  onReauth: () => void
  onRemove: () => void
}) {
  const { account: a, now } = props
  const st = statusOf(a)
  const list = accountsOf(props.accounts, a.provider)
  const ps = poolState(props.accounts, a.provider)
  const serving = ps.kind === "serving" && ps.account.id === a.id
  return (
    <section className={`vA4-panel vA4-inspector is-${st.kind}`} aria-label={`${a.label} details`}>
      <header className="vA4-insp-head">
        <span className="vA4-insp-mark">
          <ProviderMark provider={a.provider} size={18} />
        </span>
        <div className="vA4-insp-titles">
          {props.editing ? (
            <RenameInput account={a} onDone={() => props.onEdit(false)} className="vA4-insp-rename" />
          ) : (
            <button type="button" className="vA4-insp-name" onClick={() => props.onEdit(true)} title="Rename">
              {a.label}
              <IconPencil size={12} />
            </button>
          )}
          <span className="vA4-insp-email">{a.email}</span>
        </div>
        <button type="button" className="vA-iconbtn" onClick={props.onClose} aria-label="Close details">
          <IconX size={15} />
        </button>
      </header>

      <div className={`vA4-insp-status is-${st.kind}`}>
        <span className="vA-sdot" />
        <div>
          <b>{statusLabel(st)}</b>
          <span>
            {st.kind === "active" &&
              (serving ? `Gets new ${providerName[a.provider]} sessions` : `Standing by in the ${providerName[a.provider]} pool`)}
            {st.kind === "cooling" && `Until ${formatClock(st.until)} · ${countdown(st.until, now)}`}
            {st.kind === "signin" && "Its login expired, so new sessions skip it"}
            {st.kind === "disabled" && "Turned off. It keeps its place in the priority order"}
          </span>
        </div>
        {st.kind === "signin" && (
          <button type="button" className="vA-btn vA-btn-xs vA-btn-red" onClick={props.onReauth}>
            <IconLogIn size={12} /> Sign in again
          </button>
        )}
      </div>

      <dl className="vA4-insp-fields">
        <div>
          <dt>Plan</dt>
          <dd>
            <span className="vA-plan" data-tier={planTier(a.plan)}>
              {planShort(a.plan)}
            </span>
            <span className="vA4-muted">{a.plan}</span>
          </dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>
            <span className="vA4-insp-prio">
              {ordinal(a.priority)} <span className="vA4-muted">of {list.length}</span>
            </span>
            <span className="vA4-stepper">
              <button
                type="button"
                className="vA-iconbtn"
                disabled={a.priority === 1}
                onClick={() => actions.move(a.id, -1)}
                aria-label="Move up"
                title="Move up"
              >
                <IconChevronUp size={14} />
              </button>
              <button
                type="button"
                className="vA-iconbtn"
                disabled={a.priority === list.length}
                onClick={() => actions.move(a.id, 1)}
                aria-label="Move down"
                title="Move down"
              >
                <IconChevronDown size={14} />
              </button>
            </span>
          </dd>
        </div>
        <div>
          <dt>Last used</dt>
          <dd>{lastUsedText(a.lastUsedAt, now)}</dd>
        </div>
        <div>
          <dt>Added</dt>
          <dd>{lastUsedText(a.addedAt, now)}</dd>
        </div>
        <div>
          <dt>Enabled</dt>
          <dd>
            <Switch
              checked={a.enabled}
              onChange={(v) => actions.setEnabled(a.id, v)}
              label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`}
            />
            <span className="vA4-muted">{a.enabled ? "In the pool" : "Out of the pool"}</span>
          </dd>
        </div>
      </dl>

      <footer className="vA4-insp-foot">
        <button type="button" className="vA4-danger-link" onClick={props.onRemove}>
          <IconTrash size={13} /> Remove account…
        </button>
      </footer>
    </section>
  )
}

// -----------------------------------------------------------------------------------------------
// Pools

export function PoolsPanel({ s, now, onSelect }: { s: DashboardState; now: number; onSelect: (id: string) => void }) {
  return (
    <section className="vA4-panel" aria-labelledby="vA4-pools-h">
      <header className="vA4-panel-head">
        <IconLayers size={14} />
        <h3 id="vA4-pools-h">Pools</h3>
        <span className="vA4-panel-hint">Who gets new sessions</span>
      </header>
      <div className="vA4-pools">
        {PROVIDERS.map((p) => (
          <PoolCard key={p} provider={p} s={s} now={now} onSelect={onSelect} />
        ))}
      </div>
    </section>
  )
}

function PoolCard({
  provider,
  s,
  now,
  onSelect,
}: {
  provider: Provider
  s: DashboardState
  now: number
  onSelect: (id: string) => void
}) {
  const ps = poolState(s.accounts, provider)
  const list = accountsOf(s.accounts, provider)
  const disabled = list.filter((a) => !a.enabled).length
  return (
    <div className={`vA4-pool is-${ps.kind}`}>
      <div className="vA4-pool-head">
        <ProviderMark provider={provider} size={14} />
        <b>{providerName[provider]}</b>
        <span className="vA4-pool-state">
          {ps.kind === "serving" && (
            <>
              <IconArrowRight size={11} /> {ps.account.label}
            </>
          )}
          {ps.kind === "blocked" && (
            <>
              <IconAlert size={12} />
              {ps.nextReset !== null ? `Waiting · ${formatClock(ps.nextReset)}` : "Needs sign-in"}
            </>
          )}
          {ps.kind === "off" && "All disabled"}
          {ps.kind === "empty" && "No accounts"}
        </span>
      </div>
      {ps.kind === "blocked" && ps.nextReset !== null && (
        <div className="vA4-pool-note">
          {ps.allCooling ? "Every account is cooling down." : "No account can take new sessions."} Next reset{" "}
          {countdown(ps.nextReset, now)}.
        </div>
      )}
      {list.length > 0 && (
        <ol className="vA4-pool-order">
          {list.map((a) => {
            const st = statusOf(a)
            const serving = ps.kind === "serving" && ps.account.id === a.id
            return (
              <li key={a.id} className={`is-${st.kind} ${serving ? "is-serving" : ""}`}>
                <button type="button" onClick={() => onSelect(a.id)} title={`${a.label} · ${statusLabel(st)}`}>
                  <span className="vA4-pool-n">{a.priority}</span>
                  <span className="vA4-pool-name">{a.label}</span>
                  <span className="vA4-pool-st">
                    <span className="vA-sdot" />
                    {serving
                      ? "Serving"
                      : st.kind === "cooling"
                        ? formatClock(st.until)
                        : st.kind === "signin"
                          ? "Sign in"
                          : st.kind === "disabled"
                            ? "Off"
                            : "Standby"}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
      {disabled > 0 && ps.kind !== "off" && (
        <div className="vA4-pool-foot">
          {disabled} disabled · skipped, keeps {disabled === 1 ? "its" : "their"} place
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------------------------
// Connect clients

export function ClientsPanel() {
  return (
    <section className="vA4-panel" aria-labelledby="vA4-clients-h">
      <header className="vA4-panel-head">
        <span className="vA4-panel-glyph">$_</span>
        <h3 id="vA4-clients-h">Connect clients</h3>
      </header>
      <p className="vA4-panel-lede">Run once per client. It points the client at this daemon and gives it the proxy key.</p>
      <div className="vA4-clients">
        {CLIENTS.map((c) => (
          <div key={c.id} className="vA4-client">
            <div className="vA4-client-head">
              <b>{c.name}</b>
              <span className="vA4-client-pools">
                {c.providers.map((p) => (
                  <span key={p} title={`${providerName[p]} pool`}>
                    <ProviderMark provider={p} size={11} />
                    {providerName[p]}
                  </span>
                ))}
              </span>
            </div>
            <CommandLine command={c.command} />
          </div>
        ))}
      </div>
      <div className="vA4-keyrow">
        <ProxyKeyRow />
      </div>
    </section>
  )
}

// -----------------------------------------------------------------------------------------------
// Activity

const tone = (k: LiveEvent["kind"]) =>
  k === "cooldown"
    ? "amber"
    : k === "signin-expired" || k === "daemon-down" || k === "removed"
      ? "red"
      : k === "cooldown-ended" || k === "signed-in" || k === "daemon-up" || k === "added" || k === "enabled"
        ? "green"
        : "neutral"

const shortAgo = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return "now"
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

export function ActivityPanel({
  s,
  now,
  onSelect,
}: {
  s: DashboardState
  now: number
  onSelect: (id: string) => void
}) {
  const [onlyLive, setOnlyLive] = useState(false)
  const events = onlyLive ? s.events.filter((e) => e.live) : s.events
  const running = s.daemon.running
  return (
    <section className="vA4-panel vA4-activity" aria-labelledby="vA4-act-h">
      <header className="vA4-panel-head">
        <IconActivity size={14} />
        <h3 id="vA4-act-h">Activity</h3>
        <span className={`vA4-live ${running ? "is-on" : "is-off"}`} title={running ? "Streaming from the daemon" : "Not connected"}>
          <span />
          {running ? "Live" : "Paused"}
        </span>
        <span className="vA4-spacer" />
        <div className="vA4-mini-seg" role="tablist" aria-label="Filter activity">
          <button type="button" role="tab" aria-selected={!onlyLive} className={!onlyLive ? "is-on" : ""} onClick={() => setOnlyLive(false)}>
            All
          </button>
          <button type="button" role="tab" aria-selected={onlyLive} className={onlyLive ? "is-on" : ""} onClick={() => setOnlyLive(true)}>
            Daemon
          </button>
        </div>
      </header>
      {events.length === 0 ? (
        <div className="vA4-act-empty">
          Nothing yet. Status changes from the daemon, and the changes you make, show up here as they happen.
        </div>
      ) : (
        <ol className="vA4-feed" aria-live="polite">
          {events.slice(0, 40).map((e) => {
            const acc = e.accountId === null ? undefined : s.accounts.find((a) => a.id === e.accountId)
            return (
              <li key={e.id} className={`is-${tone(e.kind)}`}>
                <span className="vA4-feed-icon">
                  {e.provider !== null ? <ProviderMark provider={e.provider} size={12} /> : <IconPower size={12} />}
                </span>
                <div className="vA4-feed-body">
                  <span className="vA4-feed-msg">
                    {acc !== undefined ? (
                      <button type="button" onClick={() => onSelect(acc.id)}>
                        {e.message}
                      </button>
                    ) : (
                      e.message
                    )}
                  </span>
                  <span className="vA4-feed-meta">
                    <span className="vA4-feed-dot" />
                    {e.live ? "Daemon" : "You"}
                  </span>
                </div>
                <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleTimeString()}>
                  {shortAgo(e.at, now)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
