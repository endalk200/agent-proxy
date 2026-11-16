// PROTOTYPE chrome, not part of the design: scenario picker, live-update simulator,
// state inspector, theme toggle. Fixed bottom-centre. Hidden outside dev builds.

import { useState } from "react"

import "./prototype-bar.css"
import { IconMonitor, IconMoon, IconSun, IconZap } from "./icons.tsx"
import {
  PROVIDERS,
  lastUsedText,
  poolState,
  providerName,
  statusLabel,
  statusOf,
  untilText,
} from "./model.ts"
import { SCENARIOS, type ScenarioId, sim, useDashboard, useNow } from "./store.ts"
import type { ThemeChoice } from "./theme.ts"

export function PrototypeBar(props: { theme: ThemeChoice; onTheme: (t: ThemeChoice) => void }) {
  const { theme, onTheme } = props
  const s = useDashboard()
  const now = useNow(1000)
  const [panel, setPanel] = useState<"none" | "sim" | "state">("none")

  if (!import.meta.env.DEV) return null

  const nextTheme: Record<ThemeChoice, ThemeChoice> = {
    system: "light",
    light: "dark",
    dark: "system",
  }
  const ThemeIcon = theme === "light" ? IconSun : theme === "dark" ? IconMoon : IconMonitor

  return (
    <div className="ptbar-wrap" data-prototype-chrome>
      {panel === "sim" && (
        <div className="ptbar-panel">
          <div className="ptbar-panel-title">Simulate live updates</div>
          <div className="ptbar-grid">
            <button onClick={() => sim.coolDown()}>Serving account hits its limit</button>
            <button onClick={() => sim.expireSignIn()}>A sign-in expires</button>
            <button onClick={() => sim.endCooldown()}>Soonest cooldown ends</button>
            <button onClick={() => sim.use()}>Serve a request</button>
            <button onClick={() => sim.setDaemonRunning(!s.daemon.running)}>
              {s.daemon.running ? "Stop the daemon" : "Start the daemon"}
            </button>
            <label className="ptbar-check">
              <input
                type="checkbox"
                checked={s.autoSimulate}
                onChange={(e) => sim.setAuto(e.target.checked)}
              />
              Random event every 6s
            </label>
          </div>
          <div className="ptbar-panel-title">Recent events</div>
          <ol className="ptbar-log">
            {s.events.slice(0, 6).map((e) => (
              <li key={e.id}>
                <span>{lastUsedText(e.at, now)}</span> {e.live ? "⚡" : "·"} {e.message}
              </li>
            ))}
            {s.events.length === 0 && <li>No events yet.</li>}
          </ol>
        </div>
      )}
      {panel === "state" && (
        <div className="ptbar-panel ptbar-state">
          <div className="ptbar-panel-title">
            State · daemon {s.daemon.running ? "running" : "down"} at {s.daemon.address} · scenario{" "}
            {s.scenario}
          </div>
          {PROVIDERS.map((p) => {
            const ps = poolState(s.accounts, p)
            return (
              <div key={p}>
                <div className="ptbar-pool">
                  {providerName[p]} pool:{" "}
                  {ps.kind === "serving"
                    ? `new sessions → ${ps.account.label}`
                    : ps.kind === "blocked"
                      ? `blocked${ps.nextReset !== null ? `, next reset ${untilText(ps.nextReset)}` : ""}`
                      : ps.kind}
                </div>
                <table>
                  <tbody>
                    {s.accounts
                      .filter((a) => a.provider === p)
                      .sort((a, b) => a.priority - b.priority)
                      .map((a) => {
                        const st = statusOf(a)
                        return (
                          <tr key={a.id}>
                            <td>#{a.priority}</td>
                            <td>{a.label}</td>
                            <td>{a.plan}</td>
                            <td>
                              {statusLabel(st)}
                              {st.kind === "cooling" ? ` ${untilText(st.until)}` : ""}
                            </td>
                            <td>{lastUsedText(a.lastUsedAt, now)}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}
      <div className="ptbar" role="toolbar" aria-label="Prototype controls">
        <span className="ptbar-tag">PROTOTYPE</span>
        <select
          className="ptbar-select"
          value={s.scenario}
          onChange={(e) => sim.loadScenario(e.target.value as ScenarioId)}
          aria-label="Scenario"
        >
          {SCENARIOS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <button
          className={`ptbar-btn ${panel === "sim" ? "on" : ""} ${s.autoSimulate ? "auto" : ""}`}
          onClick={() => setPanel(panel === "sim" ? "none" : "sim")}
        >
          <IconZap size={14} /> Simulate
        </button>
        <button
          className={`ptbar-btn ${panel === "state" ? "on" : ""}`}
          onClick={() => setPanel(panel === "state" ? "none" : "state")}
        >
          State
        </button>
        <button
          className="ptbar-icon"
          onClick={() => onTheme(nextTheme[theme])}
          title={`Theme: ${theme}`}
          aria-label={`Theme: ${theme}`}
        >
          <ThemeIcon />
        </button>
      </div>
    </div>
  )
}
