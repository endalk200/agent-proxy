import { Toast } from "@base-ui/react/toast"
import { type ReactNode, useMemo } from "react"

import { IconAlert, IconCheck, IconClock, IconInfo, IconX } from "./ui.tsx"

/**
 * Notices: short toasts in the corner that say what happened: to something
 * the owner just did, such as a change the daemon refused, or to an account
 * while the page was open, such as a cooldown starting.
 */

/** A notice's colour: `ok` green, `warn` amber, `error` red, `info` neutral. */
export type NoticeTone = "error" | "warn" | "ok" | "info"

export interface Notice {
  readonly tone: NoticeTone
  readonly title: string
  readonly description: string
}

export interface Notify {
  readonly error: (title: string, description: string) => void
  readonly info: (title: string, description: string) => void
  readonly show: (notice: Notice) => void
}

/** Shows notices for everything below it. */
export function NoticeProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider limit={4}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="notices">
          <NoticeList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function NoticeList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className={`notice is-${toast.type ?? "info"}`}>
      <span className="notice-icon" aria-hidden="true">
        <NoticeIcon tone={toast.type} />
      </span>
      <div className="notice-body">
        <Toast.Title className="notice-title" />
        <Toast.Description className="notice-text" />
      </div>
      <Toast.Close className="iconbtn notice-x" aria-label="Dismiss">
        <IconX size={14} />
      </Toast.Close>
    </Toast.Root>
  ))
}

function NoticeIcon({ tone }: { tone: string | undefined }) {
  switch (tone) {
    case "error":
      return <IconAlert size={15} />
    case "warn":
      return <IconClock size={15} />
    case "ok":
      return <IconCheck size={15} />
    default:
      return <IconInfo size={15} />
  }
}

/** Adds notices; errors stay longer, and every notice waits while the pointer is on it. */
export const useNotify = (): Notify => {
  const { add } = Toast.useToastManager()
  return useMemo(() => {
    const show = ({ tone, title, description }: Notice) =>
      void add({ title, description, type: tone, timeout: tone === "error" ? 10_000 : 6000 })
    return {
      show,
      error: (title, description) => show({ tone: "error", title, description }),
      info: (title, description) => show({ tone: "info", title, description }),
    }
  }, [add])
}
