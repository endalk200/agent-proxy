// PROTOTYPE variant D ("Calm"): attention-first, one centred column, settings-page quality.
// A plain-language headline says what's going on; a "Needs attention" stack holds anything the owner
// must act on; rows expand inline (accordion) to edit; the add-account flow also unfolds inline.
// Live updates land in place (crossfade + soft highlight), never as toasts.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import "./calm.css"
import { EXAMPLE_CALLBACK, type AddFlow, loginUrl, useAddAccountFlow } from "../../shared/addFlow.ts"
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconExternal,
  IconKey,
  IconLogIn,
  IconPlus,
  IconPower,
  ProviderMark,
  providerAccent,
} from "../../shared/icons.tsx"
import {
  type Account,
  CLIENTS,
  PROVIDERS,
  type Provider,
  type Status,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  planShort,
  planTier,
  poolOf,
  poolState,
  providerLoginHost,
  providerName,
  statusLabel,
  statusOf,
} from "../../shared/model.ts"
import { type DashboardState, actions, useDashboard, useNow } from "../../shared/store.ts"

export const name = "Calm"

// ---------------------------------------------------------------------------------------------
// Helpers

const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")
  return `${n}${s}`
}

const uptime = (startedAt: number, now: number): string => {
  const m = Math.max(1, Math.round((now - startedAt) / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} hr` : `${Math.floor(h / 24)} days`
}

const copy = (text: string) => {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

const cx = (...xs: Array<string | false | null | undefined>) => xs.filter(Boolean).join(" ")

const FRESH_MS = 2600

type Open = { kind: "edit" | "signin"; id: string } | { kind: "add"; provider: Provider } | null

// ---------------------------------------------------------------------------------------------
// Small building blocks

/** Height-animated disclosure. Children mount on open and unmount after the close animation. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)))
      return () => cancelAnimationFrame(r)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), 340)
    return () => clearTimeout(t)
  }, [open])
  return (
    <div className={cx("vD-reveal", shown && "is-open")} aria-hidden={!open}>
      <div className="vD-reveal-inner">{mounted && children}</div>
    </div>
  )
}

/** Keeps removed items around briefly, flagged `leaving`, so they can animate out. */
function usePresence<T extends { key: string }>(items: ReadonlyArray<T>, ms = 320): Array<T & { leaving: boolean }> {
  const [gone, setGone] = useState<ReadonlyMap<string, T>>(new Map())
  const prev = useRef<ReadonlyArray<T>>(items)
  const keySig = items.map((i) => i.key).join("|")
  useEffect(() => {
    const keys = new Set(items.map((i) => i.key))
    const removed = prev.current.filter((i) => !keys.has(i.key))
    prev.current = items
    if (removed.length === 0) return
    setGone((g) => {
      const n = new Map(g)
      for (const r of removed) n.set(r.key, r)
      return n
    })
    const t = setTimeout(
      () =>
        setGone((g) => {
          const n = new Map(g)
          for (const r of removed) n.delete(r.key)
          return n
        }),
      ms,
    )
    return () => clearTimeout(t)
  }, [keySig])
  useEffect(() => {
    prev.current = items
  })
  const live = new Set(items.map((i) => i.key))
  return [
    ...items.map((i) => ({ ...i, leaving: false })),
    ...[...gone.values()].filter((g) => !live.has(g.key)).map((g) => ({ ...g, leaving: true })),
  ]
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("vD-switch", checked && "is-on")}
      onClick={() => onChange(!checked)}
    >
      <span className="vD-switch-knob" />
    </button>
  )
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1400)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      className={cx("vD-copy", done && "is-done")}
      onClick={() => {
        copy(text)
        setDone(true)
      }}
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
    >
      {done ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  )
}

function PlanBadge({ account }: { account: Account }) {
  return (
    <span className={cx("vD-plan", `tier-${planTier(account.plan)}`, `p-${account.provider}`)} title={account.plan}>
      {planShort(account.plan)}
    </span>
  )
}

function Avatar({ account }: { account: Account }) {
  return (
    <span
      className={cx("vD-avatar", !account.enabled && "is-off")}
      style={{ ["--tint" as string]: providerAccent[account.provider] }}
      aria-hidden="true"
    >
      {account.label.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Headline + attention

type Tone = "ok" | "warn" | "down" | "welcome"

const headline = (s: DashboardState): { tone: Tone; title: string; lines: string[] } => {
  if (!s.daemon.running)
    return {
      tone: "down",
      title: `Can't reach agent-proxy.`,
      lines: [`Nothing is answering at ${s.daemon.address}. What you see below may be out of date.`],
    }
  if (s.accounts.length === 0)
    return { tone: "welcome", title: "Welcome to agent-proxy.", lines: ["Add an account and your clients can share it."] }

  const lines: string[] = []
  const paused: string[] = []
  for (const p of PROVIDERS) {
    const ps = poolState(s.accounts, p)
    const n = providerName[p]
    if (ps.kind === "serving") lines.push(`${n} sessions go to ${ps.account.label}.`)
    else if (ps.kind === "blocked") {
      if (ps.nextReset !== null) {
        lines.push(`New ${n} sessions wait until ${formatClock(ps.nextReset)}.`)
        paused.push(`${n} is paused until ${formatClock(ps.nextReset)}.`)
      } else {
        lines.push(`No ${n} account can take new sessions.`)
        paused.push(`${n} needs you.`)
      }
    } else if (ps.kind === "off") lines.push(`Every ${n} account is turned off.`)
  }
  const needs = s.accounts.filter((a) => a.enabled && a.health.kind === "signin").length
  if (paused.length > 0) return { tone: "warn", title: paused.join(" "), lines }
  if (needs > 0) return { tone: "warn", title: needs === 1 ? "1 account needs you." : `${needs} accounts need you.`, lines }
  return { tone: "ok", title: "Everything's working.", lines }
}

interface Attention {
  key: string
  tone: "warn" | "bad"
  icon: "alert" | "clock" | "power" | "login"
  title: string
  body: string
  action?: { label: string; run: () => void }
  meta?: string
}

const attentionItems = (s: DashboardState, now: number, onSignIn: (id: string) => void): Attention[] => {
  const out: Attention[] = []
  if (!s.daemon.running)
    out.push({
      key: "daemon",
      tone: "bad",
      icon: "power",
      title: `agent-proxy isn't answering at ${s.daemon.address}`,
      body: "Clients can't reach your accounts until the daemon is running again. This page reconnects on its own.",
    })
  for (const p of PROVIDERS) {
    const ps = poolState(s.accounts, p)
    if (ps.kind !== "blocked") continue
    const n = providerName[p]
    if (ps.allCooling && ps.nextReset !== null)
      out.push({
        key: `pool-${p}`,
        tone: "warn",
        icon: "clock",
        title: `New ${n} sessions will wait until ${formatClock(ps.nextReset)}`,
        body: `Every account in the ${n} pool is cooling down. The first one back takes new sessions automatically.`,
        meta: countdown(ps.nextReset, now),
      })
    else
      out.push({
        key: `pool-${p}`,
        tone: "bad",
        icon: "alert",
        title: `No ${n} account can take new sessions`,
        body:
          ps.nextReset !== null
            ? `The rest of the pool is cooling down until ${formatClock(ps.nextReset)}. Sign in again below to get going sooner.`
            : `Every account in the ${n} pool needs sign-in.`,
      })
  }
  for (const a of s.accounts)
    if (a.enabled && a.health.kind === "signin")
      out.push({
        key: `signin-${a.id}`,
        tone: "warn",
        icon: "login",
        title: `${a.label} needs you to sign in again`,
        body: `Its ${providerName[a.provider]} login expired, so agent-proxy skips it for now.`,
        action: { label: "Sign in again", run: () => onSignIn(a.id) },
      })
  return out
}

const AttIcon = ({ icon }: { icon: Attention["icon"] }) =>
  icon === "clock" ? <IconClock size={18} /> : icon === "power" ? <IconPower size={18} /> : icon === "login" ? <IconLogIn size={18} /> : <IconAlert size={18} />

function Hero({ s, now }: { s: DashboardState; now: number }) {
  const h = headline(s)
  return (
    <header className={cx("vD-hero", `tone-${h.tone}`)}>
      <div className="vD-daemon">
        <span className={cx("vD-pulse", s.daemon.running ? "is-up" : "is-down")} />
        {s.daemon.running ? (
          <span>
            agent-proxy is running at <code>{s.daemon.address}</code>
            <span className="vD-dim"> · up {uptime(s.daemon.startedAt, now)} · v{s.daemon.version}</span>
          </span>
        ) : (
          <span>
            Can't reach agent-proxy at <code>{s.daemon.address}</code>
          </span>
        )}
      </div>
      <h1 key={h.title} className="vD-title">
        {h.title}
      </h1>
      <div key={h.lines.join()} className="vD-sub">
        {h.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
    </header>
  )
}

function AttentionStack({ items }: { items: Attention[] }) {
  const shown = usePresence(items)
  return (
    <section className={cx("vD-attn", shown.length === 0 && "is-empty")} aria-label="Needs attention">
      {shown.length > 0 && <h2 className="vD-caption">Needs attention</h2>}
      {shown.map((a) => (
        <div key={a.key} className={cx("vD-callout", `tone-${a.tone}`, a.leaving && "is-leaving")}>
          <div className="vD-callout-body">
            <span className="vD-callout-icon">
              <AttIcon icon={a.icon} />
            </span>
            <div className="vD-callout-text">
              <div className="vD-callout-title">
                {a.title}
                {a.meta !== undefined && <span className="vD-callout-meta">{a.meta}</span>}
              </div>
              <p>{a.body}</p>
            </div>
            {a.action !== undefined && (
              <button type="button" className="vD-btn vD-btn-tinted" onClick={a.action.run} disabled={a.leaving}>
                {a.action.label}
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Connect clients

function ConnectClients({ s, defaultOpen, title }: { s: DashboardState; defaultOpen: boolean; title: string }) {
  const [open, setOpen] = useState(defaultOpen)
  const [reveal, setReveal] = useState(false)
  const masked = `${s.proxyKey.slice(0, 9)}${"•".repeat(14)}${s.proxyKey.slice(-4)}`
  return (
    <section className="vD-section">
      <div className="vD-section-head">
        <div>
          <h2 className="vD-h2">{title}</h2>
          <p className="vD-caption-text">Run a client's command once on this machine to point it at agent-proxy.</p>
        </div>
        <button type="button" className="vD-link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? (defaultOpen ? "Hide" : "Already connected? Hide") : "Show"}
          <IconChevronDown size={14} className={cx("vD-chev", open && "is-up")} />
        </button>
      </div>
      <Reveal open={open}>
        <div className="vD-group">
          {CLIENTS.map((c) => (
            <div key={c.id} className="vD-client">
              <div className="vD-client-name">
                <span className="vD-client-marks">
                  {c.providers.map((p) => (
                    <ProviderMark key={p} provider={p} size={16} />
                  ))}
                </span>
                <div>
                  <div className="vD-strong">{c.name}</div>
                  <div className="vD-dim vD-small">
                    Uses the {c.providers.map((p) => providerName[p]).join(" and ")} pool{c.providers.length > 1 ? "s" : ""}
                  </div>
                </div>
              </div>
              <div className="vD-cmd">
                <code>
                  <span className="vD-prompt">$</span> {c.command}
                </code>
                <CopyButton text={c.command} label={`Copy ${c.name} command`} />
              </div>
            </div>
          ))}
          <div className="vD-client">
            <div className="vD-client-name">
              <span className="vD-client-marks vD-keyicon">
                <IconKey size={16} />
              </span>
              <div>
                <div className="vD-strong">Proxy key</div>
                <div className="vD-dim vD-small">Clients present this to agent-proxy. The connect commands set it for you.</div>
              </div>
            </div>
            <div className="vD-cmd">
              <code className="vD-key">{reveal ? s.proxyKey : masked}</code>
              <button type="button" className="vD-link vD-small" onClick={() => setReveal(!reveal)}>
                {reveal ? "Hide" : "Reveal"}
              </button>
              <CopyButton text={s.proxyKey} label="Copy proxy key" />
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Add-account / sign-in-again flow, rendered inline

function FlowPanel({ flow, onClose, isFirstRun = false }: { flow: AddFlow; onClose: () => void; isFirstRun?: boolean }) {
  const s = useDashboard()
  const step = flow.step
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasted, setPasted] = useState("")
  const [label, setLabel] = useState<string | null>(null)
  const reauth = flow.reauthAccountId === null ? undefined : s.accounts.find((a) => a.id === flow.reauthAccountId)
  const provider = step.kind === "pick" ? null : step.provider
  const link = useMemo(() => (provider === null ? "" : loginUrl(provider)), [provider])

  if (step.kind === "pick")
    return (
      <div className="vD-flow">
        <div className="vD-flow-title">{isFirstRun ? "Which account do you want to add first?" : "Add an account"}</div>
        <div className="vD-pick">
          {PROVIDERS.map((p) => (
            <button key={p} type="button" className="vD-pick-opt" onClick={() => flow.choose(p)}>
              <ProviderMark provider={p} size={26} />
              <span>
                <span className="vD-strong">{providerName[p]}</span>
                <span className="vD-dim vD-small">
                  {p === "claude" ? "Claude Pro, Max 5x or Max 20x" : "ChatGPT Plus or Pro"}
                </span>
              </span>
              <IconExternal size={15} className="vD-pick-go" />
            </button>
          ))}
        </div>
        {!isFirstRun && (
          <div className="vD-flow-actions">
            <button type="button" className="vD-btn vD-btn-plain" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
      </div>
    )

  if (step.kind === "waiting")
    return (
      <div className="vD-flow">
        <div className="vD-wait">
          <span className="vD-breathe" style={{ ["--tint" as string]: providerAccent[step.provider] }}>
            <ProviderMark provider={step.provider} size={22} />
          </span>
          <div>
            <div className="vD-flow-title">
              {reauth !== undefined ? `Sign in to ${reauth.label} again` : "Waiting for you to finish signing in…"}
            </div>
            {step.popupBlocked ? (
              <p className="vD-dim">
                Your browser blocked the new tab.{" "}
                <button type="button" className="vD-link" onClick={flow.openLogin}>
                  Open the {providerName[step.provider]} sign-in page
                </button>
              </p>
            ) : (
              <p className="vD-dim">
                {reauth !== undefined ? "Waiting for you to finish signing in. " : ""}We opened {providerLoginHost[step.provider]} in a new
                tab. Didn't see it?{" "}
                <button type="button" className="vD-link" onClick={flow.openLogin}>
                  Open it again
                </button>
              </p>
            )}
            {reauth !== undefined && (
              <p className="vD-dim vD-small">Sign in as {reauth.email}.</p>
            )}
          </div>
        </div>

        <div className="vD-paste">
          <button type="button" className="vD-link vD-small" onClick={() => setPasteOpen(!pasteOpen)} aria-expanded={pasteOpen}>
            Signing in on another machine? Paste the callback URL
            <IconChevronDown size={13} className={cx("vD-chev", pasteOpen && "is-up")} />
          </button>
          <Reveal open={pasteOpen}>
            <div className="vD-paste-body">
              <ol className="vD-steps">
                <li>
                  Open the sign-in link in any browser.{" "}
                  <span className="vD-inline-copy">
                    <CopyButton text={link} label="Copy sign-in link" /> Copy link
                  </span>
                </li>
                <li>After you approve, that browser lands on a page that won't load. Copy its address and paste it here.</li>
              </ol>
              <form
                className="vD-paste-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  flow.pasteCallback(pasted)
                }}
              >
                <input
                  className={cx("vD-input", "vD-mono", step.pasteError !== null && "is-error")}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder={EXAMPLE_CALLBACK}
                  aria-label="Callback URL"
                  spellCheck={false}
                />
                <button type="submit" className="vD-btn vD-btn-primary" disabled={pasted.trim() === ""}>
                  Continue
                </button>
              </form>
              {step.pasteError !== null && <p className="vD-error">{step.pasteError}</p>}
            </div>
          </Reveal>
        </div>

        <div className="vD-flow-actions">
          {flow.reauthAccountId === null && !isFirstRun && (
            <button type="button" className="vD-btn vD-btn-plain" onClick={flow.back}>
              Choose another provider
            </button>
          )}
          <button type="button" className="vD-btn vD-btn-plain" onClick={isFirstRun ? flow.back : onClose}>
            Cancel
          </button>
        </div>
      </div>
    )

  if (step.kind === "verifying")
    return (
      <div className="vD-flow">
        <div className="vD-wait">
          <span className="vD-spinner" />
          <div className="vD-flow-title">Checking your sign-in…</div>
        </div>
      </div>
    )

  const acc = s.accounts.find((a) => a.id === step.accountId)
  const current = label ?? acc?.label ?? ""
  const done = () => {
    if (acc !== undefined && !step.reauth) actions.rename(acc.id, current)
    onClose()
  }
  return (
    <div className="vD-flow">
      <div className="vD-success">
        <span className="vD-success-check">
          <IconCheck size={18} />
        </span>
        <div>
          <div className="vD-flow-title">{step.reauth ? `${acc?.label ?? "Account"} is signed in again` : "You're signed in"}</div>
          {acc !== undefined && (
            <p className="vD-dim">
              Signed in as {acc.email} · {acc.plan}
              {step.reauth ? ". It's back in the pool." : ""}
            </p>
          )}
        </div>
      </div>
      {!step.reauth && acc !== undefined && (
        <label className="vD-field">
          <span>Name this account</span>
          <input
            className="vD-input"
            value={current}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && done()}
            autoFocus
          />
          <span className="vD-dim vD-small">
            It joins the {providerName[acc.provider]} pool as your {ordinal(acc.priority)} choice. You can change that any time.
          </span>
        </label>
      )}
      <div className="vD-flow-actions">
        <button type="button" className="vD-btn vD-btn-primary" onClick={done}>
          Done
        </button>
      </div>
    </div>
  )
}

function AddFlowMount(props: { provider?: Provider; reauthAccountId?: string; onClose: () => void; isFirstRun?: boolean }) {
  const flow = useAddAccountFlow({
    ...(props.provider !== undefined ? { provider: props.provider } : {}),
    ...(props.reauthAccountId !== undefined ? { reauthAccountId: props.reauthAccountId } : {}),
  })
  return <FlowPanel flow={flow} onClose={props.onClose} {...(props.isFirstRun !== undefined ? { isFirstRun: props.isFirstRun } : {})} />
}

// ---------------------------------------------------------------------------------------------
// Account rows

function StatusText({ status, serving, onSignIn }: { status: Status; serving: boolean; onSignIn: () => void }) {
  return (
    <span key={status.kind} className={cx("vD-status", `st-${status.kind}`)}>
      <span className="vD-status-line">
        <span className="vD-dot" />
        {statusLabel(status)}
      </span>
      <span className="vD-status-sub">
        {status.kind === "active" && (serving ? "Gets new sessions" : "Ready")}
        {status.kind === "cooling" && `until ${formatClock(status.until)}`}
        {status.kind === "disabled" && "Turned off"}
        {status.kind === "signin" && (
          <button
            type="button"
            className="vD-link vD-small vD-signin-link"
            onClick={(e) => {
              e.stopPropagation()
              onSignIn()
            }}
          >
            Sign in again
          </button>
        )}
      </span>
    </span>
  )
}

function AccountEditor({ account, count }: { account: Account; count: number }) {
  const [label, setLabel] = useState(account.label)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => setLabel(account.label), [account.label])
  return (
    <div className="vD-editor">
      <label className="vD-field">
        <span>Label</span>
        <input
          className="vD-input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => actions.rename(account.id, label)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur()
            if (e.key === "Escape") setLabel(account.label)
          }}
        />
      </label>

      <div className="vD-field">
        <span>Priority</span>
        {count > 1 ? (
          <div className="vD-seg" role="radiogroup" aria-label="Priority">
            {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={account.priority === n}
                className={cx("vD-seg-opt", account.priority === n && "is-on")}
                onClick={() => actions.setPriority(account.id, n)}
              >
                {ordinal(n)}
              </button>
            ))}
          </div>
        ) : (
          <span className="vD-dim">Only account in this pool</span>
        )}
        <span className="vD-dim vD-small">
          New sessions go to the highest-priority account that isn't cooling down.
        </span>
      </div>

      <div className="vD-toggle-row">
        <div>
          <div className="vD-strong">Use this account</div>
          <div className="vD-dim vD-small">
            {account.enabled ? "It's in the pool." : "Turned off. agent-proxy won't send it any sessions."}
          </div>
        </div>
        <Switch checked={account.enabled} onChange={(v) => actions.setEnabled(account.id, v)} label="Use this account" />
      </div>

      <div className={cx("vD-remove", confirm && "is-confirming")}>
        {confirm ? (
          <>
            <span>
              <b>Remove {account.label}?</b> Clients can't use it after this.
            </span>
            <span className="vD-remove-actions">
              <button type="button" className="vD-btn vD-btn-plain" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="vD-btn vD-btn-danger" onClick={() => actions.remove(account.id)}>
                Remove
              </button>
            </span>
          </>
        ) : (
          <button type="button" className="vD-link vD-link-danger" onClick={() => setConfirm(true)}>
            Remove account…
          </button>
        )}
      </div>
    </div>
  )
}

function AccountRow(props: {
  account: Account
  count: number
  serving: boolean
  now: number
  open: Open
  setOpen: (o: Open) => void
}) {
  const { account: a, count, serving, now, open, setOpen } = props
  const status = statusOf(a)
  const isEdit = open?.kind === "edit" && open.id === a.id
  const isSignIn = open?.kind === "signin" && open.id === a.id
  const fresh = now - a.changedAt < FRESH_MS
  const expanded = isEdit || isSignIn
  return (
    <div id={`vD-row-${a.id}`} className={cx("vD-row", expanded && "is-open", fresh && "is-fresh", !a.enabled && "is-off")}>
      <div className="vD-row-head">
        <button
          type="button"
          className="vD-row-hit"
          aria-expanded={expanded}
          aria-label={`${a.label}, ${statusLabel(status)}. ${expanded ? "Collapse" : "Edit"}`}
          onClick={() => setOpen(expanded ? null : { kind: "edit", id: a.id })}
        />
        <Avatar account={a} />
        <div className="vD-row-main">
          <div className="vD-row-title">
            <span className="vD-strong">{a.label}</span>
            <PlanBadge account={a} />
          </div>
          <div className="vD-row-meta">
            <span>{a.email}</span>
            <span className="vD-sep">·</span>
            <span>{ordinal(a.priority)} choice</span>
            <span className="vD-sep">·</span>
            <span>{a.lastUsedAt === null ? "Not used yet" : `Used ${lastUsedText(a.lastUsedAt, now)}`}</span>
          </div>
        </div>
        <StatusText status={status} serving={serving} onSignIn={() => setOpen({ kind: "signin", id: a.id })} />
        <IconChevronDown size={16} className={cx("vD-row-chev", expanded && "is-up")} />
      </div>
      <Reveal open={expanded}>
        {isSignIn ? (
          <div className="vD-row-flow">
            <AddFlowMount reauthAccountId={a.id} onClose={() => setOpen({ kind: "edit", id: a.id })} />
          </div>
        ) : (
          <AccountEditor account={a} count={count} />
        )}
      </Reveal>
    </div>
  )
}

function ProviderGroup(props: {
  s: DashboardState
  provider: Provider
  now: number
  open: Open
  setOpen: (o: Open) => void
  footnote: boolean
}) {
  const { s, provider: p, now, open, setOpen, footnote } = props
  const accounts = accountsOf(s.accounts, p)
  const pool = poolOf(s.accounts, p)
  const ps = poolState(s.accounts, p)
  const n = providerName[p]
  const caption =
    ps.kind === "empty"
      ? `No ${n} accounts yet`
      : ps.kind === "off"
        ? "Every account is turned off, so the pool is empty"
        : ps.kind === "serving"
          ? `Pool of ${pool.length} · new sessions go to ${ps.account.label}`
          : ps.nextReset !== null
            ? `Pool of ${pool.length} · ${ps.allCooling ? "all cooling down" : "none available"}, next reset ${formatClock(ps.nextReset)}`
            : `Pool of ${pool.length} · every account needs sign-in`
  const adding = open?.kind === "add" && open.provider === p
  return (
    <section className="vD-section">
      <div className="vD-section-head">
        <div className="vD-provider-head">
          <ProviderMark provider={p} size={20} />
          <div>
            <h2 className="vD-h2">{n}</h2>
            <p key={caption} className={cx("vD-caption-text", "vD-fade", ps.kind === "blocked" && "is-warn")}>
              {caption}
            </p>
          </div>
        </div>
      </div>
      <div className="vD-group">
        {accounts.length === 0 && !adding && (
          <div className="vD-empty-row">
            <span className="vD-dim">
              {p === "claude" ? "Claude Code" : "Codex"} has no account to use yet.
              {s.accounts.length > 0 ? " opencode can still use your other pool." : ""}
            </span>
          </div>
        )}
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            count={accounts.length}
            serving={ps.kind === "serving" && ps.account.id === a.id}
            now={now}
            open={open}
            setOpen={setOpen}
          />
        ))}
        <div className={cx("vD-add", adding && "is-open")}>
          <button type="button" className="vD-add-hit" onClick={() => setOpen(adding ? null : { kind: "add", provider: p })} aria-expanded={adding}>
            <span className="vD-add-icon">
              <IconPlus size={15} />
            </span>
            Add {n} account
          </button>
          <Reveal open={adding}>
            <div className="vD-row-flow">
              <AddFlowMount provider={p} onClose={() => setOpen(null)} />
            </div>
          </Reveal>
        </div>
      </div>
      {footnote && (
        <p className="vD-footnote">
          Open an account to change its priority. agent-proxy gives new sessions to your 1st choice, and moves down the list while it's
          cooling down.
        </p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// First run

function FirstRun({ s, onStarted, onDone }: { s: DashboardState; onStarted: () => void; onDone: () => void }) {
  return (
    <>
      <section className="vD-welcome">
        <div className="vD-welcome-steps">
          <div className="vD-wstep is-now">
            <span className="vD-wnum">1</span>
            <div>
              <div className="vD-strong">Add an account</div>
              <div className="vD-dim vD-small">Sign in to Claude or Codex. Nothing is stored anywhere but this machine.</div>
            </div>
          </div>
          <div className="vD-wstep">
            <span className="vD-wnum">2</span>
            <div>
              <div className="vD-strong">Connect your clients</div>
              <div className="vD-dim vD-small">One command per client, and they share the account from then on.</div>
            </div>
          </div>
        </div>
        <div className="vD-group vD-welcome-flow" onClickCapture={onStarted}>
          <div className="vD-row-flow">
            <AddFlowMount onClose={onDone} isFirstRun />
          </div>
        </div>
      </section>
      <ConnectClients s={s} defaultOpen title="Then connect your clients" />
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Page

export function VariantD() {
  const s = useDashboard()
  const now = useNow(1000)
  const [open, setOpenState] = useState<Open>(null)
  const [onboarding, setOnboarding] = useState(false)

  const setOpen = (o: Open) => setOpenState(o)

  const signIn = (id: string) => {
    setOpenState({ kind: "signin", id })
    requestAnimationFrame(() =>
      document.getElementById(`vD-row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
    )
  }

  const firstRun = s.accounts.length === 0 || onboarding
  // Reset onboarding when the scenario changes underneath us.
  useEffect(() => {
    setOnboarding(false)
    setOpenState(null)
  }, [s.scenario])

  const items = attentionItems(s, now, signIn)
  const visibleProviders = PROVIDERS

  return (
    <div className={cx("vD", !s.daemon.running && "is-offline")}>
      <div className="vD-col">
        <div className="vD-brand">
          <span className="vD-brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          agent-proxy
        </div>
        <Hero s={s} now={now} />
        <AttentionStack items={items} />
        {firstRun ? (
          <FirstRun
            s={s}
            onStarted={() => setOnboarding(true)}
            onDone={() => setOnboarding(false)}
          />
        ) : (
          <>
            {visibleProviders.map((p) => (
              <ProviderGroup
                key={p}
                s={s}
                provider={p}
                now={now}
                open={open}
                setOpen={setOpen}
                footnote={p === PROVIDERS.find((x) => accountsOf(s.accounts, x).length > 1)}
              />
            ))}
            <ConnectClients s={s} defaultOpen={false} title="Connect clients" />
          </>
        )}
      </div>
    </div>
  )
}
