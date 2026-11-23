import { Clock, Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { AccountStore } from "../accounts/store.ts"
import { LimitWindows } from "../usage/limit-windows.ts"
import { LimitPoller } from "../usage/poller.ts"
import { isTimeZone, parseDay, type RangeKey, type UsageRange } from "../usage/ranges.ts"
import { type UsageQuery, UsageStore, type UsageStoreError } from "../usage/store.ts"
import { apiError, type LocalOnly } from "./http.ts"

/**
 * The daemon API's usage and limit-window operations:
 *
 * - `GET /api/usage/summary`, `GET /api/usage/series?by=model&metric=tokens|cost`
 *   (tokens when left out) and `GET /api/usage/breakdown?by=model|account`
 *   answer range questions. Each
 *   takes `range=6h|24h|7d|30d|90d|lifetime`, or `range=custom` with `from`
 *   and `to` as inclusive `YYYY-MM-DD` days (7d when left out); `tz`, the
 *   viewer's IANA zone, which calendar days follow (the daemon's own when
 *   left out); and `account`, which narrows every number to one account.
 * - `GET /api/limits` lists every account's limit windows and limit resets,
 *   and whether its provider offers it an instant reset to buy.
 * - `POST /api/limits/refresh` with `{ "accountId"?: string }` reads the
 *   provider's usage endpoint for that account, or for every account, and
 *   answers every account's limit windows once the reads finish.
 */

const RANGE_KEYS: ReadonlySet<string> = new Set(["6h", "24h", "7d", "30d", "90d", "lifetime"])

const isRangeKey = (key: string): key is RangeKey => RANGE_KEYS.has(key)

const RANGE_SHAPE =
  "range=6h|24h|7d|30d|90d|lifetime, or range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD"

/** The range question a request's query string asks, or why it cannot be asked. */
const queryOf = (params: URLSearchParams): UsageQuery | string => {
  const key = params.get("range") ?? "7d"
  const tz = params.get("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!isTimeZone(tz))
    return `Unknown time zone "${tz}". Expected an IANA zone such as Europe/Berlin.`
  const account = params.get("account") ?? undefined
  let range: UsageRange
  if (key === "custom") {
    const from = params.get("from") ?? ""
    const to = params.get("to") ?? ""
    const first = parseDay(from)
    const last = parseDay(to)
    if (first === undefined || last === undefined) {
      return `A custom range needs from and to as YYYY-MM-DD days.`
    }
    if (first > last) return `A custom range's from (${from}) must not be after its to (${to}).`
    range = { key: "custom", from, to }
  } else if (isRangeKey(key)) {
    range = { key }
  } else {
    return `Unknown range "${key}". Expected ${RANGE_SHAPE}.`
  }
  return { range, tz, accountId: account }
}

const searchParams = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URL(request.url, "http://daemon").searchParams,
)

/**
 * Answers what `answer` makes of the range question the request asks, or
 * 400 when the question, or `answer`, finds it cannot be asked.
 */
const usageRoute = (
  answer: (
    store: UsageStore["Service"],
    query: UsageQuery,
    params: URLSearchParams,
  ) => Effect.Effect<unknown, UsageStoreError> | string,
) =>
  Effect.gen(function* () {
    const params = yield* searchParams
    const query = queryOf(params)
    if (typeof query === "string") return apiError(400, query)
    const answered = answer(yield* UsageStore, query, params)
    if (typeof answered === "string") return apiError(400, answered)
    return HttpServerResponse.jsonUnsafe(yield* answered)
  }).pipe(
    Effect.catchTag("UsageStoreError", (error) => Effect.succeed(apiError(500, error.message))),
  )

/** Every account's limit windows and limit resets, in the order `GET /api/accounts` lists accounts. */
const allLimits = Effect.gen(function* () {
  const accounts = yield* (yield* AccountStore).list
  const limits = yield* LimitWindows
  const now = yield* Clock.currentTimeMillis
  return accounts.map((account) => limits.report(account.id, now))
})

const RefreshLimits = Schema.Struct({ accountId: Schema.optionalKey(Schema.String) })

/** Adds the routes to `router`, each served only to clients `localOnly` lets through. */
export const usageRoutes = (router: HttpRouter.HttpRouter, localOnly: LocalOnly) =>
  Effect.all([
    router.add(
      "GET",
      "/api/usage/summary",
      localOnly(usageRoute((store, query) => store.summary(query))),
    ),
    router.add(
      "GET",
      "/api/usage/series",
      localOnly(
        usageRoute((store, query, params) => {
          if ((params.get("by") ?? "model") !== "model") return "A series is by=model."
          const metric = params.get("metric") ?? "tokens"
          return metric === "tokens" || metric === "cost"
            ? store.series(query, metric)
            : "A series's metric is tokens or cost."
        }),
      ),
    ),
    router.add(
      "GET",
      "/api/usage/breakdown",
      localOnly(
        usageRoute((store, query, params) => {
          const by = params.get("by")
          return by === "model" || by === "account"
            ? store.breakdown(query, by)
            : "A breakdown is by=model or by=account."
        }),
      ),
    ),
    router.add(
      "GET",
      "/api/limits",
      localOnly(
        Effect.map(allLimits, (limits) => HttpServerResponse.jsonUnsafe(limits)).pipe(
          Effect.catchTag("AccountStoreError", (error) =>
            Effect.succeed(apiError(500, error.message)),
          ),
        ),
      ),
    ),
    router.add(
      "POST",
      "/api/limits/refresh",
      localOnly(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const text = yield* request.text
          const body =
            text.trim() === ""
              ? {}
              : yield* Schema.decodeEffect(Schema.fromJsonString(RefreshLimits))(text)
          const accounts = yield* (yield* AccountStore).list
          if (
            body.accountId !== undefined &&
            !accounts.some((account) => account.id === body.accountId)
          ) {
            return apiError(404, `No account ${body.accountId}.`)
          }
          yield* (yield* LimitPoller).refresh(body.accountId)
          return HttpServerResponse.jsonUnsafe(yield* allLimits)
        }).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.succeed(apiError(400, 'Expected a JSON body { "accountId"?: string }.')),
            HttpServerError: () =>
              Effect.succeed(apiError(400, 'Expected a JSON body { "accountId"?: string }.')),
            AccountStoreError: (error) => Effect.succeed(apiError(500, error.message)),
          }),
        ),
      ),
    ),
  ])
