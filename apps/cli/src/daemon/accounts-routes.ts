import { Clock, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { Router } from "../accounts/router.ts"
import { AccountStore } from "../accounts/store.ts"
import { Logins } from "../logins/logins.ts"
import { LimitWindows } from "../usage/limit-windows.ts"
import { UsageStore } from "../usage/store.ts"
import { StartLogin, SubmitCallback, toAccountList, toAccountView, UpdateAccount } from "./api.ts"
import { apiError, type LocalOnly } from "./http.ts"

/**
 * The daemon API's account and login operations:
 *
 * - `GET /api/accounts` lists accounts with their status, and which account
 *   gets each pool's new sessions.
 * - `PATCH /api/accounts/:id` changes an account's label, priority or enabled.
 * - `DELETE /api/accounts/:id` removes an account and its limit windows; its
 *   usage stays, under the name the account had.
 * - `POST /api/logins` starts a login; `GET /api/logins/:id` polls it.
 * - `POST /api/logins/:id/callback` finishes it with a pasted callback URL.
 * - `DELETE /api/logins/:id` cancels it.
 */

const pathId = Effect.map(HttpRouter.params, (params) => params["id"] ?? "")

const badRequest = (expected: string) => () =>
  Effect.succeed(apiError(400, `Expected a JSON body ${expected}.`))

const startLoginShape = '{ "provider": "claude" | "codex", "label"?: string }'

const updateAccountShape = '{ "label"?: string, "priority"?: integer, "enabled"?: boolean }'

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
          return HttpServerResponse.jsonUnsafe(toAccountList(accounts, routing))
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
