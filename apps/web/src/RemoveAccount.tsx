import { AlertDialog } from "@base-ui/react/alert-dialog"
import { useState } from "react"

import type { Account, AccountList } from "./daemon-api.ts"
import { accountsOf, clientsOf, planWeight, poolState, providerNames } from "./model.ts"
import { IconAlert, IconTrash, ProviderMark } from "./ui.tsx"

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
    <AlertDialog.Root
      open={props.account !== undefined}
      onOpenChange={(open) => !open && !removing && props.onClose()}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="backdrop" />
        <AlertDialog.Popup
          className="dialog dialog-narrow"
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
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
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
      <div className="dialog-head">
        <span className="dialog-icon is-danger" aria-hidden="true">
          <IconTrash size={16} />
        </span>
        <div className="dialog-titles">
          <AlertDialog.Title>Remove {account.label}?</AlertDialog.Title>
          <AlertDialog.Description>
            agent-proxy signs out of <b>{account.email}</b> and forgets its credentials. Sessions
            already using it finish;{" "}
            {servedByAnother ? (
              <>
                new sessions keep going to <b>{state.account.label}</b>.
              </>
            ) : (
              <>new sessions go to the next account in the {provider} pool.</>
            )}{" "}
            You can add it again later.
          </AlertDialog.Description>
        </div>
      </div>
      <div className="dialog-body remove">
        <div className="account-card">
          <ProviderMark provider={account.provider} size={18} />
          <div className="account-card-who">
            <b>{account.label}</b>
            <span>{account.email}</span>
          </div>
          <span className="plan" data-weight={planWeight(account.provider, account.plan)}>
            {account.plan}
          </span>
        </div>
        {props.list !== undefined && !others.some((other) => other.enabled) && (
          <div className="callout is-warn">
            <IconAlert size={15} />
            <span>
              No other {provider} account is enabled, so {clientsOf(account.provider)} can't use{" "}
              {provider} until you add or enable one.
            </span>
          </div>
        )}
      </div>
      <div className="dialog-foot">
        <AlertDialog.Close className="btn" disabled={props.removing}>
          Cancel
        </AlertDialog.Close>
        <button
          type="button"
          className="btn is-danger"
          disabled={props.removing}
          onClick={props.onRemove}
        >
          {props.removing ? "Removing…" : "Remove account"}
        </button>
      </div>
    </>
  )
}
