import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { LimitResetView } from "./api.ts"

const reset = {
  id: "full-reset-2611",
  name: "Full reset",
  refills: [{ id: "weekly", label: "Weekly" }],
  expiresAt: 1_800_000_000_000,
  usableNow: true,
  unavailableReason: null,
  asOf: 1_700_000_000_000,
}

describe("a limit reset from the daemon API", () => {
  it("reads one from a daemon that predates grant dates as granted at an unknown time", () => {
    expect(Schema.decodeSync(LimitResetView)(reset).grantedAt).toBeNull()
  })

  it("keeps the grant date a newer daemon sends", () => {
    const granted = { ...reset, grantedAt: 1_750_000_000_000 }
    expect(Schema.decodeSync(LimitResetView)(granted).grantedAt).toBe(1_750_000_000_000)
    expect(Schema.encodeSync(LimitResetView)(granted)).toEqual(granted)
  })
})
