import { BunHttpServer } from "@effect/platform-bun"
import { Clock, Data, DateTime, Effect, FileSystem, Layer, Logger, Option } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"

import packageJson from "../../package.json" with { type: "json" }
import { type ListenAddress, loadConfigFile } from "../config.ts"
import { resolveStateDir } from "../paths.ts"
import { Processes } from "../processes.ts"
import { acquireLock, removeStateFile, stateFiles, writeStateFile } from "./state.ts"

/**
 * The daemon: one HTTP listener that serves agent-proxy, meeting ADR-0002.
 *
 * It only reports its own health and identity so far; the proxy routes, the
 * account API, and the dashboard join this listener as they are built.
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

/** In-flight requests get this long to finish once shutdown starts. */
const GRACEFUL_SHUTDOWN = "5 seconds"

const isLoopback = (ip: string) =>
  ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")

/**
 * True when a peer at `ip` is this machine: a loopback address, or the
 * non-loopback address the daemon listens on, which only this machine can
 * connect from (a client on this machine reaching that address arrives from it).
 */
const isThisMachine = (ip: string, listenHost: string) =>
  isLoopback(ip) || ip === listenHost || ip === `::ffff:${listenHost}`

/** The URL a client on this machine uses to reach `host:port`. */
const clientAddress = (host: string, port: number) => {
  const reachable = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host
  return `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`
}

const notLoopback = HttpServerResponse.jsonUnsafe(
  { error: "The daemon API is served to clients on this machine only." },
  { status: 403 },
)

/**
 * Serves `handler` only to clients on this machine: until remote access is
 * designed, the daemon API is local.
 */
const localOnly =
  (listenHost: string) =>
  <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Option.exists(request.peerAddress, (ip) => isThisMachine(ip, listenHost))
        ? handler
        : Effect.succeed(notLoopback),
    )

const routes = (info: {
  readonly pid: number
  readonly address: string
  readonly listenHost: string
  readonly startedAt: DateTime.Utc
}) =>
  HttpRouter.use((router) =>
    Effect.all([
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

  const { path: configPath, config } = yield* loadConfigFile
  yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 })
  const fileLogger = yield* Logger.toFile(Logger.formatJson, files.log)
  const logToFile = Effect.provideService(Logger.CurrentLoggers, new Set([fileLogger]))

  return yield* Effect.gen(function* () {
    yield* acquireLock(stateDir, pid)

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

    yield* Layer.build(
      HttpRouter.serve(routes({ pid, address, listenHost: config.listen.host, startedAt }), {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(Layer.provide(Layer.succeed(HttpServer.HttpServer, server))),
    ).pipe(logToFile)

    yield* writeStateFile(stateDir, { pid, port, address })
    yield* Effect.logInfo("daemon started").pipe(
      Effect.annotateLogs({ pid, address, version: packageJson.version, config: configPath }),
      logToFile,
    )

    const daemon: RunningDaemon = { pid, port, address }
    return daemon
  }).pipe(
    // `daemon start` reads this line to tell the owner why its daemon exited.
    Effect.tapError((error) =>
      Effect.logError("daemon failed to start").pipe(
        Effect.annotateLogs({ error: error.message }),
        logToFile,
      ),
    ),
  )
})
