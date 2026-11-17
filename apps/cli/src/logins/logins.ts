import { randomBytes } from "node:crypto"

import { BunHttpServer } from "@effect/platform-bun"
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"

import type { Provider } from "../accounts/account.ts"
import { Router, type RoutingView } from "../accounts/router.ts"
import { AccountStore, type AccountStoreError, type Upserted } from "../accounts/store.ts"
import { type LoginView, toAccountView } from "../daemon/api.ts"
import { ClaudeLogin } from "../providers/claude.ts"
import { CodexLogin } from "../providers/codex.ts"
import { type LoginAdapter, makePkce, ProviderLoginError } from "../providers/provider.ts"

/**
 * The logins the daemon runs to add or sign in again to accounts (ADR-0007).
 *
 * A login listens on the provider's loopback callback port until the owner's
 * browser is redirected there, or until the owner pastes the URL it was
 * redirected to. It then exchanges the code, stores the account, and stops
 * listening. Cancelling it or letting it time out stores nothing and stops
 * listening too. Logins live in memory only.
 */

/** How long a login waits for the owner to sign in. */
export const LOGIN_TIMEOUT = "10 minutes"

/** How long a finished login can still be looked up. */
const FINISHED_RETENTION_MS = 10 * 60 * 1000

export class LoginNotFound extends Data.TaggedError("LoginNotFound")<{ readonly id: string }> {
  override get message() {
    return `No login ${this.id}. It may have finished more than 10 minutes ago.`
  }
}

export class LoginStartError extends Data.TaggedError("LoginStartError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** A pasted or delivered callback URL that cannot finish this login. The login keeps waiting. */
export class CallbackRejected extends Data.TaggedError("CallbackRejected")<{
  readonly message: string
}> {}

/** What the provider's redirect carried. */
type Callback =
  | { readonly _tag: "Code"; readonly code: string }
  | { readonly _tag: "Denied"; readonly reason: string }

interface Login {
  readonly view: Ref.Ref<LoginView>
  readonly finishedAt: Ref.Ref<Option.Option<number>>
  readonly oauthState: string
  readonly callback: Deferred.Deferred<Callback>
  readonly done: Deferred.Deferred<void>
}

/** Reads a callback URL the way the provider's redirect delivers it. */
const parseCallback = (
  adapter: LoginAdapter,
  text: string,
  oauthState: string,
): Effect.Effect<Callback, CallbackRejected> => {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return Effect.fail(
      new CallbackRejected({
        message: "That is not a URL. Paste the whole address from the browser's address bar.",
      }),
    )
  }
  const params = url.searchParams
  if (params.get("state") !== oauthState) {
    return Effect.fail(
      new CallbackRejected({
        message: `That URL belongs to another ${adapter.name} sign-in, not the one in progress.`,
      }),
    )
  }
  const error = params.get("error")
  if (error !== null) {
    return Effect.succeed({ _tag: "Denied", reason: params.get("error_description") ?? error })
  }
  const code = params.get("code")
  if (code === null || code === "") {
    return Effect.fail(
      new CallbackRejected({ message: "That URL has no authorization code in it." }),
    )
  }
  return Effect.succeed({ _tag: "Code", code })
}

/** How a login's flow ended, as the login reports it. */
const outcome = (
  exit: Exit.Exit<Upserted, Cause.TimeoutError | ProviderLoginError | AccountStoreError>,
  routing: RoutingView,
): Partial<LoginView> => {
  if (Exit.isSuccess(exit)) {
    return {
      status: "succeeded",
      account: toAccountView(exit.value.account, routing),
      created: exit.value.created,
    }
  }
  if (Cause.hasInterrupts(exit.cause)) return { status: "cancelled" }
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isNone(error)) return { status: "failed", error: "The sign-in failed unexpectedly." }
  return error.value._tag === "TimeoutError"
    ? { status: "expired" }
    : { status: "failed", error: error.value.message }
}

const escapeHtml = (text: string) =>
  text.replaceAll(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`)

/** The page the owner's browser shows after the redirect. */
const callbackPage = (status: number, title: string, detail: string) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><title>agent-proxy</title>` +
      `<body style="font:15px system-ui,sans-serif;margin:4rem auto;max-width:32rem">` +
      `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`,
    { status, contentType: "text/html; charset=utf-8" },
  )

export class Logins extends Context.Service<
  Logins,
  {
    /**
     * Starts a login for `provider`, listening on its callback port. A login
     * for the same provider that is still waiting is cancelled first, since
     * both need the port.
     */
    readonly start: (options: {
      readonly provider: Provider
      readonly label?: string | undefined
    }) => Effect.Effect<LoginView, LoginStartError>
    readonly get: (id: string) => Effect.Effect<LoginView, LoginNotFound>
    /** Finishes a login with a pasted callback URL, and returns how it ended. */
    readonly submitCallback: (
      id: string,
      url: string,
    ) => Effect.Effect<LoginView, LoginNotFound | CallbackRejected>
    /** Cancels a waiting login. A finished login is left as it ended. */
    readonly cancel: (id: string) => Effect.Effect<LoginView, LoginNotFound>
  }
>()("agent-proxy/Logins") {
  static readonly layer = Layer.effect(
    Logins,
    Effect.gen(function* () {
      const store = yield* AccountStore
      const router = yield* Router
      const adapters: Readonly<Record<Provider, LoginAdapter>> = {
        claude: yield* ClaudeLogin,
        codex: yield* CodexLogin,
      }
      const logins = yield* Ref.make(new Map<string, Login>())
      const flows = yield* FiberMap.make<string>()

      const lookup = (id: string) =>
        Effect.flatMap(Ref.get(logins), (all) => {
          const login = all.get(id)
          return login === undefined
            ? Effect.fail(new LoginNotFound({ id }))
            : Effect.succeed(login)
        })

      /** Forgets logins that finished long enough ago. */
      const prune = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [id, login] of yield* Ref.get(logins)) {
          const finishedAt = yield* Ref.get(login.finishedAt)
          if (Option.exists(finishedAt, (at) => now - at > FINISHED_RETENTION_MS)) {
            yield* Ref.update(logins, (all) => {
              const next = new Map(all)
              next.delete(id)
              return next
            })
          }
        }
      })

      /** Hands the callback to the login, then waits for it to finish. */
      const deliver = (login: Login, adapter: LoginAdapter, url: string) =>
        Effect.gen(function* () {
          const callback = yield* parseCallback(adapter, url, login.oauthState)
          yield* Deferred.succeed(login.callback, callback)
          yield* Deferred.await(login.done)
          return yield* Ref.get(login.view)
        })

      /** The callback listener's handler: what the owner's browser lands on. */
      const callbackHandler = (login: Login, adapter: LoginAdapter) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://localhost")
          if (url.pathname !== new URL(adapter.redirectUri(adapter.callbackPort)).pathname) {
            return callbackPage(404, "Not found", "This address only receives sign-in redirects.")
          }
          const view = yield* deliver(login, adapter, url.toString())
          return view.status === "succeeded" && view.account !== undefined
            ? callbackPage(
                200,
                `Signed in to ${adapter.name}`,
                `agent-proxy now holds ${view.account.email} (${view.account.plan}). You can close this tab.`,
              )
            : callbackPage(
                400,
                `${adapter.name} sign-in did not finish`,
                view.error ?? `The sign-in was ${view.status}.`,
              )
        }).pipe(
          Effect.catchTag("CallbackRejected", (rejected) =>
            Effect.succeed(callbackPage(400, `${adapter.name} sign-in`, rejected.message)),
          ),
        )

      /** Binds the callback listener in `scope` and returns the port it got. */
      const listen = (login: Login, adapter: LoginAdapter, scope: Scope.Scope) => {
        // Bun throws when it cannot bind, so that defect becomes a message naming the port.
        const cannotListen = (cause: unknown) =>
          new LoginStartError({
            message: `Could not listen on 127.0.0.1:${adapter.callbackPort} for the ${adapter.name} sign-in redirect: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          })
        return Effect.gen(function* () {
          const server = yield* BunHttpServer.make({
            hostname: "127.0.0.1",
            port: adapter.callbackPort,
            gracefulShutdownTimeout: "1 second",
          }).pipe(
            Effect.mapError((error) => cannotListen(error.cause)),
            Effect.catchDefect((defect) => Effect.fail(cannotListen(defect))),
          )
          yield* HttpServer.serveEffect()(callbackHandler(login, adapter)).pipe(
            Effect.provideService(HttpServer.HttpServer, server),
          )
          return "port" in server.address ? server.address.port : adapter.callbackPort
        }).pipe(Scope.provide(scope))
      }

      const cancelWaiting = (provider: Provider) =>
        Effect.gen(function* () {
          for (const [id, login] of yield* Ref.get(logins)) {
            const view = yield* Ref.get(login.view)
            if (view.provider === provider && view.status === "pending") {
              yield* FiberMap.remove(flows, id)
              yield* Deferred.await(login.done)
            }
          }
        })

      const start = Effect.fn("Logins.start")(function* (options: {
        readonly provider: Provider
        readonly label?: string | undefined
      }) {
        const adapter = adapters[options.provider]
        yield* prune
        yield* cancelWaiting(options.provider)

        const pkce = yield* makePkce
        const id = randomBytes(8).toString("hex")
        const login: Login = {
          view: yield* Ref.make<LoginView>({
            id,
            provider: options.provider,
            authorizeUrl: "",
            status: "pending",
          }),
          finishedAt: yield* Ref.make(Option.none<number>()),
          oauthState: pkce.state,
          callback: yield* Deferred.make<Callback>(),
          done: yield* Deferred.make<void>(),
        }

        // From binding the port to handing it to the flow, nothing may interrupt
        // `start`, or the port would stay bound with nothing to release it.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const listener = yield* Scope.make()
            const port = yield* listen(login, adapter, listener).pipe(
              Effect.tapError(() => Scope.close(listener, Exit.void)),
            )
            const redirectUri = adapter.redirectUri(port)
            const authorizeUrl = adapter.authorizeUrl({
              redirectUri,
              state: pkce.state,
              codeChallenge: pkce.codeChallenge,
            })
            yield* Ref.update(login.view, (view) => ({ ...view, authorizeUrl }))
            yield* Ref.update(logins, (all) => new Map(all).set(id, login))

            const flow = Effect.gen(function* () {
              const callback = yield* Deferred.await(login.callback).pipe(
                Effect.timeout(LOGIN_TIMEOUT),
              )
              if (callback._tag === "Denied") {
                return yield* new ProviderLoginError({
                  message: `${adapter.name} did not grant access: ${callback.reason}`,
                })
              }
              const signedIn = yield* adapter.exchange({
                code: callback.code,
                state: pkce.state,
                redirectUri,
                codeVerifier: pkce.codeVerifier,
              })
              // Once saving starts it finishes: a cancel arriving mid-write
              // must not report "cancelled" for an account that was saved.
              return yield* Effect.uninterruptible(
                store.upsert(signedIn.identity, signedIn.credentials, { label: options.label }),
              )
            })

            yield* FiberMap.run(
              flows,
              id,
              flow.pipe(
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    const ended = outcome(exit, yield* router.view)
                    yield* Effect.logInfo("login finished").pipe(
                      Effect.annotateLogs({
                        login: id,
                        provider: options.provider,
                        status: ended.status,
                        ...(ended.error === undefined ? {} : { error: ended.error }),
                        ...(ended.account === undefined
                          ? {}
                          : { account: ended.account.id, created: ended.created }),
                      }),
                    )
                    yield* Ref.update(login.view, (view) => ({ ...view, ...ended }))
                    yield* Ref.set(login.finishedAt, Option.some(yield* Clock.currentTimeMillis))
                    yield* Deferred.succeed(login.done, undefined)
                  }),
                ),
                Effect.ensuring(Scope.close(listener, Exit.void)),
              ),
            )
            yield* Effect.logInfo("login started").pipe(
              Effect.annotateLogs({ login: id, provider: options.provider, redirectUri }),
            )
            return yield* Ref.get(login.view)
          }),
        )
      })

      const get = (id: string) => Effect.flatMap(lookup(id), (login) => Ref.get(login.view))

      const submitCallback = Effect.fn("Logins.submitCallback")(function* (
        id: string,
        url: string,
      ) {
        const login = yield* lookup(id)
        const view = yield* Ref.get(login.view)
        if (view.status !== "pending") return view
        return yield* deliver(login, adapters[view.provider], url)
      })

      const cancel = Effect.fn("Logins.cancel")(function* (id: string) {
        const login = yield* lookup(id)
        yield* FiberMap.remove(flows, id)
        yield* Deferred.await(login.done)
        return yield* Ref.get(login.view)
      })

      return Logins.of({ start, get, submitCallback, cancel })
    }),
  )
}
