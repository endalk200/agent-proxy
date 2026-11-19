import { Database } from "bun:sqlite"
import { rmSync } from "node:fs"

import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { TestClock } from "effect/testing"

import { alice, limitHeaders, streamedMessage } from "../support/fake-claude.ts"
import { codexHeaders, streamedResponse } from "../support/fake-codex.ts"
import { HOUR, makeHome, NOW, services, sse } from "../support/usage-home.ts"

// Usage recording, in-process: a real daemon on loopback in a throwaway home,
// fake Claude and Codex backends, and Effect's test clock, set to a fixed
// moment each test. Clients are plain `fetch` calls to the proxy; the tests
// read only what the daemon API reports (`/api/usage/*` and `/api/events`).

layer(services)("usage", (it) => {
  it.effect(
    "a streamed Claude message is recorded with its token kinds, and its client gets the bytes as sent",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        const body = streamedMessage({
          input: 10,
          cacheRead: 200,
          cacheWrite: 30,
          output: 40,
        })
        home.claude.answerApiWith(() => sse(body, limitHeaders))
        const events = yield* home.events

        const response = yield* home.claudeMessage()
        expect(response.status).toBe(200)
        expect(response.text).toBe(body)

        const recorded = yield* events.next("usage-recorded")
        expect(recorded["usage"]).toEqual({
          at: NOW,
          provider: "claude",
          accountId: "work",
          model: "claude-sonnet-4-5",
          client: "claude-code",
          status: "success",
          tokens: {
            uncached: 10,
            cacheRead: 200,
            cacheWrite: 30,
            cacheWrite1h: 0,
            output: 40,
            reasoning: 0,
          },
        })
        const summary = yield* home.usage("summary", { range: "24h" })
        expect(summary.requests).toEqual({
          total: 1,
          success: 1,
          failed: 0,
          limited: 0,
          incomplete: 0,
        })
        expect(summary.tokens).toEqual({
          uncached: 10,
          cacheRead: 200,
          cacheWrite: 30,
          cacheWrite1h: 0,
          output: 40,
          reasoning: 0,
        })
        expect(summary.cacheHitRate).toBeCloseTo(200 / 240)
      }),
  )

  it.effect(
    "a Codex response is recorded with cached input split from uncached, and reasoning as part of output",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("codex", "cx")
        const body = streamedResponse({
          input: 3000,
          cached: 1000,
          output: 400,
          reasoning: 100,
        })
        home.codex.answerApiWith(() => sse(body, codexHeaders))
        const events = yield* home.events

        const response = yield* home.codexResponse()
        expect(response.text).toBe(body)

        const recorded = yield* events.next("usage-recorded")
        expect(recorded["usage"]).toEqual({
          at: NOW,
          provider: "codex",
          accountId: "cx",
          model: "gpt-5.4",
          client: "codex",
          status: "success",
          tokens: {
            uncached: 2000,
            cacheRead: 1000,
            cacheWrite: 0,
            cacheWrite1h: 0,
            output: 400,
            reasoning: 100,
          },
        })
      }),
  )

  it.effect("a Claude message answered as one JSON body is recorded from its usage", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      const events = yield* home.events
      // The fake's default answer: a JSON message with 3 input and 5 output tokens.
      const response = yield* home.claudeMessage()
      expect(response.status).toBe(200)

      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        status: "success",
        tokens: {
          uncached: 3,
          cacheRead: 0,
          cacheWrite: 0,
          output: 5,
          reasoning: 0,
        },
      })
    }),
  )

  it.effect("a gzip-compressed stream reaches its client as sent and is still recorded", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      const body = streamedMessage({
        input: 7,
        cacheRead: 0,
        cacheWrite: 0,
        output: 9,
      })
      home.claude.answerApiWith(
        () =>
          new Response(Bun.gzipSync(new TextEncoder().encode(body)), {
            headers: {
              ...limitHeaders,
              "content-type": "text/event-stream",
              "content-encoding": "gzip",
            },
          }),
      )
      const events = yield* home.events

      const response = yield* home.claudeMessage()
      expect(response.text).toBe(body)
      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        status: "success",
        tokens: { uncached: 7, output: 9 },
      })
    }),
  )

  it.effect("opencode's Claude path is recorded as opencode, by its Agent SDK user agent", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      const events = yield* home.events
      yield* home.send("/v1/messages?beta=true", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "claude-cli/2.1.326 (external, sdk-ts, agent-sdk/0.3.1)",
          "x-api-key": yield* home.key,
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 8,
          messages: [],
        }),
      })
      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        client: "opencode",
        model: "claude-haiku-4-5",
      })
    }),
  )

  it.effect("Codex embedded in an app that renames its user agent is recorded as codex", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("codex", "cx")
      const events = yield* home.events
      // T3 Code runs Codex's app-server, which takes the app's name as its user
      // agent, but Codex still sends its own headers.
      yield* home.send("/backend-api/codex/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "T3/0.169.0 (Mac OS 26.6.0; arm64)",
          authorization: `Bearer ${yield* home.key}`,
          "x-codex-window-id": "019a0000-0000-7000-8000-000000000000:0",
        },
        body: JSON.stringify({ model: "gpt-5.4", stream: true, input: [] }),
      })
      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        client: "codex",
        model: "gpt-5.4",
      })
    }),
  )

  it.effect("counting tokens spends no usage, so it is not recorded", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      const events = yield* home.events
      const counted = yield* home.claudeMessage({
        path: "/v1/messages/count_tokens?beta=true",
        model: "claude-opus-4-5",
      })
      expect(counted.status).toBe(200)
      yield* home.claudeMessage({ model: "claude-sonnet-4-5" })

      // The first usage recorded is the message's, not the count's.
      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({ model: "claude-sonnet-4-5" })
      const summary = yield* home.usage("summary", { range: "24h" })
      expect(summary.requests.total).toBe(1)
    }),
  )

  it.effect("an error answer is recorded as failed, with no tokens", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      home.claude.answerApiWith(() =>
        Response.json(
          {
            type: "error",
            error: { type: "api_error", message: "Overloaded." },
          },
          { status: 500, headers: limitHeaders },
        ),
      )
      const events = yield* home.events
      expect((yield* home.claudeMessage()).status).toBe(500)

      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        accountId: "work",
        status: "failed",
        tokens: {
          uncached: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
        },
      })
    }),
  )

  it.effect("a limit answer is recorded as limited, against the account that hit it", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      home.claude.answerApiWith(() =>
        Response.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Limit reached." },
          },
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
      const events = yield* home.events
      expect((yield* home.claudeMessage()).status).toBe(429)

      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        accountId: "work",
        status: "limited",
      })
      const summary = yield* home.usage("summary", { range: "24h" })
      expect(summary.requests).toEqual({
        total: 1,
        success: 0,
        failed: 0,
        limited: 1,
        incomplete: 0,
      })
    }),
  )

  it.effect(
    "a stream that ends without its final usage event is recorded as incomplete, with what it saw",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        const whole = streamedMessage({
          input: 11,
          cacheRead: 22,
          cacheWrite: 0,
          output: 33,
        })
        // Everything up to the message_delta.
        const cut = whole.slice(0, whole.indexOf("event: message_delta"))
        home.claude.answerApiWith(() => sse(cut, limitHeaders))
        const events = yield* home.events

        expect((yield* home.claudeMessage()).text).toBe(cut)
        const recorded = yield* events.next("usage-recorded")
        expect(recorded["usage"]).toMatchObject({
          status: "incomplete",
          tokens: { uncached: 11, cacheRead: 22, cacheWrite: 0, output: 1 },
        })
      }),
  )

  it.effect("a client that goes away mid-stream leaves its request recorded as incomplete", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      const whole = streamedMessage({
        input: 5,
        cacheRead: 50,
        cacheWrite: 0,
        output: 9,
      })
      const start = whole.slice(0, whole.indexOf("event: content_block_start"))
      // Sends the message_start, then never finishes.
      home.claude.answerApiWith(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(start))
              },
            }),
            {
              headers: {
                ...limitHeaders,
                "content-type": "text/event-stream",
              },
            },
          ),
      )
      const events = yield* home.events
      const key = yield* home.key

      yield* Effect.promise(async () => {
        const controller = new AbortController()
        const response = await fetch(`${home.address()}/v1/messages?beta=true`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            stream: true,
            messages: [],
          }),
        })
        const reader = (response.body ?? new ReadableStream()).getReader()
        await reader.read()
        controller.abort()
      })

      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        status: "incomplete",
        tokens: { uncached: 5, cacheRead: 50, output: 1 },
      })
    }),
  )

  it.effect("ranges cover whole buckets of the viewer's calendar, in the zone they name", () =>
    Effect.gen(function* () {
      // 23:30 on 15 November in Tokyo, which is 14:30 UTC.
      const home = yield* makeHome({
        startAt: Date.UTC(2026, 10, 15, 14, 30),
      })
      yield* home.seed("claude", "work")
      yield* home.claudeMessage()
      // An hour later it is 16 November in Tokyo, still 15 November in UTC.
      yield* TestClock.adjust("1 hour")
      yield* home.claudeMessage()
      yield* TestClock.setTime(NOW)

      const tokyoDays = yield* home.usage("series", {
        range: "30d",
        by: "model",
      })
      expect(tokyoDays.bucketMs).toBe(24 * HOUR)
      expect(tokyoDays.buckets).toHaveLength(30)
      // Today plus the previous 29 days, from midnight in Tokyo (15:00 UTC the day before).
      expect(tokyoDays.from).toBe(Date.UTC(2026, 9, 19, 15))
      expect(tokyoDays.to).toBe(Date.UTC(2026, 10, 18, 15))
      const tokyoNonZero = tokyoDays.buckets
        .filter((bucket: { values: object }) => Object.keys(bucket.values).length > 0)
        .map((bucket: { t: number }) => bucket.t)
      expect(tokyoNonZero).toEqual([Date.UTC(2026, 10, 14, 15), Date.UTC(2026, 10, 15, 15)])
      expect(tokyoDays.keys).toEqual(["claude-sonnet-4-5"])

      const utcDays = yield* home.usage("series", {
        range: "30d",
        by: "model",
        tz: "UTC",
      })
      const utcNonZero = utcDays.buckets
        .filter((bucket: { values: object }) => Object.keys(bucket.values).length > 0)
        .map((bucket: { t: number; values: Record<string, number> }) => [bucket.t, bucket.values])
      expect(utcNonZero).toEqual([[Date.UTC(2026, 10, 15), { "claude-sonnet-4-5": 16 }]])

      // 7d: from midnight six days ago in Tokyo, to the end of the 3-hour bucket holding now (18:00–21:00).
      const week = yield* home.usage("summary", { range: "7d" })
      expect(week.from).toBe(Date.UTC(2026, 10, 11, 15))
      expect(week.to).toBe(Date.UTC(2026, 10, 18, 12))
      expect(week.requests.total).toBe(2)

      // 6h: 24 buckets of 15 minutes, the last holding now.
      const sixHours = yield* home.usage("series", {
        range: "6h",
        by: "model",
      })
      expect(sixHours.bucketMs).toBe(15 * 60_000)
      expect(sixHours.buckets).toHaveLength(24)
      expect(sixHours.to).toBe(NOW + 15 * 60_000)

      // A custom day is that calendar day in the viewer's zone, in hour buckets.
      const day = yield* home.usage("summary", {
        range: "custom",
        from: "2026-11-15",
        to: "2026-11-15",
      })
      expect(day.from).toBe(Date.UTC(2026, 10, 14, 15))
      expect(day.to).toBe(Date.UTC(2026, 10, 15, 15))
      expect(day.requests.total).toBe(1)
      const daySeries = yield* home.usage("series", {
        range: "custom",
        from: "2026-11-15",
        to: "2026-11-15",
      })
      expect(daySeries.bucketMs).toBe(HOUR)
      expect(daySeries.buckets).toHaveLength(24)

      // Lifetime starts on the day of the first recorded request.
      const lifetime = yield* home.usage("summary", { range: "lifetime" })
      expect(lifetime.from).toBe(Date.UTC(2026, 10, 14, 15))
      expect(lifetime.requests.total).toBe(2)
    }),
  )

  it.effect(
    "a client that goes away before the provider answers leaves its request recorded as incomplete",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        // The provider takes the request and never answers.
        const arrived = Promise.withResolvers<void>()
        home.claude.answerApiWith(() => {
          arrived.resolve()
          return new Promise<Response>(() => {})
        })
        const events = yield* home.events
        const key = yield* home.key

        yield* Effect.promise(async () => {
          const controller = new AbortController()
          const sent = fetch(`${home.address()}/v1/messages?beta=true`, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", "x-api-key": key },
            body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
          }).catch(() => undefined)
          await arrived.promise
          controller.abort()
          await sent
        })

        const recorded = yield* events.next("usage-recorded")
        expect(recorded["usage"]).toMatchObject({
          accountId: "work",
          status: "incomplete",
          tokens: {
            uncached: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            reasoning: 0,
          },
        })
      }),
  )

  it.effect("a rejection the client is shown is recorded against the account that sent it", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      // a1 refreshes fine, but Claude rejects every token it sends.
      yield* home.seed("claude", "a1", 1, {
        credentials: {
          ...home.claude.grant(alice),
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      // a2's token is rejected too, and its refresh is refused, so it drops out without an answer to show.
      yield* home.seed("claude", "a2", 2, {
        credentials: {
          accessToken: "token-a2",
          refreshToken: "refused",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      home.claude.answerApiWith(() =>
        Response.json(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "Invalid token.",
            },
          },
          { status: 401 },
        ),
      )
      const events = yield* home.events
      expect((yield* home.claudeMessage()).status).toBe(401)

      const recorded = yield* events.next("usage-recorded")
      expect(recorded["usage"]).toMatchObject({
        accountId: "a1",
        status: "failed",
      })
    }),
  )

  it.effect("a range ending where clocks skip an hour still holds the request just made", () =>
    Effect.gen(function* () {
      // 01:50 in New York on 8 March 2026, ten minutes before its clocks skip from 02:00 to 03:00.
      const home = yield* makeHome({ startAt: Date.UTC(2026, 2, 8, 6, 50) })
      yield* home.seed("claude", "work")
      yield* home.claudeMessage()
      for (const range of ["6h", "24h", "7d"]) {
        const summary = yield* home.usage("summary", {
          range,
          tz: "America/New_York",
        })
        expect({ range, total: summary.requests.total }).toEqual({
          range,
          total: 1,
        })
        expect(summary.to).toBeGreaterThan(Date.UTC(2026, 2, 8, 6, 50))
      }
    }),
  )

  it.effect("a range ending in an hour that clocks repeat still holds the request just made", () =>
    Effect.gen(function* () {
      // 01:20 the second time round in New York on 1 November 2026, after its clocks went back from 02:00 to 01:00.
      const home = yield* makeHome({ startAt: Date.UTC(2026, 10, 1, 6, 20) })
      yield* home.seed("claude", "work")
      yield* home.claudeMessage()
      for (const range of ["6h", "24h"]) {
        const summary = yield* home.usage("summary", {
          range,
          tz: "America/New_York",
        })
        expect({ range, total: summary.requests.total }).toEqual({
          range,
          total: 1,
        })
        expect(summary.to).toBeGreaterThan(Date.UTC(2026, 10, 1, 6, 20))
      }
    }),
  )

  it.effect("a range the daemon cannot read is refused with a message saying what it expects", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      const unknown = yield* home.api("GET", "/api/usage/summary?range=2w")
      expect(unknown.status).toBe(400)
      expect(unknown.json.error).toContain("range=6h|24h|7d|30d|90d|lifetime")
      const backwards = yield* home.api(
        "GET",
        "/api/usage/summary?range=custom&from=2026-11-10&to=2026-11-01",
      )
      expect(backwards.status).toBe(400)
      const zone = yield* home.api("GET", "/api/usage/summary?tz=Mars/Olympus")
      expect(zone.status).toBe(400)
      const metric = yield* home.api("GET", "/api/usage/series?by=model&metric=requests")
      expect(metric.status).toBe(400)
      expect(metric.json.error).toBe("A series's metric is tokens or cost.")
    }),
  )

  it.effect(
    "equivalent cost prices each model at its list prices, and leaves unpriced models out of totals but names them",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        yield* home.seed("codex", "cx")
        home.claude.answerApiWith(() =>
          sse(
            streamedMessage({
              input: 1000,
              cacheRead: 10_000,
              cacheWrite: 2000,
              output: 500,
            }),
            limitHeaders,
          ),
        )
        yield* home.claudeMessage({ model: "claude-sonnet-4-5" })
        home.codex.answerApiWith(() =>
          sse(
            streamedResponse({
              input: 3000,
              cached: 1000,
              output: 400,
              reasoning: 100,
            }),
            codexHeaders,
          ),
        )
        yield* home.codexResponse({ model: "gpt-5.4" })
        home.codex.answerApiWith(() =>
          sse(
            streamedResponse({
              input: 500,
              cached: 0,
              output: 100,
              reasoning: 0,
            }),
            codexHeaders,
          ),
        )
        yield* home.codexResponse({ model: "gpt-made-up" })

        // claude-sonnet-4-5 at $3 input, $0.30 cache read, $3.75 cache write and $15 output per
        // million tokens: $0.021. gpt-5.4 at $2.50 input, $0.25 cache read and $15 output: $0.01125.
        const summary = yield* home.usage("summary", { range: "24h" })
        expect(summary.costUsd).toBeCloseTo(0.03225, 10)
        expect(summary.unpricedModels).toEqual(["gpt-made-up"])

        const models = yield* home.usage("breakdown", {
          range: "24h",
          by: "model",
        })
        expect(
          models.rows.map((row: Record<string, unknown>) => [
            row["key"],
            row["totalTokens"],
            row["costUsd"],
            row["partlyUnpriced"],
          ]),
        ).toEqual([
          ["claude-sonnet-4-5", 13_500, expect.closeTo(0.021, 10), false],
          ["gpt-5.4", 3400, expect.closeTo(0.01125, 10), false],
          ["gpt-made-up", 600, null, false],
        ])
        expect(models.rows[0].share).toBeCloseTo(13_500 / 17_500)

        // A cost series ranks models by cost and leaves the unpriced one out; a token series has it.
        const costs = yield* home.usage("series", { range: "24h", by: "model", metric: "cost" })
        expect(costs.metric).toBe("cost")
        expect(costs.keys).toEqual(["claude-sonnet-4-5", "gpt-5.4"])
        const spent = costs.buckets.flatMap((bucket: { values: Record<string, number> }) =>
          Object.entries(bucket.values),
        )
        expect(spent).toEqual([
          ["claude-sonnet-4-5", expect.closeTo(0.021, 10)],
          ["gpt-5.4", expect.closeTo(0.01125, 10)],
        ])
        const tokens = yield* home.usage("series", { range: "24h", by: "model" })
        expect(tokens.metric).toBe("tokens")
        expect(tokens.keys).toEqual(["claude-sonnet-4-5", "gpt-5.4", "gpt-made-up"])

        const accounts = yield* home.usage("breakdown", {
          range: "24h",
          by: "account",
        })
        expect(
          accounts.rows.map((row: Record<string, unknown>) => [
            row["key"],
            row["totalTokens"],
            row["costUsd"],
            row["partlyUnpriced"],
          ]),
        ).toEqual([
          ["work", 13_500, expect.closeTo(0.021, 10), false],
          ["cx", 4000, expect.closeTo(0.01125, 10), true],
        ])

        // Narrowed to one account, every number is that account's.
        const codexOnly = yield* home.usage("summary", {
          range: "24h",
          account: "cx",
        })
        expect(codexOnly.requests.total).toBe(2)
        expect(codexOnly.costUsd).toBeCloseTo(0.01125, 10)
      }),
  )

  it.effect(
    "a request whose input goes over a model's long-context size is priced wholly at its long-context rates",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("codex", "cx")
        const answer = (usage: { input: number; cached: number; output: number }) =>
          Effect.gen(function* () {
            home.codex.answerApiWith(() =>
              sse(streamedResponse({ ...usage, reasoning: 0 }), codexHeaders),
            )
            yield* home.codexResponse({ model: "gpt-6.1-sol" })
          })
        // gpt-6.1-sol is $2 input, $0.10 cache read and $10 output per million tokens, and over
        // 272K input tokens $4, $0.20 and $15. All three requests land in one 15-minute slot.
        // Short: 2000 uncached, 1000 cached, 400 output: $0.0081.
        yield* answer({ input: 3000, cached: 1000, output: 400 })
        // At the size, not over it: 272,000 uncached at the base rate, $0.544.
        yield* answer({ input: 272_000, cached: 0, output: 0 })
        // Over it: 100,000 uncached, 200,000 cached and 1000 output, all at the long rates: $0.455.
        yield* answer({ input: 300_000, cached: 200_000, output: 1000 })

        const summary = yield* home.usage("summary", { range: "24h" })
        expect(summary.costUsd).toBeCloseTo(1.0071, 10)
        const models = yield* home.usage("breakdown", {
          range: "24h",
          by: "model",
        })
        expect(models.rows[0].costUsd).toBeCloseTo(1.0071, 10)
      }),
  )

  it.effect(
    "cache writes count toward a request's long-context size, and a 1-hour write over it costs twice the long-context input rate",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        const write = (tokens: number) =>
          Effect.gen(function* () {
            home.claude.answerApiWith(() =>
              sse(
                streamedMessage({
                  input: 0,
                  cacheRead: 0,
                  cacheWrite: tokens,
                  cacheWrite1h: tokens,
                  output: 0,
                }),
                limitHeaders,
              ),
            )
            yield* home.claudeMessage({ model: "claude-haiku-5-5" })
          })
        // claude-haiku-5-5's input is $0.10 per million tokens, and $0.50 over 100K input tokens.
        // At the size: 100,000 1-hour writes at twice $0.10, $0.02.
        yield* write(100_000)
        // Over it: 100,001 1-hour writes at twice $0.50, $0.100001.
        yield* write(100_001)

        const summary = yield* home.usage("summary", { range: "24h" })
        expect(summary.costUsd).toBeCloseTo(0.120001, 10)
        const models = yield* home.usage("breakdown", { range: "24h", by: "model" })
        expect(models.rows[0].costUsd).toBeCloseTo(0.120001, 10)
      }),
  )

  it.effect(
    "a cache write to the 1-hour cache is priced at twice the input price, the rest at the 5-minute rate",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        home.claude.answerApiWith(() =>
          sse(
            streamedMessage({
              input: 0,
              cacheRead: 0,
              cacheWrite: 3000,
              cacheWrite1h: 1000,
              output: 0,
            }),
            limitHeaders,
          ),
        )
        const events = yield* home.events
        yield* home.claudeMessage({ model: "claude-opus-4-5" })

        const recorded = yield* events.next("usage-recorded")
        expect(recorded["usage"]).toMatchObject({
          tokens: { cacheWrite: 3000, cacheWrite1h: 1000 },
        })
        // claude-opus-4-5's input is $5 per million tokens: 2000 tokens at the 5-minute rate,
        // $6.25, and 1000 at the 1-hour rate, $10, cost $0.0225.
        const summary = yield* home.usage("summary", { range: "24h" })
        expect(summary.tokens).toMatchObject({
          cacheWrite: 3000,
          cacheWrite1h: 1000,
        })
        expect(summary.costUsd).toBeCloseTo(0.0225, 10)
        const models = yield* home.usage("breakdown", {
          range: "24h",
          by: "model",
        })
        expect(models.rows[0].tokens).toMatchObject({
          cacheWrite: 3000,
          cacheWrite1h: 1000,
        })
        expect(models.rows[0].costUsd).toBeCloseTo(0.0225, 10)
      }),
  )

  it.effect("a breakdown by account names each account, and a removed one by its last name", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      yield* home.seed("claude", "home", 2)
      const events = yield* home.events
      yield* home.claudeMessage()
      // Renamed and removed at once: the name kept is the one it had when removed.
      expect((yield* home.api("PATCH", "/api/accounts/work", { label: "Work" })).status).toBe(200)
      expect((yield* home.api("DELETE", "/api/accounts/work")).status).toBe(200)
      yield* events.next("removed")

      const rows = (yield* home.usage("breakdown", {
        range: "24h",
        by: "account",
      })).rows
      expect(rows.map((row: Record<string, unknown>) => [row["key"], row["account"]])).toEqual([
        [
          "work",
          {
            provider: "claude",
            label: "Work",
            email: "work@example.com",
            plan: "Pro",
            removedAt: NOW,
          },
        ],
      ])

      // The name outlives a restart, and a held account is named too.
      yield* home.restart
      yield* home.claudeMessage()
      const after = (yield* home.usage("breakdown", {
        range: "24h",
        by: "account",
      })).rows
      expect(after.map((row: Record<string, unknown>) => [row["key"], row["account"]])).toEqual([
        [
          "home",
          {
            provider: "claude",
            label: "home",
            email: "home@example.com",
            plan: "Pro",
            removedAt: null,
          },
        ],
        ["work", expect.objectContaining({ label: "Work", removedAt: NOW })],
      ])
    }),
  )

  it.effect("an account whose file cannot be read for a while is not taken for removed", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      yield* home.seed("claude", "home", 2)
      const events = yield* home.events
      yield* home.claudeMessage()
      yield* home.damage("work")
      // Any change makes the daemon read the accounts again, while work's file is unreadable.
      expect((yield* home.api("PATCH", "/api/accounts/home", { label: "Home" })).status).toBe(200)
      yield* events.next("settings-changed")

      const rows = (yield* home.usage("breakdown", {
        range: "24h",
        by: "account",
      })).rows
      expect(rows.map((row: Record<string, unknown>) => [row["key"], row["account"]])).toEqual([
        ["work", expect.objectContaining({ label: "work", removedAt: null })],
      ])
    }),
  )

  it.effect("a removed account's usage stays in totals, under its id", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      yield* home.claudeMessage()
      expect((yield* home.api("DELETE", "/api/accounts/work")).status).toBe(200)

      const accounts = yield* home.usage("breakdown", {
        range: "24h",
        by: "account",
      })
      expect(accounts.rows.map((row: { key: string }) => row.key)).toEqual(["work"])
      expect((yield* home.usage("summary", { range: "24h" })).requests.total).toBe(1)
    }),
  )

  it.effect("recorded usage survives a restart", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      yield* home.claudeMessage()
      yield* home.restart
      const summary = yield* home.usage("summary", { range: "lifetime" })
      expect(summary.requests.total).toBe(1)
      expect(summary.tokens.output).toBe(5)
    }),
  )

  it.effect("a usage store that cannot be opened leaves the proxy serving, and says why", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      const file = `${home.dataDir}/usage.sqlite`
      yield* home.restartAfter(
        Effect.gen(function* () {
          for (const leftover of [file, `${file}-wal`, `${file}-shm`]) {
            yield* fs.remove(leftover, { force: true })
          }
          yield* fs.writeFileString(file, "not a database, just damage\n".repeat(200))
        }),
      )

      const answer = yield* home.claudeMessage()
      expect(answer.status).toBe(200)
      expect(answer.text).toContain("msg_fake")
      const summary = yield* home.api("GET", "/api/usage/summary?range=lifetime&tz=Asia%2FTokyo")
      expect(summary.status).toBe(500)
      expect(summary.json.error).toContain("Usage is not recorded")
      expect(summary.json.error).toContain(file)
      // The damaged file is left for the owner to look at.
      expect(yield* fs.readFileString(file)).toContain("not a database")
    }),
  )

  it.effect(
    "a usage store at this build's version but missing its tables leaves the proxy serving",
    () =>
      Effect.gen(function* () {
        const home = yield* makeHome()
        yield* home.seed("claude", "work")
        const file = `${home.dataDir}/usage.sqlite`
        yield* home.restartAfter(
          Effect.sync(() => {
            const before = new Database(file, { readonly: true })
            const version = before.query<{ user_version: number }, []>("PRAGMA user_version").get()
            before.close()
            for (const leftover of [file, `${file}-wal`, `${file}-shm`])
              rmSync(leftover, { force: true })
            // A real SQLite file that claims this build's schema, its tables gone.
            const damaged = new Database(file)
            damaged.run(`PRAGMA user_version = ${version?.user_version ?? 0}`)
            damaged.close()
          }),
        )

        expect((yield* home.claudeMessage()).status).toBe(200)
        const summary = yield* home.api("GET", "/api/usage/summary?range=lifetime&tz=Asia%2FTokyo")
        expect(summary.status).toBe(500)
        expect(summary.json.error).toContain("Usage is not recorded")
      }),
  )

  it.effect("a usage store a newer build wrote is left as it is, and the proxy still serves", () =>
    Effect.gen(function* () {
      const home = yield* makeHome()
      yield* home.seed("claude", "work")
      yield* home.claudeMessage()
      const file = `${home.dataDir}/usage.sqlite`
      const version = () => {
        const db = new Database(file, { readonly: true })
        try {
          return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
        } finally {
          db.close()
        }
      }
      yield* home.restartAfter(
        Effect.sync(() => {
          const db = new Database(file)
          db.run("PRAGMA user_version = 99")
          db.close()
        }),
      )

      const answer = yield* home.claudeMessage()
      expect(answer.status).toBe(200)
      const summary = yield* home.api("GET", "/api/usage/summary?range=lifetime&tz=Asia%2FTokyo")
      expect(summary.status).toBe(500)
      expect(summary.json.error).toContain("newer agent-proxy build")
      // Never migrated down: the newer build opens it as it left it, its rows intact.
      yield* home.restartAfter(Effect.void)
      expect(version()).toBe(99)
    }),
  )
})
