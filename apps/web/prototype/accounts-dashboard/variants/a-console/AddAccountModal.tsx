// PROTOTYPE variant A: add-account / "Sign in again" modal. Mounted only while open, so the flow resets.
import { useMemo, useState } from "react"

import { EXAMPLE_CALLBACK, useAddAccountFlow } from "../../shared/addFlow.ts"
import { IconAlert, IconArrowRight, IconCheck, IconChevronLeft, IconExternal, ProviderMark } from "../../shared/icons.tsx"
import {
  CLIENTS,
  PLANS,
  type Provider,
  accountsOf,
  planShort,
  planTier,
  providerLoginHost,
  providerName,
} from "../../shared/model.ts"
import { actions, useDashboard } from "../../shared/store.ts"
import { CopyButton, Modal, Spinner } from "./ui.tsx"

const clientsFor = (p: Provider) =>
  CLIENTS.filter((c) => c.providers.includes(p))
    .map((c) => c.name)
    .join(" and ")

export function AddAccountModal(props: {
  provider: Provider | undefined
  reauthAccountId: string | undefined
  onClose: () => void
}) {
  const { onClose } = props
  const opts =
    props.reauthAccountId !== undefined
      ? { reauthAccountId: props.reauthAccountId }
      : props.provider !== undefined
        ? { provider: props.provider }
        : undefined
  const flow = useAddAccountFlow(opts)
  const s = useDashboard()
  const step = flow.step
  const reauth = props.reauthAccountId === undefined ? undefined : s.accounts.find((a) => a.id === props.reauthAccountId)

  if (step.kind === "pick") {
    return (
      <Modal title="Add an account" subtitle="Pick a provider. Its sign-in page opens in a new tab." onClose={onClose} width={520}>
        <div className="vA-pick">
          {(["claude", "codex"] as const).map((p) => (
            <button key={p} type="button" className="vA-pick-card" onClick={() => flow.choose(p)}>
              <span className="vA-pick-mark">
                <ProviderMark provider={p} size={26} />
              </span>
              <span className="vA-pick-text">
                <b>{providerName[p]}</b>
                <span>{PLANS[p].map(planShort).join(", ")}</span>
                <span className="vA-pick-clients">Used by {clientsFor(p)}</span>
              </span>
              <IconArrowRight size={16} />
            </button>
          ))}
        </div>
      </Modal>
    )
  }

  if (step.kind === "success") {
    const acc = s.accounts.find((a) => a.id === step.accountId)
    return (
      <SuccessStep
        key={step.accountId}
        accountId={step.accountId}
        reauth={step.reauth}
        label={acc?.label ?? ""}
        email={acc?.email ?? ""}
        plan={acc === undefined ? "" : acc.plan}
        tier={acc === undefined ? 1 : planTier(acc.plan)}
        provider={step.provider}
        priority={acc?.priority ?? 0}
        poolSize={accountsOf(s.accounts, step.provider).length}
        onClose={onClose}
      />
    )
  }

  const provider = step.provider
  const title = reauth !== undefined ? `Sign in again to ${reauth.label}` : `Sign in to ${providerName[provider]}`
  const subtitle =
    reauth !== undefined ? (
      <>
        Sign in as <b>{reauth.email}</b> to put this account back in the {providerName[provider]} pool.
      </>
    ) : (
      `agent-proxy adds the account it signs in as to the ${providerName[provider]} pool.`
    )

  return (
    <Modal title={title} subtitle={subtitle} icon={<ProviderMark provider={provider} size={22} />} onClose={onClose} width={540}>
      {step.kind === "verifying" ? (
        <div className="vA-wait">
          <Spinner size={22} />
          <div>
            <b>Finishing sign-in…</b>
            <p>Checking the account and its plan with {providerName[provider]}.</p>
          </div>
        </div>
      ) : (
        <WaitingStep
          provider={provider}
          popupBlocked={step.popupBlocked}
          pasteError={step.pasteError}
          loginUrl={flow.loginUrl}
          onOpen={flow.openLogin}
          onPaste={flow.pasteCallback}
          onBack={reauth === undefined && props.provider === undefined ? flow.back : undefined}
        />
      )}
    </Modal>
  )
}

function WaitingStep(props: {
  provider: Provider
  popupBlocked: boolean
  pasteError: string | null
  loginUrl: (p: Provider) => string
  onOpen: () => void
  onPaste: (url: string) => string | null
  onBack: (() => void) | undefined
}) {
  const { provider, loginUrl } = props
  const [pasteOpen, setPasteOpen] = useState(false)
  const [url, setUrl] = useState("")
  const login = useMemo(() => loginUrl(provider), [loginUrl, provider])
  return (
    <div className="vA-waiting">
      {props.popupBlocked ? (
        <div className="vA-callout is-warn">
          <IconAlert size={16} />
          <div>
            <b>Your browser blocked the new tab.</b>
            <p>Open the {providerName[provider]} sign-in page yourself, then come back here.</p>
          </div>
          <button type="button" className="vA-btn vA-btn-primary" onClick={props.onOpen}>
            Open sign-in page <IconExternal size={13} />
          </button>
        </div>
      ) : (
        <div className="vA-wait">
          <Spinner size={22} />
          <div>
            <b>Waiting for you to finish signing in…</b>
            <p>
              We opened {providerLoginHost[provider]} in a new tab. Approve agent-proxy there and this dialog moves on by itself.
            </p>
            <button type="button" className="vA-linkbtn" onClick={props.onOpen}>
              Open sign-in page again <IconExternal size={12} />
            </button>
          </div>
        </div>
      )}

      <div className={`vA-paste ${pasteOpen ? "is-open" : ""}`}>
        <button type="button" className="vA-paste-toggle" onClick={() => setPasteOpen(!pasteOpen)} aria-expanded={pasteOpen}>
          <span className="vA-chev">›</span> Signing in over SSH or on a headless box? Paste the callback URL
        </button>
        {pasteOpen && (
          <div className="vA-paste-body">
            <ol>
              <li>
                Open this URL in a browser on any machine:
                <div className="vA-urlbox">
                  <code>{login}</code>
                  <CopyButton text={login} label="Copy sign-in URL" />
                </div>
              </li>
              <li>
                Sign in. The browser ends up on a page that won't load, at an address starting with{" "}
                <code className="vA-inline">http://127.0.0.1:8318/callback</code>. Copy that whole address.
              </li>
              <li>Paste it here:</li>
            </ol>
            <form
              className="vA-paste-form"
              onSubmit={(e) => {
                e.preventDefault()
                props.onPaste(url)
              }}
            >
              <input
                className={`vA-input vA-mono ${props.pasteError !== null ? "is-error" : ""}`}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={EXAMPLE_CALLBACK}
                spellCheck={false}
                aria-label="Callback URL"
                autoFocus
              />
              <button type="submit" className="vA-btn vA-btn-primary" disabled={url.trim() === ""}>
                Continue
              </button>
            </form>
            {props.pasteError !== null && <p className="vA-error">{props.pasteError}</p>}
          </div>
        )}
      </div>

      {props.onBack !== undefined && (
        <button type="button" className="vA-linkbtn vA-back" onClick={props.onBack}>
          <IconChevronLeft size={13} /> Choose a different provider
        </button>
      )}
    </div>
  )
}

function SuccessStep(props: {
  accountId: string
  reauth: boolean
  label: string
  email: string
  plan: string
  tier: 1 | 2 | 3
  provider: Provider
  priority: number
  poolSize: number
  onClose: () => void
}) {
  const [label, setLabel] = useState(props.label)
  const done = () => {
    actions.rename(props.accountId, label)
    props.onClose()
  }
  return (
    <Modal
      title={props.reauth ? `${props.label} is signed in again` : `${providerName[props.provider]} account added`}
      subtitle={
        props.reauth
          ? `It's back in the ${providerName[props.provider]} pool at priority ${props.priority}.`
          : props.poolSize > 1
            ? `It joins the ${providerName[props.provider]} pool at priority ${props.priority} of ${props.poolSize}. Drag it higher to use it first.`
            : `It's the first account in the ${providerName[props.provider]} pool, so it gets new sessions right away.`
      }
      icon={
        <span className="vA-success-icon">
          <IconCheck size={18} />
        </span>
      }
      onClose={done}
      width={500}
      footer={
        <button type="button" className="vA-btn vA-btn-primary" onClick={done}>
          Done
        </button>
      }
    >
      <form
        className="vA-success"
        onSubmit={(e) => {
          e.preventDefault()
          done()
        }}
      >
        <div className="vA-success-card">
          <ProviderMark provider={props.provider} size={20} />
          <div>
            <div className="vA-success-email">{props.email}</div>
            <div className="vA-muted">Signed in · Active</div>
          </div>
          <span className="vA-plan" data-tier={props.tier}>
            {props.plan}
          </span>
        </div>
        {!props.reauth && (
          <label className="vA-field">
            <span>Label</span>
            <input className="vA-input" value={label} onChange={(e) => setLabel(e.target.value)} data-autofocus />
            <small>Only you see this. Pick something that tells your accounts apart.</small>
          </label>
        )}
      </form>
    </Modal>
  )
}
