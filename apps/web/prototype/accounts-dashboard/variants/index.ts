// PROTOTYPE: the variant registry the switcher cycles through.
// Round 2 iterates on round 1's Console (A): four app shells in the same visual language,
// each leaving room for the pages that come later (Usage, Sessions, Skills, remote daemons).
// Round 1's Console stays last as the baseline. Round 1's other variants are in commit 8d0df93.
import type { ComponentType } from "react"

import { VariantA, name as nameA } from "./a-console/VariantA.tsx"
import { VariantA1, name as nameA1 } from "./a1-sidebar/VariantA1.tsx"
import { VariantA2, name as nameA2 } from "./a2-toptabs/VariantA2.tsx"
import { VariantA3, name as nameA3 } from "./a3-grid/VariantA3.tsx"
import { VariantA4, name as nameA4 } from "./a4-rail/VariantA4.tsx"

export const VARIANTS: ReadonlyArray<{ key: string; name: string; Component: ComponentType }> = [
  { key: "A1", name: nameA1, Component: VariantA1 },
  { key: "A2", name: nameA2, Component: VariantA2 },
  { key: "A3", name: nameA3, Component: VariantA3 },
  { key: "A4", name: nameA4, Component: VariantA4 },
  { key: "A", name: `${nameA} (round 1)`, Component: VariantA },
]
