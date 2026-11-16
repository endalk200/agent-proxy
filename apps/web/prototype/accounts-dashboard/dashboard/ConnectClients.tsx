// PROTOTYPE: pieces of the Connect clients panel: a copyable command line and the proxy key row.
import { useState } from "react"

import { IconKey } from "../shared/icons.tsx"
import { useDashboard } from "../shared/store.ts"
import { CopyButton } from "./ui.tsx"

const maskKey = (key: string) => `${key.slice(0, 9)}${"•".repeat(14)}${key.slice(-4)}`

export function CommandLine({ command }: { command: string }) {
  return (
    <div className="ap-cmd">
      <span className="ap-cmd-prompt">$</span>
      <code>{command}</code>
      <CopyButton text={command} label="Copy command" />
    </div>
  )
}

export function ProxyKeyRow() {
  const s = useDashboard()
  const [shown, setShown] = useState(false)
  return (
    <div className="ap-key">
      <IconKey size={14} />
      <span className="ap-key-label">Proxy key</span>
      <code>{shown ? s.proxyKey : maskKey(s.proxyKey)}</code>
      <button type="button" className="ap-linkbtn" onClick={() => setShown(!shown)}>
        {shown ? "Hide" : "Reveal"}
      </button>
      <CopyButton text={s.proxyKey} label="Copy proxy key" />
    </div>
  )
}
