import { Tooltip } from "@base-ui/react/tooltip"
import { type ReactElement, type ReactNode, useEffect, useState } from "react"

import type { Provider } from "./daemon-api.ts"

/** Small shared pieces: icons, provider marks, the copy button, and tooltips. */

const Svg = ({ size = 16, children }: { size?: number | undefined; children: ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

type IconProps = { readonly size?: number }

export const IconCheck = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
)
export const IconCopy = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </Svg>
)
export const IconMore = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </Svg>
)
export const IconKey = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
  </Svg>
)
export const IconAlert = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
)
export const IconClock = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
)
export const IconPower = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04" />
  </Svg>
)
export const IconTerminal = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </Svg>
)
export const IconLink = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
)
export const IconX = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)
export const IconUsers = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
)
export const IconLaptop = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M2 20h20" />
  </Svg>
)
export const IconMonitor = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Svg>
)
export const IconSun = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Svg>
)
export const IconMoon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Svg>
)
export const IconSelector = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
  </Svg>
)
export const IconChevronRight = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
)
export const IconChevronUp = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m18 15-6-6-6 6" />
  </Svg>
)
export const IconChevronDown = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
)
export const IconPencil = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </Svg>
)
export const IconTrash = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
)

export const IconInfo = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Svg>
)
export const IconGrip = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="9" cy="6" r="1" />
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="18" r="1" />
    <circle cx="15" cy="6" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="18" r="1" />
  </Svg>
)
export const IconPlus = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconArrowRight = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
)
export const IconChevronLeft = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
)
export const IconExternal = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
)

/** A small spinning ring, for something the dashboard is waiting on. */
export const Spinner = ({ size = 16 }: { size?: number }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />
)

export const IconActivity = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Svg>
)
export const IconChart = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 3v18h18" />
    <path d="M18 17V9M13 17V5M8 17v-3" />
  </Svg>
)

/**
 * Provider marks, deliberately generic rather than the providers' logos:
 * Claude a warm eight-point spark, Codex a terminal prompt in a rounded square.
 */
export const ProviderMark = ({ provider, size = 16 }: { provider: Provider; size?: number }) =>
  provider === "claude" ? (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g stroke="#d97757" strokeWidth="2.6" strokeLinecap="round">
        <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />
      </g>
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="#10a37f" />
      <path
        d="m7.5 9 3 3-3 3M12.5 15.5h4"
        stroke="#fff"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

/** Writes `text` to the clipboard; resolves false where the browser refuses. */
export const copyText = (text: string): Promise<boolean> =>
  navigator.clipboard === undefined
    ? Promise.resolve(false)
    : navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      )

/** True for a moment after `flash()`, for "Copied" feedback. */
export const useFlag = (duration = 1400): [boolean, () => void] => {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!on) return
    const timer = setTimeout(() => setOn(false), duration)
    return () => clearTimeout(timer)
  }, [on, duration])
  return [on, () => setOn(true)]
}

/** An icon button that copies `text`; its name is `label` until it says "Copied". */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, flash] = useFlag()
  return (
    <Tip label={copied ? "Copied" : label}>
      <button
        type="button"
        className={`iconbtn ${copied ? "is-done" : ""}`}
        aria-label={copied ? "Copied" : label}
        onClick={() => {
          void copyText(text).then((ok) => ok && flash())
        }}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </Tip>
  )
}

/** A tooltip on `children`, which must accept a ref and props (a button or similar). */
export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="layer layer-tip" sideOffset={6}>
          <Tooltip.Popup className="tooltip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
