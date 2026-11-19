import { BunHttpServer } from "@effect/platform-bun"
import {
  Clock,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
} from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"

import packageJson from "../../package.json" with { type: "json" }
import { AccountChanges } from "../accounts/changes.ts"
import { CredentialKeeper } from "../accounts/keeper.ts"
import { Router } from "../accounts/router.ts"
import { AccountStore } from "../accounts/store.ts"
import { type ListenAddress, loadConfigFile } from "../config.ts"
import { isSupervised } from "../launchd.ts"
import { Logins } from "../logins/logins.ts"
import { resolveDataDir, resolveStateDir } from "../paths.ts"
import { Processes } from "../processes.ts"
import { ClaudeApi } from "../providers/claude-api.ts"
import { ClaudeLogin, ClaudeTokens } from "../providers/claude.ts"
import { CodexApi } from "../providers/codex-api.ts"
import { CodexLogin, CodexTokens } from "../providers/codex.ts"
import { claudeRoutes } from "../proxy/claude-routes.ts"
import { codexRoutes } from "../proxy/codex-routes.ts"
import { DrainLimit, InFlight, makeInFlight } from "../proxy/in-flight.ts"
import { ProxyKey } from "../proxy/proxy-key.ts"
import { buildLabel, RuntimeInfo } from "../runtime-info.ts"
import { LimitWindows } from "../usage/limit-windows.ts"
import { LimitPoller } from "../usage/poller.ts"
import { UsageStore } from "../usage/store.ts"
import { AccountEvents } from "./account-events.ts"
import { accountRoutes } from "./accounts-routes.ts"
import { dashboardRoutes } from "./dashboard.ts"
import { eventRoutes } from "./events-routes.ts"
import { localOnly } from "./http.ts"
import { keyRoutes } from "./key-routes.ts"
import { openLogFile } from "./log-file.ts"
import { acquireLock, removeStateFile, stateFiles, writeStateFile } from "./state.ts"
import { usageRoutes } from "./usage-routes.ts"

/**
 * The daemon: one HTTP listener that serves agent-proxy, meeting ADR-0002.
 *
 * It serves its health and identity, the daemon API under `/api/`, the
 * proxy's Claude and Codex routes, and the built dashboard at `/` for every
 * other GET. It records usage and keeps limit windows in its usage store.
 */

export interface RunningDaemon {
  readonly pid: number
  readonly port: number
  /** The base URL clients on this machine reach the daemon at. */
  readonly address: string
}

export class DaemonStartError extends Data.TaggedError("DaemonStartError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Requests still open once the daemon stops serving get this long to finish:
 * by then no proxied request is in flight, or the drain limit has passed.
 */
const GRACEFUL_SHUTDOWN = "5 seconds"

/** The URL a client on this machine uses to reach `host:port`. */
export const clientAddress = (host: string, port: number) => {
  const reachable = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host
  return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`
}

/** Waits, still serving, until no proxied request is in flight, and logs how the wait went. */
const drain = (inFlight: InFlight["Service"], limit: Duration.Input) =>
  Effect.gen(function* () {
    const pending = yield* inFlight.count
    if (pending === 0) return
    yield* Effect.logInfo("daemon stopping once the requests in flight finish").pipe(
      Effect.annotateLogs({
        inFlight: pending,
        atMost: Duration.format(Duration.fromInputUnsafe(limit)),
      }),
    )
    const drained = yield* inFlight.drain(limit)
    if (drained === "idle") return yield* Effect.logInfo("no request in flight; stopping")
    yield* Effect.logWarning(
      drained === "timed-out"
        ? "requests still in flight after the drain limit; stopping anyway"
        : "asked again to stop; stopping without waiting for the requests in flight",
    ).pipe(Effect.annotateLogs({ inFlight: yield* inFlight.count }))
  })

const routes = (info: {
  readonly pid: number
  readonly address: string
  readonly listenHost: string
  readonly startedAt: DateTime.Utc
  /** The build it runs, as `buildLabel` names it. */
  readonly build: string
  /** Done when the daemon starts shutting down. */
  readonly closing: Deferred.Deferred<void>
}) =>
  HttpRouter.use((router) =>
    Effect.all([
      accountRoutes(router, localOnly(info.listenHost)),
      eventRoutes(router, localOnly(info.listenHost), info.closing),
      keyRoutes(router, localOnly(info.listenHost)),
      usageRoutes(router, localOnly(info.listenHost)),
      claudeRoutes(router),
      codexRoutes(router),
      dashboardRoutes(router, localOnly(info.listenHost)),
      router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ status: "ok" })),
      router.add(
        "GET",
        "/api/daemon",
        localOnly(info.listenHost)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const uptimeMs = now - DateTime.toEpochMillis(info.startedAt)
            return HttpServerResponse.jsonUnsafe({
              pid: info.pid,
              address: info.address,
              version: packageJson.version,
              build: info.build,
              startedAt: DateTime.formatIso(info.startedAt),
              uptimeSeconds: Math.max(0, Math.floor(uptimeMs / 1000)),
            })
          }),
        ),
      ),
    ]),
  )

/** Binds `listen`. Bun throws when it cannot bind, so that defect becomes a message naming the address. */
const bind = (listen: ListenAddress) => {
  const cannotListen = (cause: unknown) =>
    new DaemonStartError({
      message: `Could not listen on ${listen.host}:${listen.port}: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    })
  return BunHttpServer.make({
    hostname: listen.host,
    port: listen.port,
    gracefulShutdownTimeout: GRACEFUL_SHUTDOWN,
    // No `idleTimeout`: Effect leaves Bun's 10-second one off, and a proxied
    // stream can go quiet for longer than that while Claude thinks.
  }).pipe(
    Effect.mapError((error) => cannotListen(error.cause)),
    Effect.catchDefect((defect) => Effect.fail(cannotListen(defect))),
  )
}

/**
 * Starts the daemon in the current scope and returns once `/healthz` answers
 * 200. Closing the scope stops accepting work, lets in-flight requests finish
 * (or cancels them after a grace period), removes the state file, and frees
 * the state directory.
 *
 * Startup order matters: config first, then the single-instance lock, then
 * the listener, and the state file last, so a reader of the state file always
 * finds a daemon that is ready.
 */
export const startDaemon = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { pid } = yield* Processes
  const stateDir = yield* resolveStateDir
  const files = stateFiles(stateDir)

  const build = buildLabel((yield* RuntimeInfo).binary)
  const supervised = yield* isSupervised

  const { path: configPath, config } = yield* loadConfigFile
  yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 })
  const logFile = yield* openLogFile(files.log)
  const logToFile = Effect.provideService(Logger.CurrentLoggers, new Set([logFile.logger]))

  return yield* Effect.gen(function* () {
    yield* acquireLock(stateDir, pid)
    yield* logFile.rotateIfFull
    // The data directory gets its own lock: two daemons with different state
    // directories must still never share accounts, or both would refresh the
    // same single-use refresh tokens and write the same files.
    const dataDir = yield* resolveDataDir
    yield* fs.makeDirectory(dataDir, { recursive: true, mode: 0o700 })
    yield* acquireLock(dataDir, pid)

    // Registered after the lock, so a refused daemon never removes another's
    // state file, and before the listener, so it runs once the listener has drained.
    yield* Effect.addFinalizer(() =>
      removeStateFile(stateDir).pipe(
        Effect.ignore,
        Effect.andThen(Effect.logInfo("daemon stopped")),
        logToFile,
      ),
    )

    const server = yield* bind(config.listen)
    const port = "port" in server.address ? server.address.port : config.listen.port
    const address = clientAddress(config.listen.host, port)
    const startedAt = yield* DateTime.now
    const closing = yield* Deferred.make<void>()
    const inFlight = makeInFlight()
    const drainLimit = yield* DrainLimit

    yield* Layer.build(
      HttpRouter.serve(
        routes({ pid, address, listenHost: config.listen.host, startedAt, build, closing }),
        {
          disableLogger: true,
          disableListenLog: true,
        },
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            LimitPoller.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(Logins.layer, CredentialKeeper.layer, AccountEvents.layer),
              ),
              Layer.provideMerge(Router.layer),
              Layer.provideMerge(LimitWindows.layer),
              Layer.provideMerge(UsageStore.layer),
              Layer.provideMerge(AccountStore.layer),
              Layer.provideMerge(AccountChanges.layer),
              Layer.provideMerge(Layer.mergeAll(ClaudeApi.layer, CodexApi.layer)),
              Layer.provide(
                Layer.mergeAll(
                  ClaudeLogin.layer,
                  ClaudeTokens.layer,
                  CodexLogin.layer,
                  CodexTokens.layer,
                ),
              ),
            ),
            ProxyKey.layer,
            Layer.succeed(InFlight, inFlight),
          ),
        ),
        Layer.provide(Layer.succeed(HttpServer.HttpServer, server)),
      ),
    ).pipe(logToFile)
    // Runs before the listener drains, so open event streams end rather than
    // holding up shutdown for the whole grace period.
    yield* Effect.addFinalizer(() => Deferred.succeed(closing, undefined))
    // Runs first of all: the daemon goes on serving, so a client mid-turn
    // finishes it and no client finds the proxy gone, until no proxied
    // request is in flight. Only then does it stop, which takes a moment.
    yield* Effect.addFinalizer(() => drain(inFlight, drainLimit).pipe(logToFile))

    yield* writeStateFile(stateDir, { pid, port, address })
    yield* Effect.logInfo("daemon started").pipe(
      Effect.annotateLogs({
        pid,
        address,
        version: packageJson.version,
        build,
        supervised,
        config: configPath,
      }),
      logToFile,
    )

    const daemon: RunningDaemon = { pid, port, address }
    return daemon
  }).pipe(
    // `daemon start` and `daemon status` read this line to tell the owner why
    // the daemon is not running. A supervised daemon refused by the lock is no
    // failure: the daemon that holds it serves.
    Effect.tapError((error) =>
      (supervised && error._tag === "DaemonAlreadyRunning"
        ? Effect.logWarning("daemon not started: another daemon is running")
        : Effect.logError("daemon failed to start")
      ).pipe(Effect.annotateLogs({ error: error.message }), logToFile),
    ),
  )
})
