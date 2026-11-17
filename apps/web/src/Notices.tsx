import { Toast } from "@base-ui/react/toast"
import { type ReactNode, useMemo } from "react"

import { IconAlert, IconInfo, IconX } from "./ui.tsx"

/**
 * Notices: short toasts in the corner that say what happened to something
 * the owner just did, such as a change the daemon refused.
 */

export type NoticeTone = "error" | "info"

export interface Notify {
  readonly error: (title: string, description: string) => void
  readonly info: (title: string, description: string) => void
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
        {toast.type === "error" ? <IconAlert size={15} /> : <IconInfo size={15} />}
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

/** Adds notices; errors stay longer, and every notice waits while the pointer is on it. */
export const useNotify = (): Notify => {
  const { add } = Toast.useToastManager()
  return useMemo(
    () => ({
      error: (title, description) => add({ title, description, type: "error", timeout: 10_000 }),
      info: (title, description) => add({ title, description, type: "info", timeout: 6000 }),
    }),
    [add],
  )
}
