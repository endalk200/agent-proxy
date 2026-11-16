// PROTOTYPE: in-memory stand-in for the daemon. No persistence; reload resets to the scenario.
// The dashboard reads state with `useDashboard()` and change it only through `actions`.
// `sim` fakes the daemon pushing live status changes (the prototype bar drives it).

import { useEffect, useState, useSyncExternalStore } from "react"

import {
  type Account,
  type Health,
  type Plan,
  type Provider,
  accountsOf,
  formatClock,
  providerName,
  servingAccountId,
} from "./model.ts"

export type ScenarioId = "default" | "first-run" | "all-cooling" | "single"

export const SCENARIOS: ReadonlyArray<{ id: ScenarioId; name: string }> = [
  { id: "default", name: "Mixed (default)" },
  { id: "first-run", name: "First run: no accounts" },
  { id: "all-cooling", name: "Claude pool all cooling down" },
  { id: "single", name: "Single account" },
]

export type LiveEventKind =
  | "cooldown"
  | "cooldown-ended"
  | "signin-expired"
  | "signed-in"
  | "used"
  | "added"
  | "removed"
  | "enabled"
  | "disabled"
  | "reordered"
  | "renamed"
  | "daemon-down"
  | "daemon-up"

export interface LiveEvent {
  id: number
  at: number
  kind: LiveEventKind
  accountId: string | null
  provider: Provider | null
  /** Sentence the UI can show as a toast or log line, e.g. "Work is cooling down until 3:42 PM". */
  message: string
  /** true when the daemon caused it (live update) rather than the owner's own action. */
  live: boolean
}

export interface DashboardState {
  scenario: ScenarioId
  daemon: { running: boolean; address: string; version: string; startedAt: number }
  proxyKey: string
  accounts: Account[]
  /** Newest first, capped. */
  events: LiveEvent[]
  autoSimulate: boolean
}

const MIN = 60_000

/** A reset time on a whole minute, `minutes` from now. */
const resetIn = (minutes: number): number => {
  const t = Date.now() + minutes * MIN
  return t - (t % MIN)
}

let nextId = 100
const newId = () => `acc_${(nextId++).toString(36)}`

const acct = (
  p: Omit<Account, "addedAt" | "changedAt" | "lastUsedAt"> & { lastUsedMinAgo: number | null },
): Account => {
  const { lastUsedMinAgo, ...rest } = p
  return {
    ...rest,
    lastUsedAt: lastUsedMinAgo === null ? null : Date.now() - lastUsedMinAgo * MIN,
    addedAt: Date.now() - 40 * 24 * 60 * MIN,
    changedAt: 0,
  }
}

const scenarioAccounts = (id: ScenarioId): Account[] => {
  const personal = acct({
    id: "acc_personal",
    provider: "claude",
    label: "Personal Max",
    email: "me@example.com",
    plan: "Claude Max 20x",
    enabled: true,
    health: { kind: "active" },
    priority: 1,
    lastUsedMinAgo: 0.2,
  })
  const work = acct({
    id: "acc_work",
    provider: "claude",
    label: "Work",
    email: "me@work.example",
    plan: "Claude Max 5x",
    enabled: true,
    health: { kind: "cooling", until: resetIn(47) },
    priority: 2,
    lastUsedMinAgo: 38,
  })
  const spare = acct({
    id: "acc_spare",
    provider: "claude",
    label: "Spare",
    email: "spare@example.com",
    plan: "Claude Pro",
    enabled: true,
    health: { kind: "signin" },
    priority: 3,
    lastUsedMinAgo: 6 * 24 * 60,
  })
  const gptPro = acct({
    id: "acc_gptpro",
    provider: "codex",
    label: "ChatGPT Pro",
    email: "me@example.com",
    plan: "ChatGPT Pro",
    enabled: true,
    health: { kind: "active" },
    priority: 1,
    lastUsedMinAgo: 12,
  })
  const plusBackup = acct({
    id: "acc_plus",
    provider: "codex",
    label: "Plus backup",
    email: "backup@example.com",
    plan: "ChatGPT Plus",
    enabled: false,
    health: { kind: "active" },
    priority: 2,
    lastUsedMinAgo: 3 * 24 * 60,
  })
  switch (id) {
    case "default":
      return [personal, work, spare, gptPro, plusBackup]
    case "first-run":
      return []
    case "all-cooling":
      return [
        {
          ...personal,
          health: { kind: "cooling", until: resetIn(18) },
          lastUsedAt: Date.now() - 2 * MIN,
        },
        { ...work, health: { kind: "cooling", until: resetIn(72) } },
        gptPro,
        plusBackup,
      ]
    case "single":
      return [personal]
  }
}

const initialState = (scenario: ScenarioId): DashboardState => ({
  scenario,
  daemon: {
    running: true,
    address: "127.0.0.1:8318",
    version: "0.1.0",
    startedAt: Date.now() - 3 * 60 * MIN,
  },
  proxyKey: "apk_live_7f3c9e2a41b84d0f95c1e6a2",
  accounts: scenarioAccounts(scenario),
  events: [],
  autoSimulate: false,
})

// ---------------------------------------------------------------------------------------------
// Store plumbing

const scenarioFromUrl = (): ScenarioId => {
  const s = new URLSearchParams(window.location.search).get("scenario")
  return SCENARIOS.some((x) => x.id === s) ? (s as ScenarioId) : "default"
}

let state: DashboardState = initialState(scenarioFromUrl())
const listeners = new Set<() => void>()

const setState = (next: DashboardState) => {
  state = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const getState = (): DashboardState => state

export const useDashboard = (): DashboardState => useSyncExternalStore(subscribe, getState)

/** Re-renders every `ms` so relative times and countdowns stay fresh. */
export const useNow = (ms = 1000): number => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

let eventSeq = 1
const log = (
  s: DashboardState,
  kind: LiveEventKind,
  account: Account | null,
  message: string,
  live: boolean,
): DashboardState => ({
  ...s,
  events: [
    {
      id: eventSeq++,
      at: Date.now(),
      kind,
      accountId: account?.id ?? null,
      provider: account?.provider ?? null,
      message,
      live,
    },
    ...s.events,
  ].slice(0, 50),
})

const find = (id: string) => state.accounts.find((a) => a.id === id)

const patch = (id: string, f: (a: Account) => Account): Account[] =>
  state.accounts.map((a) => (a.id === id ? f(a) : a))

const setHealth = (id: string, health: Health) =>
  patch(id, (a) => ({ ...a, health, changedAt: Date.now() }))

/** Rewrites priorities 1..n for one provider in the given order. */
const applyOrder = (
  accounts: Account[],
  provider: Provider,
  orderedIds: ReadonlyArray<string>,
): Account[] =>
  accounts.map((a) =>
    a.provider === provider ? { ...a, priority: orderedIds.indexOf(a.id) + 1 } : a,
  )

// ---------------------------------------------------------------------------------------------
// Owner actions (what the dashboard UI calls)

export const actions = {
  /** Adds a signed-in account at the lowest priority of its pool. Returns its id. */
  addAccount(p: { provider: Provider; label: string; email: string; plan: Plan }): string {
    const id = newId()
    const priority = accountsOf(state.accounts, p.provider).length + 1
    const a: Account = {
      ...p,
      id,
      enabled: true,
      health: { kind: "active" },
      priority,
      lastUsedAt: null,
      addedAt: Date.now(),
      changedAt: Date.now(),
    }
    setState(
      log(
        { ...state, accounts: [...state.accounts, a] },
        "added",
        a,
        `Added ${a.label} (${a.plan})`,
        false,
      ),
    )
    return id
  },

  rename(id: string, label: string) {
    const a = find(id)
    const trimmed = label.trim()
    if (a === undefined || trimmed === "" || trimmed === a.label) return
    setState(
      log(
        { ...state, accounts: patch(id, (x) => ({ ...x, label: trimmed })) },
        "renamed",
        a,
        `Renamed ${a.label} to ${trimmed}`,
        false,
      ),
    )
  },

  /** Sets a full priority order for a provider (e.g. after a drag-and-drop). */
  reorder(provider: Provider, orderedIds: ReadonlyArray<string>) {
    const first = find(orderedIds[0] ?? "")
    setState(
      log(
        { ...state, accounts: applyOrder(state.accounts, provider, orderedIds) },
        "reordered",
        first ?? null,
        `${providerName[provider]} priority: ${orderedIds.map((id) => find(id)?.label).join(" → ")}`,
        false,
      ),
    )
  },

  /** Moves an account to priority `to` (1-based), shifting the others. */
  setPriority(id: string, to: number) {
    const a = find(id)
    if (a === undefined) return
    const ids = accountsOf(state.accounts, a.provider)
      .map((x) => x.id)
      .filter((x) => x !== id)
    const index = Math.max(0, Math.min(ids.length, to - 1))
    ids.splice(index, 0, id)
    actions.reorder(a.provider, ids)
  },

  /** -1 = up (higher priority), +1 = down. */
  move(id: string, direction: -1 | 1) {
    const a = find(id)
    if (a !== undefined) actions.setPriority(id, a.priority + direction)
  },

  setEnabled(id: string, enabled: boolean) {
    const a = find(id)
    if (a === undefined || a.enabled === enabled) return
    setState(
      log(
        { ...state, accounts: patch(id, (x) => ({ ...x, enabled, changedAt: Date.now() })) },
        enabled ? "enabled" : "disabled",
        a,
        `${enabled ? "Enabled" : "Disabled"} ${a.label}`,
        false,
      ),
    )
  },

  remove(id: string) {
    const a = find(id)
    if (a === undefined) return
    const rest = state.accounts.filter((x) => x.id !== id)
    const order = accountsOf(rest, a.provider).map((x) => x.id)
    setState(
      log(
        { ...state, accounts: applyOrder(rest, a.provider, order) },
        "removed",
        a,
        `Removed ${a.label}`,
        false,
      ),
    )
  },

  /** After "Sign in again" completes. */
  markSignedIn(id: string) {
    const a = find(id)
    if (a === undefined) return
    setState(
      log(
        { ...state, accounts: setHealth(id, { kind: "active" }) },
        "signed-in",
        a,
        `${a.label} is signed in again`,
        false,
      ),
    )
  },
}

// ---------------------------------------------------------------------------------------------
// Simulation (stands in for the daemon pushing changes; driven by the prototype bar)

const pickServing = (): Account | undefined => {
  for (const p of ["claude", "codex"] as const) {
    const id = servingAccountId(state.accounts, p)
    if (id !== null) return find(id)
  }
  return undefined
}

export const sim = {
  loadScenario(id: ScenarioId) {
    const url = new URL(window.location.href)
    if (id === "default") url.searchParams.delete("scenario")
    else url.searchParams.set("scenario", id)
    window.history.replaceState(null, "", url)
    setState({ ...initialState(id), autoSimulate: state.autoSimulate })
  },

  /** Puts an account (default: the one serving new sessions) into cooldown. */
  coolDown(id?: string, minutes = 25) {
    const a = id === undefined ? pickServing() : find(id)
    if (a === undefined) return
    const until = resetIn(minutes)
    setState(
      log(
        { ...state, accounts: setHealth(a.id, { kind: "cooling", until }) },
        "cooldown",
        a,
        `${a.label} hit its limit and is cooling down until ${formatClock(until)}`,
        true,
      ),
    )
  },

  /** Expires an account's login (default: an Active one, preferring a non-serving account). */
  expireSignIn(id?: string) {
    const serving = new Set(
      ["claude", "codex"].map((p) => servingAccountId(state.accounts, p as Provider)),
    )
    const a =
      id === undefined
        ? (state.accounts.find(
            (x) => x.enabled && x.health.kind === "active" && !serving.has(x.id),
          ) ?? state.accounts.find((x) => x.enabled && x.health.kind === "active"))
        : find(id)
    if (a === undefined) return
    setState(
      log(
        { ...state, accounts: setHealth(a.id, { kind: "signin" }) },
        "signin-expired",
        a,
        `${a.label}'s sign-in expired. Sign in again to use it`,
        true,
      ),
    )
  },

  /** Ends the soonest cooldown now. */
  endCooldown(id?: string) {
    const a =
      id === undefined
        ? state.accounts
            .filter((x) => x.health.kind === "cooling")
            .sort((x, y) =>
              x.health.kind === "cooling" && y.health.kind === "cooling"
                ? x.health.until - y.health.until
                : 0,
            )[0]
        : find(id)
    if (a === undefined || a.health.kind !== "cooling") return
    setState(
      log(
        { ...state, accounts: setHealth(a.id, { kind: "active" }) },
        "cooldown-ended",
        a,
        `${a.label}'s cooldown ended`,
        true,
      ),
    )
  },

  /** The serving account handles a request (bumps "last used"). */
  use() {
    const a = pickServing()
    if (a === undefined) return
    setState(
      log(
        { ...state, accounts: patch(a.id, (x) => ({ ...x, lastUsedAt: Date.now() })) },
        "used",
        a,
        `${a.label} served a request`,
        true,
      ),
    )
  },

  setDaemonRunning(running: boolean) {
    setState(
      log(
        {
          ...state,
          daemon: {
            ...state.daemon,
            running,
            startedAt: running ? Date.now() : state.daemon.startedAt,
          },
        },
        running ? "daemon-up" : "daemon-down",
        null,
        running ? "Daemon is running again" : `Can't reach the daemon at ${state.daemon.address}`,
        true,
      ),
    )
  },

  /** One plausible event, weighted toward the interesting ones. */
  random() {
    const roll = Math.random()
    const cooling = state.accounts.some((a) => a.health.kind === "cooling")
    if (roll < 0.35) sim.use()
    else if (roll < 0.65) sim.coolDown()
    else if (roll < 0.85 && cooling) sim.endCooldown()
    else sim.expireSignIn()
  },

  setAuto(on: boolean) {
    setState({ ...state, autoSimulate: on })
  },
}

// Cooldowns end on their own when their reset time passes; auto-simulate fires an event every 6s.
let autoTick = 0
setInterval(() => {
  const now = Date.now()
  const due = state.accounts.find((a) => a.health.kind === "cooling" && a.health.until <= now)
  if (due !== undefined) sim.endCooldown(due.id)
  if (state.autoSimulate && state.daemon.running && ++autoTick % 6 === 0) sim.random()
}, 1000)
