import { Dialog } from "@base-ui/react/dialog"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import type { Account, DaemonClient, DaemonFailure, Login, Provider } from "./daemon-api.ts"
import { clientsOf, planWeight, providerNames, statusLabels } from "./model.ts"
import {
  CopyButton,
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconPlus,
  IconX,
  ProviderMark,
  Spinner,
} from "./ui.tsx"
import { asFailure } from "./useDaemon.ts"

/**
 * The sign-in dialog: adding an account, or signing in again to one that
 * needs it. The daemon runs the login (ADR-0007); the dialog opens the
 * provider's sign-in page in a new tab and waits for the daemon to say how it
 * ended. Closing the dialog while it waits cancels the login in the daemon.
 */

/** What the dialog was opened for. */
export type SignInRequest =
  /** Add an account of `provider`, or of a provider the owner picks first. */
  | { readonly kind: "add"; readonly provider?: Provider }
  /** Sign in again to `account`, which needs it. */
  | { readonly kind: "again"; readonly account: Account }

/** Where the flow stands. */
type Step =
  | { readonly kind: "pick" }
  | {
      readonly kind: "starting"
      readonly provider: Provider
      /** Which of the dialog's logins this is: each try starts a new one. */
      readonly attempt: number
    }
  | {
      readonly kind: "waiting"
      readonly provider: Provider
      readonly attempt: number
      readonly login: Login
      /** True when the browser refused to open the sign-in page in a new tab. */
      readonly tabBlocked: boolean
    }
  | {
      readonly kind: "problem"
      readonly provider: Provider
      readonly title: string
      readonly message: string
      /** More on what to do, beside the message. */
      readonly hint?: string
    }
  | {
      readonly kind: "signed-in"
      readonly provider: Provider
      readonly account: Account
      readonly created: boolean
    }

/** Why a login ended without signing in, in words for the dialog. */
const ending = (login: Login): { readonly title: string; readonly message: string } => {
  switch (login.status) {
    case "expired":
      return {
        title: "The sign-in timed out",
        message: "Nobody finished signing in within 10 minutes, so the daemon stopped waiting.",
      }
    case "cancelled":
      return {
        title: "The sign-in was cancelled",
        message: `Another ${providerNames[login.provider]} sign-in started, perhaps from the CLI, and took its place.`,
      }
    default:
      return {
        title: "The sign-in failed",
        message: login.error ?? "The daemon did not say why.",
      }
  }
}

/** What went wrong talking to the daemon, in words for the dialog. */
const daemonTrouble = (failure: DaemonFailure): string =>
  failure.kind === "unreachable"
    ? "Can't reach the daemon. Is it running? Start it with agent-proxy daemon start."
    : failure.message

const providerOf = (request: SignInRequest): Provider | undefined =>
  request.kind === "again" ? request.account.provider : request.provider

/** Opens `url` in a new tab that cannot reach back into the dashboard; false when the browser refused. */
const openTab = (url: string): boolean => {
  const tab = window.open(url, "_blank")
  if (tab === null) return false
  tab.opener = null
  return true
}

export function SignInDialog(props: {
  request: SignInRequest | undefined
  client: DaemonClient
  /** How often a waiting login is asked how it stands, in milliseconds. */
  pollInterval: number
  /** A login added or updated an account. */
  onSignedIn: () => void
  rename: (account: Account, label: string) => void
  onClose: () => void
}) {
  // The dialog keeps showing its last step while it animates closed.
  const [shown, setShown] = useState(props.request)
  const [opening, setOpening] = useState(0)
  if (props.request !== undefined && props.request !== shown) {
    setShown(props.request)
    setOpening(opening + 1)
  }
  const request = props.request ?? shown

  return (
    <Dialog.Root
      open={props.request !== undefined}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="dialog dialog-signin">
          {request !== undefined && (
            <SignInFlow
              key={opening}
              request={request}
              open={props.request !== undefined}
              client={props.client}
              pollInterval={props.pollInterval}
              onSignedIn={props.onSignedIn}
              rename={props.rename}
              onClose={props.onClose}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The step a login that ended reaches. */
const settled = (login: Login): Step =>
  login.status === "succeeded" && login.account !== undefined
    ? {
        kind: "signed-in",
        provider: login.provider,
        account: login.account,
        created: login.created ?? false,
      }
    : { kind: "problem", provider: login.provider, ...ending(login) }

function SignInFlow(props: {
  request: SignInRequest
  /** False once the dialog is closing: a waiting login is cancelled, a label kept. */
  open: boolean
  client: DaemonClient
  pollInterval: number
  onSignedIn: () => void
  rename: (account: Account, label: string) => void
  onClose: () => void
}) {
  const { client, request, pollInterval, open, rename, onSignedIn } = props
  const preset = providerOf(request)
  const [step, setStep] = useState<Step>(
    preset === undefined ? { kind: "pick" } : { kind: "starting", provider: preset, attempt: 0 },
  )
  const [label, setLabel] = useState("")
  const [pasting, setPasting] = useState(false)
  const [pasteError, setPasteError] = useState<string | undefined>()
  /** Why the latest question about the waiting login went unanswered, while it goes unanswered. */
  const [pollTrouble, setPollTrouble] = useState<string | undefined>()
  const attempts = useRef(0)
  /** Finishes the waiting login with a pasted callback URL; set while a login waits. */
  const submit = useRef<((url: string) => void) | undefined>(undefined)

  const start = (provider: Provider) => {
    attempts.current += 1
    setPasting(false)
    setPasteError(undefined)
    setPollTrouble(undefined)
    setStep({ kind: "starting", provider, attempt: attempts.current })
  }

  // Each attempt is one login in the daemon, for as long as the dialog is open
  // on it: it starts, opens the provider's sign-in page, and is asked how it
  // stands until it ends. Closing the dialog or going back cancels it.
  const live = open && (step.kind === "starting" || step.kind === "waiting") ? step : undefined
  const liveProvider = live?.provider
  const liveAttempt = live?.attempt
  useEffect(() => {
    if (liveProvider === undefined || liveAttempt === undefined) return
    const provider = liveProvider
    /** True once this attempt is no longer the dialog's. */
    let over = false
    let ended = false
    let loginId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const settle = (login: Login) => {
      if (over || ended) return
      ended = true
      clearTimeout(timer)
      setPasting(false)
      setStep(settled(login))
    }

    const poll = async (id: string) => {
      try {
        const login = await client.login(id, controller.signal)
        if (over) return
        setPollTrouble(undefined)
        if (login.status !== "pending") return settle(login)
      } catch (error) {
        if (over) return
        const failure = asFailure(error)
        if (failure.kind === "error" && failure.status === 404) {
          ended = true
          setStep({
            kind: "problem",
            provider,
            title: "The sign-in was lost",
            message: "The daemon no longer knows it, perhaps because it restarted. Try again.",
          })
          return
        }
        setPollTrouble(daemonTrouble(failure))
      }
      if (!ended) timer = setTimeout(() => void poll(id), pollInterval)
    }

    client.startLogin(provider).then(
      (login) => {
        // Cancelled before the daemon answered: the login it started is not wanted.
        if (over) return void client.cancelLogin(login.id).catch(() => undefined)
        loginId = login.id
        setStep({
          kind: "waiting",
          provider,
          attempt: liveAttempt,
          login,
          tabBlocked: !openTab(login.authorizeUrl),
        })
        timer = setTimeout(() => void poll(login.id), pollInterval)
      },
      (error: unknown) => {
        if (over) return
        ended = true
        const failure = asFailure(error)
        setStep({
          kind: "problem",
          provider,
          title: "Couldn't start the sign-in",
          message: daemonTrouble(failure),
          ...(failure.kind === "error" && failure.status === 409
            ? {
                hint: `Something else is listening on ${providerNames[provider]}'s sign-in port, such as a sign-in started from the CLI or another agent-proxy${provider === "codex" ? ", or codex login" : ""}. Finish or cancel it, then try again.`,
              }
            : {}),
        })
      },
    )

    submit.current = (url) => {
      if (loginId === undefined || ended) return
      setPasting(true)
      setPasteError(undefined)
      client.submitCallback(loginId, url).then(
        (login) => {
          if (over) return
          if (login.status !== "pending") return settle(login)
          setPasting(false)
        },
        (error: unknown) => {
          if (over) return
          setPasting(false)
          setPasteError(daemonTrouble(asFailure(error)))
        },
      )
    }

    return () => {
      over = true
      submit.current = undefined
      clearTimeout(timer)
      controller.abort()
      if (loginId !== undefined && !ended) void client.cancelLogin(loginId).catch(() => undefined)
    }
  }, [liveProvider, liveAttempt, client, pollInterval])

  // A sign-in changed the daemon's accounts: the page asks for them again.
  const signedIn = step.kind === "signed-in" ? step.account.id : undefined
  useEffect(() => {
    if (signedIn !== undefined) onSignedIn()
  }, [signedIn, onSignedIn])

  // An added account's label starts as the daemon's suggestion, and closing
  // the dialog keeps it as edited.
  const [labelFor, setLabelFor] = useState<string | undefined>()
  if (step.kind === "signed-in" && labelFor !== step.account.id) {
    setLabelFor(step.account.id)
    setLabel(step.account.label)
  }
  const kept = useRef(false)
  useEffect(() => {
    if (open || kept.current || step.kind !== "signed-in" || !step.created) return
    kept.current = true
    const trimmed = label.trim()
    if (trimmed !== "" && trimmed !== step.account.label) rename(step.account, trimmed)
  }, [open, step, label, rename])

  const back = () => {
    setPasting(false)
    setPasteError(undefined)
    setPollTrouble(undefined)
    setStep({ kind: "pick" })
  }

  switch (step.kind) {
    case "pick":
      return (
        <>
          <Head
            icon={<IconPlus size={16} />}
            title="Add an account"
            description="Pick a provider. Its sign-in page opens in a new tab."
          />
          <div className="dialog-body signin-pick">
            {(["claude", "codex"] as const).map((provider) => (
              <ProviderCard key={provider} provider={provider} onPick={() => start(provider)} />
            ))}
          </div>
        </>
      )
    case "signed-in":
      return (
        <SignedIn
          request={request}
          step={step}
          label={label}
          setLabel={setLabel}
          onDone={props.onClose}
        />
      )
    case "starting":
    case "waiting":
    case "problem":
      return (
        <>
          <Head
            icon={<ProviderMark provider={step.provider} size={18} />}
            title={
              request.kind === "again"
                ? `Sign in again to ${request.account.label}`
                : `Sign in to ${providerNames[step.provider]}`
            }
            description={
              request.kind === "again" ? (
                <>
                  Sign in as <b>{request.account.email}</b> to put it back in the{" "}
                  {providerNames[step.provider]} pool.
                </>
              ) : (
                `agent-proxy adds the account you sign in as to the bottom of the ${providerNames[step.provider]} pool.`
              )
            }
          />
          <div className="dialog-body signin">
            {step.kind === "starting" && (
              <div className="wait">
                <Spinner size={18} />
                <output>
                  <b>Starting sign-in…</b>
                  <p>Asking the daemon to listen for {providerNames[step.provider]}'s redirect.</p>
                </output>
              </div>
            )}
            {step.kind === "waiting" && (
              <Waiting
                key={step.login.id}
                step={step}
                trouble={pollTrouble}
                pasting={pasting}
                pasteError={pasteError}
                onPaste={(url) => submit.current?.(url)}
              />
            )}
            {step.kind === "problem" && (
              <>
                <div className="problem" role="alert">
                  <IconAlert size={16} />
                  <div>
                    <b>{step.title}</b>
                    <p>{step.message}</p>
                  </div>
                </div>
                {step.hint !== undefined && <p className="problem-hint">{step.hint}</p>}
              </>
            )}
          </div>
          <div className="dialog-foot signin-foot">
            {request.kind === "add" && request.provider === undefined && (
              <button type="button" className="linkbtn is-quiet" onClick={back}>
                <IconChevronLeft size={13} />
                Choose another provider
              </button>
            )}
            <Dialog.Close className="btn">Cancel</Dialog.Close>
            {step.kind === "problem" && (
              <button type="button" className="btn is-primary" onClick={() => start(step.provider)}>
                Try again
              </button>
            )}
          </div>
        </>
      )
  }
}

/** The redirect address in a login's sign-in URL: where the provider sends the browser back. */
const redirectOf = (login: Login): string | undefined => {
  try {
    return new URL(login.authorizeUrl).searchParams.get("redirect_uri") ?? undefined
  } catch {
    return undefined
  }
}

function Waiting(props: {
  step: Extract<Step, { kind: "waiting" }>
  /** Why the daemon did not answer the latest question about the login, while it does not. */
  trouble: string | undefined
  pasting: boolean
  pasteError: string | undefined
  onPaste: (url: string) => void
}) {
  const { login, provider } = props.step
  const name = providerNames[provider]
  const [pasteOpen, setPasteOpen] = useState(false)
  const [url, setUrl] = useState("")
  const ids = useId()
  const redirect = redirectOf(login)
  return (
    <>
      {props.step.tabBlocked ? (
        <div className="callout is-warn blocked">
          <IconAlert size={15} />
          <div>
            <b>Your browser blocked the new tab.</b>
            <p>Open {name}'s sign-in page yourself; this dialog waits for you to sign in.</p>
          </div>
          <a
            className="btn btn-sm is-primary"
            href={login.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open sign-in page
            <IconExternal size={12} />
          </a>
        </div>
      ) : (
        <div className="wait">
          <Spinner size={18} />
          <div>
            <output>
              <b>Waiting for you to sign in…</b>
              <p>
                {name}'s sign-in page opened in a new tab. Sign in there and approve agent-proxy;
                this dialog moves on by itself.
              </p>
            </output>
            <a className="linkbtn" href={login.authorizeUrl} target="_blank" rel="noreferrer">
              Open sign-in page again
              <IconExternal size={12} />
            </a>
          </div>
        </div>
      )}
      {props.trouble !== undefined && (
        <p className="wait-trouble">
          <IconAlert size={13} />
          {props.trouble} Still waiting.
        </p>
      )}

      <div className={`paste ${pasteOpen ? "is-open" : ""}`}>
        <button
          type="button"
          className="paste-toggle"
          aria-expanded={pasteOpen}
          aria-controls={`${ids}-paste`}
          onClick={() => setPasteOpen(!pasteOpen)}
        >
          <IconChevronRight size={14} />
          <span>Paste the callback URL instead</span>
        </button>
        {pasteOpen && (
          <div className="paste-body" id={`${ids}-paste`}>
            <p className="paste-why">
              For signing in from another machine, or when the browser can't reach this one.
            </p>
            <ol>
              <li>
                Open this URL in a browser on any machine:
                <div className="urlbox">
                  <code>{login.authorizeUrl}</code>
                  <CopyButton text={login.authorizeUrl} label="Copy sign-in URL" />
                </div>
              </li>
              <li>
                Sign in. The browser ends up on a page that may not load, at an address starting
                with <code className="inline-code">{redirect ?? "http://localhost"}</code>. Copy
                that whole address.
              </li>
              <li>
                <label htmlFor={`${ids}-url`}>Paste it here:</label>
                <form
                  className="paste-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (url.trim() !== "" && !props.pasting) props.onPaste(url.trim())
                  }}
                >
                  <input
                    id={`${ids}-url`}
                    className={`field-input is-mono ${props.pasteError === undefined ? "" : "is-error"}`}
                    value={url}
                    aria-label="Callback URL"
                    aria-invalid={props.pasteError !== undefined}
                    aria-describedby={props.pasteError === undefined ? undefined : `${ids}-error`}
                    placeholder={`${redirect ?? "http://localhost"}?code=…`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn is-primary"
                    disabled={url.trim() === "" || props.pasting}
                  >
                    {props.pasting ? "Checking…" : "Continue"}
                  </button>
                </form>
                {props.pasteError !== undefined && (
                  <p className="field-error" id={`${ids}-error`} role="alert">
                    {props.pasteError}
                  </p>
                )}
              </li>
            </ol>
          </div>
        )}
      </div>
    </>
  )
}

function Head(props: { icon: ReactNode; title: string; description: ReactNode; tone?: "ok" }) {
  return (
    <div className="dialog-head">
      <span className={`dialog-icon ${props.tone === "ok" ? "is-ok" : ""}`} aria-hidden="true">
        {props.icon}
      </span>
      <div className="dialog-titles">
        <Dialog.Title>{props.title}</Dialog.Title>
        <Dialog.Description>{props.description}</Dialog.Description>
      </div>
      <Dialog.Close className="iconbtn dialog-x" aria-label="Close">
        <IconX size={16} />
      </Dialog.Close>
    </div>
  )
}

const planLines: Readonly<Record<Provider, string>> = {
  claude: "Pro and Max plans",
  codex: "ChatGPT Plus and Pro plans",
}

function ProviderCard({ provider, onPick }: { provider: Provider; onPick: () => void }) {
  const nameId = useId()
  const detailId = useId()
  return (
    <button
      type="button"
      className="pick"
      aria-labelledby={nameId}
      aria-describedby={detailId}
      onClick={onPick}
    >
      <span className="pick-mark" aria-hidden="true">
        <ProviderMark provider={provider} size={22} />
      </span>
      <span className="pick-text">
        <b id={nameId}>{providerNames[provider]}</b>
        <span id={detailId}>
          {planLines[provider]} · used by {clientsOf(provider)}
        </span>
      </span>
      <IconArrowRight size={16} />
    </button>
  )
}

function SignedIn(props: {
  request: SignInRequest
  step: Extract<Step, { kind: "signed-in" }>
  label: string
  setLabel: (label: string) => void
  onDone: () => void
}) {
  const { account, created, provider } = props.step
  const name = providerNames[provider]
  const fieldId = useId()
  return (
    <>
      <Head
        icon={<IconCheck size={16} />}
        tone="ok"
        title={created ? `${name} account added` : `${account.label} is signed in again`}
        description={
          created
            ? account.priority === 1
              ? `It's the first account in the ${name} pool, so it gets new sessions right away.`
              : `It joins the ${name} pool at priority ${account.priority} of ${account.priority}. Drag it higher to use it first.`
            : account.status === "disabled"
              ? `Its credentials are fresh. It stays disabled, at priority ${account.priority}, until you enable it.`
              : `It's back in the ${name} pool at priority ${account.priority}.`
        }
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          props.onDone()
        }}
      >
        <div className="dialog-body signin-done">
          <div className="account-card">
            <ProviderMark provider={provider} size={18} />
            <div className="account-card-who">
              <b>{account.email}</b>
              <span>Signed in · {statusLabels[account.status]}</span>
            </div>
            <span className="plan" data-weight={planWeight(provider, account.plan)}>
              {account.plan}
            </span>
          </div>
          {created && props.request.kind === "again" && (
            <div className="callout is-warn">
              <IconAlert size={15} />
              <span>
                You signed in as <b>{account.email}</b>, not <b>{props.request.account.email}</b>,
                so it was added as a new account. {props.request.account.label} still needs sign-in.
              </span>
            </div>
          )}
          {created && (
            <div className="field">
              <label htmlFor={`${fieldId}-label`}>Label</label>
              <input
                id={`${fieldId}-label`}
                className="field-input"
                value={props.label}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- naming it is what is left to do
                autoFocus
                maxLength={80}
                spellCheck={false}
                aria-describedby={`${fieldId}-hint`}
                onChange={(event) => props.setLabel(event.target.value)}
              />
              <small id={`${fieldId}-hint`}>
                Only you see it. Pick something that tells your accounts apart.
              </small>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button type="submit" className="btn is-primary">
            Done
          </button>
        </div>
      </form>
    </>
  )
}
