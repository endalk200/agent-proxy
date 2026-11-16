// PROTOTYPE variant A4: the ⌘K command palette. One place to jump to an account, act on it,
// add an account, copy a connect command, or change page. Scales to later pages' commands.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"

import {
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconKey,
  IconLogIn,
  IconPencil,
  IconPlus,
  IconPower,
  IconSearch,
  IconTrash,
  ProviderMark,
} from "../../shared/icons.tsx"
import { CLIENTS, type Provider, accountsOf, planShort, providerName, statusLabel, statusOf } from "../../shared/model.ts"
import { type DashboardState, actions } from "../../shared/store.ts"
import { copyText } from "../a-console/ui.tsx"
import { PAGES } from "../kit/future.tsx"
import { IconCornerDownLeft } from "./icons.tsx"
import { NAV_ICON, NAV_PAGES, type NavPage } from "./nav.ts"

export interface PaletteHandlers {
  go: (page: NavPage) => void
  select: (id: string) => void
  rename: (id: string) => void
  add: (p: Provider) => void
  reauth: (id: string) => void
  remove: (id: string) => void
  notify: (msg: string) => void
}

interface Item {
  id: string
  group: "Accounts" | "Actions" | "Clients" | "Go to"
  title: string
  hint?: ReactNode
  keywords?: string
  icon: ReactNode
  /** Only listed once the owner types something (keeps the empty list short). */
  searchOnly?: boolean
  run: () => void
}

/** Subsequence match with a bonus for word starts and contiguous runs. -1 = no match. */
const score = (q: string, text: string): number => {
  if (q === "") return 0
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return 100 - at + (at === 0 || t[at - 1] === " " ? 50 : 0)
  let s = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const i = t.indexOf(ch, ti)
    if (i < 0) return -1
    s += i === prev + 1 ? 3 : 1
    if (i === 0 || t[i - 1] === " ") s += 2
    prev = i
    ti = i + 1
  }
  return s
}

export function CommandPalette({ s, onClose, h }: { s: DashboardState; onClose: () => void; h: PaletteHandlers }) {
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const offline = !s.daemon.running

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    if (!offline) {
      for (const p of ["claude", "codex"] as const) {
        out.push({
          id: `add-${p}`,
          group: "Actions",
          title: `Add ${providerName[p]} account`,
          keywords: "new sign in login",
          icon: <IconPlus size={15} />,
          run: () => h.add(p),
        })
      }
    }
    for (const p of ["claude", "codex"] as const) {
      for (const a of accountsOf(s.accounts, p)) {
        const st = statusOf(a)
        out.push({
          id: `open-${a.id}`,
          group: "Accounts",
          title: a.label,
          hint: (
            <>
              {providerName[p]} · {planShort(a.plan)} · {statusLabel(st)}
            </>
          ),
          keywords: `${a.email} ${a.plan} ${providerName[p]}`,
          icon: <ProviderMark provider={p} size={14} />,
          run: () => h.select(a.id),
        })
        if (offline) continue
        if (st.kind === "signin") {
          out.push({
            id: `reauth-${a.id}`,
            group: "Accounts",
            title: `Sign in again: ${a.label}`,
            icon: <IconLogIn size={15} />,
            run: () => h.reauth(a.id),
          })
        }
        out.push(
          {
            id: `rename-${a.id}`,
            group: "Accounts",
            title: `Rename ${a.label}`,
            icon: <IconPencil size={14} />,
            searchOnly: true,
            run: () => h.rename(a.id),
          },
          {
            id: `toggle-${a.id}`,
            group: "Accounts",
            title: `${a.enabled ? "Disable" : "Enable"} ${a.label}`,
            icon: <IconPower size={14} />,
            searchOnly: true,
            run: () => {
              actions.setEnabled(a.id, !a.enabled)
              h.notify(`${a.enabled ? "Disabled" : "Enabled"} ${a.label}`)
            },
          },
        )
        if (a.priority > 1)
          out.push({
            id: `up-${a.id}`,
            group: "Accounts",
            title: `Move ${a.label} up`,
            hint: `to priority ${a.priority - 1}`,
            icon: <IconChevronUp size={15} />,
            searchOnly: true,
            run: () => actions.move(a.id, -1),
          })
        if (a.priority < accountsOf(s.accounts, p).length)
          out.push({
            id: `down-${a.id}`,
            group: "Accounts",
            title: `Move ${a.label} down`,
            hint: `to priority ${a.priority + 1}`,
            icon: <IconChevronDown size={15} />,
            searchOnly: true,
            run: () => actions.move(a.id, 1),
          })
        out.push({
          id: `remove-${a.id}`,
          group: "Accounts",
          title: `Remove ${a.label}…`,
          icon: <IconTrash size={14} />,
          searchOnly: true,
          run: () => h.remove(a.id),
        })
      }
    }
    for (const c of CLIENTS) {
      out.push({
        id: `copy-${c.id}`,
        group: "Clients",
        title: `Copy connect command: ${c.name}`,
        hint: <code>{c.command}</code>,
        keywords: c.command,
        icon: <IconCopy size={14} />,
        run: () => {
          copyText(c.command)
          h.notify(`Copied ${c.command}`)
        },
      })
    }
    out.push({
      id: "copy-key",
      group: "Clients",
      title: "Copy proxy key",
      keywords: "secret token",
      icon: <IconKey size={14} />,
      run: () => {
        copyText(s.proxyKey)
        h.notify("Copied the proxy key")
      },
    })
    for (const id of NAV_PAGES) {
      const P = PAGES[id]
      const Icon = NAV_ICON[id]
      out.push({
        id: `go-${id}`,
        group: "Go to",
        title: P.title,
        hint: P.ready ? undefined : "Planned",
        icon: <Icon size={15} />,
        run: () => h.go(id),
      })
    }
    return out
  }, [s.accounts, s.proxyKey, offline, h])

  const query = q.trim().toLowerCase()
  const shown = useMemo(() => {
    if (query === "") return items.filter((i) => i.searchOnly !== true)
    return items
      .map((i) => ({ i, sc: Math.max(score(query, i.title), score(query, `${i.title} ${i.keywords ?? ""}`) - 20) }))
      .filter((x) => x.sc >= 0)
      .sort((x, y) => y.sc - x.sc)
      .slice(0, 14)
      .map((x) => x.i)
  }, [items, query])

  // Group in a fixed order when browsing; keep score order when searching.
  const groups = useMemo(() => {
    const order: Item["group"][] = query === "" ? ["Actions", "Accounts", "Clients", "Go to"] : []
    const m = new Map<Item["group"], Item[]>()
    for (const g of order) m.set(g, [])
    for (const it of shown) m.set(it.group, [...(m.get(it.group) ?? []), it])
    return [...m.entries()].filter(([, v]) => v.length > 0)
  }, [shown, query])
  const flat = groups.flatMap(([, v]) => v)

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const runAt = (i: number) => {
    const it = flat[i]
    if (it === undefined) return
    onClose()
    it.run()
  }

  let idx = -1
  return (
    <div className="vA4-cmdk-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vA4-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="vA4-cmdk-input">
          <IconSearch size={16} />
          <input
            autoFocus
            value={q}
            placeholder="Search accounts, or run a command…"
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search or run a command"
            aria-controls="vA4-cmdk-list"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive((a) => (flat.length === 0 ? 0 : (a + 1) % flat.length))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((a) => (flat.length === 0 ? 0 : (a - 1 + flat.length) % flat.length))
              } else if (e.key === "Enter") {
                e.preventDefault()
                runAt(active)
              } else if (e.key === "Escape") {
                e.preventDefault()
                onClose()
              }
            }}
          />
          <kbd className="vA4-kbd">esc</kbd>
        </div>
        <div className="vA4-cmdk-list" id="vA4-cmdk-list" role="listbox" ref={listRef}>
          {flat.length === 0 && <div className="vA4-cmdk-empty">No matches for “{q}”.</div>}
          {groups.map(([g, list]) => (
            <div key={g} className="vA4-cmdk-group" role="group" aria-label={g}>
              <div className="vA4-cmdk-gtitle">{g}</div>
              {list.map((it) => {
                idx++
                const i = idx
                return (
                  <div
                    key={it.id}
                    data-idx={i}
                    role="option"
                    aria-selected={i === active}
                    className={`vA4-cmdk-item ${i === active ? "is-active" : ""} ${it.id.startsWith("remove-") ? "is-danger" : ""}`}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => runAt(i)}
                  >
                    <span className="vA4-cmdk-icon">{it.icon}</span>
                    <span className="vA4-cmdk-title">{it.title}</span>
                    {it.hint !== undefined && <span className="vA4-cmdk-hint">{it.hint}</span>}
                    {i === active && <IconCornerDownLeft size={13} className="vA4-cmdk-enter" />}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <div className="vA4-cmdk-foot">
          <span>
            <kbd className="vA4-kbd">↑</kbd>
            <kbd className="vA4-kbd">↓</kbd> to navigate
          </span>
          <span>
            <kbd className="vA4-kbd">↵</kbd> to run
          </span>
          {offline && <span className="vA4-cmdk-off">Daemon unreachable · changes are paused</span>}
        </div>
      </div>
    </div>
  )
}
