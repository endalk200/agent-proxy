#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Layer, Runtime } from "effect"
import { FetchHttpClient } from "effect/http"

import { main } from "./cli.ts"
import { Processes } from "./processes.ts"
import { RuntimeInfo } from "./runtime-info.ts"

// The process entry point: it provides the real platform services, so tests
// can swap in other layers for everything below it.

// SIGTERM is a request for a clean shutdown (ADR-0002): the runtime interrupts
// the command, its finalizers run, and the process exits 0 rather than the 130
// an interrupt reports. SIGINT (Ctrl-C) keeps 130.
let terminated = false
process.on("SIGTERM", () => {
  terminated = true
})

const teardown: Runtime.Teardown = (exit, onExit) =>
  terminated && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
    ? onExit(0)
    : Runtime.defaultTeardown(exit, onExit)

main.pipe(
  Effect.provide(
    Layer.mergeAll(
      BunServices.layer,
      RuntimeInfo.layerProcess,
      Processes.layerProcess,
      FetchHttpClient.layer,
    ),
  ),
  BunRuntime.runMain({ teardown }),
)
