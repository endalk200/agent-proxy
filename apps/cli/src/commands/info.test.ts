import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Path } from "effect"

import { RuntimeInfo } from "../runtime-info.ts"
import { formatInfo, gatherInfo, type Info } from "./info.ts"

const info: Info = {
  version: "1.2.3",
  build: "abc1234-dirty",
  runtime: "bun",
  runtimeVersion: "1.4.4",
  platform: "linux",
  arch: "x64",
  configPath: "/home/me/.config/agent-proxy/config.toml",
}

const TestEnvironment = Layer.mergeAll(
  Path.layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/me" })),
  Layer.succeed(RuntimeInfo, {
    runtime: "bun",
    runtimeVersion: "1.4.4",
    platform: "linux",
    arch: "x64",
    binary: Option.none(),
    realHome: Option.some("/home/me"),
  }),
)

layer(TestEnvironment)("info command", (it) => {
  it.effect("gatherInfo combines runtime facts with the resolved config path", () =>
    Effect.gen(function* () {
      const gathered = yield* gatherInfo
      expect(gathered).toMatchObject({
        runtime: "bun",
        runtimeVersion: "1.4.4",
        platform: "linux",
        arch: "x64",
        configPath: "/home/me/.config/agent-proxy/config.toml",
        build: "source",
      })
      expect(gathered.version).toMatch(/^\d+\.\d+\.\d+/)
    }),
  )

  it("formatInfo renders aligned human-readable lines", () => {
    expect(formatInfo(info, { json: false })).toBe(
      [
        "agent-proxy 1.2.3 (abc1234-dirty)",
        "runtime   bun 1.4.4",
        "platform  linux-x64",
        "config    /home/me/.config/agent-proxy/config.toml",
      ].join("\n"),
    )
  })

  it("formatInfo renders JSON that round-trips to the same data", () => {
    expect(JSON.parse(formatInfo(info, { json: true }))).toEqual(info)
  })
})
