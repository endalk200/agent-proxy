import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  claudeLimit,
  limitHeaders,
  modelLimit,
  usageAnswer as claudeUsage,
} from "../support/fake-claude.ts"
import { codexHeaders, usageAnswer as codexUsage } from "../support/fake-codex.ts"
import { HOUR, makeHome, NOW, services } from "../support/usage-home.ts"

// Limit windows, in-process: a real daemon on loopback in a throwaway home,
// fake Claude and Codex backends (API and usage endpoints), and Effect's test
// clock, which moves only when a test moves it. Sockets are real, so a test
// waits in real time for reads the daemon makes on its own. Tests read only
// `GET /api/limits`, `POST /api/limits/refresh`, `/api/events`, and which
// account's requests reach the fakes.

const MINUTE = 60_000

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init)
const notFound = () => json({ error: "not_found" }, { status: 404 })
const serverError = () => json({ error: "server_error" }, { status: 500 })

/**
 * Waits in real time until `check` passes, failing after about two seconds.
 * It counts tries, not time: the test clock never moves on its own.
 */
const eventually = <A>(read: Effect.Effect<A>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 1; ; tries++) {
      const value = yield* read
      if (check(value)) return value
      if (tries >= 200) {
        throw new Error(`still not as expected: ${JSON.stringify(value)}`)
      }
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
    }
  })

/** Lets the daemon run for `ms` of real time, for asserting that nothing happens. */
const settle = (ms = 150) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

/** The account a request to a fake reached it as, by its seeded `token-<id>`. */
const bearerAccount = (headers: Readonly<Record<string, string>>) =>
  headers["authorization"]?.replace(/^Bearer token-/, "")

type Limits = ReadonlyArray<{
  readonly accountId: string
  readonly asOf: number | null
  readonly windows: ReadonlyArray<Record<string, unknown>>
}>

const windowsOf = (limits: Limits, accountId: string) =>
  limits.find((entry) => entry.accountId === accountId)?.windows ?? []

/** A Claude usage endpoint answer whose 5-hour window is `percent` used and resets at `resetsAt`. */
const claudeFiveHour = (percent: number, resetsAt: number) => ({
  ...claudeUsage,
  five_hour: { utilization: percent, resets_at: new Date(resetsAt).toISOString() },
})

layer(services)("limit windows", (it) => {
  it.effect(
    "an answer's headers set its account's limit windows, and say so on the event stream",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work" }],
          prepare: ({ claude }) => claude.answerUsageWith(notFound),
        })
        const events = yield* home.events
        yield* home.claudeMessage()

        const expected = {
          accountId: "work",
          asOf: NOW,
          windows: [
            {
              id: "five-hour",
              label: "5-hour",
              usedPct: 12,
              resetsAt: 1_795_000_000_000,
              asOf: NOW,
            },
            { id: "weekly", label: "Weekly", usedPct: 34, resetsAt: 1_795_500_000_000, asOf: NOW },
          ],
          limitResets: [],
          canBuyReset: false,
        }
        expect((yield* events.next("limits-changed"))["limits"]).toEqual(expected)
        expect(yield* home.limits).toEqual([expected])
      }),
  )

  it.effect("a Codex answer's windows are named by their length", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "codex", id: "cx" }],
        prepare: ({ codex }) => {
          codex.answerUsageWith(notFound)
          codex.answerApiWith(
            () =>
              new Response("", {
                headers: {
                  ...codexHeaders,
                  "x-codex-secondary-used-percent": "71",
                  "content-type": "text/event-stream",
                },
              }),
          )
        },
      })
      yield* home.codexResponse()
      expect(windowsOf(yield* home.limits, "cx")).toEqual([
        { id: "five-hour", label: "5-hour", usedPct: 12, resetsAt: 1_795_000_000_000, asOf: NOW },
        { id: "weekly", label: "Weekly", usedPct: 71, resetsAt: 1_795_500_000_000, asOf: NOW },
      ])
    }),
  )

  it.effect("an account that hits a limit keeps its used-up window beside its cooldown", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work" }],
        prepare: ({ claude }) => {
          claude.answerUsageWith(notFound)
          claude.answerApiWith(() =>
            json(
              { type: "error", error: { type: "rate_limit_error", message: "Limit reached." } },
              {
                status: 429,
                headers: {
                  ...limitHeaders,
                  "anthropic-ratelimit-unified-status": "rejected",
                  "anthropic-ratelimit-unified-5h-status": "rejected",
                  "anthropic-ratelimit-unified-5h-utilization": "1",
                },
              },
            ),
          )
        },
      })
      yield* home.claudeMessage()
      const accounts = yield* home.api("GET", "/api/accounts")
      expect(accounts.json.accounts[0].status).toBe("cooling-down")
      expect(windowsOf(yield* home.limits, "work")[0]).toMatchObject({
        id: "five-hour",
        usedPct: 100,
      })
    }),
  )

  it.effect(
    "the daemon reads every servable account's usage endpoint at startup, per-model weekly windows included",
    () =>
      Effect.gen(function* () {
        const fableResets = NOW + 3 * 24 * HOUR
        const home = yield* makeHome({
          accounts: [
            { provider: "claude", id: "work" },
            { provider: "codex", id: "cx" },
            { provider: "claude", id: "off", priority: 2, enabled: false },
            { provider: "claude", id: "out", priority: 3, needsSignIn: true },
          ],
          prepare: ({ claude }) =>
            claude.answerUsageWith(() =>
              json({
                ...claudeUsage,
                // As a Max plan answers: `is_active` marks the limit Claude
                // highlights, not one the account has, so a Fable window
                // nothing has spent from yet is inactive.
                limits: [
                  claudeLimit({ kind: "session", percent: 12, is_active: true }),
                  claudeLimit({ kind: "weekly_all", group: "weekly", percent: 34 }),
                  modelLimit("Fable", 80, new Date(fableResets).toISOString()),
                  // A scoped limit that names no model is no window, and the rest still read.
                  claudeLimit({ kind: "weekly_scoped", group: "weekly", percent: 50 }),
                ],
              }),
            ),
        })
        const limits = yield* eventually(
          home.limits,
          (all: Limits) => windowsOf(all, "work").length === 3 && windowsOf(all, "cx").length === 2,
        )
        expect(limits).toEqual([
          {
            accountId: "work",
            asOf: NOW,
            windows: [
              {
                id: "five-hour",
                label: "5-hour",
                usedPct: 12,
                resetsAt: 1_795_000_000_000,
                asOf: NOW,
              },
              {
                id: "weekly",
                label: "Weekly",
                usedPct: 34,
                resetsAt: 1_795_500_000_000,
                asOf: NOW,
              },
              {
                id: "weekly:Fable",
                label: "Fable weekly",
                usedPct: 80,
                resetsAt: fableResets,
                asOf: NOW,
              },
            ],
            limitResets: [],
            canBuyReset: false,
          },
          { accountId: "off", asOf: null, windows: [], limitResets: [], canBuyReset: false },
          { accountId: "out", asOf: null, windows: [], limitResets: [], canBuyReset: false },
          {
            accountId: "cx",
            asOf: NOW,
            windows: [
              {
                id: "five-hour",
                label: "5-hour",
                usedPct: 12,
                resetsAt: 1_795_000_000_000,
                asOf: NOW,
              },
              {
                id: "weekly",
                label: "Weekly",
                usedPct: 34,
                resetsAt: 1_795_500_000_000,
                asOf: NOW,
              },
            ],
            limitResets: [],
            canBuyReset: false,
          },
        ])
        // Read as each account, the way its provider's own clients do.
        expect(home.claude.usageRequests().map((request) => request.headers)).toEqual([
          expect.objectContaining({
            authorization: "Bearer token-work",
            "anthropic-beta": "oauth-2025-04-20",
          }),
        ])
        expect(home.codex.usageRequests().map((request) => request.headers)).toEqual([
          expect.objectContaining({
            authorization: "Bearer token-cx",
            "chatgpt-account-id": "provider-cx",
          }),
        ])
      }),
  )

  it.effect("the newer observation of a window wins, whichever source it came from", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work" }],
        prepare: ({ claude }) =>
          claude.answerUsageWith(() =>
            json({
              ...claudeUsage,
              limits: [modelLimit("Fable", 80, new Date(NOW + 24 * HOUR).toISOString())],
            }),
          ),
      })
      yield* eventually(home.limits, (all: Limits) => windowsOf(all, "work").length === 3)

      // A minute later an answer's headers say the 5-hour window is half used.
      yield* TestClock.adjust("1 minute")
      home.claude.answerApiWith(() =>
        json(
          { type: "message", usage: { input_tokens: 1, output_tokens: 1 } },
          { headers: { ...limitHeaders, "anthropic-ratelimit-unified-5h-utilization": "0.5" } },
        ),
      )
      yield* home.claudeMessage()
      const afterHeaders = windowsOf(yield* home.limits, "work")
      expect(
        afterHeaders.map((window) => [window["id"], window["usedPct"], window["asOf"]]),
      ).toEqual([
        ["five-hour", 50, NOW + MINUTE],
        ["weekly", 34, NOW + MINUTE],
        // Headers never report the Fable window, so the endpoint's stays.
        ["weekly:Fable", 80, NOW],
      ])

      // A minute after that, a refresh reads the endpoint again, which wins.
      yield* TestClock.adjust("1 minute")
      const refreshed = yield* home.api("POST", "/api/limits/refresh", {})
      expect(refreshed.status).toBe(200)
      expect(
        windowsOf(refreshed.json, "work").map((window) => [window["id"], window["usedPct"]]),
      ).toEqual([
        ["five-hour", 12],
        ["weekly", 34],
        ["weekly:Fable", 80],
      ])
    }),
  )

  it.effect("idle accounts are read every 30 minutes, and once just after a window resets", () =>
    Effect.gen(function* () {
      let answer = claudeFiveHour(40, NOW + 10 * MINUTE)
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work" }],
        prepare: ({ claude }) => claude.answerUsageWith(() => json(answer)),
      })
      const reads = Effect.sync(() => home.claude.usageRequests().length)
      yield* eventually(reads, (count) => count === 1)
      answer = claudeFiveHour(0, NOW + 5 * HOUR + 10 * MINUTE)

      // The window resets at +10 minutes; the daemon reads again just after.
      yield* TestClock.adjust("10 minutes")
      yield* settle()
      expect(yield* reads).toBe(1)
      yield* TestClock.adjust("1 minute")
      yield* eventually(reads, (count) => count === 2)
      expect(windowsOf(yield* home.limits, "work")[0]).toMatchObject({
        id: "five-hour",
        usedPct: 0,
        asOf: NOW + 11 * MINUTE,
      })

      // Every 30 minutes from startup, each account is read again.
      yield* TestClock.adjust("18 minutes")
      yield* settle()
      expect(yield* reads).toBe(2)
      yield* TestClock.adjust("1 minute")
      yield* eventually(reads, (count) => count === 3)
    }),
  )

  it.effect("reads go one account at a time", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [
          { provider: "claude", id: "a", priority: 1 },
          { provider: "claude", id: "b", priority: 2 },
          { provider: "claude", id: "c", priority: 3 },
        ],
        prepare: ({ claude }) =>
          claude.answerUsageWith(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30))
            return json(claudeUsage)
          }),
      })
      yield* eventually(
        Effect.sync(() => home.claude.usageRequests().length),
        (count) => count === 3,
      )
      // A refresh asked for meanwhile waits its turn too.
      yield* home.api("POST", "/api/limits/refresh", {})
      expect(home.claude.usageRequests()).toHaveLength(6)
      expect(home.claude.peakUsageInFlight()).toBe(1)
    }),
  )

  it.effect(
    "a provider that answers 429 is not read again until its Retry-After passes, an hour at most",
    () =>
      Effect.gen(function* () {
        let busy = true
        const home = yield* makeHome({
          accounts: [
            { provider: "claude", id: "a", priority: 1 },
            { provider: "claude", id: "b", priority: 2 },
          ],
          prepare: ({ claude }) =>
            claude.answerUsageWith(() =>
              busy
                ? json(
                    { error: "rate_limited" },
                    { status: 429, headers: { "retry-after": "7200" } },
                  )
                : json(claudeUsage),
            ),
        })
        const reads = Effect.sync(() => home.claude.usageRequests().length)
        yield* eventually(reads, (count) => count === 1)
        yield* settle()
        // b is not read after a's 429, and a refresh reads nothing either.
        expect(yield* reads).toBe(1)
        const refreshed = yield* home.api("POST", "/api/limits/refresh", {})
        expect(refreshed.status).toBe(200)
        expect(yield* reads).toBe(1)

        // Not at the 30-minute mark, nor just before the hour…
        busy = false
        yield* TestClock.adjust("59 minutes")
        yield* settle()
        expect(yield* reads).toBe(1)
        // …but once an hour has passed, though Retry-After asked for two.
        yield* TestClock.adjust("1 minute")
        yield* eventually(reads, (count) => count >= 2)
        expect(
          windowsOf(
            yield* eventually(home.limits, (all: Limits) => windowsOf(all, "b").length > 0),
            "b",
          ),
        ).toHaveLength(2)
      }),
  )

  it.effect(
    "a broken usage endpoint leaves the windows from headers in place, with their age",
    () =>
      Effect.gen(function* () {
        let broken: () => Response = serverError
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work" }],
          prepare: ({ claude }) => claude.answerUsageWith(() => broken()),
        })
        yield* eventually(
          Effect.sync(() => home.claude.usageRequests().length),
          (count) => count === 1,
        )
        yield* home.claudeMessage()
        yield* TestClock.adjust("2 hours")

        const refreshed = yield* home.api("POST", "/api/limits/refresh", { accountId: "work" })
        expect(refreshed.status).toBe(200)
        expect(windowsOf(refreshed.json, "work").map((window) => window["asOf"])).toEqual([
          NOW,
          NOW,
        ])

        // An answer of a shape the daemon does not know is no different.
        broken = () => json({ something: "else" })
        const again = yield* home.api("POST", "/api/limits/refresh", { accountId: "work" })
        expect(again.status).toBe(200)
        expect(windowsOf(again.json, "work").map((window) => window["asOf"])).toEqual([NOW, NOW])
      }),
  )

  it.effect(
    "a usage answer whose windows cannot be read leaves the last-known windows in place",
    () =>
      Effect.gen(function* () {
        let answer: unknown = codexUsage
        const home = yield* makeHome({
          accounts: [{ provider: "codex", id: "cx" }],
          prepare: ({ codex }) => codex.answerUsageWith(() => json(answer)),
        })
        yield* eventually(home.limits, (all: Limits) => windowsOf(all, "cx").length === 2)
        // The shape it knows, but a reset time it cannot read.
        answer = {
          rate_limit: {
            ...codexUsage.rate_limit,
            primary_window: {
              ...codexUsage.rate_limit.primary_window,
              reset_at: "soon",
              reset_after_seconds: null,
            },
          },
        }
        yield* TestClock.adjust("1 minute")
        const refreshed = yield* home.api("POST", "/api/limits/refresh", { accountId: "cx" })
        expect(
          windowsOf(refreshed.json, "cx").map((window) => [window["id"], window["asOf"]]),
        ).toEqual([
          ["five-hour", NOW],
          ["weekly", NOW],
        ])
      }),
  )

  it.effect(
    "a Claude answer whose 5-hour or weekly window has no utilization leaves the last-known windows in place",
    () =>
      Effect.gen(function* () {
        let answer: unknown = claudeUsage
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work" }],
          prepare: ({ claude }) => claude.answerUsageWith(() => json(answer)),
        })
        yield* eventually(home.limits, (all: Limits) => windowsOf(all, "work").length === 2)
        // `percent` is the share used only in a `limits` entry, so this is not
        // a 5-hour window it can read, and the weekly one is not left out.
        answer = {
          five_hour: { percent: 72, resets_at: new Date(NOW + HOUR).toISOString() },
          limits: [],
        }
        yield* TestClock.adjust("1 minute")
        const refreshed = yield* home.api("POST", "/api/limits/refresh", { accountId: "work" })
        expect(
          windowsOf(refreshed.json, "work").map((window) => [window["id"], window["asOf"]]),
        ).toEqual([
          ["five-hour", NOW],
          ["weekly", NOW],
        ])
      }),
  )

  it.effect(
    "a refresh reads one account when asked to, and refuses an account the daemon does not hold",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          accounts: [
            { provider: "claude", id: "a", priority: 1 },
            { provider: "claude", id: "b", priority: 2 },
          ],
        })
        yield* eventually(
          Effect.sync(() => home.claude.usageRequests().length),
          (count) => count === 2,
        )
        const refreshed = yield* home.api("POST", "/api/limits/refresh", { accountId: "b" })
        expect(refreshed.status).toBe(200)
        expect(refreshed.json.map((entry: { accountId: string }) => entry.accountId)).toEqual([
          "a",
          "b",
        ])
        expect(
          home.claude
            .usageRequests()
            .slice(2)
            .map((request) => bearerAccount(request.headers)),
        ).toEqual(["b"])

        const unknown = yield* home.api("POST", "/api/limits/refresh", { accountId: "nobody" })
        expect(unknown.status).toBe(404)
      }),
  )

  it.effect("last-known windows survive a restart, as of when they were observed", () =>
    Effect.gen(function* () {
      let up = true
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work" }],
        prepare: ({ claude }) =>
          claude.answerUsageWith(() => (up ? json(claudeUsage) : notFound())),
      })
      const before = yield* eventually(
        home.limits,
        (all: Limits) => windowsOf(all, "work").length === 2,
      )
      up = false
      yield* TestClock.adjust("3 hours")
      yield* home.restart
      yield* settle()
      expect(yield* home.limits).toEqual(before)
    }),
  )

  it.effect(
    "accounts of equal priority are chosen by the room left in their 5-hour and weekly windows",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          prepare: ({ claude }) =>
            claude.answerUsageWith((request) =>
              bearerAccount(Object.fromEntries(request.headers)) === "busy"
                ? json(claudeFiveHour(90, NOW + HOUR))
                : // A used-up per-model window limits only that model, so it takes no room from the account.
                  json({
                    ...claudeFiveHour(20, NOW + HOUR),
                    limits: [modelLimit("Fable", 100, new Date(NOW + 24 * HOUR).toISOString())],
                  }),
            ),
        })
        // Two accounts at one priority, as a change interrupted between its
        // file writes leaves them, until the daemon next starts.
        yield* home.seed("claude", "busy", 1)
        yield* home.seed("claude", "roomy", 1)
        const refreshed = yield* home.api("POST", "/api/limits/refresh", {})
        expect(windowsOf(refreshed.json, "busy")[0]).toMatchObject({ usedPct: 90 })
        expect(windowsOf(refreshed.json, "roomy")[0]).toMatchObject({ usedPct: 20 })

        // The answers carry no limit headers, so only the endpoint's windows count.
        home.claude.answerApiWith(() =>
          json({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }),
        )
        yield* home.claudeMessage()
        expect(bearerAccount(home.claude.apiRequests().at(-1)?.headers ?? {})).toBe("roomy")
      }),
  )

  it.effect("an account signed in to while the daemon is idle is read at once", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      expect(home.claude.usageRequests()).toHaveLength(0)
      yield* home.signIn("claude")
      yield* eventually(
        Effect.sync(() => home.claude.usageRequests().length),
        (count) => count === 1,
      )
    }),
  )

  it.effect(
    "an answer that only confirms a window's numbers moves its as-of once a minute at most",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work" }],
          prepare: ({ claude }) => claude.answerUsageWith(notFound),
        })
        const asOf = Effect.map(home.limits, (all: Limits) => all[0]?.asOf)
        yield* home.claudeMessage()
        expect(yield* asOf).toBe(NOW)
        yield* TestClock.adjust("30 seconds")
        yield* home.claudeMessage()
        expect(yield* asOf).toBe(NOW)
        yield* TestClock.adjust("31 seconds")
        yield* home.claudeMessage()
        expect(yield* asOf).toBe(NOW + 61_000)
      }),
  )

  it.effect("removing an account removes its limit windows", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [
          { provider: "claude", id: "a", priority: 1 },
          { provider: "claude", id: "b", priority: 2 },
        ],
      })
      yield* eventually(home.limits, (all: Limits) => windowsOf(all, "b").length === 2)
      expect((yield* home.api("DELETE", "/api/accounts/b")).status).toBe(200)
      expect((yield* home.limits).map((entry: { accountId: string }) => entry.accountId)).toEqual([
        "a",
      ])
    }),
  )
})
