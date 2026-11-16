// PROTOTYPE variant A: the "Connect clients" popover and its pieces.
import { useEffect, useRef, useState } from "react"

import { IconKey, IconLink, IconTerminal, ProviderMark } from "../../shared/icons.tsx"
import { CLIENTS, type Client, poolState, providerName } from "../../shared/model.ts"
import { useDashboard } from "../../shared/store.ts"
import { CopyButton } from "./ui.tsx"

export const maskKey = (key: string) => `${key.slice(0, 9)}${"•".repeat(14)}${key.slice(-4)}`

export function CommandLine({ command }: { command: string }) {
  return (
    <div className="vA-cmd">
      <span className="vA-cmd-prompt">$</span>
      <code>{command}</code>
      <CopyButton text={command} label="Copy command" />
    </div>
  )
}

export function ProxyKeyRow() {
  const s = useDashboard()
  const [shown, setShown] = useState(false)
  return (
    <div className="vA-key">
      <IconKey size={14} />
      <span className="vA-key-label">Proxy key</span>
      <code>{shown ? s.proxyKey : maskKey(s.proxyKey)}</code>
      <button type="button" className="vA-linkbtn" onClick={() => setShown(!shown)}>
        {shown ? "Hide" : "Reveal"}
      </button>
      <CopyButton text={s.proxyKey} label="Copy proxy key" />
    </div>
  )
}

function ClientPools({ client }: { client: Client }) {
  const s = useDashboard()
  return (
    <div className="vA-cc-pools">
      {client.providers.map((p) => {
        const ps = poolState(s.accounts, p)
        return (
          <div key={p} className="vA-cc-pool">
            <ProviderMark provider={p} size={14} />
            <span className="vA-cc-pool-name">{providerName[p]} pool</span>
            <span className="vA-cc-pool-state">
              {ps.kind === "serving"
                ? `new sessions → ${ps.account.label}`
                : ps.kind === "blocked"
                  ? "no account can take new sessions"
                  : ps.kind === "off"
                    ? "every account disabled"
                    : "no accounts yet"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ConnectClientsButton() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Client["id"]>("claude-code")
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", down)
    window.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("mousedown", down)
      window.removeEventListener("keydown", key)
    }
  }, [open])
  const client = CLIENTS.find((c) => c.id === tab) ?? CLIENTS[0]!
  return (
    <div className="vA-cc-wrap" ref={ref}>
      <button
        type="button"
        className={`vA-btn vA-btn-ghost ${open ? "is-active" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <IconLink size={14} /> Connect clients
      </button>
      {open && (
        <div className="vA-pop" role="dialog" aria-label="Connect clients">
          <div className="vA-pop-head">
            <div className="vA-pop-title">
              <IconTerminal size={15} /> Connect clients
            </div>
            <p>Run one command per client. It points the client at this proxy and gives it the proxy key.</p>
          </div>
          <div className="vA-seg" role="tablist">
            {CLIENTS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={c.id === tab}
                className={c.id === tab ? "is-on" : ""}
                onClick={() => setTab(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
          <CommandLine command={client.command} />
          <div className="vA-pop-sub">{client.name} draws from</div>
          <ClientPools client={client} />
          <div className="vA-pop-divider" />
          <ProxyKeyRow />
        </div>
      )}
    </div>
  )
}
