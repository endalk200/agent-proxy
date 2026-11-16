// PROTOTYPE variant A: small UI pieces (modal, switch, menu, copy button) private to this variant.
import { type ReactNode, useEffect, useRef, useState } from "react"

import { IconCheck, IconCopy, IconMore, IconX } from "../../shared/icons.tsx"

export const copyText = (text: string) => {
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className={`vA-iconbtn ${copied ? "is-done" : ""}`}
      onClick={() => {
        copyText(text)
        setCopied(true)
      }}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  )
}

export function Modal(props: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  icon?: ReactNode
}) {
  const { onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", k)
    return () => window.removeEventListener("keydown", k)
  }, [onClose])
  useEffect(() => {
    const root = ref.current
    if (root === null || root.contains(document.activeElement)) return
    const first =
      root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>(".vA-modal-body button, .vA-modal-body input")
    first?.focus()
  }, [])
  return (
    <div className="vA-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="vA-modal"
        role="dialog"
        aria-modal="true"
        ref={ref}
        style={props.width !== undefined ? { width: props.width } : undefined}
      >
        <div className="vA-modal-head">
          {props.icon !== undefined && <div className="vA-modal-icon">{props.icon}</div>}
          <div className="vA-modal-titles">
            <h2>{props.title}</h2>
            {props.subtitle !== undefined && <p>{props.subtitle}</p>}
          </div>
          <button type="button" className="vA-iconbtn vA-modal-x" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <div className="vA-modal-body">{props.children}</div>
        {props.footer !== undefined && <div className="vA-modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      className={`vA-switch ${props.checked ? "is-on" : ""}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
}

export function RowMenu({ items, label }: { items: ReadonlyArray<MenuItem>; label: string }) {
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
    <div className="vA-menu-wrap" ref={ref}>
      <button
        type="button"
        className={`vA-iconbtn ${open ? "is-active" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconMore size={16} />
      </button>
      {open && (
        <div className="vA-menu" role="menu">
          {items.map((it) => (
            <div key={it.label}>
              {it.separatorBefore === true && <div className="vA-menu-sep" />}
              <button
                type="button"
                role="menuitem"
                disabled={it.disabled}
                className={`vA-menu-item ${it.danger === true ? "is-danger" : ""}`}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
              >
                <span className="vA-menu-icon">{it.icon}</span>
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="vA-spinner" style={{ width: size, height: size }} aria-hidden="true" />
}
