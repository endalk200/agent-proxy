// PROTOTYPE: the app's pages, including the ones that come later, and a placeholder for those.
// Later pages come from docs/vision.md: usage, the session archive, skills sync. Remote daemons
// live in the sidebar's daemon switcher instead.

import type { ReactNode } from "react"

import "./future.css"

export type PageId = "accounts" | "usage" | "sessions" | "skills" | "settings"

export interface PageInfo {
  id: PageId
  title: string
  /** false = planned, not built yet. */
  ready: boolean
  blurb: string
}

export const PAGES: Record<PageId, PageInfo> = {
  accounts: {
    id: "accounts",
    title: "Accounts",
    ready: true,
    blurb:
      "Each client spends only its own provider's accounts. Within a pool, the highest-priority account that isn't cooling down gets new sessions.",
  },
  usage: {
    id: "usage",
    title: "Usage",
    ready: false,
    blurb:
      "Tokens and requests per account, and how much of each plan's limit is left, such as Claude's five-hour window.",
  },
  sessions: {
    id: "sessions",
    title: "Sessions",
    ready: false,
    blurb:
      "Every Claude Code, Codex and opencode session from every machine, in one archive you can search and review.",
  },
  skills: {
    id: "skills",
    title: "Skills",
    ready: false,
    blurb: "Your skills catalog, kept in sync across every machine and agent.",
  },
  settings: {
    id: "settings",
    title: "Settings",
    ready: false,
    blurb: "The proxy key, the daemon's address, and where the config file lives.",
  },
}

/** Placeholder for a page that is planned but not built: header, a "Planned" note, and a faint skeleton of its shape. */
export function FuturePage({
  id,
  headerExtra,
}: {
  id: Exclude<PageId, "accounts">
  headerExtra?: ReactNode
}) {
  const p = PAGES[id]
  return (
    <div className="ap-future">
      <div className="ap-future-head">
        <div>
          <h1>
            {p.title} <span className="ap-planned">Planned</span>
          </h1>
          <p>{p.blurb}</p>
        </div>
        {headerExtra}
      </div>
      <div className="ap-skel" aria-hidden="true">
        {id === "usage" && (
          <>
            <div className="ap-skel-tiles">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="ap-skel-tile">
                  <i style={{ width: 70 }} />
                  <b style={{ width: 54 }} />
                </div>
              ))}
            </div>
            <div className="ap-skel-chart">
              {Array.from({ length: 28 }, (_, i) => (
                <span key={i} style={{ height: `${22 + ((i * 37) % 70)}%` }} />
              ))}
            </div>
            <SkelRows n={4} cols={[38, 14, 14, 14]} />
          </>
        )}
        {id === "sessions" && (
          <>
            <div className="ap-skel-toolbar">
              <i style={{ width: 220 }} />
              <i style={{ width: 90 }} />
              <i style={{ width: 90 }} />
            </div>
            <SkelRows n={7} cols={[8, 40, 16, 14]} />
          </>
        )}
        {id === "skills" && <SkelRows n={6} cols={[30, 36, 12, 6]} />}
        {id === "settings" && (
          <div className="ap-skel-form">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <i style={{ width: 120 }} />
                <b />
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="ap-future-note">Not built yet. This page shows where it will sit in the app.</p>
    </div>
  )
}

function SkelRows({ n, cols }: { n: number; cols: ReadonlyArray<number> }) {
  return (
    <div className="ap-skel-table">
      {Array.from({ length: n }, (_, r) => (
        <div key={r} className="ap-skel-row">
          {cols.map((w, c) => (
            <i key={c} style={{ width: `${Math.max(4, w - ((r * 7 + c * 3) % 9))}%` }} />
          ))}
        </div>
      ))}
    </div>
  )
}
