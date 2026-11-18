import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import { FetchHttpClient } from "effect/http"

import { Browser } from "./browser.ts"
import { main } from "./cli.ts"
import { Dashboard, type DashboardSource } from "./daemon/dashboard.ts"
import { Launchd } from "./launchd.ts"
import { Processes } from "./processes.ts"
import { ProviderEndpoints } from "./providers/endpoints.ts"
import { type RuntimeInfo } from "./runtime-info.ts"

/**
 * Runs the CLI as this process, with the real platform services, so tests can
 * swap in other layers for everything below it. Two entry points call it:
 * `bin.ts` from source, and the compiled binary's generated entry (see
 * `scripts/build.ts`), each saying how this process runs again and where the
 * dashboard's build is.
 */
export const runProcess = (options: {
  readonly runtimeInfo: Layer.Layer<RuntimeInfo>
  /** How to run this CLI again: the executable and the arguments before the CLI's own. */
  readonly self: { readonly command: string; readonly args: ReadonlyArray<string> }
  readonly dashboard: DashboardSource
}) => {
  // SIGTERM is a request for a clean shutdown (ADR-0002): the runtime
  // interrupts the command, its finalizers run, and the process exits 0
  // rather than the 130 an interrupt reports. SIGINT (Ctrl-C) keeps 130.
  let terminated = false
  process.on("SIGTERM", () => {
    terminated = true
  })

  const teardown: Runtime.Teardown = (exit, onExit) =>
    terminated && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? onExit(0)
      : Runtime.defaultTeardown(exit, onExit)

  main.pipe(
    Effect.provideService(Dashboard, options.dashboard),
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        options.runtimeInfo,
        Processes.layer(options.self),
        Launchd.layer.pipe(Layer.provide(BunServices.layer)),
        FetchHttpClient.layer,
        ProviderEndpoints.layer,
        Browser.layerSystem.pipe(Layer.provide(BunServices.layer)),
      ),
    ),
    BunRuntime.runMain({ teardown }),
  )
}
