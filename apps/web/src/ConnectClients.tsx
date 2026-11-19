import { KeyRound, Terminal } from "lucide-react"
import { useEffect, useId, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

import type { AccountList, DaemonClient } from "./daemon-api.ts"
import { clients, poolState, providerNames } from "./model.ts"
import { CopyButton, ProviderMark } from "./ui.tsx"

/** A shell command with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex h-11 min-w-0 items-center gap-3 rounded-md border border-input bg-background/60 pr-1.5 pl-3.5 font-mono text-sm">
      <span className="text-muted-foreground select-none" aria-hidden="true">
        $
      </span>
      <code className="min-w-0 flex-1 truncate">{command}</code>
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
    <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium" id={labelId}>
        Proxy key
      </span>
      {state.kind === "loaded" ? (
        <>
          <code
            aria-labelledby={labelId}
            className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
          >
            {shown ? state.key : mask(state.key)}
          </code>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={shown}
              onClick={() => setShown(!shown)}
            >
              {shown ? "Hide" : "Reveal"}
            </Button>
            <CopyButton text={state.key} label="Copy proxy key" />
          </div>
        </>
      ) : (
        <span className="text-muted-foreground">
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
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="flex-row items-start gap-4 border-b p-6 pr-14">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            <Terminal className="size-5" />
          </span>
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="text-lg font-semibold">Connect clients</DialogTitle>
            <DialogDescription className="text-pretty">
              Run one command per client. It points the client at this proxy and has it fetch the
              proxy key.
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex flex-col gap-6 p-6">
          {clients.map((connectable) => (
            <div key={connectable.command} className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <b className="font-semibold">{connectable.name}</b>
                <span className="flex flex-wrap gap-1.5">
                  {connectable.providers.map((provider) => {
                    const pool = props.list?.pools.find((p) => p.provider === provider)
                    const kind =
                      props.list === undefined || pool === undefined
                        ? "empty"
                        : poolState(props.list, pool).kind
                    return (
                      <Badge
                        key={provider}
                        variant="outline"
                        data-state={kind}
                        className={cn(
                          "h-6 gap-1.5 px-2 font-normal text-muted-foreground",
                          kind === "blocked" && "border-warning/40 text-warning",
                          (kind === "empty" || kind === "off") && "border-dashed",
                        )}
                      >
                        <ProviderMark provider={provider} size={12} />
                        {providerNames[provider]} pool
                      </Badge>
                    )
                  })}
                </span>
              </div>
              <CommandLine command={connectable.command} />
            </div>
          ))}
        </div>
        <div className="border-t bg-muted/40 px-6 py-3">
          <ProxyKeyRow client={props.client} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
