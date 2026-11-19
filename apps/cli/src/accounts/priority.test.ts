import { describe, expect, it } from "@effect/vitest"

import { levelsOf, place, type Placement } from "./priority.ts"

/** A pool written as its accounts' priorities, `{ a: 1, b: 1, c: 2 }`. */
const pool = (priorities: Readonly<Record<string, number>>) =>
  Object.entries(priorities).map(([id, priority]) => ({ id, priority }))

/** `place`'s pool as `{ id: priority }`, or its problem. */
const placed = (priorities: Readonly<Record<string, number>>, id: string, placement: Placement) => {
  const result = place(pool(priorities), id, placement)
  return result._tag === "Placed"
    ? Object.fromEntries(result.pool.map((account) => [account.id, account.priority]))
    : result
}

describe("levelsOf", () => {
  it("groups a pool by priority, closing gaps, in listed order within a priority", () => {
    expect(
      levelsOf(pool({ c: 5, a: 2, b: 2, d: 9 })).map((level) => level.map((a) => a.id)),
    ).toEqual([["a", "b"], ["c"], ["d"]])
  })
})

describe("place", () => {
  it("moves an account alone to a priority, shifting those from there down", () => {
    expect(placed({ a: 1, b: 2, c: 3 }, "c", { _tag: "Own", priority: 1 })).toEqual({
      c: 1,
      a: 2,
      b: 3,
    })
    expect(placed({ a: 1, b: 2, c: 3 }, "a", { _tag: "Own", priority: 2 })).toEqual({
      b: 1,
      a: 2,
      c: 3,
    })
  })

  it("takes an account out of a shared priority, alone above or below it", () => {
    expect(placed({ a: 1, b: 1, c: 2 }, "b", { _tag: "Own", priority: 1 })).toEqual({
      b: 1,
      a: 2,
      c: 3,
    })
    expect(placed({ a: 1, b: 1, c: 2 }, "a", { _tag: "Own", priority: 2 })).toEqual({
      b: 1,
      a: 2,
      c: 3,
    })
  })

  it("shares the priority of another account, closing the priority it leaves", () => {
    expect(placed({ a: 1, b: 2, c: 3 }, "a", { _tag: "Share", with: "b" })).toEqual({
      b: 1,
      a: 1,
      c: 2,
    })
    expect(placed({ a: 1, b: 2, c: 3 }, "c", { _tag: "Share", with: "a" })).toEqual({
      a: 1,
      c: 1,
      b: 2,
    })
  })

  it("leaves a shared priority in place when another account still holds it", () => {
    expect(placed({ a: 1, b: 1, c: 2 }, "b", { _tag: "Share", with: "c" })).toEqual({
      a: 1,
      c: 2,
      b: 2,
    })
  })

  it("closes gaps in the priorities it is given", () => {
    expect(placed({ a: 3, b: 7 }, "a", { _tag: "Share", with: "a" })).toEqual({ a: 1, b: 2 })
  })

  it("refuses a priority past either end, saying the lowest one it can take", () => {
    expect(placed({ a: 1, b: 1, c: 2 }, "a", { _tag: "Own", priority: 4 })).toEqual({
      _tag: "OutOfRange",
      max: 3,
    })
    expect(placed({ a: 1, b: 2 }, "a", { _tag: "Own", priority: 0 })).toEqual({
      _tag: "OutOfRange",
      max: 2,
    })
    expect(placed({ a: 1 }, "a", { _tag: "Own", priority: 2 })).toEqual({
      _tag: "OutOfRange",
      max: 1,
    })
  })

  it("refuses to share with an account outside the pool", () => {
    expect(placed({ a: 1, b: 2 }, "a", { _tag: "Share", with: "z" })).toEqual({
      _tag: "NotInPool",
      id: "z",
    })
  })
})
