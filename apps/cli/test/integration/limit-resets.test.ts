import { expect, layer } from "@effect/vitest"
import { DateTime, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import {
  resetGrant,
  limitHeaders,
  limitResetStatus,
  usageAnswer as claudeUsage,
} from "../support/fake-claude.ts"
import { resetCredit, resetsAnswer, usageWithResets } from "../support/fake-codex.ts"
import { HOUR, makeHome, NOW, services } from "../support/usage-home.ts"

// Limit resets, in-process: a real daemon on loopback in a throwaway home,
// fake Claude and Codex backends (usage, limit reset and redeem endpoints),
// and Effect's test clock. Tests read only what the daemon API reports
// (`GET /api/limits`, `GET /api/accounts`, the redeem route, `/api/events`)
// and which requests reach the fakes.

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init)

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

type Limits = ReadonlyArray<{
  readonly accountId: string
  readonly windows: ReadonlyArray<unknown>
  readonly limitResets: ReadonlyArray<Record<string, unknown>>
  readonly canBuyReset: boolean
}>

const limitsOf = (limits: Limits, accountId: string) =>
  limits.find((entry) => entry.accountId === accountId)

const resetsOf = (limits: Limits, accountId: string) =>
  limitsOf(limits, accountId)?.limitResets ?? []

/** A Claude usage answer whose `cedar_ember` block lists `grants` to Claude Code. */
const claudeWithGrants =
  (...grants: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  (request: Request) =>
    json({ ...claudeUsage, cedar_ember: limitResetStatus(request, grants) })

const CLAUDE_ORG = "7d3e2a90-aaaa-4b2b-8b2b-000000000001"
const CLAUDE_ACCOUNT = `0b5c1f7e-1111-4a1a-9a1a-000000000001:${CLAUDE_ORG}`

/** The account a request to a fake reached it as, by its seeded `token-<id>`. */
const bearerAccount = (headers: Readonly<Record<string, string>>) =>
  headers["authorization"]?.replace(/^Bearer token-/, "")

/** Claude's answer when the account's 5-hour window is used up, until `resetsAt`. */
const fiveHourUsedUp = (resetsAt: number) =>
  json(
    { type: "error", error: { type: "rate_limit_error", message: "Limit reached." } },
    {
      status: 429,
      headers: {
        ...limitHeaders,
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(resetsAt / 1000),
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String(resetsAt / 1000),
        "anthropic-ratelimit-unified-5h-utilization": "1",
      },
    },
  )

/** Claude's answer to a request that is rate limited for `seconds`, with no window used up. */
const rateLimited = (seconds: number) =>
  json(
    { type: "error", error: { type: "rate_limit_error", message: "Slow down." } },
    { status: 429, headers: { "retry-after": String(seconds) } },
  )

/** An answer whose connection drops before its body arrives. */
const dropped = () =>
  new Response(
    new ReadableStream({
      pull(controller) {
        controller.error("connection dropped by the test")
      },
    }),
  )

const redeemPath = (accountId: string, resetId: string) =>
  `/api/accounts/${accountId}/limit-resets/${encodeURIComponent(resetId)}/redeem`

layer(services)("limit resets", (it) => {
  it.effect(
    "a Claude account's limit resets come with its limit windows, read as Claude Code",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
          prepare: ({ claude }) => claude.answerUsageWith(claudeWithGrants(resetGrant())),
        })
        const limits = yield* eventually(
          home.limits,
          (all: Limits) => resetsOf(all, "work").length === 1,
        )
        expect(limitsOf(limits, "work")).toMatchObject({
          limitResets: [
            {
              id: "full-reset-2611",
              name: "Full reset",
              refills: [
                { id: "five-hour", label: "5-hour" },
                { id: "weekly", label: "Weekly" },
              ],
              grantedAt: Date.UTC(2026, 10, 10, 18, 0, 0),
              expiresAt: Date.UTC(2026, 11, 10, 22, 0, 0),
              usableNow: true,
              unavailableReason: null,
              asOf: NOW,
            },
          ],
          canBuyReset: false,
        })
        // One read, windows and resets together, as Claude Code makes it.
        const reads = home.claude.usageRequests()
        expect(reads).toHaveLength(1)
        expect(reads[0]?.path).toBe("/api/oauth/usage?cedar_ember=1")
        expect(reads[0]?.headers["user-agent"]).toMatch(/^claude-cli\/\d[\w.]* \(external, cli\)$/)
        expect(limitsOf(limits, "work")).toMatchObject({
          windows: [{ id: "five-hour" }, { id: "weekly" }],
        })
      }),
  )

  it.effect(
    "a Codex account's limit resets are listed at every read, even when it holds none",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          accounts: [
            { provider: "codex", id: "plus", plan: "Plus" },
            { provider: "codex", id: "pro", plan: "Pro", priority: 2 },
            { provider: "codex", id: "none", priority: 3 },
          ],
          prepare: ({ codex }) => {
            codex.answerUsageWith((request) =>
              json(
                usageWithResets(
                  request.headers.get("chatgpt-account-id") === "provider-none" ? 0 : 2,
                ),
              ),
            )
            codex.answerResetsWith((request) =>
              json(
                request.headers.get("chatgpt-account-id") === "provider-none"
                  ? resetsAnswer([], { canBuy: true })
                  : resetsAnswer(
                      [
                        resetCredit({ id: "later", expires_at: "2027-01-05T00:00:00Z" }),
                        resetCredit({
                          id: "sooner",
                          title: "Referral reset",
                          granted_at: undefined,
                          expires_at: "2026-11-20T00:00:00Z",
                          is_supported_by_plan: false,
                        }),
                        resetCredit({ id: "spent", status: "redeemed" }),
                      ],
                      { canBuy: true },
                    ),
              ),
            )
          },
        })
        const limits = yield* eventually(
          home.limits,
          (all: Limits) => resetsOf(all, "plus").length === 2 && resetsOf(all, "pro").length === 2,
        )
        // Soonest to expire first; a spent one is not listed.
        expect(limitsOf(limits, "plus")).toEqual(
          expect.objectContaining({
            canBuyReset: true,
            limitResets: [
              {
                id: "sooner",
                name: "Referral reset",
                refills: [
                  { id: "five-hour", label: "5-hour" },
                  { id: "weekly", label: "Weekly" },
                ],
                grantedAt: null,
                expiresAt: Date.UTC(2026, 10, 20),
                usableNow: false,
                unavailableReason: "Not available on this plan",
                asOf: NOW,
              },
              {
                id: "later",
                name: "Full reset",
                refills: [
                  { id: "five-hour", label: "5-hour" },
                  { id: "weekly", label: "Weekly" },
                ],
                grantedAt: Date.UTC(2026, 10, 12, 22, 27, 7, 83),
                expiresAt: Date.UTC(2027, 0, 5),
                usableNow: true,
                unavailableReason: null,
                asOf: NOW,
              },
            ],
          }),
        )
        // On Pro, a reset refills the weekly window only.
        expect(resetsOf(limits, "pro").map((reset) => reset["refills"])).toEqual([
          [{ id: "weekly", label: "Weekly" }],
          [{ id: "weekly", label: "Weekly" }],
        ])
        // One that holds none still hears whether it may buy one.
        expect(limitsOf(limits, "none")).toMatchObject({ limitResets: [], canBuyReset: true })
        // Listed as each account, the way the usage read is.
        expect(
          home.codex
            .resetsRequests()
            .map((request) => request.headers["chatgpt-account-id"] ?? "")
            .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(["provider-none", "provider-plus", "provider-pro"])
      }),
  )

  it.effect("a restarted daemon shows the limit resets it last knew, until they expire", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) =>
          claude.answerUsageWith(
            claudeWithGrants(
              resetGrant({ id: "soon", ends_at: new Date(NOW + 2 * HOUR).toISOString() }),
              resetGrant({ id: "later" }),
            ),
          ),
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 2)

      yield* home.restartAfter(
        Effect.sync(() => home.claude.answerUsageWith(() => json({}, { status: 500 }))),
      )
      expect(resetsOf(yield* home.limits, "work").map((reset) => reset["id"])).toEqual([
        "soon",
        "later",
      ])
      // Kept with its grant date, which the list shows beside its expiry.
      expect(resetsOf(yield* home.limits, "work")[0]?.["grantedAt"]).toBe(
        Date.UTC(2026, 10, 10, 18, 0, 0),
      )

      yield* TestClock.adjust("2 hours")
      expect(resetsOf(yield* home.limits, "work").map((reset) => reset["id"])).toEqual(["later"])
    }),
  )

  it.effect(
    "a reset read the daemon cannot make sense of keeps the resets it knew, and the account serving",
    () =>
      Effect.gen(function* () {
        let answer: (request: Request) => Response = claudeWithGrants(resetGrant())
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
          prepare: ({ claude }) => claude.answerUsageWith((request) => answer(request)),
        })
        yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
        const refresh = Effect.map(
          home.api("POST", "/api/limits/refresh", { accountId: "work" }),
          (response) => resetsOf(response.json, "work").map((reset) => reset["id"]),
        )

        for (const unreadable of [
          { ...claudeUsage },
          { ...claudeUsage, cedar_ember: { eligible: true, grants: "none" } },
          { ...claudeUsage, cedar_ember: { eligible: true, grants: [{ label: "No id" }] } },
          // Claude did not take the daemon for Claude Code.
          {
            ...claudeUsage,
            cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
          },
        ]) {
          answer = () => json(unreadable)
          expect(yield* refresh).toEqual(["full-reset-2611"])
        }
        const accounts = yield* home.api("GET", "/api/accounts")
        expect(accounts.json.accounts[0].status).toBe("active")

        // An answer that lists none, for any other reason, means none.
        answer = (request) =>
          json({
            ...claudeUsage,
            cedar_ember: limitResetStatus(request, [], { ineligibleReason: "no_grant" }),
          })
        expect(yield* refresh).toEqual([])
      }),
  )

  it.effect("the daemon's Claude reads name the Claude Code version it last proxied", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) => claude.answerUsageWith(claudeWithGrants(resetGrant())),
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
      yield* home.claudeMessage()
      yield* home.api("POST", "/api/limits/refresh", { accountId: "work" })
      expect(home.claude.usageRequests().at(-1)?.headers["user-agent"]).toBe(
        "claude-cli/2.1.326 (external, cli)",
      )
    }),
  )

  it.effect(
    "redeeming a Claude limit reset brings a used-up account back to its pool at once",
    () =>
      Effect.gen(function* () {
        let grants = [resetGrant()]
        const home = yield* makeHome({
          accounts: [
            { provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT },
            { provider: "claude", id: "backup", priority: 2 },
          ],
          prepare: ({ claude }) => {
            claude.answerUsageWith((request) => claudeWithGrants(...grants)(request))
            claude.answerApiWith((request) =>
              request.headers.get("authorization") === "Bearer token-work"
                ? fiveHourUsedUp(NOW + 3 * HOUR)
                : json({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }),
            )
          },
        })
        yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
        yield* home.claudeMessage()
        const before = yield* home.api("GET", "/api/accounts")
        expect(before.json.accounts[0]).toMatchObject({ id: "work", status: "cooling-down" })
        const reads = home.claude.usageRequests().length

        grants = []
        home.claude.answerApiWith(() =>
          json({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } }),
        )
        const redeemed = yield* home.api("POST", redeemPath("work", "full-reset-2611"))
        expect(redeemed.status).toBe(200)
        expect(redeemed.json).toMatchObject({
          outcome: "redeemed",
          limits: { accountId: "work", limitResets: [] },
        })
        expect(String(redeemed.json.message)).toContain("Full reset")

        // Redeemed as Claude Code redeems one, as the account's organization.
        const [request] = home.claude.redeemRequests()
        expect(request?.path).toBe(`/api/organizations/${CLAUDE_ORG}/reset_rate_limits`)
        expect(request?.headers).toMatchObject({
          authorization: "Bearer token-work",
          "anthropic-beta": "oauth-2025-04-20",
        })
        expect(request?.headers["user-agent"]).toMatch(/^claude-cli\/[\d.]+ \(external, cli\)$/)
        expect(JSON.parse(request?.body ?? "")).toEqual({
          program: "cedar_ember",
          grant_id: "full-reset-2611",
          request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        })
        // Its windows and resets were read again, outside the usual schedule.
        expect(home.claude.usageRequests().length).toBe(reads + 1)
        expect(resetsOf(yield* home.limits, "work")).toEqual([])

        // Back in its pool: the next session goes to it.
        const after = yield* home.api("GET", "/api/accounts")
        expect(after.json.accounts[0]).toMatchObject({ id: "work", status: "active" })
        yield* home.claudeMessage()
        expect(bearerAccount(home.claude.apiRequests().at(-1)?.headers ?? {})).toBe("work")
      }),
  )

  it.effect("a redeem leaves a short Retry-After cooldown as it is", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) => {
          claude.answerUsageWith(claudeWithGrants(resetGrant()))
          claude.answerApiWith(() => rateLimited(120))
        },
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
      yield* home.claudeMessage()
      const redeemed = yield* home.api("POST", redeemPath("work", "full-reset-2611"))
      expect(redeemed.json.outcome).toBe("redeemed")
      const after = yield* home.api("GET", "/api/accounts")
      expect(after.json.accounts[0]).toMatchObject({ status: "cooling-down" })
    }),
  )

  it.effect("every refusal from Claude says why, and leaves the limit reset unspent", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) => claude.answerUsageWith(claudeWithGrants(resetGrant())),
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
      for (const [answer, reason] of [
        [() => json({ result: "not_limited" }), "nothing-to-refill"],
        [() => json({ result: "already_used" }), "already-redeemed"],
        [() => json({ result: "cooldown" }, { status: 409 }), "cooldown"],
        [() => json({ result: "ineligible" }), "ineligible"],
        [() => json({ result: "unavailable" }), "unavailable"],
        [() => json({ error: "bad_request" }, { status: 400 }), "rejected"],
      ] as const) {
        home.claude.answerRedeemWith(answer)
        const refused = yield* home.api("POST", redeemPath("work", "full-reset-2611"))
        expect(refused.status).toBe(200)
        expect(refused.json).toMatchObject({ outcome: "refused", reason })
        expect(String(refused.json.message)).toContain("Nothing was spent.")
        expect(refused.json.limits.limitResets).toHaveLength(1)
      }
      // Each refusal is an answer: none was sent twice.
      expect(home.claude.redeemRequests()).toHaveLength(6)
    }),
  )

  it.effect("a Codex limit reset is redeemed as the account, and its refusals say why", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "codex", id: "cx" }],
        prepare: ({ codex }) => {
          codex.answerUsageWith(() => json(usageWithResets(1)))
          codex.answerResetsWith(() => json(resetsAnswer([resetCredit({ id: "credit-1" })])))
        },
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "cx").length === 1)
      for (const [code, reason] of [
        ["nothing_to_reset", "nothing-to-refill"],
        ["already_redeemed", "already-redeemed"],
        ["no_credit", "unavailable"],
      ] as const) {
        home.codex.answerRedeemWith(() => json({ code, windows_reset: 0 }))
        const refused = yield* home.api("POST", redeemPath("cx", "credit-1"))
        expect(refused.json).toMatchObject({ outcome: "refused", reason })
      }
      home.codex.answerRedeemWith(() => json({ code: "reset", windows_reset: 2 }))
      const redeemed = yield* home.api("POST", redeemPath("cx", "credit-1"))
      expect(redeemed.json.outcome).toBe("redeemed")

      const request = home.codex.redeemRequests().at(-1)
      expect(request?.headers).toMatchObject({
        authorization: "Bearer token-cx",
        "chatgpt-account-id": "provider-cx",
      })
      expect(JSON.parse(request?.body ?? "")).toEqual({
        redeem_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        credit_id: "credit-1",
      })
      // Every redeem is a new request id.
      const ids = home.codex
        .redeemRequests()
        .map((sent) => JSON.parse(sent.body)["redeem_request_id"])
      expect(new Set(ids).size).toBe(4)
    }),
  )

  it.effect("a redeem that gets no answer is sent once more with the same request id", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) => claude.answerUsageWith(claudeWithGrants(resetGrant())),
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
      const requestIds = () =>
        home.claude.redeemRequests().map((sent) => JSON.parse(sent.body)["request_id"])

      // The second try is answered.
      let tries = 0
      home.claude.answerRedeemWith(() => (++tries === 1 ? dropped() : json({ result: "reset" })))
      const redeemed = yield* home.api("POST", redeemPath("work", "full-reset-2611"))
      expect(redeemed.json.outcome).toBe("redeemed")
      const [first, second] = requestIds()
      expect(second).toBe(first)

      // Neither try is answered: whether it was redeemed is unknown.
      home.claude.answerRedeemWith(() => json({ error: "overloaded" }, { status: 503 }))
      const unknown = yield* home.api("POST", redeemPath("work", "full-reset-2611"))
      expect(unknown.json.outcome).toBe("unknown")
      expect(requestIds()).toHaveLength(4)
      expect(requestIds()[3]).toBe(requestIds()[2])
      expect(requestIds()[2]).not.toBe(first)
    }),
  )

  it.effect("a disabled account may redeem; one that needs sign-in may not", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [
          { provider: "claude", id: "off", providerAccountId: CLAUDE_ACCOUNT },
          { provider: "claude", id: "out", priority: 2, needsSignIn: true },
        ],
        prepare: ({ claude }) => claude.answerUsageWith(claudeWithGrants(resetGrant())),
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "off").length === 1)
      yield* home.api("PATCH", "/api/accounts/off", { enabled: false })
      const reads = home.claude.usageRequests().length

      const redeemed = yield* home.api("POST", redeemPath("off", "full-reset-2611"))
      expect(redeemed.json.outcome).toBe("redeemed")
      // Read again though disabled: the owner asked.
      expect(home.claude.usageRequests().length).toBe(reads + 1)

      const out = yield* home.api("POST", redeemPath("out", "full-reset-2611"))
      expect(out.status).toBe(409)
      expect(String(out.json.error)).toContain("needs sign-in")
      expect(home.claude.redeemRequests()).toHaveLength(1)
    }),
  )

  it.effect(
    "a limit reset the daemon does not know, or of an account it does not hold, is refused",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome({
          accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
          prepare: ({ claude }) => claude.answerUsageWith(claudeWithGrants(resetGrant())),
        })
        yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
        expect((yield* home.api("POST", redeemPath("work", "no-such-reset"))).status).toBe(404)
        expect((yield* home.api("POST", redeemPath("nobody", "full-reset-2611"))).status).toBe(404)
        expect(home.claude.redeemRequests()).toHaveLength(0)
      }),
  )

  it.effect("the accounts list and the event stream carry each account's limit resets", () =>
    Effect.gen(function* () {
      let grants = [resetGrant()]
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) =>
          claude.answerUsageWith((request) => claudeWithGrants(...grants)(request)),
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
      const listed = yield* home.api("GET", "/api/accounts")
      expect(listed.json.accounts[0].limitResets).toEqual([
        expect.objectContaining({ id: "full-reset-2611", name: "Full reset" }),
      ])

      const events = yield* home.events
      grants = []
      yield* home.api("POST", redeemPath("work", "full-reset-2611"))
      expect((yield* events.next("limits-changed"))["limits"]).toMatchObject({
        accountId: "work",
        limitResets: [],
      })
      expect((yield* home.api("GET", "/api/accounts")).json.accounts[0].limitResets).toEqual([])
    }),
  )

  it.effect("a reset list that never answers leaves the windows read with it", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        accounts: [{ provider: "codex", id: "cx" }],
        prepare: ({ codex }) => {
          codex.answerUsageWith(() => json(usageWithResets(1)))
          codex.answerResetsWith(() => new Promise<Response>(() => {}))
        },
      })
      yield* eventually(
        Effect.sync(() => home.codex.resetsRequests().length),
        (count) => count === 1,
      )
      yield* TestClock.adjust("31 seconds")
      const limits = yield* eventually(
        home.limits,
        (all: Limits) => limitsOf(all, "cx")?.windows.length === 2,
      )
      expect(resetsOf(limits, "cx")).toEqual([])
    }),
  )

  it.effect("a reset list that answers 429 is not asked again until its Retry-After passes", () =>
    Effect.gen(function* () {
      let busy = true
      const home = yield* makeHome({
        accounts: [{ provider: "codex", id: "cx" }],
        prepare: ({ codex }) => {
          codex.answerUsageWith(() => json(usageWithResets(1)))
          codex.answerResetsWith(() =>
            busy
              ? json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "600" } })
              : json(resetsAnswer([resetCredit()])),
          )
        },
      })
      yield* eventually(
        Effect.sync(() => home.codex.resetsRequests().length),
        (count) => count === 1,
      )
      busy = false
      yield* home.api("POST", "/api/limits/refresh", { accountId: "cx" })
      expect(home.codex.resetsRequests()).toHaveLength(1)

      yield* TestClock.adjust("10 minutes")
      const refreshed = yield* home.api("POST", "/api/limits/refresh", { accountId: "cx" })
      expect(resetsOf(refreshed.json, "cx")).toHaveLength(1)
    }),
  )

  it.effect("a redeem keeps a Retry-After cooldown that a longer window cooldown hid", () =>
    Effect.gen(function* () {
      const arrived: Array<(response: Response) => void> = []
      const home = yield* makeHome({
        accounts: [{ provider: "claude", id: "work", providerAccountId: CLAUDE_ACCOUNT }],
        prepare: ({ claude }) => {
          claude.answerUsageWith(claudeWithGrants(resetGrant()))
          // The first two requests wait for the test to answer them; any later one is served.
          claude.answerApiWith(() =>
            arrived.length >= 2
              ? json({ type: "message", usage: { input_tokens: 1, output_tokens: 1 } })
              : new Promise<Response>((resolve) => void arrived.push(resolve)),
          )
        },
      })
      yield* eventually(home.limits, (all: Limits) => resetsOf(all, "work").length === 1)
      // Two requests in flight at once: one finds the 5-hour window used up,
      // the other a two-minute rate limit, answered after it.
      const first = yield* Effect.forkChild(home.claudeMessage())
      const second = yield* Effect.forkChild(home.claudeMessage())
      yield* eventually(
        Effect.sync(() => arrived.length),
        (count) => count === 2,
      )
      // Either request may have arrived first: answer one, wait for its
      // cooldown, then the other.
      arrived[0]?.(fiveHourUsedUp(NOW + 3 * HOUR))
      yield* eventually(
        Effect.map(home.api("GET", "/api/accounts"), (response) => response.json.accounts[0]),
        (account: { readonly status: string }) => account.status === "cooling-down",
      )
      arrived[1]?.(rateLimited(120))
      yield* Fiber.join(first)
      yield* Fiber.join(second)

      const redeemed = yield* home.api("POST", redeemPath("work", "full-reset-2611"))
      expect(redeemed.json.outcome).toBe("redeemed")
      const after = yield* home.api("GET", "/api/accounts")
      expect(after.json.accounts[0]).toMatchObject({
        status: "cooling-down",
        cooldownEndsAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + 120_000)),
      })
    }),
  )

  it.effect("a reset list's Retry-After counts from when its 429 arrives", () =>
    Effect.gen(function* () {
      let answer: ((response: Response) => void) | undefined
      let held = true
      const home = yield* makeHome({
        accounts: [{ provider: "codex", id: "cx" }],
        prepare: ({ codex }) => {
          codex.answerUsageWith(() => json(usageWithResets(1)))
          codex.answerResetsWith(() =>
            held
              ? new Promise<Response>((resolve) => {
                  answer = resolve
                })
              : json(resetsAnswer([resetCredit()])),
          )
        },
      })
      yield* eventually(
        Effect.sync(() => home.codex.resetsRequests().length),
        (count) => count === 1,
      )
      // The 429 takes 20 seconds to arrive and asks for 10 more.
      held = false
      yield* TestClock.adjust("20 seconds")
      answer?.(json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "10" } }))
      yield* eventually(home.limits, (all: Limits) => limitsOf(all, "cx")?.windows.length === 2)

      yield* home.api("POST", "/api/limits/refresh", { accountId: "cx" })
      expect(home.codex.resetsRequests()).toHaveLength(1)
      yield* TestClock.adjust("10 seconds")
      yield* home.api("POST", "/api/limits/refresh", { accountId: "cx" })
      expect(home.codex.resetsRequests()).toHaveLength(2)
    }),
  )
})
