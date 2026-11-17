import { describe, expect, it } from "@effect/vitest"

import { formatUptime } from "./daemon.ts"

describe("formatUptime", () => {
  it("shows seconds alone under a minute, including zero", () => {
    expect(formatUptime(0)).toBe("0s")
    expect(formatUptime(45)).toBe("45s")
  })

  it("shows the two largest units", () => {
    expect(formatUptime(192)).toBe("3m 12s")
    expect(formatUptime(3725)).toBe("1h 2m")
    expect(formatUptime(273_600)).toBe("3d 4h")
  })

  it("skips a zero unit between the two largest", () => {
    expect(formatUptime(3605)).toBe("1h 5s")
  })
})
