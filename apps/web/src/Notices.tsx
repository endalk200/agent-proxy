import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { CircleAlert, CircleCheck, Clock, Info } from "lucide-react"
import { type ReactNode, useMemo } from "react"

import {
  Toast,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { cn } from "@/lib/utils"

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

/**
 * Shows notices for everything below it. Each provider keeps its own toasts,
 * so two dashboards on one page (as in tests) never share them.
 */
export function NoticeProvider({ children }: { children: ReactNode }) {
  return (
    <ToastProvider limit={4}>
      {children}
      <ToastPortal>
        <ToastViewport data-notices="" className="sm:max-w-md">
          <NoticeList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

const toneStyles: Readonly<Record<NoticeTone, string>> = {
  error: "text-danger",
  warn: "text-warning",
  ok: "text-success",
  info: "text-muted-foreground",
}

function NoticeList() {
  const { toasts } = ToastPrimitive.useToastManager()
  return toasts.map((toast) => {
    const tone = isTone(toast.type) ? toast.type : "info"
    return (
      // Always laid out as the expanded stack, so a burst of notices stays
      // readable at once rather than hiding all but the newest until hover.
      <Toast
        key={toast.id}
        toast={toast}
        className="h-(--toast-height) rounded-lg [transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]"
      >
        <ToastContent className="items-start gap-3 p-4 data-behind:opacity-100">
          <span
            className={cn("mt-0.5 shrink-0 [&_svg]:size-4", toneStyles[tone])}
            aria-hidden="true"
          >
            <NoticeIcon tone={tone} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ToastTitle />
            <ToastDescription className="text-pretty" />
          </div>
          <ToastClose aria-label="Dismiss" className="-mt-1 -mr-1" />
        </ToastContent>
      </Toast>
    )
  })
}

const isTone = (type: string | undefined): type is NoticeTone =>
  type === "error" || type === "warn" || type === "ok" || type === "info"

function NoticeIcon({ tone }: { tone: NoticeTone }) {
  switch (tone) {
    case "error":
      return <CircleAlert />
    case "warn":
      return <Clock />
    case "ok":
      return <CircleCheck />
    case "info":
      return <Info />
  }
}

/** Adds notices; errors stay longer, and every notice waits while the pointer is on it. */
export const useNotify = (): Notify => {
  const { add } = ToastPrimitive.useToastManager()
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
