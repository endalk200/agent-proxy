import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { AccountStore } from "../accounts/store.ts"
import { Logins } from "../logins/logins.ts"
import { StartLogin, SubmitCallback, toAccountView } from "./api.ts"
import { apiError, type LocalOnly } from "./http.ts"

/**
 * The daemon API's account and login operations:
 *
 * - `GET /api/accounts` lists accounts with their status.
 * - `POST /api/logins` starts a login; `GET /api/logins/:id` polls it.
 * - `POST /api/logins/:id/callback` finishes it with a pasted callback URL.
 * - `DELETE /api/logins/:id` cancels it.
 */

const loginId = Effect.map(HttpRouter.params, (params) => params["id"] ?? "")

const badRequest = (expected: string) => () =>
  Effect.succeed(apiError(400, `Expected a JSON body ${expected}.`))

/** Adds the routes to `router`, each served only to clients `localOnly` lets through. */
export const accountRoutes = (router: HttpRouter.HttpRouter, localOnly: LocalOnly) =>
  Effect.all([
    router.add(
      "GET",
      "/api/accounts",
      localOnly(
        Effect.gen(function* () {
          const accounts = yield* (yield* AccountStore).list
          return HttpServerResponse.jsonUnsafe({ accounts: accounts.map(toAccountView) })
        }).pipe(
          Effect.catchTag("AccountStoreError", (error) =>
            Effect.succeed(apiError(500, error.message)),
          ),
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
            SchemaError: badRequest('{ "provider": "claude", "label"?: string }'),
            HttpServerError: badRequest('{ "provider": "claude", "label"?: string }'),
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
          const login = yield* (yield* Logins).get(yield* loginId)
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
          const login = yield* (yield* Logins).submitCallback(yield* loginId, url)
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
          const login = yield* (yield* Logins).cancel(yield* loginId)
          return HttpServerResponse.jsonUnsafe(login)
        }).pipe(
          Effect.catchTag("LoginNotFound", (error) => Effect.succeed(apiError(404, error.message))),
        ),
      ),
    ),
  ])
