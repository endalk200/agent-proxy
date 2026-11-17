import { Data, type Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

import { resolveStateDir } from "../paths.ts"
import { AccountList, ApiError, LoginView, type StartLogin } from "./api.ts"
import { readStateFile } from "./state.ts"

/**
 * How the CLI reaches the daemon: the state file says where it listens, and
 * everything else goes over its HTTP API. Nothing here ever starts a daemon.
 */

export class DaemonNotRunning extends Data.TaggedError("DaemonNotRunning")<{}> {
  override get message() {
    return "The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`."
  }
}

export class DaemonUnexpectedResponse extends Data.TaggedError("DaemonUnexpectedResponse")<{
  readonly address: string
  readonly cause: unknown
}> {
  override get message() {
    return `The agent-proxy daemon at ${this.address} sent an unexpected response.`
  }
}

/** The daemon understood the request and refused it, saying why. */
export class DaemonApiError extends Data.TaggedError("DaemonApiError")<{
  readonly status: number
  readonly message: string
}> {}

export const DaemonInfo = Schema.Struct({
  pid: Schema.Int,
  address: Schema.String,
  version: Schema.String,
  startedAt: Schema.String,
  uptimeSeconds: Schema.Finite,
})
export type DaemonInfo = typeof DaemonInfo.Type

/** How long the CLI waits for a daemon on this machine before calling it not running. */
const REQUEST_TIMEOUT = "2 seconds"

/** The running daemon's state file, or `DaemonNotRunning`. */
const discover = Effect.gen(function* () {
  const stateDir = yield* resolveStateDir
  const state = yield* readStateFile(stateDir)
  if (Option.isNone(state)) {
    return yield* new DaemonNotRunning()
  }
  return state.value
})

/** True when the daemon at `address` answers `/healthz` with 200. */
export const isHealthy = (address: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(`${address}/healthz`).pipe(Effect.timeout(REQUEST_TIMEOUT))
    return response.status === 200
  }).pipe(Effect.orElseSucceed(() => false))

/**
 * Asks the running daemon who it is. A missing or unreachable daemon is `DaemonNotRunning`.
 *
 * The answer must come from the daemon the state file names: after a crash, its
 * address may now belong to another state directory's daemon, which this
 * directory's commands must never report or signal.
 */
export const fetchDaemonInfo = Effect.gen(function* () {
  const state = yield* discover
  const client = yield* HttpClient.HttpClient
  const info = yield* client.get(`${state.address}/api/daemon`).pipe(
    Effect.mapError(() => new DaemonNotRunning()),
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DaemonInfo)),
        Effect.mapError((cause) => new DaemonUnexpectedResponse({ address: state.address, cause })),
      ),
    ),
    // The whole exchange, body included: a stale address may answer and then stall.
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(new DaemonNotRunning()),
    }),
  )
  if (info.pid !== state.pid) {
    return yield* new DaemonNotRunning()
  }
  return info
})

/**
 * Sends `request` to the running daemon's API and decodes the answer with
 * `schema`. A refusal with an `{ "error": … }` body is `DaemonApiError`.
 * Only the daemon the state file names is asked (see `fetchDaemonInfo`), and
 * the whole exchange, body included, must finish within `timeout`.
 */
const callApi = <A>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Decoder<A>,
  timeout: Duration.Input = REQUEST_TIMEOUT,
) =>
  Effect.gen(function* () {
    const { address } = yield* fetchDaemonInfo
    const client = yield* HttpClient.HttpClient
    const unexpected = (cause: unknown) => new DaemonUnexpectedResponse({ address, cause })
    return yield* client.execute(HttpClientRequest.prependUrl(request, address)).pipe(
      Effect.mapError(() => new DaemonNotRunning()),
      Effect.flatMap((response) =>
        response.status >= 400
          ? HttpClientResponse.schemaBodyJson(ApiError)(response).pipe(
              Effect.mapError(unexpected),
              Effect.flatMap((body) =>
                Effect.fail(new DaemonApiError({ status: response.status, message: body.error })),
              ),
            )
          : HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.mapError(unexpected)),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new DaemonNotRunning()),
      }),
    )
  })

/** Every account the daemon holds, with its status. */
export const listAccounts = callApi(HttpClientRequest.get("/api/accounts"), AccountList)

/** Starts a login in the daemon. */
export const startLogin = (body: StartLogin) =>
  callApi(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post("/api/logins"), body), LoginView)

export const getLogin = (id: string) =>
  callApi(HttpClientRequest.get(`/api/logins/${encodeURIComponent(id)}`), LoginView)

/**
 * Finishes a login with the callback URL the owner pasted. The daemon answers
 * once it has exchanged the code with the provider, which can take a while.
 */
export const submitCallback = (id: string, url: string) =>
  callApi(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`/api/logins/${encodeURIComponent(id)}/callback`),
      { url },
    ),
    LoginView,
    "60 seconds",
  )

export const cancelLogin = (id: string) =>
  callApi(HttpClientRequest.delete(`/api/logins/${encodeURIComponent(id)}`), LoginView)
