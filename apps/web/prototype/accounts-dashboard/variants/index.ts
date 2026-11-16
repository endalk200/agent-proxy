// PROTOTYPE: the variant registry the switcher cycles through.
import type { ComponentType } from "react"

import { VariantA, name as nameA } from "./a-console/VariantA.tsx"
import { VariantB, name as nameB } from "./b-lanes/VariantB.tsx"
import { VariantC, name as nameC } from "./c-keyboard/VariantC.tsx"
import { VariantD, name as nameD } from "./d-calm/VariantD.tsx"

export const VARIANTS: ReadonlyArray<{ key: string; name: string; Component: ComponentType }> = [
  { key: "A", name: nameA, Component: VariantA },
  { key: "B", name: nameB, Component: VariantB },
  { key: "C", name: nameC, Component: VariantC },
  { key: "D", name: nameD, Component: VariantD },
]
