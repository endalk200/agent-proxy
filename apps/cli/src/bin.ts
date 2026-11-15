#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { main } from "./cli.ts"
import { RuntimeInfo } from "./runtime-info.ts"

// The only module that knows the CLI runs on Bun. Everything else depends on
// Effect's platform-agnostic services, so tests can swap in other layers.
main.pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, RuntimeInfo.layerProcess)),
  BunRuntime.runMain,
)
