/**
 * A pool's priorities (ADR-0003): the owner ranks a pool's accounts, and
 * accounts may share a priority, so the router spreads new sessions across
 * them by headroom. A pool's priorities run 1, 2, 3… with no gaps; any number
 * of accounts may hold each one.
 */

/** What this module needs of an account. */
interface Ranked {
  readonly id: string
  readonly priority: number
}

/** Where the owner puts an account in its pool. */
export type Placement =
  /** Alone at `priority`; the accounts from that priority down move down one. */
  | { readonly _tag: "Own"; readonly priority: number }
  /** At the priority account `with` holds, sharing it. */
  | { readonly _tag: "Share"; readonly with: string }

/**
 * `pool` by priority, highest first: each level holds the accounts of one
 * priority, in the order `pool` lists them. Gaps between priorities close.
 */
export const levelsOf = <A extends Ranked>(
  pool: ReadonlyArray<A>,
): ReadonlyArray<ReadonlyArray<A>> => {
  const byPriority = new Map<number, Array<A>>()
  for (const account of pool) {
    const level = byPriority.get(account.priority) ?? []
    level.push(account)
    byPriority.set(account.priority, level)
  }
  return [...byPriority.entries()].toSorted(([a], [b]) => a - b).map(([, level]) => level)
}

/** Every account in `levels` with the priority its level gives it: the first level is 1. */
export const numbered = <A extends Ranked>(levels: ReadonlyArray<ReadonlyArray<A>>): Array<A> =>
  levels.flatMap((level, index) =>
    level.map((account) =>
      account.priority === index + 1 ? account : { ...account, priority: index + 1 },
    ),
  )

/** Why a placement cannot be made. */
export type PlacementProblem =
  /** `Own` asked for a priority outside 1 to `max`. */
  | { readonly _tag: "OutOfRange"; readonly max: number }
  /** `Share` named an account that is not in the pool. */
  | { readonly _tag: "NotInPool"; readonly id: string }

/**
 * `pool` once account `id` is placed as `placement` says, every account
 * numbered 1, 2, 3… by level. The accounts that do not move keep their order,
 * and a priority the account leaves empty closes up. `pool` holds one
 * provider's accounts, `id` among them.
 */
export const place = <A extends Ranked>(
  pool: ReadonlyArray<A>,
  id: string,
  placement: Placement,
): { readonly _tag: "Placed"; readonly pool: Array<A> } | PlacementProblem => {
  const moving = pool.find((account) => account.id === id)
  if (moving === undefined) return { _tag: "NotInPool", id }
  const others = levelsOf(pool.filter((account) => account.id !== id))
  switch (placement._tag) {
    case "Own": {
      const max = others.length + 1
      const { priority } = placement
      if (!Number.isInteger(priority) || priority < 1 || priority > max) {
        return { _tag: "OutOfRange", max }
      }
      return {
        _tag: "Placed",
        pool: numbered([...others.slice(0, priority - 1), [moving], ...others.slice(priority - 1)]),
      }
    }
    case "Share": {
      if (placement.with === id) return { _tag: "Placed", pool: numbered(levelsOf(pool)) }
      const at = others.findIndex((level) => level.some((account) => account.id === placement.with))
      if (at === -1) return { _tag: "NotInPool", id: placement.with }
      return {
        _tag: "Placed",
        pool: numbered(others.map((level, index) => (index === at ? level.concat(moving) : level))),
      }
    }
  }
}
