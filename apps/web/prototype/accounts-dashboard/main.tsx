// PROTOTYPE — the agent-proxy web dashboard, accounts page first.
//
// Answers "What should the dashboard look like?". Two rounds of variants settled on a sidebar app shell
// in a dense console style (see NOTES.md; the full comparisons are in commits 8d0df93 and 37eb456).
// Mock data lives in memory (shared/store.ts). The floating prototype bar loads the edge-state
// scenarios, fakes the daemon's live status changes, shows the state, and toggles the theme.
// `?scenario=`, `?theme=light|dark` and `?page=` pin a view so a URL reproduces it.
//
// Run from the repo root: `bun run prototype:accounts`. Disposable; never merge into main.

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./shared/base.css"
import { Dashboard } from "./dashboard/Dashboard.tsx"
import { PrototypeBar } from "./shared/PrototypeBar.tsx"
import { useTheme } from "./shared/theme.ts"

function Prototype() {
  const [theme, setTheme] = useTheme()
  return (
    <>
      <Dashboard />
      <PrototypeBar theme={theme} onTheme={setTheme} />
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
)
