// PROTOTYPE round 2 variant A2: an account's own page (?page=accounts&account=<id>).
// Where per-account usage will live later. Sections are bordered settings-style cards.

import { useState } from "react"

import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronUp,
  IconClock,
  IconLogIn,
  IconPencil,
  ProviderMark,
} from "../../shared/icons.tsx"
import {
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  planShort,
  planTier,
  poolState,
  providerName,
  statusOf,
} from "../../shared/model.ts"
import { type DashboardState, actions } from "../../shared/store.ts"
import { CopyButton, Switch } from "../a-console/ui.tsx"
import { RenameInput, clientsFor } from "./AccountsPage.tsx"
import { StatusPill, eventTitle, eventTone } from "./bits.tsx"

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`

export function AccountDetail(props: {
  s: DashboardState
  now: number
  id: string
  onBack: () => void
  onReauth: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { s, now, id } = props
  const a = s.accounts.find((x) => x.id === id)
  const [renaming, setRenaming] = useState(false)

  if (a === undefined) {
    return (
      <div className="vA2-detail">
        <Crumbs label="Not found" onBack={props.onBack} />
        <div className="vA2-card vA2-gone">
          <h2>This account no longer exists</h2>
          <p>It may have been removed. Go back to the list to see the accounts you have.</p>
          <button type="button" className="vA-btn vA-btn-ghost" onClick={props.onBack}>
            <IconChevronLeft size={14} /> Back to Accounts
          </button>
        </div>
      </div>
    )
  }

  const st = statusOf(a)
  const list = accountsOf(s.accounts, a.provider)
  const ps = poolState(s.accounts, a.provider)
  const serving = ps.kind === "serving" && ps.account.id === a.id
  const p = providerName[a.provider]
  const events = s.events.filter((e) => e.accountId === a.id || (e.kind === "reordered" && e.provider === a.provider))
  const flash = a.changedAt > 0 && now - a.changedAt < 2600

  return (
    <div className="vA2-detail">
      <Crumbs label={a.label} onBack={props.onBack} />

      <header className={`vA2-dhead ${flash ? "is-flash" : ""}`}>
        <span className="vA2-dmark">
          <ProviderMark provider={a.provider} size={24} />
        </span>
        <div className="vA2-dtitle">
          {renaming ? (
            <RenameInput account={a} onDone={() => setRenaming(false)} className="vA2-drename" />
          ) : (
            <h1>
              {a.label}
              <button type="button" className="vA-iconbtn" onClick={() => setRenaming(true)} aria-label="Rename" title="Rename">
                <IconPencil size={14} />
              </button>
            </h1>
          )}
          <div className="vA2-dmeta">
            <span>{a.email}</span>
            <span className="vA2-sep">·</span>
            <span className="vA-plan" data-tier={planTier(a.plan)} title={a.plan}>
              {planShort(a.plan)}
            </span>
            <StatusPill status={st} size="sm" />
            {serving && <span className="vA-serving">New sessions</span>}
          </div>
        </div>
        <div className="vA2-dactions">
          {st.kind === "signin" && (
            <button type="button" className="vA-btn vA-btn-primary" onClick={() => props.onReauth(a.id)}>
              <IconLogIn size={14} /> Sign in again
            </button>
          )}
        </div>
      </header>

      <div className="vA2-dgrid">
        <div className="vA2-dmain">
          {/* Status */}
          <section className={`vA2-card vA2-statuscard is-${st.kind}`}>
            <div className="vA2-card-head">
              <h2>Status</h2>
            </div>
            <div className="vA2-statusbody">
              <span className="vA2-statusicon">
                <span />
              </span>
              <div>
                <div className="vA2-statustitle">
                  {st.kind === "active" && (serving ? `Getting new ${p} sessions` : "Active, ready to take sessions")}
                  {st.kind === "cooling" && `Cooling down until ${formatClock(st.until)}`}
                  {st.kind === "signin" && "Needs sign-in"}
                  {st.kind === "disabled" && "Disabled"}
                </div>
                <p>
                  {st.kind === "active" &&
                    (serving
                      ? `It's the highest-priority ${p} account that isn't cooling down, so ${clientsFor(a.provider)} sessions start here.`
                      : `It takes new sessions when every account above it is cooling down or needs sign-in.`)}
                  {st.kind === "cooling" &&
                    `It hit its plan's limit. agent-proxy skips it until the limit resets ${countdown(st.until, now)}, then it's Active again on its own.`}
                  {st.kind === "signin" && `Its ${p} login expired, so agent-proxy skips it. Sign in again to put it back in the pool.`}
                  {st.kind === "disabled" && `You turned it off. It keeps its place in the priority order but never gets sessions.`}
                </p>
              </div>
              {st.kind === "cooling" && (
                <span className="vA2-countdown">
                  <IconClock size={13} /> {countdown(st.until, now)}
                </span>
              )}
              {st.kind === "signin" && (
                <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm" onClick={() => props.onReauth(a.id)}>
                  <IconLogIn size={13} /> Sign in again
                </button>
              )}
            </div>
          </section>

          {/* Routing */}
          <section className="vA2-card">
            <div className="vA2-card-head">
              <h2>Routing</h2>
              <p>
                The highest-priority account in the {p} pool that isn't cooling down gets new sessions.
              </p>
            </div>
            <div className="vA2-setting">
              <div>
                <div className="vA2-setting-title">Priority</div>
                <div className="vA2-setting-sub">
                  {ordinal(a.priority)} of {list.length} in the {p} pool
                </div>
              </div>
              <div className="vA2-stepper">
                <button
                  type="button"
                  className="vA-btn vA-btn-ghost vA-btn-sm"
                  onClick={() => actions.move(a.id, -1)}
                  disabled={a.priority === 1}
                >
                  <IconChevronUp size={14} /> Move up
                </button>
                <button
                  type="button"
                  className="vA-btn vA-btn-ghost vA-btn-sm"
                  onClick={() => actions.move(a.id, 1)}
                  disabled={a.priority === list.length}
                >
                  <IconChevronDown size={14} /> Move down
                </button>
              </div>
            </div>
            <ol className="vA2-order">
              {list.map((x) => {
                const xs = statusOf(x)
                const isServing = ps.kind === "serving" && ps.account.id === x.id
                return (
                  <li key={x.id} className={`${x.id === a.id ? "is-me" : ""} is-${xs.kind}`}>
                    <span className="vA2-order-n">{x.priority}</span>
                    <span className="vA2-order-name">{x.label}</span>
                    {isServing && <span className="vA2-order-serving">New sessions</span>}
                    <span className="vA2-order-spacer" />
                    <StatusPill status={xs} size="sm" />
                  </li>
                )
              })}
            </ol>
            <div className="vA2-setting">
              <div>
                <div className="vA2-setting-title">Use this account</div>
                <div className="vA2-setting-sub">Turn it off to keep it signed in but out of the pool.</div>
              </div>
              <Switch
                checked={a.enabled}
                onChange={(v) => actions.setEnabled(a.id, v)}
                label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`}
              />
            </div>
          </section>

          {/* Usage (planned) */}
          <section className="vA2-card vA2-usage">
            <div className="vA2-card-head">
              <h2>
                Usage <span className="vK-planned">Planned</span>
              </h2>
              <p>Tokens and requests through this account, and how much of its {a.plan} limit is left.</p>
            </div>
            <div className="vA2-usage-skel" aria-hidden="true">
              <div className="vA2-usage-meter">
                <i style={{ width: "62%" }} />
              </div>
              <div className="vA2-usage-bars">
                {Array.from({ length: 24 }, (_, i) => (
                  <span key={i} style={{ height: `${18 + ((i * 41) % 76)}%` }} />
                ))}
              </div>
            </div>
          </section>

          {/* Activity */}
          <section className="vA2-card">
            <div className="vA2-card-head">
              <h2>Activity</h2>
              <p>Changes to this account since the dashboard opened.</p>
            </div>
            {events.length === 0 ? (
              <div className="vA2-feed-empty">Nothing yet. Status changes and your edits show up here as they happen.</div>
            ) : (
              <ol className="vA2-feed">
                {events.slice(0, 8).map((e) => (
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

          {/* Danger zone */}
          <section className="vA2-card vA2-danger">
            <div className="vA2-setting">
              <div>
                <div className="vA2-setting-title">Remove account</div>
                <div className="vA2-setting-sub">
                  Signs out of {a.email} and forgets it. You can add it again later.
                </div>
              </div>
              <button type="button" className="vA-btn vA-btn-danger" onClick={() => props.onRemove(a.id)}>
                Remove…
              </button>
            </div>
          </section>
        </div>

        <aside className="vA2-dside">
          <div className="vA2-card">
            <dl className="vA2-props">
              <div>
                <dt>Provider</dt>
                <dd>
                  <ProviderMark provider={a.provider} size={14} /> {p}
                </dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{a.plan}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd className="vA2-trunc">{a.email}</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>
                  {a.priority} of {list.length}
                </dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>{lastUsedText(a.lastUsedAt, now)}</dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{new Date(a.addedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</dd>
              </div>
              <div>
                <dt>Used by</dt>
                <dd>{clientsFor(a.provider)}</dd>
              </div>
              <div>
                <dt>Account ID</dt>
                <dd className="vA2-idcell">
                  <code>{a.id}</code>
                  <CopyButton text={a.id} label="Copy account ID" />
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  )
}

function Crumbs({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <nav className="vA2-crumbs" aria-label="Breadcrumb">
      <button type="button" onClick={onBack}>
        Accounts
      </button>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{label}</span>
    </nav>
  )
}
