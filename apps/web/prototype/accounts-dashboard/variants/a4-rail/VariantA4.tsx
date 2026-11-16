// PROTOTYPE round 2 variant A4 — "Rail and activity".
// Console's visual language in an app shell built for more pages: a slim icon rail (Accounts, then
// the planned Usage, Sessions, Skills, and Settings), a top bar with the daemon as a switcher
// (room for remote daemons later) and a ⌘K command palette, and on Accounts a sticky right-hand
// context column of persistent panels: the selected account's inspector, Pools, Connect clients,
// and a live Activity feed that replaces toasts.

import { useCallback, useEffect, useState } from "react"

import "../a-console/console.css"
import "./rail.css"
import { IconCheck, IconPlus, IconPower } from "../../shared/icons.tsx"
import { PROVIDERS, type Provider } from "../../shared/model.ts"
import { useDashboard, useNow } from "../../shared/store.ts"
import { AddAccountModal } from "../a-console/AddAccountModal.tsx"
import { FuturePage, PAGES } from "../kit/future.tsx"
import { FirstRun, ProviderSection, RemoveModal } from "./accounts.tsx"
import { ActivityPanel, ClientsPanel, Inspector, PoolsPanel } from "./context.tsx"
import { type NavPage, pageFromUrl, writePage } from "./nav.ts"
import { CommandPalette } from "./palette.tsx"
import { Rail, TopBar } from "./shell.tsx"

export const name = "Rail and activity"

type Dialog =
  | { kind: "add"; provider: Provider | undefined }
  | { kind: "reauth"; accountId: string }
  | { kind: "remove"; accountId: string }
  | null

export function VariantA4() {
  const s = useDashboard()
  const now = useNow(1000)
  const [page, setPage] = useState<NavPage>(pageFromUrl)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [palette, setPalette] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [inspEditing, setInspEditing] = useState(false)
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)

  const offline = !s.daemon.running
  const selected = selectedId === null ? undefined : s.accounts.find((a) => a.id === selectedId)
  const removing = dialog?.kind === "remove" ? s.accounts.find((a) => a.id === dialog.accountId) : undefined

  // Drop a selection whose account is gone (removed, or a scenario switch).
  useEffect(() => {
    if (selectedId !== null && selected === undefined) setSelectedId(null)
  }, [selectedId, selected])

  // ⌘K / Ctrl+K toggles the palette; Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (e.key === "Escape" && dialog === null && !palette) {
        const t = document.activeElement
        if (!(t instanceof HTMLInputElement)) setSelectedId(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [dialog, palette])

  useEffect(() => {
    if (notice === null) return
    const t = setTimeout(() => setNotice(null), 1800)
    return () => clearTimeout(t)
  }, [notice])

  const go = useCallback((p: NavPage) => {
    writePage(p)
    setPage(p)
  }, [])

  const select = useCallback(
    (id: string) => {
      go("accounts")
      setSelectedId(id)
      setInspEditing(false)
      requestAnimationFrame(() =>
        document.querySelector(`.vA4 [data-account="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      )
    },
    [go],
  )

  const close = () => setDialog(null)

  return (
    <div className={`vA vA4 ${offline ? "is-offline" : ""}`}>
      <Rail s={s} page={page} onGo={go} />
      <div className="vA4-body">
        <TopBar s={s} now={now} page={page} onPalette={() => setPalette(true)} />

        {page === "accounts" ? (
          <main className="vA4-page">
            <div className="vA4-pagehead">
              <div>
                <h1>Accounts</h1>
                <p>{PAGES.accounts.blurb}</p>
              </div>
              <button
                type="button"
                className="vA-btn vA-btn-primary"
                onClick={() => setDialog({ kind: "add", provider: undefined })}
                disabled={offline}
              >
                <IconPlus size={14} /> Add account
              </button>
            </div>

            {offline && (
              <div className="vA4-offline" role="status">
                <IconPower size={15} />
                <div>
                  <b>Can't reach the daemon at {s.daemon.address}.</b> Is it running? You're looking at the last state it reported;
                  changes are paused until it's back.
                </div>
              </div>
            )}

            <div className="vA4-split">
              <div className="vA4-maincol">
                {s.accounts.length === 0 ? (
                  <FirstRun onAdd={(p) => setDialog({ kind: "add", provider: p })} address={s.daemon.address} />
                ) : (
                  PROVIDERS.map((p) => (
                    <ProviderSection
                      key={p}
                      provider={p}
                      accounts={s.accounts}
                      now={now}
                      selectedId={selectedId}
                      editingId={editingId}
                      onEdit={setEditingId}
                      onSelect={(id) => {
                        setSelectedId(id === selectedId ? null : id)
                        setInspEditing(false)
                      }}
                      onAdd={() => setDialog({ kind: "add", provider: p })}
                      onReauth={(id) => setDialog({ kind: "reauth", accountId: id })}
                      onRemove={(id) => setDialog({ kind: "remove", accountId: id })}
                    />
                  ))
                )}
              </div>

              <aside className="vA4-context" aria-label="Context">
                {selected !== undefined && (
                  <Inspector
                    key={selected.id}
                    account={selected}
                    accounts={s.accounts}
                    now={now}
                    editing={inspEditing}
                    onEdit={setInspEditing}
                    onClose={() => setSelectedId(null)}
                    onReauth={() => setDialog({ kind: "reauth", accountId: selected.id })}
                    onRemove={() => setDialog({ kind: "remove", accountId: selected.id })}
                  />
                )}
                {s.accounts.length > 0 && <PoolsPanel s={s} now={now} onSelect={select} />}
                <ActivityPanel s={s} now={now} onSelect={select} />
                <ClientsPanel />
              </aside>
            </div>
          </main>
        ) : (
          <main className="vA4-page vA4-page-single">
            <FuturePage id={page} />
          </main>
        )}
      </div>

      {notice !== null && (
        <div className="vA4-notice" key={notice.id} role="status">
          <IconCheck size={13} /> {notice.text}
        </div>
      )}

      {palette && (
        <CommandPalette
          s={s}
          onClose={() => setPalette(false)}
          h={{
            go,
            select,
            rename: (id) => {
              select(id)
              setEditingId(id)
            },
            add: (p) => setDialog({ kind: "add", provider: p }),
            reauth: (id) => setDialog({ kind: "reauth", accountId: id }),
            remove: (id) => setDialog({ kind: "remove", accountId: id }),
            notify: (text) => setNotice({ id: Date.now(), text }),
          }}
        />
      )}
      {dialog?.kind === "add" && <AddAccountModal provider={dialog.provider} reauthAccountId={undefined} onClose={close} />}
      {dialog?.kind === "reauth" && <AddAccountModal provider={undefined} reauthAccountId={dialog.accountId} onClose={close} />}
      {removing !== undefined && <RemoveModal account={removing} accounts={s.accounts} onClose={close} />}
    </div>
  )
}
