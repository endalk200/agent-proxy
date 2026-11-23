import { CircleCheck, ExternalLink, Info, RotateCcw, TriangleAlert } from "lucide-react"
import { useId, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { Account, AccountLimits, LimitReset, RedeemResult } from "./daemon-api.ts"
import { dayText, until } from "./format.ts"
import { Meter } from "./limits.tsx"
import { useUsage } from "./usage.tsx"
import { asFailure } from "./useDaemon.ts"

/**
 * Limit resets as the pages show them: a count on each account's row, and in
 * the account sheet each one, soonest expiry first, with a Redeem button
 * that asks first. A limit reset expiring within a week is in the warning
 * tone, so it gets spent. The daemon never redeems one on its own (ADR-0010).
 */

/** A limit reset expiring sooner than this is shown in the warning tone. */
export const EXPIRES_SOON_MS = 7 * 24 * 60 * 60_000

/** Where Codex sells an instant reset, in the browser only. */
export const BUY_RESET_URL = "https://chatgpt.com/codex/purchase/reset"

/** The limit resets `limits` holds that have not expired at `now`, soonest expiry first. */
export const liveResets = (
  limits: AccountLimits | undefined,
  now: number,
): ReadonlyArray<LimitReset> =>
  (limits?.limitResets ?? []).filter((reset) => reset.expiresAt === null || reset.expiresAt > now)

/** True when `reset` expires within a week of `now`. */
export const expiresSoon = (reset: LimitReset, now: number) =>
  reset.expiresAt !== null && reset.expiresAt - now < EXPIRES_SOON_MS

/** "5-hour", "5-hour and Weekly", "5-hour, Weekly and Fable weekly". */
const joined = (labels: ReadonlyArray<string>) =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`

/** What `reset` refills, in words: "5-hour and Weekly". */
const refillsText = (reset: LimitReset) => joined(reset.refills.map((window) => window.label))

/** "expires Dec 10 (in 23d 0h)", or "never expires". */
const expiryText = (reset: LimitReset, now: number) =>
  reset.expiresAt === null
    ? "never expires"
    : `expires ${dayText(reset.expiresAt)} (in ${until(reset.expiresAt, now)})`

/** How many limit resets an account holds, beside its label; nothing when it holds none. */
export function ResetsBadge(props: { resets: ReadonlyArray<LimitReset>; now: number }) {
  const { resets } = props
  if (resets.length === 0) return null
  const soon = resets.some((reset) => expiresSoon(reset, props.now))
  return (
    <Badge
      variant="outline"
      data-tone={soon ? "warn" : undefined}
      className={cn(
        "h-5 gap-1 rounded-md px-1.5 text-[11px] font-semibold tabular-nums",
        soon ? "border-warning/40 bg-warning/10 text-warning" : "text-muted-foreground",
      )}
    >
      <RotateCcw aria-hidden="true" />
      {resets.length}
      <span className="sr-only">{resets.length === 1 ? " limit reset" : " limit resets"}</span>
    </Badge>
  )
}

/** How the last redeem from the sheet went, as it shows under the list. */
interface Outcome {
  readonly tone: "ok" | "warn" | "error"
  readonly title: string
  readonly message: string
}

const outcomeOf = (reset: LimitReset, result: RedeemResult): Outcome => {
  switch (result.outcome) {
    case "redeemed":
      return { tone: "ok", title: `Redeemed ${reset.name}`, message: result.message }
    case "refused":
      return { tone: "warn", title: `${reset.name} wasn't redeemed`, message: result.message }
    case "unknown":
      return {
        tone: "warn",
        title: `Not sure ${reset.name} was redeemed`,
        message: result.message,
      }
  }
}

const outcomeTone: Readonly<Record<Outcome["tone"], string>> = {
  ok: "border-success/30 bg-success/10 text-success *:data-[slot=alert-description]:text-foreground/80",
  warn: "border-warning/40 bg-warning/10 text-warning *:data-[slot=alert-description]:text-foreground/80",
  error:
    "border-danger/35 bg-danger/10 text-danger *:data-[slot=alert-description]:text-foreground/80",
}

/**
 * The account sheet's limit resets: each one with what it refills, when it
 * expires, and a Redeem button, or why it can't be redeemed now. A Codex
 * account its provider offers an instant reset to also gets a link to buy one.
 */
export function LimitResetsPanel(props: { account: Account; readOnly: boolean; now: number }) {
  const { account, now } = props
  const usage = useUsage()
  const limits = usage.limits?.get(account.id)
  const resets = liveResets(limits, now)
  const [asking, setAsking] = useState<LimitReset | undefined>()
  const [redeeming, setRedeeming] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | undefined>()
  const headingId = useId()
  const canBuy = account.provider === "codex" && limits?.canBuyReset === true

  const redeem = (reset: LimitReset) => {
    setRedeeming(true)
    setOutcome(undefined)
    usage.client
      .redeemReset(account.id, reset.id)
      .then(
        (result) => {
          usage.applyLimits(result.limits)
          setOutcome(outcomeOf(reset, result))
        },
        (error: unknown) => {
          const failure = asFailure(error)
          // No answer may come after the daemon redeemed it: only an answer refuses it.
          setOutcome(
            failure.kind === "unreachable"
              ? {
                  tone: "warn",
                  title: `Not sure ${reset.name} was redeemed`,
                  message:
                    "No answer came back from the daemon, so whether it was redeemed is unknown. The list shows it once the daemon answers again: a redeemed one is no longer there.",
                }
              : { tone: "error", title: `Couldn't redeem ${reset.name}`, message: failure.message },
          )
        },
      )
      .finally(() => {
        setRedeeming(false)
        setAsking(undefined)
      })
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby={headingId}>
      <div className="flex min-h-8 items-center gap-3">
        <h3 id={headingId} className="text-sm font-semibold">
          Limit resets
        </h3>
        {canBuy && (
          <a
            href={BUY_RESET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}
          >
            Buy a reset
            <ExternalLink aria-hidden="true" />
          </a>
        )}
      </div>
      {limits === undefined ? (
        <p className="py-2 text-sm text-muted-foreground">Loading limit resets…</p>
      ) : resets.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          None now. New ones show up here by themselves.
        </p>
      ) : (
        <ul className="flex flex-col rounded-lg border border-border">
          {resets.map((reset) => {
            const soon = expiresSoon(reset, now)
            return (
              <li
                key={reset.id}
                className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
              >
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-md border",
                    soon
                      ? "border-warning/40 bg-warning/10 text-warning"
                      : "border-border bg-muted text-muted-foreground",
                  )}
                  aria-hidden="true"
                >
                  <RotateCcw className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <b className="text-sm font-medium text-pretty">{reset.name}</b>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {reset.refills.length > 0 && `Refills ${refillsText(reset)} · `}
                    <span
                      data-tone={soon ? "warn" : undefined}
                      className={cn(soon && "font-medium text-warning")}
                    >
                      {expiryText(reset, now)}
                    </span>
                  </p>
                </div>
                {reset.usableNow ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    aria-label={`Redeem ${reset.name}`}
                    disabled={props.readOnly || redeeming}
                    onClick={() => setAsking(reset)}
                  >
                    Redeem
                  </Button>
                ) : (
                  <span className="max-w-40 shrink-0 text-right text-xs text-muted-foreground text-pretty">
                    {reset.unavailableReason ?? "Not usable right now"}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {outcome !== undefined && (
        <Alert className={outcomeTone[outcome.tone]}>
          {outcome.tone === "ok" ? (
            <CircleCheck aria-hidden="true" />
          ) : outcome.tone === "warn" ? (
            <Info aria-hidden="true" />
          ) : (
            <TriangleAlert aria-hidden="true" />
          )}
          <AlertTitle className="font-semibold">{outcome.title}</AlertTitle>
          <AlertDescription>{outcome.message}</AlertDescription>
        </Alert>
      )}
      <RedeemDialog
        account={account}
        limits={limits}
        reset={asking}
        redeeming={redeeming}
        onRedeem={redeem}
        onClose={() => !redeeming && setAsking(undefined)}
      />
    </section>
  )
}

/** What redeeming does to the account's reset schedule, as each provider says. */
const sideEffects: Readonly<Record<Account["provider"], string>> = {
  codex: "Codex moves this account's weekly refresh to a week from now.",
  claude: "Claude keeps this account's weekly reset day.",
}

/**
 * Asks before redeeming `reset`: what it refills and how used each of those
 * windows is now, and what the provider does to the reset schedule.
 */
function RedeemDialog(props: {
  account: Account
  limits: AccountLimits | undefined
  reset: LimitReset | undefined
  redeeming: boolean
  onRedeem: (reset: LimitReset) => void
  onClose: () => void
}) {
  const { account } = props
  // The dialog keeps showing its limit reset while it animates closed.
  const [shown, setShown] = useState(props.reset)
  if (props.reset !== undefined && props.reset !== shown) setShown(props.reset)
  const reset = props.reset ?? shown

  return (
    <AlertDialog open={props.reset !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogContent className="gap-6 sm:max-w-lg">
        {reset !== undefined && (
          <>
            <AlertDialogHeader className="grid-cols-[auto_1fr] grid-rows-none place-items-start gap-x-4 gap-y-1.5 text-left">
              <span
                className="row-span-2 grid size-10 place-items-center bg-accent/15 text-accent"
                aria-hidden="true"
              >
                <RotateCcw className="size-5" />
              </span>
              <AlertDialogTitle className="font-semibold">{`Redeem ${reset.name}?`}</AlertDialogTitle>
              <AlertDialogDescription className="text-pretty">
                {reset.refills.length > 0
                  ? `It refills ${account.label}'s ${refillsText(reset)} ${reset.refills.length === 1 ? "window" : "windows"} now.`
                  : `It refills ${account.label}'s limits now.`}{" "}
                {sideEffects[account.provider]} A redeem can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {reset.refills.length > 0 && (
              <ul
                className="flex flex-col gap-3 rounded-lg border bg-muted/50 px-4 py-3"
                aria-label="Windows it refills"
              >
                {reset.refills.map((refill) => {
                  const window = props.limits?.windows.find(
                    (candidate) => candidate.id === refill.id,
                  )
                  return (
                    <li key={refill.id} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-medium">{refill.label}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {window === undefined
                            ? "not read yet"
                            : `${Math.round(window.usedPct)}% used`}
                        </span>
                      </div>
                      {window !== undefined && <Meter usedPct={window.usedPct} />}
                    </li>
                  )
                })}
              </ul>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={props.redeeming}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                disabled={props.redeeming}
                onClick={() => props.onRedeem(reset)}
              >
                {props.redeeming ? "Redeeming…" : "Redeem"}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
