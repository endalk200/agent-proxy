// PROTOTYPE — accounts dashboard, "What should this look like?"
//
// Four structurally different variants of the accounts page, switchable via `?variant=A|B|C|D` and the
// floating bar at the bottom (← / → keys too). Mock data lives in memory (shared/store.ts); the
// bar's Simulate menu fakes the daemon's live status changes, and its scenario picker loads the edge
// states (first run, a pool all cooling down, a single account). `?theme=light|dark` pins the theme.
//
// Run from the repo root: `bun run prototype:accounts`. Disposable; never merge into main.

import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import "./shared/base.css"
import { PrototypeBar } from "./shared/PrototypeBar.tsx"
import { useTheme } from "./shared/theme.ts"
import { VARIANTS } from "./variants/index.ts"

const fromUrl = () => {
  const v = new URLSearchParams(window.location.search).get("variant")
  return VARIANTS.some((x) => x.key === v) ? v! : VARIANTS[0]!.key
}

function Prototype() {
  const [variant, setVariant] = useState(fromUrl)
  const [theme, setTheme] = useTheme()
  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]!
  const Variant = current.Component

  const change = (key: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set("variant", key)
    window.history.replaceState(null, "", url)
    setVariant(key)
  }

  return (
    <>
      <Variant key={current.key} />
      <PrototypeBar variants={VARIANTS} current={current.key} onChange={change} theme={theme} onTheme={setTheme} />
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
)
