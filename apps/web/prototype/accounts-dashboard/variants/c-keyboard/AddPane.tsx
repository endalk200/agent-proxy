// PROTOTYPE variant C: the add-account / "Sign in again" flow, rendered in the right pane.
import { useEffect, useRef, useState } from "react"

import { EXAMPLE_CALLBACK, useAddAccountFlow } from "../../shared/addFlow.ts"
import { ProviderMark } from "../../shared/icons.tsx"
import { type Provider, PROVIDERS, providerLoginHost, providerName } from "../../shared/model.ts"
import { actions, useDashboard } from "../../shared/store.ts"
import { Kbd, PlanBadge, isTyping, spinnerFrame } from "./bits.tsx"

export function AddPane(props: {
  provider?: Provider
  reauthId?: string
  onDone: (accountId: string | null) => void
}) {
  const { onDone } = props
  const flow = useAddAccountFlow({
    ...(props.reauthId === undefined ? {} : { reauthAccountId: props.reauthId }),
    ...(props.provider === undefined ? {} : { provider: props.provider }),
  })
  const s = useDashboard()
  const { step } = flow
  const [tick, setTick] = useState(Date.now)
  const [waitStart, setWaitStart] = useState(Date.now)
  const [paste, setPaste] = useState("")
  const [label, setLabel] = useState("")
  const labelRef = useRef<HTMLInputElement>(null)
  const reauth = props.reauthId === undefined ? undefined : s.accounts.find((a) => a.id === props.reauthId)

  const spinning = step.kind === "waiting" || step.kind === "verifying"
  useEffect(() => {
    if (!spinning) return
    const t = setInterval(() => setTick(Date.now()), 90)
    return () => clearInterval(t)
  }, [spinning])

  useEffect(() => {
    if (step.kind === "waiting") setWaitStart(Date.now())
  }, [step.kind])

  const account = step.kind === "success" ? s.accounts.find((a) => a.id === step.accountId) : undefined
  useEffect(() => {
    if (step.kind === "success" && account !== undefined) {
      setLabel(account.label)
      requestAnimationFrame(() => {
        labelRef.current?.focus()
        labelRef.current?.select()
      })
    }
  }, [step.kind])

  const finish = () => {
    if (step.kind !== "success") return
    if (!step.reauth) actions.rename(step.accountId, label)
    onDone(step.accountId)
  }
  const finishRef = useRef(finish)
  finishRef.current = finish

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "Escape") {
        e.preventDefault()
        if (step.kind === "success") finishRef.current()
        else onDone(null)
        return
      }
      if (isTyping(document.activeElement)) return
      if (step.kind === "pick") {
        if (e.key === "1") flow.choose("claude")
        if (e.key === "2") flow.choose("codex")
      } else if (step.kind === "waiting") {
        if (e.key === "o") flow.openLogin()
        if (e.key === "p") {
          e.preventDefault()
          document.getElementById("vC-paste")?.focus()
        }
        if (e.key === "b" && reauth === undefined) flow.back()
      } else if (step.kind === "success" && e.key === "Enter") {
        finishRef.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [step, flow, onDone, reauth])

  const title = reauth !== undefined ? `sign in again · ${reauth.label}` : "add account"

  return (
    <section className="vC-pane vC-add" aria-label={title}>
      <header className="vC-pane-head">
        <span className="vC-crumb">
          <span className="vC-muted">accounts /</span> {title}
        </span>
        <button className="vC-btn vC-ghost" onClick={() => (step.kind === "success" ? finish() : onDone(null))}>
          {step.kind === "success" ? "done" : "cancel"} <Kbd>esc</Kbd>
        </button>
      </header>

      <ol className="vC-steps" aria-label="Progress">
        {(["pick", "waiting", "success"] as const).map((k, i) => {
          const order = { pick: 0, waiting: 1, verifying: 1, success: 3 }[step.kind]
          return (
            <li key={k} className={i < order ? "done" : i === order ? "now" : ""}>
              <span>{i < order ? "✓" : i + 1}</span>
              {["provider", "sign in", "done"][i]}
            </li>
          )
        })}
      </ol>

      {step.kind === "pick" && (
        <div className="vC-add-body">
          <p className="vC-prose">Which provider is this account for? Its login opens in a new tab.</p>
          <div className="vC-choices">
            {PROVIDERS.map((p, i) => (
              <button key={p} className="vC-choice" onClick={() => flow.choose(p)}>
                <Kbd>{i + 1}</Kbd>
                <ProviderMark provider={p} size={22} />
                <span>
                  <b>{providerName[p]}</b>
                  <small>
                    {p === "claude" ? "Pro · Max 5x · Max 20x" : "ChatGPT Plus · Pro"} — signs in at {providerLoginHost[p]}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {step.kind === "waiting" && (
        <div className="vC-add-body">
          <div className="vC-wait">
            <span className="vC-spin">{spinnerFrame(tick)}</span>
            <div>
              <div>
                waiting for you to finish signing in…{" "}
                <span className="vC-muted">{Math.floor((tick - waitStart) / 1000)}s</span>
              </div>
              <div className="vC-muted">
                {step.popupBlocked ? (
                  <span className="vC-warn">
                    the browser blocked the new tab. press <Kbd>o</Kbd> to open {providerLoginHost[step.provider]} again
                  </span>
                ) : (
                  <>opened {providerLoginHost[step.provider]} in a new tab</>
                )}
              </div>
            </div>
          </div>
          <div className="vC-row-actions">
            <button className="vC-btn" onClick={flow.openLogin}>
              open sign-in page again <Kbd>o</Kbd>
            </button>
            {reauth === undefined && (
              <button className="vC-btn vC-ghost" onClick={flow.back}>
                change provider <Kbd>b</Kbd>
              </button>
            )}
          </div>
          <code className="vC-url" title="Sign-in URL">
            {flow.loginUrl(step.provider)}
          </code>

          <div className="vC-paste">
            <label htmlFor="vC-paste">
              <span className="vC-sect">headless or over SSH?</span> Paste the callback URL your browser landed on{" "}
              <Kbd>p</Kbd>
            </label>
            <form
              className="vC-prompt"
              onSubmit={(e) => {
                e.preventDefault()
                flow.pasteCallback(paste)
              }}
            >
              <span className="vC-caret">›</span>
              <input
                id="vC-paste"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder="http://127.0.0.1:8318/callback?code=…"
                spellCheck={false}
                autoComplete="off"
              />
              <button className="vC-btn" type="submit" disabled={paste.trim() === ""}>
                use URL <Kbd>↵</Kbd>
              </button>
            </form>
            {step.pasteError !== null && <div className="vC-error">✕ {step.pasteError}</div>}
            <button className="vC-link" type="button" onClick={() => setPaste(EXAMPLE_CALLBACK)}>
              fill an example callback (prototype)
            </button>
          </div>
        </div>
      )}

      {step.kind === "verifying" && (
        <div className="vC-add-body">
          <div className="vC-wait">
            <span className="vC-spin">{spinnerFrame(tick)}</span>
            <div>
              <div>finishing sign-in with {providerName[step.provider]}…</div>
              <div className="vC-muted">exchanging the code · reading the account's plan</div>
            </div>
          </div>
        </div>
      )}

      {step.kind === "success" && account !== undefined && (
        <div className="vC-add-body">
          <div className="vC-success">
            <span className="vC-ok-mark">✓</span>
            <div>
              <div>
                {step.reauth ? `${account.label} is signed in again and back in the pool.` : "Signed in. The account joined the pool."}
              </div>
              <div className="vC-muted">
                <ProviderMark provider={account.provider} size={12} /> {account.email} · <PlanBadge plan={account.plan} /> · priority{" "}
                {account.priority}
              </div>
            </div>
          </div>
          {!step.reauth && (
            <form
              className="vC-paste"
              onSubmit={(e) => {
                e.preventDefault()
                finish()
              }}
            >
              <label htmlFor="vC-newlabel">
                <span className="vC-sect">label</span> Name it so you can tell accounts apart
              </label>
              <div className="vC-prompt">
                <span className="vC-caret">›</span>
                <input
                  id="vC-newlabel"
                  ref={labelRef}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="vC-btn vC-primary" type="submit">
                  finish <Kbd>↵</Kbd>
                </button>
              </div>
            </form>
          )}
          {step.reauth && (
            <button className="vC-btn vC-primary" onClick={finish}>
              done <Kbd>↵</Kbd>
            </button>
          )}
        </div>
      )}
    </section>
  )
}
