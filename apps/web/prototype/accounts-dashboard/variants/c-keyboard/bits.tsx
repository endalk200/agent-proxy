// PROTOTYPE variant C: small pieces used across the Keyboard variant.
import type { ReactNode } from "react"

import { type Plan, type Status, planShort, planTier } from "../../shared/model.ts"

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="vC-kbd">{children}</kbd>

export const isTyping = (el: Element | null) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLElement && el.isContentEditable)

export const glyph: Record<Status["kind"], string> = {
  active: "●",
  cooling: "◐",
  signin: "▲",
  disabled: "○",
}

export const Glyph = ({ status }: { status: Status }) => (
  <span className={`vC-glyph vC-st-${status.kind}`} aria-hidden="true">
    {glyph[status.kind]}
  </span>
)

export const PlanBadge = ({ plan }: { plan: Plan }) => (
  <span className={`vC-plan vC-tier${planTier(plan)}`} title={plan}>
    {planShort(plan)}
  </span>
)

export const copy = (text: string): Promise<boolean> =>
  navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  ) ?? Promise.resolve(false)

/** "3h 02m", "12m", "45s" */
export const uptime = (since: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

export const clockSeconds = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const spinnerFrame = (now: number) => SPIN[Math.floor(now / 90) % SPIN.length]

export const maskKey = (k: string) => `${k.slice(0, 9)}${"•".repeat(14)}${k.slice(-4)}`
