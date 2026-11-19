import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

import { refreshUnanswered } from "./provider.ts"

/** How a refresh POSTed to `url` that gets no answer is judged. */
const judged = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.execute(HttpClientRequest.post(url))),
    Effect.flip,
    Effect.map(refreshUnanswered("Claude")),
  )

layer(FetchHttpClient.layer)("a refresh that got no answer", (it) => {
  it.effect("a refresh that cannot connect was never sent, so it is only unavailable", () =>
    Effect.gen(function* () {
      // Nothing listens on port 1.
      const error = yield* judged("http://127.0.0.1:1/v1/oauth/token")
      expect(error._tag).toBe("RefreshUnavailable")
    }),
  )

  it.effect("a refresh whose TLS handshake fails was never sent, so it is only unavailable", () =>
    Effect.gen(function* () {
      // A server that does not speak TLS, as a captive portal's may not.
      const plain = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("portal") }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const error = yield* judged(`https://127.0.0.1:${plain.port}/v1/oauth/token`)
      expect(error._tag).toBe("RefreshUnavailable")
      expect(error.reason).toContain("securely")
    }),
  )
})
