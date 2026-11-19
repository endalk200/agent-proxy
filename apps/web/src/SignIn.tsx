import {
  ArrowRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

import type { Account, DaemonClient, DaemonFailure, Login, Provider } from "./daemon-api.ts"
import { clientsOf, planWeight, providerNames, statusLabels } from "./model.ts"
import { CopyButton, ProviderMark } from "./ui.tsx"
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

/** True for an absolute http or https URL: the only kind the dashboard opens or links. */
const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}

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
  /** How long one question about a waiting login may go unanswered, in milliseconds. */
  requestTimeout: number
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
    <Dialog open={props.request !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="gap-6 p-6 sm:max-w-lg">
        {request !== undefined && (
          <SignInFlow
            key={opening}
            request={request}
            open={props.request !== undefined}
            client={props.client}
            pollInterval={props.pollInterval}
            requestTimeout={props.requestTimeout}
            onSignedIn={props.onSignedIn}
            rename={props.rename}
            onClose={props.onClose}
          />
        )}
      </DialogContent>
    </Dialog>
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
  /** How long one question about the waiting login may go unanswered, in milliseconds. */
  requestTimeout: number
  onSignedIn: () => void
  rename: (account: Account, label: string) => void
  onClose: () => void
}) {
  const { client, request, pollInterval, requestTimeout, open, rename, onSignedIn } = props
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
        // Each question gets its own deadline: one the daemon never answers
        // counts as connection trouble, and the next question still goes out.
        const attempt = new AbortController()
        const abort = () => attempt.abort()
        controller.signal.addEventListener("abort", abort)
        const deadline = setTimeout(abort, requestTimeout)
        const login = await client.login(id, attempt.signal).finally(() => {
          clearTimeout(deadline)
          controller.signal.removeEventListener("abort", abort)
        })
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
        // Only a web page is ever opened or linked: anything else could run in
        // the dashboard's own origin.
        if (!isWebUrl(login.authorizeUrl)) {
          ended = true
          void client.cancelLogin(login.id).catch(() => undefined)
          setStep({
            kind: "problem",
            provider,
            title: "Couldn't start the sign-in",
            message: `The daemon did not give a web address for ${providerNames[provider]}'s sign-in page, so it was not opened.`,
          })
          return
        }
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
  }, [liveProvider, liveAttempt, client, pollInterval, requestTimeout])

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
            icon={<PlusIcon />}
            title="Add an account"
            description="Pick a provider. Its sign-in page opens in a new tab."
          />
          <div className="grid gap-3">
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
            icon={<ProviderMark provider={step.provider} size={20} />}
            title={
              request.kind === "again"
                ? `Sign in again to ${request.account.label}`
                : `Sign in to ${providerNames[step.provider]}`
            }
            description={
              request.kind === "again" ? (
                <>
                  Sign in as <b className="font-medium text-foreground">{request.account.email}</b>{" "}
                  to put it back in the {providerNames[step.provider]} pool.
                </>
              ) : (
                `agent-proxy adds the account you sign in as to the bottom of the ${providerNames[step.provider]} pool.`
              )
            }
          />
          <div className="grid gap-4">
            {step.kind === "starting" && (
              <WaitPanel>
                <output className="grid gap-1">
                  <b className="font-medium">Starting sign-in…</b>
                  <p className="text-muted-foreground">
                    Asking the daemon to listen for {providerNames[step.provider]}'s redirect.
                  </p>
                </output>
              </WaitPanel>
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
                <Alert variant="destructive" className="px-4 py-3.5">
                  <CircleAlertIcon />
                  <AlertTitle>{step.title}</AlertTitle>
                  <AlertDescription>{step.message}</AlertDescription>
                </Alert>
                {step.hint !== undefined && (
                  <p className="text-sm text-pretty text-muted-foreground">{step.hint}</p>
                )}
              </>
            )}
          </div>
          <DialogFooter className="items-center">
            {request.kind === "add" && request.provider === undefined && (
              <Button variant="ghost" className="text-muted-foreground sm:mr-auto" onClick={back}>
                <ChevronLeftIcon data-icon="inline-start" />
                Choose another provider
              </Button>
            )}
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            {step.kind === "problem" && (
              <Button onClick={() => start(step.provider)}>Try again</Button>
            )}
          </DialogFooter>
        </>
      )
  }
}

/** A spinner beside what the dialog is waiting on. */
function WaitPanel(props: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-3.5 rounded-lg border bg-muted/40 p-4 text-sm">
      <LoaderCircleIcon
        aria-hidden="true"
        className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground"
      />
      <div className="grid min-w-0 gap-2.5">{props.children}</div>
    </div>
  )
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
        <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm sm:flex-row sm:items-center">
          <TriangleAlertIcon aria-hidden="true" className="size-5 shrink-0 text-warning" />
          <div className="grid flex-1 gap-1">
            <b className="font-medium">Your browser blocked the new tab.</b>
            <p className="text-muted-foreground">
              Open {name}'s sign-in page yourself; this dialog waits for you to sign in.
            </p>
          </div>
          <a
            className={cn(buttonVariants({ size: "sm" }), "self-start sm:self-center")}
            href={login.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open sign-in page
            <ExternalLinkIcon data-icon="inline-end" />
          </a>
        </div>
      ) : (
        <WaitPanel>
          <output className="grid gap-1">
            <b className="font-medium">Waiting for you to sign in…</b>
            <p className="text-pretty text-muted-foreground">
              {name}'s sign-in page opened in a new tab. Sign in there and approve agent-proxy; this
              dialog moves on by itself.
            </p>
          </output>
          <a
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-foreground underline decoration-muted-foreground underline-offset-4 hover:decoration-foreground"
            href={login.authorizeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open sign-in page again
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </a>
        </WaitPanel>
      )}
      {props.trouble !== undefined && (
        <p className="flex items-start gap-2 text-sm text-warning">
          <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{props.trouble} Still waiting.</span>
        </p>
      )}

      <div className="border-t pt-4">
        <button
          type="button"
          className="group flex items-center gap-2 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={pasteOpen}
          aria-controls={`${ids}-paste`}
          onClick={() => setPasteOpen(!pasteOpen)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 transition-transform group-aria-expanded:rotate-90"
          />
          <span>Paste the callback URL instead</span>
        </button>
        {pasteOpen && (
          <div className="mt-4 grid gap-4 text-sm" id={`${ids}-paste`}>
            <p className="text-muted-foreground">
              For signing in from another machine, or when the browser can't reach this one.
            </p>
            <ol className="grid list-decimal gap-5 pl-5 marker:text-muted-foreground">
              <li className="pl-1">
                Open this URL in a browser on any machine:
                <div className="mt-2 flex items-start gap-2 rounded-md border bg-muted/40 py-2 pr-2 pl-3">
                  <code className="min-w-0 flex-1 py-1 text-xs leading-relaxed break-all text-muted-foreground">
                    {login.authorizeUrl}
                  </code>
                  <CopyButton text={login.authorizeUrl} label="Copy sign-in URL" />
                </div>
              </li>
              <li className="pl-1 text-pretty">
                Sign in. The browser ends up on a page that may not load, at an address starting
                with{" "}
                <code className="bg-muted px-1.5 py-0.5 text-xs break-all">
                  {redirect ?? "http://localhost"}
                </code>
                . Copy that whole address.
              </li>
              <li className="pl-1">
                <Label htmlFor={`${ids}-url`} className="font-normal">
                  Paste it here:
                </Label>
                <form
                  className="mt-2 flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (url.trim() !== "" && !props.pasting) props.onPaste(url.trim())
                  }}
                >
                  <Input
                    id={`${ids}-url`}
                    className="flex-1 font-mono text-xs"
                    value={url}
                    aria-label="Callback URL"
                    aria-invalid={props.pasteError !== undefined}
                    aria-describedby={props.pasteError === undefined ? undefined : `${ids}-error`}
                    placeholder={`${redirect ?? "http://localhost"}?code=…`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <Button type="submit" disabled={url.trim() === "" || props.pasting}>
                    {props.pasting ? "Checking…" : "Continue"}
                  </Button>
                </form>
                {props.pasteError !== undefined && (
                  <p className="mt-2 text-sm text-destructive" id={`${ids}-error`} role="alert">
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
    <DialogHeader className="flex-row items-start gap-4 pr-8">
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg border bg-muted [&_svg:not([class*='size-'])]:size-5",
          props.tone === "ok" && "border-success/40 bg-success/15 text-success",
        )}
        aria-hidden="true"
      >
        {props.icon}
      </span>
      <div className="grid min-w-0 gap-1.5">
        <DialogTitle className="text-lg leading-tight font-semibold">{props.title}</DialogTitle>
        <DialogDescription className="text-pretty">{props.description}</DialogDescription>
      </div>
    </DialogHeader>
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
      className="group flex w-full items-center gap-4 rounded-lg border bg-card p-4 text-left transition-colors outline-none hover:border-foreground/30 hover:bg-foreground/5 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      aria-labelledby={nameId}
      aria-describedby={detailId}
      onClick={onPick}
    >
      <span
        className="grid size-11 shrink-0 place-items-center rounded-lg border bg-muted"
        aria-hidden="true"
      >
        <ProviderMark provider={provider} size={22} />
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <b id={nameId} className="text-base font-semibold">
          {providerNames[provider]}
        </b>
        <span id={detailId} className="text-sm text-muted-foreground">
          {planLines[provider]} · used by {clientsOf(provider)}
        </span>
      </span>
      <ArrowRightIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </button>
  )
}

/** A plan's badge, heavier for a bigger plan. */
function PlanBadge(props: { provider: Provider; plan: string }) {
  const weight = planWeight(props.provider, props.plan)
  return (
    <Badge
      variant="outline"
      data-weight={weight}
      className={cn(
        "rounded-md font-semibold",
        weight === 2 && "bg-muted",
        weight === 3 && "border-foreground bg-foreground text-background",
      )}
    >
      {props.plan}
    </Badge>
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
  const title = created ? `${name} account added` : `${account.label} is signed in again`
  // "Sign in again" for one account, but another one signed in.
  const intended = props.request.kind === "again" ? props.request.account : undefined
  const mismatch = intended !== undefined && intended.id !== account.id ? intended : undefined
  return (
    <>
      {/* The waiting step's controls are gone: say what happened. */}
      <output className="sr-only">{title}</output>
      <Head
        icon={<CheckIcon />}
        tone="ok"
        title={title}
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
        className="grid gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          props.onDone()
        }}
      >
        <div className="grid gap-5">
          <div className="flex items-center gap-3.5 rounded-lg border bg-muted/40 p-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-card">
              <ProviderMark provider={provider} size={18} />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <b className="truncate font-medium">{account.email}</b>
              <span className="text-sm text-muted-foreground">
                Signed in · {statusLabels[account.status]}
              </span>
            </div>
            <PlanBadge provider={provider} plan={account.plan} />
          </div>
          {mismatch !== undefined && (
            <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
              <TriangleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-warning"
              />
              <span className="text-pretty">
                You signed in as <b className="font-medium">{account.email}</b>, not{" "}
                <b className="font-medium">{mismatch.email}</b>, so{" "}
                {created
                  ? "it was added as a new account"
                  : `${account.label} was signed in again instead`}
                . {mismatch.label} still needs sign-in.
              </span>
            </div>
          )}
          {created && (
            <div className="grid gap-2">
              <Label htmlFor={`${fieldId}-label`}>Label</Label>
              <Input
                id={`${fieldId}-label`}
                value={props.label}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- naming it is what is left to do
                autoFocus
                maxLength={80}
                spellCheck={false}
                aria-describedby={`${fieldId}-hint`}
                onChange={(event) => props.setLabel(event.target.value)}
              />
              <p id={`${fieldId}-hint`} className="text-sm text-muted-foreground">
                Only you see it. Pick something that tells your accounts apart.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="submit"
            // With no label to name, Done is what is left: focus lands there,
            // not on the page behind the dialog.
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- see above
            autoFocus={!created}
          >
            Done
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}
