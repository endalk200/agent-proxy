// PROTOTYPE variant C ("Keyboard"): a master-detail, keyboard-first console.
// Left: one list of every account, grouped by provider, with each pool's state in the group header.
// Right: the selected account's detail (or the add-account flow), with an events tail underneath.
// Bottom: a vim-like status line (daemon, mode, key hints). ⌘K opens a command palette.

import { useEffect, useMemo, useRef, useState } from "react"

import "./keyboard.css"
import { ProviderMark } from "../../shared/icons.tsx"
import {
  type Account,
  type PoolState,
  type Provider,
  CLIENTS,
  PROVIDERS,
  accountsOf,
  countdown,
  formatClock,
  lastUsedText,
  poolState,
  providerName,
  servingAccountId,
  statusLabel,
  statusOf,
} from "../../shared/model.ts"
import { actions, useDashboard, useNow } from "../../shared/store.ts"
import { AddPane } from "./AddPane.tsx"
import { Glyph, Kbd, PlanBadge, clockSeconds, copy, isTyping, uptime } from "./bits.tsx"
import { type Command, ConnectPanel, Palette } from "./Overlays.tsx"

export const name = "Keyboard"

type Mode = { kind: "detail" } | { kind: "add"; n: number; provider?: Provider; reauthId?: string }

let addSeq = 0

const poolText = (ps: PoolState): { text: string; tone: string } => {
  switch (ps.kind) {
    case "serving":
      return { text: `→ ${ps.account.label}`, tone: "ok" }
    case "blocked":
      return ps.allCooling && ps.nextReset !== null
        ? { text: `⏸ all cooling · ${formatClock(ps.nextReset)}`, tone: "cool" }
        : {
            text: `✕ no account can serve${ps.nextReset !== null ? ` · next ${formatClock(ps.nextReset)}` : ""}`,
            tone: "bad",
          }
    case "off":
      return { text: "○ pool off · all disabled", tone: "mute" }
    case "empty":
      return { text: "no accounts", tone: "mute" }
  }
}

export function VariantC() {
  const s = useDashboard()
  const now = useNow(1000)
  const down = !s.daemon.running

  const ordered = useMemo(() => PROVIDERS.flatMap((p) => accountsOf(s.accounts, p)), [s.accounts])
  const [selectedId, setSelectedId] = useState<string | null>(() => ordered[0]?.id ?? null)
  const lastIndex = useRef(0)
  const selected = ordered.find((a) => a.id === selectedId) ?? null
  if (selected !== null) lastIndex.current = ordered.indexOf(selected)

  // Keep a valid selection when accounts disappear (remove, scenario change).
  useEffect(() => {
    if (selected === null && ordered.length > 0) {
      setSelectedId(ordered[Math.min(lastIndex.current, ordered.length - 1)]!.id)
    }
  }, [selected, ordered])

  const [mode, setMode] = useState<Mode>({ kind: "detail" })
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState("")
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [palette, setPalette] = useState(false)
  const [connect, setConnect] = useState(false)
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" | "info"; at: number } | null>(null)

  const say = (text: string, tone: "ok" | "bad" | "info" = "info") => setMsg({ text, tone, at: Date.now() })
  useEffect(() => {
    if (msg === null) return
    const t = setTimeout(() => setMsg(null), 3200)
    return () => clearTimeout(t)
  }, [msg])

  // Live updates: rows touched by an event flash; a pool's arrow blinks when its serving account changes.
  const [flash, setFlash] = useState<Record<string, { at: number; live: boolean }>>({})
  const seenEvent = useRef(s.events[0]?.id ?? 0)
  useEffect(() => {
    const fresh = s.events.filter((e) => e.id > seenEvent.current)
    if (fresh.length === 0) return
    seenEvent.current = s.events[0]!.id
    const touched = fresh.filter((e) => e.accountId !== null && e.kind !== "removed")
    if (touched.length > 0) {
      setFlash((f) => {
        const next = { ...f }
        for (const e of touched) next[e.accountId!] = { at: e.at, live: e.live }
        return next
      })
    }
    const live = fresh.find((e) => e.live)
    if (live !== undefined) say(`⚡ ${live.message}`, live.kind === "cooldown-ended" || live.kind === "daemon-up" ? "ok" : "bad")
  }, [s.events])
  useEffect(() => {
    const ids = Object.keys(flash)
    if (ids.length === 0) return
    const t = setTimeout(() => {
      setFlash((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => Date.now() - v.at < 1700)))
    }, 1800)
    return () => clearTimeout(t)
  }, [flash])

  const serving = Object.fromEntries(PROVIDERS.map((p) => [p, servingAccountId(s.accounts, p)])) as Record<Provider, string | null>
  const prevServing = useRef(serving)
  const [blink, setBlink] = useState<Record<Provider, number>>({ claude: 0, codex: 0 })
  useEffect(() => {
    const changed = PROVIDERS.filter((p) => prevServing.current[p] !== serving[p])
    prevServing.current = serving
    if (changed.length > 0) setBlink((b) => ({ ...b, ...Object.fromEntries(changed.map((p) => [p, Date.now()])) }))
  }, [serving.claude, serving.codex])

  // Scroll the selection into view.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector(`[data-id="${selectedId}"]`)?.scrollIntoView({ block: "nearest" })
  }, [selectedId])

  // ------------------------------------------------------------------------------------------
  // Actions (guarded while the daemon is unreachable)

  const guard = (f: () => void) => {
    if (down) {
      say("daemon unreachable: changes are paused until it's back", "bad")
      return
    }
    f()
  }
  const select = (a: Account | undefined) => {
    if (a === undefined) return
    setSelectedId(a.id)
    setRenaming(false)
    setConfirmRemove(null)
  }
  const moveSel = (d: 1 | -1) => {
    if (ordered.length === 0) return
    const i = selected === null ? 0 : ordered.indexOf(selected)
    select(ordered[Math.max(0, Math.min(ordered.length - 1, i + d))])
  }
  const reorder = (a: Account, d: 1 | -1) =>
    guard(() => {
      const n = accountsOf(s.accounts, a.provider).length
      if ((d === -1 && a.priority === 1) || (d === 1 && a.priority === n)) {
        say(`${a.label} is already ${d === -1 ? "first" : "last"} in the ${providerName[a.provider]} pool`)
        return
      }
      actions.move(a.id, d)
      say(`${a.label} → priority ${a.priority + d}`, "ok")
    })
  const toggle = (a: Account) =>
    guard(() => {
      actions.setEnabled(a.id, !a.enabled)
      say(a.enabled ? `${a.label} disabled · left the ${providerName[a.provider]} pool` : `${a.label} enabled · back in the pool`, "ok")
    })
  const startRename = (a: Account) =>
    guard(() => {
      setSelectedId(a.id)
      setDraft(a.label)
      setRenaming(true)
    })
  const commitRename = () => {
    if (selected !== null) actions.rename(selected.id, draft)
    setRenaming(false)
  }
  const askRemove = (a: Account) =>
    guard(() => {
      setSelectedId(a.id)
      setConfirmRemove(a.id)
    })
  const doRemove = (a: Account) => {
    actions.remove(a.id)
    setConfirmRemove(null)
    say(`removed ${a.label}`, "ok")
  }
  const startAdd = (opts: { provider?: Provider; reauthId?: string } = {}) =>
    guard(() => {
      setRenaming(false)
      setConfirmRemove(null)
      setMode({ kind: "add", n: ++addSeq, ...opts })
    })
  const endAdd = (id: string | null) => {
    setMode({ kind: "detail" })
    if (id !== null) setSelectedId(id)
  }
  const copyText = (text: string, what: string) => void copy(text).then(() => say(what, "ok"))

  // ------------------------------------------------------------------------------------------
  // Keyboard

  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      setConnect(false)
      setPalette((p) => !p)
      return
    }
    if (palette || connect || mode.kind === "add") return
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(document.activeElement)) return

    if (confirmRemove !== null) {
      const a = ordered.find((x) => x.id === confirmRemove)
      if ((e.key === "d" || e.key === "y") && a !== undefined) doRemove(a)
      else setConfirmRemove(null)
      e.preventDefault()
      return
    }
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault()
        moveSel(1)
        break
      case "k":
      case "ArrowUp":
        e.preventDefault()
        moveSel(-1)
        break
      case "g":
        select(ordered[0])
        break
      case "G":
        select(ordered[ordered.length - 1])
        break
      case "J":
        if (selected !== null) reorder(selected, 1)
        break
      case "K":
        if (selected !== null) reorder(selected, -1)
        break
      case "e":
        if (selected !== null) {
          e.preventDefault()
          startRename(selected)
        }
        break
      case " ":
        e.preventDefault()
        if (selected !== null) toggle(selected)
        break
      case "d":
        if (selected !== null) askRemove(selected)
        break
      case "s":
        if (selected !== null && statusOf(selected).kind === "signin") startAdd({ reauthId: selected.id })
        break
      case "a":
        startAdd()
        break
      case "c":
        setConnect(true)
        break
    }
  }
  const keyRef = useRef(onKey)
  keyRef.current = onKey
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
  }, [])

  // ------------------------------------------------------------------------------------------
  // Command palette

  const commands: Command[] = [
    { id: "add", label: "Add account", group: "accounts", hint: "a", run: () => startAdd() },
    ...PROVIDERS.map((p) => ({
      id: `add-${p}`,
      label: `Add ${providerName[p]} account`,
      group: "accounts",
      run: () => startAdd({ provider: p }),
    })),
    ...ordered.flatMap((a): Command[] => {
      const g = `${providerName[a.provider]} · ${a.label}`
      const n = accountsOf(s.accounts, a.provider).length
      return [
        ...(statusOf(a).kind === "signin"
          ? [{ id: `si-${a.id}`, label: `Sign in again: ${a.label}`, group: g, hint: "s", run: () => startAdd({ reauthId: a.id }) }]
          : []),
        { id: `go-${a.id}`, label: `Go to ${a.label}`, group: g, run: () => select(a) },
        {
          id: `tg-${a.id}`,
          label: `${a.enabled ? "Disable" : "Enable"} ${a.label}`,
          group: g,
          hint: "space",
          run: () => {
            select(a)
            toggle(a)
          },
        },
        ...(a.priority > 1
          ? [{ id: `up-${a.id}`, label: `Move ${a.label} up`, group: g, hint: "K", run: () => (select(a), reorder(a, -1)) }]
          : []),
        ...(a.priority < n
          ? [{ id: `dn-${a.id}`, label: `Move ${a.label} down`, group: g, hint: "J", run: () => (select(a), reorder(a, 1)) }]
          : []),
        { id: `rn-${a.id}`, label: `Rename ${a.label}`, group: g, hint: "e", run: () => startRename(a) },
        { id: `rm-${a.id}`, label: `Remove ${a.label}`, group: g, hint: "d", run: () => askRemove(a) },
      ]
    }),
    { id: "connect", label: "Connect clients", group: "clients", hint: "c", run: () => setConnect(true) },
    ...CLIENTS.map((c) => ({
      id: `cp-${c.id}`,
      label: `Copy connect command: ${c.id}`,
      group: "clients",
      run: () => copyText(c.command, `copied: ${c.command}`),
    })),
    { id: "key", label: "Copy proxy key", group: "clients", run: () => copyText(s.proxyKey, "copied the proxy key") },
    { id: "addr", label: `Copy address: ${s.daemon.address}`, group: "clients", run: () => copyText(s.daemon.address, "copied the address") },
  ]

  // ------------------------------------------------------------------------------------------
  // Render

  const modeChip =
    palette ? "COMMAND" : mode.kind === "add" ? (mode.reauthId !== undefined ? "SIGN IN" : "ADD") : confirmRemove !== null ? "CONFIRM" : renaming ? "RENAME" : "NORMAL"
  const confirmAccount = ordered.find((a) => a.id === confirmRemove)

  return (
    <div className={`vC ${down ? "vC-down" : ""}`}>
      <div className="vC-window">
        <header className="vC-title">
          <div className="vC-brand">
            <span className="vC-logo" aria-hidden="true">
              ▚
            </span>
            <b>agent-proxy</b>
            <span className="vC-muted">~/accounts</span>
          </div>
          <div className="vC-title-right">
            <span className={`vC-daemon ${down ? "bad" : "ok"}`}>
              <span className="vC-dot" />
              {down ? "unreachable" : "running"} <span className="vC-muted">{s.daemon.address}</span>
            </span>
            <button className="vC-btn vC-ghost" onClick={() => setPalette(true)}>
              commands <Kbd>⌘K</Kbd>
            </button>
            <button className="vC-btn" onClick={() => setConnect(true)}>
              Connect clients <Kbd>c</Kbd>
            </button>
          </div>
        </header>

        {down && (
          <div className="vC-banner" role="alert">
            <b>✕ Can't reach the daemon at {s.daemon.address}.</b> Showing the last state it reported; changes are paused.
            This page reconnects on its own once the daemon is running.
          </div>
        )}

        <div className="vC-body">
          <nav className="vC-list" ref={listRef} aria-label="Accounts">
            {PROVIDERS.map((p) => {
              const accts = accountsOf(s.accounts, p)
              const ps = poolState(s.accounts, p)
              const pt = poolText(ps)
              return (
                <section key={p} className="vC-group">
                  <div className="vC-group-head">
                    <span className="vC-group-name">
                      <ProviderMark provider={p} size={13} />
                      {providerName[p].toUpperCase()}
                      <span className="vC-muted">{accts.length}</span>
                    </span>
                    <span className="vC-rule" />
                    <span key={blink[p]} className={`vC-pool vC-tone-${pt.tone} ${blink[p] > 0 ? "vC-blink" : ""}`} title="Pool: where new sessions go">
                      {pt.text}
                    </span>
                    <button
                      className="vC-icon-btn"
                      aria-label={`Add ${providerName[p]} account`}
                      title={`Add ${providerName[p]} account`}
                      onClick={() => startAdd({ provider: p })}
                    >
                      +
                    </button>
                  </div>
                  {accts.length === 0 && (
                    <button className="vC-empty-row" onClick={() => startAdd({ provider: p })}>
                      no {providerName[p]} accounts · press <Kbd>a</Kbd> to add one
                    </button>
                  )}
                  <ul role="listbox" aria-label={`${providerName[p]} accounts`}>
                    {accts.map((a) => {
                      const st = statusOf(a)
                      const f = flash[a.id]
                      const isServing = serving[p] === a.id
                      const right =
                        st.kind === "cooling"
                          ? `until ${formatClock(st.until)}`
                          : st.kind === "signin"
                            ? "sign in"
                            : st.kind === "disabled"
                              ? "off"
                              : lastUsedText(a.lastUsedAt, now)
                      return (
                        <li key={a.id} role="presentation">
                          <button
                            data-id={a.id}
                            role="option"
                            aria-selected={a.id === selectedId}
                            className={[
                              "vC-row",
                              a.id === selectedId && mode.kind === "detail" ? "sel" : "",
                              a.id === selectedId ? "cur" : "",
                              st.kind === "disabled" ? "off" : "",
                              f !== undefined ? (f.live ? "flash-live" : "flash") : "",
                            ].join(" ")}
                            onClick={() => {
                              setMode({ kind: "detail" })
                              select(a)
                            }}
                            onDoubleClick={() => startRename(a)}
                          >
                            <span className={`vC-arrow ${isServing ? "on" : ""}`} aria-hidden="true">
                              {isServing ? "→" : ""}
                            </span>
                            <span className="vC-prio">{a.priority}</span>
                            <Glyph status={st} />
                            <span className="vC-row-label">{a.label}</span>
                            <PlanBadge plan={a.plan} />
                            <span className={`vC-row-right vC-st-${st.kind}`}>{right}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
            <div className="vC-list-foot">
              <button className="vC-btn vC-ghost" onClick={() => startAdd()}>
                + add account <Kbd>a</Kbd>
              </button>
            </div>
          </nav>

          <div className="vC-right">
            {mode.kind === "add" ? (
              <AddPane
                key={mode.n}
                {...(mode.provider === undefined ? {} : { provider: mode.provider })}
                {...(mode.reauthId === undefined ? {} : { reauthId: mode.reauthId })}
                onDone={endAdd}
              />
            ) : selected === null ? (
              <Welcome onAdd={(p) => startAdd({ provider: p })} onCopy={copyText} />
            ) : (
              <Detail
                a={selected}
                now={now}
                serving={serving[selected.provider] === selected.id}
                servingLabel={ordered.find((x) => x.id === serving[selected.provider])?.label ?? null}
                poolSize={accountsOf(s.accounts, selected.provider).length}
                renaming={renaming}
                draft={draft}
                setDraft={setDraft}
                commitRename={commitRename}
                cancelRename={() => setRenaming(false)}
                confirming={confirmAccount?.id === selected.id}
                onRename={() => startRename(selected)}
                onToggle={() => toggle(selected)}
                onUp={() => reorder(selected, -1)}
                onDown={() => reorder(selected, 1)}
                onRemove={() => askRemove(selected)}
                onConfirmRemove={() => doRemove(selected)}
                onCancelRemove={() => setConfirmRemove(null)}
                onSignIn={() => startAdd({ reauthId: selected.id })}
              />
            )}

            <section className="vC-events" aria-label="Events">
              <div className="vC-events-head">
                <span className="vC-sect">events</span>
                <span className="vC-muted">tail -f · newest first</span>
              </div>
              <ol>
                {s.events.slice(0, 30).map((e) => (
                  <li key={e.id} className={e.live ? "live" : ""}>
                    <span className="vC-muted">{clockSeconds(e.at)}</span>
                    <span className="vC-ev-mark">{e.live ? "⚡" : "·"}</span>
                    <span>{e.message}</span>
                  </li>
                ))}
                {s.events.length === 0 && (
                  <li className="vC-muted vC-events-empty">
                    <span className="vC-cursor" /> waiting for events from the daemon…
                  </li>
                )}
              </ol>
            </section>
          </div>
        </div>

        <footer className={`vC-status ${down ? "bad" : ""}`}>
          <span className={`vC-mode vC-mode-${modeChip.toLowerCase().replace(" ", "")}`}>{modeChip}</span>
          <span className="vC-status-daemon">
            {down ? "✕ daemon unreachable" : "● daemon running"} <span className="vC-sep">│</span> {s.daemon.address}{" "}
            <span className="vC-sep">│</span> {down ? "reconnecting…" : `up ${uptime(s.daemon.startedAt, now)}`}{" "}
            <span className="vC-sep">│</span> v{s.daemon.version}
          </span>
          {confirmRemove !== null && confirmAccount !== undefined ? (
            <span className="vC-msg vC-msg-bad" role="status">
              Remove {confirmAccount.label}? press <Kbd>d</Kbd> again or <Kbd>y</Kbd> to confirm, <Kbd>Esc</Kbd> to cancel
            </span>
          ) : msg !== null ? (
            <span className={`vC-msg vC-msg-${msg.tone}`} key={msg.at} role="status">
              {msg.text}
            </span>
          ) : (
          <span className="vC-hints">
            {mode.kind === "add" ? (
              <>
                <Kbd>1</Kbd>/<Kbd>2</Kbd> provider · <Kbd>o</Kbd> open again · <Kbd>p</Kbd> paste · <Kbd>esc</Kbd> cancel
              </>
            ) : (
              <>
                <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>J</Kbd>/<Kbd>K</Kbd> reorder · <Kbd>e</Kbd> rename · <Kbd>space</Kbd>{" "}
                enable/disable · <Kbd>d</Kbd> remove · <Kbd>a</Kbd> add · <Kbd>c</Kbd> connect · <Kbd>⌘K</Kbd> commands
              </>
            )}
          </span>
          )}
        </footer>

        {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
        {connect && (
          <ConnectPanel
            address={s.daemon.address}
            proxyKey={s.proxyKey}
            onClose={() => setConnect(false)}
            onCopied={(w) => say(w, "ok")}
          />
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------------------------

function Detail(p: {
  a: Account
  now: number
  serving: boolean
  servingLabel: string | null
  poolSize: number
  renaming: boolean
  draft: string
  setDraft: (s: string) => void
  commitRename: () => void
  cancelRename: () => void
  confirming: boolean
  onRename: () => void
  onToggle: () => void
  onUp: () => void
  onDown: () => void
  onRemove: () => void
  onConfirmRemove: () => void
  onCancelRemove: () => void
  onSignIn: () => void
}) {
  const { a, now } = p
  const st = statusOf(a)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (p.renaming) inputRef.current?.select()
  }, [p.renaming])

  const statusLine = (() => {
    switch (st.kind) {
      case "active":
        return p.serving ? (
          <>gets new {providerName[a.provider]} sessions</>
        ) : (
          <>standing by{p.servingLabel !== null ? ` behind ${p.servingLabel}` : ""}</>
        )
      case "cooling":
        return (
          <>
            until <b>{formatClock(st.until)}</b> <span className="vC-muted">({countdown(st.until, now)})</span>
            {p.servingLabel === null && a.enabled && (
              <div className="vC-warn">No other {providerName[a.provider]} account can take new sessions right now.</div>
            )}
          </>
        )
      case "signin":
        return <>its login expired; the pool skips it until you sign in again</>
      case "disabled":
        return <>turned off; not in the pool</>
    }
  })()

  return (
    <section className="vC-pane vC-detail" aria-label={`${a.label} details`}>
      <header className="vC-pane-head">
        <span className="vC-crumb">
          <span className="vC-muted">accounts / {providerName[a.provider].toLowerCase()} /</span> {a.label}
        </span>
        <span className="vC-muted">
          {a.priority} of {p.poolSize}
        </span>
      </header>

      <div className="vC-detail-hero">
        <ProviderMark provider={a.provider} size={28} />
        <div className="vC-detail-id">
          {p.renaming ? (
            <form
              className="vC-prompt vC-rename"
              onSubmit={(e) => {
                e.preventDefault()
                p.commitRename()
              }}
            >
              <span className="vC-caret">›</span>
              <input
                ref={inputRef}
                aria-label="Label"
                value={p.draft}
                onChange={(e) => p.setDraft(e.target.value)}
                onBlur={p.commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault()
                    p.cancelRename()
                  }
                }}
                spellCheck={false}
              />
              <span className="vC-muted">
                <Kbd>↵</Kbd> save <Kbd>esc</Kbd> cancel
              </span>
            </form>
          ) : (
            <h2 onDoubleClick={p.onRename}>{a.label}</h2>
          )}
          <div className="vC-muted">{a.email}</div>
        </div>
      </div>

      <div className={`vC-status-card vC-sc-${st.kind}`}>
        <span className="vC-sc-glyph">
          <Glyph status={st} />
        </span>
        <div>
          <div className="vC-sc-label">
            {statusLabel(st)}
            {p.serving && <span className="vC-serving-tag">→ serving</span>}
          </div>
          <div className="vC-sc-line">{statusLine}</div>
        </div>
        {st.kind === "signin" && (
          <button className="vC-btn vC-primary" onClick={p.onSignIn}>
            Sign in again <Kbd>s</Kbd>
          </button>
        )}
      </div>

      <dl className="vC-fields">
        <dt>provider</dt>
        <dd>{providerName[a.provider]}</dd>
        <dt>plan</dt>
        <dd>
          <PlanBadge plan={a.plan} /> <span className="vC-muted">{a.plan}</span>
        </dd>
        <dt>priority</dt>
        <dd>
          <span className="vC-prio-big">{a.priority}</span>
          <span className="vC-muted"> of {p.poolSize}</span>
          <span className="vC-inline-btns">
            <button className="vC-icon-btn" onClick={p.onUp} disabled={a.priority === 1} aria-label="Move up" title="Move up (K)">
              ↑
            </button>
            <button className="vC-icon-btn" onClick={p.onDown} disabled={a.priority === p.poolSize} aria-label="Move down" title="Move down (J)">
              ↓
            </button>
          </span>
          {!a.enabled && <span className="vC-muted"> · skipped while disabled</span>}
        </dd>
        <dt>last used</dt>
        <dd>{lastUsedText(a.lastUsedAt, now)}</dd>
        <dt>added</dt>
        <dd>{lastUsedText(a.addedAt, now)}</dd>
      </dl>

      {p.confirming ? (
        <div className="vC-confirm" role="alert">
          <div>
            <b>Remove {a.label}?</b> agent-proxy forgets this login. To use it again you'd add it and sign in again.
          </div>
          <div className="vC-row-actions">
            <button className="vC-btn vC-danger" onClick={p.onConfirmRemove}>
              remove <Kbd>y</Kbd>
            </button>
            <button className="vC-btn vC-ghost" onClick={p.onCancelRemove}>
              keep it <Kbd>esc</Kbd>
            </button>
          </div>
        </div>
      ) : (
        <div className="vC-actions">
          <button className="vC-btn" onClick={p.onRename}>
            rename <Kbd>e</Kbd>
          </button>
          <button className="vC-btn" onClick={p.onUp} disabled={a.priority === 1}>
            move up <Kbd>K</Kbd>
          </button>
          <button className="vC-btn" onClick={p.onDown} disabled={a.priority === p.poolSize}>
            move down <Kbd>J</Kbd>
          </button>
          <button className="vC-btn" onClick={p.onToggle} role="switch" aria-checked={a.enabled}>
            <span className={`vC-toggle ${a.enabled ? "on" : ""}`} aria-hidden="true" />
            {a.enabled ? "enabled" : "disabled"} <Kbd>space</Kbd>
          </button>
          <button className="vC-btn vC-danger-ghost" onClick={p.onRemove}>
            remove <Kbd>d</Kbd>
          </button>
        </div>
      )}
    </section>
  )
}

function Welcome(p: { onAdd: (provider: Provider) => void; onCopy: (text: string, what: string) => void }) {
  return (
    <section className="vC-pane vC-welcome" aria-label="Getting started">
      <pre className="vC-ascii" aria-hidden="true">{`claude code ──┐
codex ────────┼──▶ agent-proxy · 127.0.0.1:8318
opencode ─────┘`}</pre>
      <h2>No accounts yet</h2>
      <p className="vC-prose">
        Add the Claude and Codex accounts you already pay for. Each client then spends its own provider's pool, through
        this one address.
      </p>
      <ol className="vC-getting">
        <li>
          <span className="vC-step-n">1</span>
          <div>
            <b>Add an account</b> <span className="vC-muted">· or press <Kbd>a</Kbd></span>
            <div className="vC-row-actions">
              {PROVIDERS.map((pr) => (
                <button key={pr} className="vC-btn" onClick={() => p.onAdd(pr)}>
                  <ProviderMark provider={pr} size={13} /> {providerName[pr]} account
                </button>
              ))}
            </div>
          </div>
        </li>
        <li>
          <span className="vC-step-n">2</span>
          <div>
            <b>Connect your clients</b>
            {CLIENTS.map((c) => (
              <button key={c.id} className="vC-cmd" onClick={() => p.onCopy(c.command, `copied: ${c.command}`)}>
                <span className="vC-dollar">$</span>
                <span className="vC-cmd-text">{c.command}</span>
                <span className="vC-cmd-copy">copy</span>
              </button>
            ))}
          </div>
        </li>
      </ol>
    </section>
  )
}
