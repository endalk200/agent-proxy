import { describe, expect, it } from "vitest"

import { axisUsd } from "./format.ts"

describe("a cost axis tick", () => {
  it("reads whole dollars bare, cents in pairs, and every positive tick as more than zero", () => {
    expect([0, 1, 250, 1500].map(axisUsd)).toEqual(["$0", "$1", "$250", "$1.5K"])
    expect([0.1, 0.25, 7.5, 0.025].map(axisUsd)).toEqual(["$0.10", "$0.25", "$7.50", "$0.025"])
    // A range of one cached token: steps far below a cent, past where JS writes 1e-7.
    expect([1e-7, 2.5e-8, 3 * 1e-7].map(axisUsd)).toEqual([
      "$0.0000001",
      "$0.000000025",
      "$0.0000003",
    ])
  })
})
