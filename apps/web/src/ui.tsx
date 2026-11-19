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

/** Claude's spark and OpenAI's blossom, the marks of the two providers (from Simple Icons). */
const CLAUDE_MARK =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
const OPENAI_MARK =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"

/**
 * A provider's own mark: Claude's spark in its orange, and OpenAI's blossom
 * for Codex, drawn in the text colour so it reads on either theme.
 */
export const ProviderMark = ({ provider, size = 16 }: { provider: Provider; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {provider === "claude" ? (
      <path d={CLAUDE_MARK} fill="#d97757" />
    ) : (
      <path d={OPENAI_MARK} fill="currentColor" />
    )}
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

export const IconRefresh = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8" />
    <path d="M21 3v5h-5M3 21v-5h5" />
  </Svg>
)
export const IconGauge = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
)
export const IconCalendar = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </Svg>
)
