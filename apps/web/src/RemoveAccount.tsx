import { Trash2, TriangleAlert } from "lucide-react"
import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { Account, AccountList } from "./daemon-api.ts"
import { accountsOf, clientsOf, planWeight, poolState, providerNames } from "./model.ts"
import { ProviderMark } from "./ui.tsx"

/**
 * Asks before removing `account`, and removes it when the owner confirms.
 * `remove` resolves once the daemon has answered; the dialog then closes.
 */
export function RemoveAccountDialog(props: {
  account: Account | undefined
  list: AccountList | undefined
  remove: (account: Account) => Promise<boolean>
  onClose: () => void
}) {
  // The dialog keeps showing the account while it animates closed.
  const [shown, setShown] = useState(props.account)
  const [removing, setRemoving] = useState(false)
  // Once the account is gone, so is whatever opened this dialog for it.
  const [removed, setRemoved] = useState(false)
  if (props.account !== undefined && props.account !== shown) {
    setShown(props.account)
    setRemoved(false)
  }
  const account = props.account ?? shown

  return (
    <AlertDialog
      open={props.account !== undefined}
      onOpenChange={(open) => !open && !removing && props.onClose()}
    >
      <AlertDialogContent
        className="gap-6 sm:max-w-lg"
        finalFocus={removed ? () => document.getElementById("page-title") : true}
      >
        {account !== undefined && (
          <RemoveBody
            account={account}
            list={props.list}
            removing={removing}
            onRemove={() => {
              setRemoving(true)
              void props.remove(account).then((gone) => {
                setRemoving(false)
                setRemoved(gone)
                props.onClose()
              })
            }}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RemoveBody(props: {
  account: Account
  list: AccountList | undefined
  removing: boolean
  onRemove: () => void
}) {
  const { account } = props
  const provider = providerNames[account.provider]
  const others =
    props.list === undefined
      ? []
      : accountsOf(props.list, account.provider).filter((other) => other.id !== account.id)
  const pool = props.list?.pools.find((candidate) => candidate.provider === account.provider)
  const state =
    props.list === undefined || pool === undefined ? undefined : poolState(props.list, pool)
  const servedByAnother = state?.kind === "serving" && state.account.id !== account.id

  return (
    <>
      <AlertDialogHeader className="grid-cols-[auto_1fr] grid-rows-none place-items-start gap-x-4 gap-y-1.5 text-left">
        <span
          className="row-span-2 grid size-10 place-items-center bg-destructive/15 text-destructive"
          aria-hidden="true"
        >
          <Trash2 className="size-5" />
        </span>
        <AlertDialogTitle className="font-semibold">Remove {account.label}?</AlertDialogTitle>
        <AlertDialogDescription className="text-pretty">
          agent-proxy signs out of <b className="font-medium text-foreground">{account.email}</b>{" "}
          and forgets its credentials. Sessions already using it finish;{" "}
          {servedByAnother ? (
            <>
              new sessions keep going to{" "}
              <b className="font-medium text-foreground">{state.account.label}</b>.
            </>
          ) : (
            <>new sessions go to the next account in the {provider} pool.</>
          )}{" "}
          You can add it again later.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3">
          <ProviderMark provider={account.provider} size={18} />
          <div className="flex min-w-0 flex-1 flex-col">
            <b className="truncate font-medium">{account.label}</b>
            <span className="truncate text-xs text-muted-foreground">{account.email}</span>
          </div>
          <PlanBadge account={account} />
        </div>
        {props.list !== undefined && !others.some((other) => other.enabled) && (
          <Alert className="border-warning/40 text-warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="text-warning/90">
              No other {provider} account is enabled, so {clientsOf(account.provider)} can't use{" "}
              {provider} until you add or enable one.
            </AlertDescription>
          </Alert>
        )}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={props.removing}>Cancel</AlertDialogCancel>
        <Button
          type="button"
          variant="destructive"
          className="bg-destructive text-destructive-foreground hover:bg-destructive/85 dark:bg-destructive dark:hover:bg-destructive/85"
          disabled={props.removing}
          onClick={props.onRemove}
        >
          {props.removing ? "Removing…" : "Remove account"}
        </Button>
      </AlertDialogFooter>
    </>
  )
}

/** An account's plan, heavier for bigger plans. */
export function PlanBadge({ account }: { account: Account }) {
  const weight = planWeight(account.provider, account.plan)
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
      {account.plan}
    </Badge>
  )
}
