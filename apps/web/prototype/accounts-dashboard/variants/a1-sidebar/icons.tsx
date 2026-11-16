// PROTOTYPE variant A1: nav icons private to this variant (lucide-style, 24px grid).
import type { ReactNode } from "react"

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
  >
    {children}
  </svg>
)

export const IconUsers = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
)
export const IconChart = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="M3 3v18h18" />
    <path d="M7 16v-4M11 16V8M15 16v-6M19 16V5" />
  </Svg>
)
export const IconHistory = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5M12 7v5l4 2" />
  </Svg>
)
export const IconSpark = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </Svg>
)
export const IconGear = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)
export const IconLaptop = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M2 20h20" />
  </Svg>
)
export const IconSelector = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
  </Svg>
)
export const IconGlobe = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </Svg>
)
export const IconActivity = ({ size }: { size?: number | undefined }) => (
  <Svg size={size}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Svg>
)
