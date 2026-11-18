import { expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"

import { buildLabel, RuntimeInfo, versionText } from "./runtime-info.ts"

it.effect("takes the real home from the OS user record, whatever HOME says", () =>
  Effect.gen(function* () {
    // The test runs as the developer or CI user, whose HOME is their real home.
    const real = process.env["HOME"]
    process.env["HOME"] = "/tmp/agent-proxy-not-home"
    try {
      const info = Context.get(
        yield* Effect.scoped(Layer.build(RuntimeInfo.layerProcess)),
        RuntimeInfo,
      )
      expect(info.realHome).toStrictEqual(Option.some(real))
    } finally {
      process.env["HOME"] = real
    }
  }),
)

it("names the build: its commit, marked when the tree had changes, or source", () => {
  expect(buildLabel(Option.some({ commit: "abc1234", dirty: false }))).toBe("abc1234")
  expect(buildLabel(Option.some({ commit: "abc1234", dirty: true }))).toBe("abc1234-dirty")
  expect(buildLabel(Option.none())).toBe("source")
  expect(versionText(Option.none())).toMatch(/^\d+\.\d+\.\d+ \(source\)$/)
})
