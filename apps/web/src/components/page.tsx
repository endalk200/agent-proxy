import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * A page's head: its title, which takes focus when the page changes, a line
 * on what the page is for, and the page's actions on the right.
 */
export function PageHeader(props: {
  title: string
  description: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    // The head lays out by its own width, not the window's, so it fits when
    // the account sheet narrows the page.
    <div className="@container">
      <header
        className={cn(
          "flex flex-col gap-4 @3xl:flex-row @3xl:items-end @3xl:justify-between",
          props.className,
        )}
      >
        <div className="flex max-w-3xl flex-col gap-1.5">
          <h1
            id="page-title"
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight outline-none"
          >
            {props.title}
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">{props.description}</p>
        </div>
        {props.actions !== undefined && (
          <div className="flex max-w-full min-w-0 shrink-0 flex-wrap items-center gap-2">
            {props.actions}
          </div>
        )}
      </header>
    </div>
  )
}

/**
 * The page's content under its head. While the daemon is unreachable it
 * dims, showing what the daemon last reported.
 */
export function PageContent(props: { stale: boolean; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-6 transition-opacity",
        props.stale && "opacity-60",
        props.className,
      )}
    >
      {props.children}
    </div>
  )
}
