import { Clock, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { Router } from "../accounts/router.ts"
import { AccountStore } from "../accounts/store.ts"
import { Logins } from "../logins/logins.ts"
import { LimitWindows } from "../usage/limit-windows.ts"
import { Redeemer } from "../usage/redeem.ts"
import { UsageStore } from "../usage/store.ts"
import {
  StartLogin,
  SubmitCallback,
  toAccountListing,
  toAccountView,
  UpdateAccount,
} from "./api.ts"
import { apiError, type LocalOnly } from "./http.ts"

/**
 * The daemon API's account and login operations:
 *
 * - `GET /api/accounts` lists accounts with their status and limit resets,
 *   and which account gets each pool's new sessions.
 * - `PATCH /api/accounts/:id` changes an account's label, priority or enabled,
 *   or has it share another account's priority.
 * - `DELETE /api/accounts/:id` removes an account and its limit windows; its
 *   usage stays, under the name the account had.
 * - `POST /api/accounts/:id/limit-resets/:resetId/redeem` redeems one of the
 *   account's limit resets, and answers how it went: `redeemed`, `refused`
 *   (nothing spent) with a reason, or `unknown`, each with a message and
 *   the account's limits read after it.
 * - `POST /api/logins` starts a login; `GET /api/logins/:id` polls it.
 * - `POST /api/logins/:id/callback` finishes it with a pasted callback URL.
 * - `DELETE /api/logins/:id` cancels it.
 */

const pathId = Effect.map(HttpRouter.params, (params) => params["id"] ?? "")
const pathResetId = Effect.map(HttpRouter.params, (params) => params["resetId"] ?? "")

const badRequest = (expected: string) => () =>
  Effect.succeed(apiError(400, `Expected a JSON body ${expected}.`))

const startLoginShape = '{ "provider": "claude" | "codex", "label"?: string }'

const updateAccountShape =
  '{ "label"?: string, "priority"?: integer, "sharePriorityWith"?: string, "enabled"?: boolean }, with at most one of "priority" and "sharePriorityWith"'

/** Adds the routes to `router`, each served only to clients `localOnly` lets through. */
export const accountRoutes = (router: HttpRouter.HttpRouter, localOnly: LocalOnly) =>
  Effect.all([
    router.add(
      "GET",
      "/api/accounts",
      localOnly(
        Effect.gen(function* () {
          const accounts = yield* (yield* AccountStore).list
          const routing = yield* (yield* Router).view
          const limits = yield* LimitWindows
          const now = yield* Clock.currentTimeMillis
          return HttpServerResponse.jsonUnsafe(
            toAccountListing(
              accounts,
              routing,
              (account) => limits.report(account.id, now).limitResets,
            ),
          )
        }).pipe(
          Effect.catchTag("AccountStoreError", (error) =>
            Effect.succeed(apiError(500, error.message)),
          ),
        ),
      ),
    ),
    router.add(
      "PATCH",
      "/api/accounts/:id",
      localOnly(
        Effect.gen(function* () {
          const settings = yield* HttpServerRequest.schemaBodyJson(UpdateAccount)
          const account = yield* (yield* AccountStore).updateSettings(yield* pathId, settings)
          const routing = yield* (yield* Router).view
          return HttpServerResponse.jsonUnsafe(toAccountView(account, routing))
        }).pipe(
          Effect.catchTags({
            SchemaError: badRequest(updateAccountShape),
            HttpServerError: badRequest(updateAccountShape),
            AccountNotFound: (error) => Effect.succeed(apiError(404, error.message)),
            PriorityOutOfRange: (error) => Effect.succeed(apiError(400, error.message)),
            CannotSharePriority: (error) => Effect.succeed(apiError(400, error.message)),
            AccountStoreError: (error) => Effect.succeed(apiError(500, error.message)),
          }),
        ),
      ),
    ),
    router.add(
      "DELETE",
      "/api/accounts/:id",
      localOnly(
        Effect.gen(function* () {
          const account = yield* (yield* AccountStore).remove(yield* pathId)
          yield* (yield* LimitWindows).forget(account.id)
          // Its usage stays, under the name it had when removed.
          yield* (yield* UsageStore)
            .rememberRemoved(account, yield* Clock.currentTimeMillis)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("could not remember a removed account's name").pipe(
                  Effect.annotateLogs({ account: account.id, cause: error.message }),
                ),
              ),
            )
          const routing = yield* (yield* Router).view
          return HttpServerResponse.jsonUnsafe(toAccountView(account, routing))
        }).pipe(
          Effect.catchTags({
            AccountNotFound: (error) => Effect.succeed(apiError(404, error.message)),
            AccountStoreError: (error) => Effect.succeed(apiError(500, error.message)),
          }),
        ),
      ),
    ),
    router.add(
      "POST",
      "/api/accounts/:id/limit-resets/:resetId/redeem",
      localOnly(
        Effect.gen(function* () {
          const result = yield* (yield* Redeemer).redeem(yield* pathId, yield* pathResetId)
          return HttpServerResponse.jsonUnsafe(result)
        }).pipe(
          Effect.catchTags({
            AccountNotFound: (error) => Effect.succeed(apiError(404, error.message)),
            LimitResetNotFound: (error) => Effect.succeed(apiError(404, error.message)),
            RedeemNeedsSignIn: (error) => Effect.succeed(apiError(409, error.message)),
            AccountStoreError: (error) => Effect.succeed(apiError(500, error.message)),
          }),
        ),
      ),
    ),
    router.add(
      "POST",
      "/api/logins",
      localOnly(
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(StartLogin)
          const login = yield* (yield* Logins).start(body)
          return HttpServerResponse.jsonUnsafe(login, { status: 201 })
        }).pipe(
          Effect.catchTags({
            SchemaError: badRequest(startLoginShape),
            HttpServerError: badRequest(startLoginShape),
            LoginStartError: (error) => Effect.succeed(apiError(409, error.message)),
          }),
        ),
      ),
    ),
    router.add(
      "GET",
      "/api/logins/:id",
      localOnly(
        Effect.gen(function* () {
          const login = yield* (yield* Logins).get(yield* pathId)
          return HttpServerResponse.jsonUnsafe(login)
        }).pipe(
          Effect.catchTag("LoginNotFound", (error) => Effect.succeed(apiError(404, error.message))),
        ),
      ),
    ),
    router.add(
      "POST",
      "/api/logins/:id/callback",
      localOnly(
        Effect.gen(function* () {
          const { url } = yield* HttpServerRequest.schemaBodyJson(SubmitCallback)
          const login = yield* (yield* Logins).submitCallback(yield* pathId, url)
          return HttpServerResponse.jsonUnsafe(login)
        }).pipe(
          Effect.catchTags({
            SchemaError: badRequest('{ "url": string }'),
            HttpServerError: badRequest('{ "url": string }'),
            LoginNotFound: (error) => Effect.succeed(apiError(404, error.message)),
            CallbackRejected: (error) => Effect.succeed(apiError(400, error.message)),
          }),
        ),
      ),
    ),
    router.add(
      "DELETE",
      "/api/logins/:id",
      localOnly(
        Effect.gen(function* () {
          const login = yield* (yield* Logins).cancel(yield* pathId)
          return HttpServerResponse.jsonUnsafe(login)
        }).pipe(
          Effect.catchTag("LoginNotFound", (error) => Effect.succeed(apiError(404, error.message))),
        ),
      ),
    ),
  ])
