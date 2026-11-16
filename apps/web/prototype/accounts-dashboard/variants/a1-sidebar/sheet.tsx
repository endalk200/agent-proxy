// PROTOTYPE variant A1: the account sheet. Slides over from the right when a row is clicked.
// It is where one account's detail lives, and later its usage (the Usage tab is a placeholder).

import { useEffect, useState } from "react"

import {
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconLogIn,
  IconPencil,
  IconTrash,
  IconX,
  ProviderMark,
} from "../../shared/icons.tsx"
import {
  type Account,
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
import { type LiveEvent, actions } from "../../shared/store.ts"
import { Switch } from "../a-console/ui.tsx"
import { RenameInput, eventTitle, eventTone } from "./accounts.tsx"
import { IconActivity, IconChart } from "./icons.tsx"

type Tab = "overview" | "activity" | "usage"

const ordinal = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`

export function AccountSheet(props: {
  account: Account
  accounts: ReadonlyArray<Account>
  events: ReadonlyArray<LiveEvent>
  now: number
  readOnly: boolean
  /** true while a modal is open on top, so Esc belongs to the modal. */
  covered: boolean
  onClose: () => void
  onReauth: () => void
  onRemove: () => void
}) {
  const { account: a, accounts, now, onClose, covered } = props
  const [tab, setTab] = useState<Tab>("overview")
  const [renaming, setRenaming] = useState(false)
  const st = statusOf(a)
  const list = accountsOf(accounts, a.provider)
  const ps = poolState(accounts, a.provider)
  const serving = ps.kind === "serving" && ps.account.id === a.id
  const servingLabel = ps.kind === "serving" ? ps.account.label : null
  const p = providerName[a.provider]
  const mine = props.events.filter((e) => e.accountId === a.id)
  const flash = a.changedAt > 0 && now - a.changedAt < 2600

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !covered) onClose()
    }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  }, [onClose, covered])

  const statusText = (() => {
    switch (st.kind) {
      case "active":
        return serving
          ? `Gets every new ${p} session.`
          : ps.kind === "serving"
            ? `Ready. Takes new sessions when ${servingLabel} can't.`
            : `Ready to take new ${p} sessions.`
      case "cooling":
        return "It hit its plan's limit. agent-proxy skips it until the limit resets."
      case "signin":
        return "Its login expired. agent-proxy skips it until you sign in again."
      case "disabled":
        return "You turned it off. It keeps its place in the priority order."
    }
  })()

  return (
    <>
      <div className="vA1-scrim" onMouseDown={onClose} aria-hidden="true" />
      <aside className="vA1-sheet" role="dialog" aria-modal="false" aria-label={`${a.label} details`}>
        <div className="vA1-sheet-top">
          <span className="vA1-sheet-crumb">
            <ProviderMark provider={a.provider} size={14} />
            {p} pool
            <span className="vA1-sheet-crumb-sep">/</span>
            <span>{ordinal(a.priority)} priority</span>
          </span>
          <button type="button" className="vA-iconbtn" onClick={onClose} aria-label="Close details" title="Close (Esc)">
            <IconX size={16} />
          </button>
        </div>

        <div className="vA1-sheet-scroll">
          <header className="vA1-sheet-head">
            {renaming ? (
              <RenameInput account={a} onDone={() => setRenaming(false)} className="vA-input vA1-sheet-rename" />
            ) : (
              <h2 className="vA1-sheet-title">
                <button type="button" onClick={() => setRenaming(true)} disabled={props.readOnly} title="Rename">
                  {a.label}
                  <IconPencil size={13} />
                </button>
              </h2>
            )}
            <div className="vA1-sheet-meta">
              <span>{a.email}</span>
              <span className="vA-plan" data-tier={planTier(a.plan)}>
                {planShort(a.plan)}
              </span>
            </div>
          </header>

          <div className={`vA1-statuscard is-${st.kind} ${flash ? "is-flash" : ""}`}>
            <div className="vA1-statuscard-main">
              <span className="vA1-statuscard-dot" />
              <div>
                <div className="vA1-statuscard-label">
                  {statusLabel(st)}
                  {st.kind === "cooling" && <span> until {formatClock(st.until)}</span>}
                  {serving && <span className="vA-serving">New sessions</span>}
                </div>
                <p>{statusText}</p>
              </div>
            </div>
            {st.kind === "cooling" && (
              <div className="vA1-statuscard-side">
                <IconClock size={13} /> {countdown(st.until, now)}
              </div>
            )}
            {st.kind === "signin" && (
              <button type="button" className="vA-btn vA-btn-sm vA-btn-red" onClick={props.onReauth} disabled={props.readOnly}>
                <IconLogIn size={13} /> Sign in again
              </button>
            )}
          </div>

          <div className="vA1-tabs" role="tablist">
            {(
              [
                ["overview", "Overview"],
                ["activity", `Activity${mine.length > 0 ? ` · ${mine.length}` : ""}`],
                ["usage", "Usage"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "is-on" : ""}
                onClick={() => setTab(id)}
              >
                {label}
                {id === "usage" && <span className="vA1-tag">Planned</span>}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <div className="vA1-sheet-body">
              <dl className="vA1-props">
                <div>
                  <dt>Priority</dt>
                  <dd>
                    <span>
                      <b>{a.priority}</b> of {list.length} in the {p} pool
                    </span>
                    <span className="vA1-stepper">
                      <button
                        type="button"
                        className="vA-iconbtn"
                        disabled={a.priority === 1 || props.readOnly}
                        onClick={() => actions.move(a.id, -1)}
                        aria-label="Move up"
                        title="Move up"
                      >
                        <IconChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="vA-iconbtn"
                        disabled={a.priority === list.length || props.readOnly}
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
                  <dt>Use this account</dt>
                  <dd>
                    <span className="vA1-muted">{a.enabled ? "In the pool" : "Out of the pool"}</span>
                    <Switch
                      checked={a.enabled}
                      onChange={(v) => actions.setEnabled(a.id, v)}
                      label={a.enabled ? `Disable ${a.label}` : `Enable ${a.label}`}
                      disabled={props.readOnly}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Plan</dt>
                  <dd>{a.plan}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{a.email}</dd>
                </div>
                <div>
                  <dt>Last used</dt>
                  <dd>{lastUsedText(a.lastUsedAt, now)}</dd>
                </div>
                <div>
                  <dt>Added</dt>
                  <dd>{new Date(a.addedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</dd>
                </div>
              </dl>

              <div className="vA1-order">
                <div className="vA1-order-title">{p} pool order</div>
                <ol>
                  {list.map((x) => {
                    const xs = statusOf(x)
                    return (
                      <li key={x.id} className={`is-${xs.kind} ${x.id === a.id ? "is-me" : ""}`}>
                        <span className="vA1-order-n">{x.priority}</span>
                        <span className="vA1-order-label">{x.label}</span>
                        <span className="vA1-order-status">
                          <span className="vA-sdot" />
                          {statusLabel(xs)}
                        </span>
                      </li>
                    )
                  })}
                </ol>
              </div>

              <div className="vA1-danger">
                <div>
                  <b>Remove account</b>
                  <p>Signs agent-proxy out of {a.email}. You can add it again later.</p>
                </div>
                <button type="button" className="vA-btn vA-btn-ghost vA-btn-sm vA1-btn-danger-ghost" onClick={props.onRemove} disabled={props.readOnly}>
                  <IconTrash size={13} /> Remove…
                </button>
              </div>
            </div>
          )}

          {tab === "activity" && (
            <div className="vA1-sheet-body">
              {mine.length === 0 ? (
                <div className="vA1-quiet">
                  <IconActivity size={18} />
                  <p>Nothing has happened to {a.label} since you opened the dashboard. Status changes and edits show up here.</p>
                </div>
              ) : (
                <ol className="vA1-feed">
                  {mine.map((e) => (
                    <li key={e.id} className={`is-${eventTone(e.kind)}`}>
                      <span className="vA1-feed-dot" />
                      <div>
                        <div className="vA1-feed-title">
                          {eventTitle(e.kind)}
                          {e.live && <span className="vA1-feed-live">Live</span>}
                        </div>
                        <div className="vA1-feed-msg">{e.message}</div>
                      </div>
                      <time>{lastUsedText(e.at, now)}</time>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {tab === "usage" && (
            <div className="vA1-sheet-body">
              <div className="vA1-usage-skel" aria-hidden="true">
                <div className="vA1-usage-tiles">
                  <div>
                    <i />
                    <b />
                  </div>
                  <div>
                    <i />
                    <b />
                  </div>
                </div>
                <div className="vA1-usage-bars">
                  {Array.from({ length: 18 }, (_, i) => (
                    <span key={i} style={{ height: `${20 + ((i * 41) % 75)}%` }} />
                  ))}
                </div>
              </div>
              <div className="vA1-quiet">
                <IconChart size={18} />
                <p>
                  <b>Usage for {a.label} is planned.</b> Tokens, requests, and how much of this plan's limit is left will show here.
                </p>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
