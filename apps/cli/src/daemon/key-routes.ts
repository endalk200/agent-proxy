import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

import { ProxyKey } from "../proxy/proxy-key.ts"
import type { ProxyKeyView } from "./api.ts"
import { apiError, type LocalOnly } from "./http.ts"

/**
 * The daemon API's proxy key operations:
 *
 * - `GET /api/key` returns the key.
 * - `POST /api/key/rotate` replaces it and returns the new key; the old one
 *   stops working with the next proxy request.
 */

const keyResponse = (key: string) => {
  const view: ProxyKeyView = { key }
  return HttpServerResponse.jsonUnsafe(view)
}

export const keyRoutes = (router: HttpRouter.HttpRouter, localOnly: LocalOnly) =>
  Effect.all([
    router.add(
      "GET",
      "/api/key",
      localOnly(
        Effect.map(
          Effect.flatMap(ProxyKey, (proxyKey) => proxyKey.current),
          keyResponse,
        ),
      ),
    ),
    router.add(
      "POST",
      "/api/key/rotate",
      localOnly(
        Effect.flatMap(ProxyKey, (proxyKey) => proxyKey.rotate).pipe(
          Effect.map(keyResponse),
          Effect.catchTag("ProxyKeyError", (error) => Effect.succeed(apiError(500, error.message))),
        ),
      ),
    ),
  ])
