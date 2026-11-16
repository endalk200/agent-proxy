// PROTOTYPE round 2 variant A2: small helpers shared by A2's pages (routing, status pill, popover, toasts).
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"

import { IconPower, IconX, ProviderMark } from "../../shared/icons.tsx"
import { type Status, statusLabel } from "../../shared/model.ts"
import type { LiveEvent } from "../../shared/store.ts"
import { PAGES, type PageId } from "../kit/future.tsx"

// ---------------------------------------------------------------------------------------------
// Route: ?page= and, on the accounts page, ?account=

export interface Route {
  page: PageId
  account: string | null
}

const readRoute = (): Route => {
  const q = new URLSearchParams(window.location.search)
  const p = q.get("page")
  const page: PageId = p !== null && p in PAGES ? (p as PageId) : "accounts"
  return { page, account: page === "accounts" ? q.get("account") : null }
}

export const useRoute = (): [Route, (r: Route) => void] => {
  const [route, setRoute] = useState<Route>(readRoute)
  const go = useCallback((r: Route) => {
    const url = new URL(window.location.href)
    url.searchParams.set("page", r.page)
    if (r.account !== null) url.searchParams.set("account", r.account)
    else url.searchParams.delete("account")
    window.history.replaceState(null, "", url)
    setRoute(r)
    window.scrollTo({ top: 0 })
  }, [])
  return [route, go]
}

// ---------------------------------------------------------------------------------------------

export const uptime = (startedAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Status as a compact pill: dot + word. */
export function StatusPill({ status, size = "md" }: { status: Status; size?: "sm" | "md" }) {
  return (
    <span className={`vA2-st is-${status.kind} is-${size}`}>
      <span className="vA2-st-dot" />
      {statusLabel(status)}
    </span>
  )
}

/** A popover anchored under its trigger; closes on outside click and Escape. */
export function Popover(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  children: (close: () => void) => ReactNode
  align?: "left" | "right"
  className?: string
}) {
  const [open, setOpen] = useState(false)
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
  return (
    <div className="vA2-popwrap" ref={ref}>
      {props.trigger(open, () => setOpen(!open))}
      {open && (
        <div className={`vA2-popover is-${props.align ?? "left"} ${props.className ?? ""}`} role="dialog">
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Toasts for live updates (adapted from round 1 Console)

const toastTone = (k: LiveEvent["kind"]) =>
  k === "cooldown" ? "amber" : k === "signin-expired" || k === "daemon-down" ? "red" : "green"

export const eventTitle = (k: LiveEvent["kind"]): string => {
  switch (k) {
    case "cooldown":
      return "Cooling down"
    case "signin-expired":
      return "Needs sign-in"
    case "cooldown-ended":
      return "Active again"
    case "daemon-down":
      return "Daemon unreachable"
    case "daemon-up":
      return "Daemon running"
    case "signed-in":
      return "Signed in"
    case "used":
      return "Served a request"
    case "added":
      return "Added"
    case "removed":
      return "Removed"
    case "enabled":
      return "Enabled"
    case "disabled":
      return "Disabled"
    case "reordered":
      return "Priority changed"
    case "renamed":
      return "Renamed"
  }
}

export const eventTone = (k: LiveEvent["kind"]): "green" | "amber" | "red" | "neutral" =>
  k === "cooldown"
    ? "amber"
    : k === "signin-expired" || k === "daemon-down" || k === "removed"
      ? "red"
      : k === "cooldown-ended" || k === "signed-in" || k === "daemon-up" || k === "added" || k === "enabled"
        ? "green"
        : "neutral"

export function Toasts({ events }: { events: ReadonlyArray<LiveEvent> }) {
  const [toasts, setToasts] = useState<LiveEvent[]>([])
  const seen = useRef(events[0]?.id ?? 0)
  useEffect(() => {
    const fresh = events.filter((e) => e.id > seen.current && e.live && e.kind !== "used")
    seen.current = Math.max(seen.current, events[0]?.id ?? 0)
    if (fresh.length > 0) setToasts((t) => [...t, ...fresh.reverse()].slice(-4))
  }, [events])
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  return (
    <div className="vA-toasts vA2-toasts" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} event={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  )
}

function Toast({ event, onDismiss }: { event: LiveEvent; onDismiss: () => void }) {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    const t = setTimeout(() => dismissRef.current(), 6000)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className={`vA-toast is-${toastTone(event.kind)}`}>
      <span className="vA-toast-icon">
        {event.provider !== null ? <ProviderMark provider={event.provider} size={15} /> : <IconPower size={14} />}
      </span>
      <div className="vA-toast-body">
        <div className="vA-toast-kind">
          <span className="vA-sdot" />
          {eventTitle(event.kind)}
        </div>
        <div>{event.message}</div>
      </div>
      <button type="button" className="vA-iconbtn" onClick={onDismiss} aria-label="Dismiss">
        <IconX size={13} />
      </button>
    </div>
  )
}
