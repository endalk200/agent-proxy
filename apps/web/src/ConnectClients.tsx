import { Dialog } from "@base-ui/react/dialog"
import { useEffect, useId, useState } from "react"

import type { AccountList, DaemonClient } from "./daemon-api.ts"
import { clients, poolState, providerNames } from "./model.ts"
import { CopyButton, IconKey, IconTerminal, IconX, ProviderMark } from "./ui.tsx"

/** A shell command with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="cmd">
      <span className="cmd-prompt" aria-hidden="true">
        $
      </span>
      <code>{command}</code>
      <CopyButton text={command} label={`Copy ${command}`} />
    </div>
  )
}

/** The proxy key's first and last few characters, the rest hidden. */
const mask = (key: string) => `${key.slice(0, 6)}${"•".repeat(16)}${key.slice(-4)}`

type KeyState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly key: string }
  | { readonly kind: "failed" }

/** The proxy key, masked until revealed, with a copy button. */
export function ProxyKeyRow({ client }: { client: DaemonClient }) {
  const [state, setState] = useState<KeyState>({ kind: "loading" })
  const [shown, setShown] = useState(false)
  const labelId = useId()
  useEffect(() => {
    let current = true
    client.key().then(
      (key) => current && setState({ kind: "loaded", key }),
      () => current && setState({ kind: "failed" }),
    )
    return () => {
      current = false
    }
  }, [client])

  return (
    <div className="key">
      <IconKey size={14} />
      <span className="key-label" id={labelId}>
        Proxy key
      </span>
      {state.kind === "loaded" ? (
        <>
          <code aria-labelledby={labelId}>{shown ? state.key : mask(state.key)}</code>
          <button
            type="button"
            className="linkbtn"
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            {shown ? "Hide" : "Reveal"}
          </button>
          <CopyButton text={state.key} label="Copy proxy key" />
        </>
      ) : (
        <span className="key-note">
          {state.kind === "loading"
            ? "Loading…"
            : "The daemon did not answer. Run agent-proxy key to see it."}
        </span>
      )}
    </div>
  )
}

/** The Connect clients dialog: each client's `connect` command, the pools it spends, and the key. */
export function ConnectClientsDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  list: AccountList | undefined
  client: DaemonClient
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="backdrop" />
        <Dialog.Popup className="dialog">
          <div className="dialog-head">
            <span className="dialog-icon" aria-hidden="true">
              <IconTerminal size={16} />
            </span>
            <div className="dialog-titles">
              <Dialog.Title>Connect clients</Dialog.Title>
              <Dialog.Description>
                Run one command per client. It points the client at this proxy and has it fetch the
                proxy key.
              </Dialog.Description>
            </div>
            <Dialog.Close className="iconbtn dialog-x" aria-label="Close">
              <IconX size={16} />
            </Dialog.Close>
          </div>
          <div className="dialog-body connect">
            {clients.map((connectable) => (
              <div key={connectable.command} className="connect-row">
                <div className="connect-head">
                  <b>{connectable.name}</b>
                  <span className="connect-pools">
                    {connectable.providers.map((provider) => {
                      const pool = props.list?.pools.find((p) => p.provider === provider)
                      const kind =
                        props.list === undefined || pool === undefined
                          ? "empty"
                          : poolState(props.list, pool).kind
                      return (
                        <span key={provider} className={`chip is-${kind}`}>
                          <ProviderMark provider={provider} size={11} />
                          {providerNames[provider]} pool
                        </span>
                      )
                    })}
                  </span>
                </div>
                <CommandLine command={connectable.command} />
              </div>
            ))}
            <div className="connect-key">
              <ProxyKeyRow client={props.client} />
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
