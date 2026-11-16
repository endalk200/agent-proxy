// PROTOTYPE variant C: the ⌘K command palette and the Connect clients panel.
import { useEffect, useMemo, useRef, useState } from "react"

import { CLIENTS, providerName } from "../../shared/model.ts"
import { Kbd, copy, maskKey } from "./bits.tsx"

export interface Command {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

/** Subsequence match; returns matched indices and a score (higher is better), or null. */
const fuzzy = (query: string, text: string): { score: number; hits: number[] } | null => {
  if (query === "") return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const hits: number[] = []
  let score = 0
  let from = 0
  for (const ch of q) {
    if (ch === " ") continue
    const i = t.indexOf(ch, from)
    if (i === -1) return null
    const prev = hits[hits.length - 1]
    score += prev !== undefined && i === prev + 1 ? 3 : 1
    if (i === 0 || t[i - 1] === " " || t[i - 1] === ":") score += 2
    hits.push(i)
    from = i + 1
  }
  return { score: score - text.length * 0.01, hits }
}

const Highlight = ({ text, hits }: { text: string; hits: number[] }) => {
  const set = new Set(hits)
  return (
    <>
      {[...text].map((c, i) => (set.has(i) ? <mark key={i}>{c}</mark> : c))}
    </>
  )
}

export function Palette(props: { commands: ReadonlyArray<Command>; onClose: () => void }) {
  const { commands, onClose } = props
  const [q, setQ] = useState("")
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const results = useMemo(
    () =>
      commands
        .flatMap((c) => {
          const m = fuzzy(q, c.label)
          return m === null ? [] : [{ c, ...m }]
        })
        .sort((a, b) => (q === "" ? 0 : b.score - a.score)),
    [commands, q],
  )

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setIndex(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [index])

  const run = (i: number) => {
    const r = results[i]
    if (r === undefined) return
    onClose()
    r.c.run()
  }

  return (
    <div className="vC-scrim" onMouseDown={onClose}>
      <div className="vC-palette" role="dialog" aria-label="Commands" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vC-prompt vC-palette-input">
          <span className="vC-caret">›</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="type a command: disable work, add codex, copy key…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Command"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
                e.preventDefault()
                setIndex((i) => Math.min(results.length - 1, i + 1))
              } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === "Enter") {
                e.preventDefault()
                run(index)
              } else if (e.key === "Escape") {
                e.preventDefault()
                onClose()
              }
            }}
          />
          <span className="vC-muted vC-count">{results.length}</span>
        </div>
        <ul className="vC-palette-list" ref={listRef} role="listbox">
          {results.map((r, i) => {
            const groupStart = i === 0 || results[i - 1]?.c.group !== r.c.group
            return (
              <li key={r.c.id} role="presentation">
                {q === "" && groupStart && <div className="vC-palette-group">{r.c.group}</div>}
                <button
                  data-i={i}
                  role="option"
                  aria-selected={i === index}
                  className={`vC-palette-item ${i === index ? "sel" : ""}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(i)}
                >
                  <span>
                    <Highlight text={r.c.label} hits={r.hits} />
                  </span>
                  {r.c.hint !== undefined && <Kbd>{r.c.hint}</Kbd>}
                </button>
              </li>
            )
          })}
          {results.length === 0 && <li className="vC-palette-empty">no command matches “{q}”</li>}
        </ul>
        <footer className="vC-palette-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> select
          </span>
          <span>
            <Kbd>↵</Kbd> run
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </footer>
      </div>
    </div>
  )
}

export function ConnectPanel(props: { address: string; proxyKey: string; onClose: () => void; onCopied: (what: string) => void }) {
  const { address, proxyKey, onClose, onCopied } = props
  const [reveal, setReveal] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const doCopy = (id: string, text: string, what: string) => {
    void copy(text).then(() => {
      setCopied(id)
      onCopied(what)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400)
    })
  }

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "Escape" || e.key === "c") {
        e.preventDefault()
        onClose()
      }
      const n = Number(e.key)
      const client = CLIENTS[n - 1]
      if (client !== undefined) doCopy(client.id, client.command, `copied: ${client.command}`)
      if (e.key === "r") setReveal((r) => !r)
      if (e.key === "y") doCopy("key", proxyKey, "copied the proxy key")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="vC-scrim" onMouseDown={onClose}>
      <div className="vC-connect" role="dialog" aria-label="Connect clients" onMouseDown={(e) => e.stopPropagation()}>
        <header className="vC-pane-head">
          <span className="vC-crumb">connect clients</span>
          <button ref={closeRef} className="vC-btn vC-ghost" onClick={onClose}>
            close <Kbd>esc</Kbd>
          </button>
        </header>
        <p className="vC-prose">
          Run one command per client. It points the client at <code>{address}</code> and saves the proxy key in the
          client's config.
        </p>
        <ul className="vC-clients">
          {CLIENTS.map((c, i) => (
            <li key={c.id}>
              <div className="vC-client-name">
                <Kbd>{i + 1}</Kbd>
                <b>{c.name}</b>
                <span className="vC-muted">
                  uses the {c.providers.map((p) => providerName[p]).join(" + ")} pool{c.providers.length > 1 ? "s" : ""}
                </span>
              </div>
              <button className={`vC-cmd ${copied === c.id ? "copied" : ""}`} onClick={() => doCopy(c.id, c.command, `copied: ${c.command}`)}>
                <span className="vC-dollar">$</span>
                <span className="vC-cmd-text">{c.command}</span>
                <span className="vC-cmd-copy">{copied === c.id ? "copied ✓" : "copy"}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="vC-key">
          <div className="vC-client-name">
            <b>Proxy key</b>
            <span className="vC-muted">the secret clients present to the proxy</span>
          </div>
          <div className="vC-key-row">
            <code>{reveal ? proxyKey : maskKey(proxyKey)}</code>
            <button className="vC-btn vC-ghost" onClick={() => setReveal((r) => !r)}>
              {reveal ? "hide" : "reveal"} <Kbd>r</Kbd>
            </button>
            <button className="vC-btn" onClick={() => doCopy("key", proxyKey, "copied the proxy key")}>
              {copied === "key" ? "copied ✓" : "copy"} <Kbd>y</Kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
