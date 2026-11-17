import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"

import { loadConfig } from "./config.ts"

/** Writes `contents` to a fresh config.toml and loads it. */
const loadFrom = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-config-" })
    const path = `${dir}/config.toml`
    yield* fs.writeFileString(path, contents)
    return { path, result: yield* Effect.result(loadConfig(path)) }
  })

const failureMessage = (contents: string) =>
  loadFrom(contents).pipe(
    Effect.map(({ path, result }) =>
      result._tag === "Failure" ? result.failure.message.replace(path, "<config>") : "loaded",
    ),
  )

layer(BunServices.layer)("loadConfig", (it) => {
  it.effect("uses the defaults when the file does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-config-" })
      const config = yield* loadConfig(`${dir}/config.toml`)
      expect(config.listen).toEqual({ host: "127.0.0.1", port: 8318 })
    }),
  )

  it.effect("uses the defaults for a file holding only comments", () =>
    Effect.gen(function* () {
      const { result } = yield* loadFrom("# nothing to change\n\n")
      expect(result._tag === "Success" && result.success.listen).toEqual({
        host: "127.0.0.1",
        port: 8318,
      })
    }),
  )

  it.effect("reads the listen address", () =>
    Effect.gen(function* () {
      const { result } = yield* loadFrom('listen = "127.0.0.1:0"\n')
      expect(result._tag === "Success" && result.success.listen).toEqual({
        host: "127.0.0.1",
        port: 0,
      })
    }),
  )

  it.effect("reads a bracketed IPv6 listen address", () =>
    Effect.gen(function* () {
      const { result } = yield* loadFrom('listen = "[::1]:9000"\n')
      expect(result._tag === "Success" && result.success.listen).toEqual({
        host: "::1",
        port: 9000,
      })
    }),
  )

  it.effect("names the line of a TOML syntax error", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(
        ["# agent-proxy", 'listen = "127.0.0.1:8318"', "port = = 1", ""].join("\n"),
      )
      expect(message).toBe("Invalid config file <config>, line 3: Expected a value but found '='")
    }),
  )

  it.effect("names the line after a valid multi-line value", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(
        ["a = [", "  1,", "  2,", "]", "", 'listen = "x', ""].join("\n"),
      )
      expect(message).toMatch(/^Invalid config file <config>, line 6: Unterminated string/)
    }),
  )

  it.effect("rejects an unknown key, naming it and its line", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(
        ["# agent-proxy", "", 'lisen = "127.0.0.1:0"'].join("\n"),
      )
      expect(message).toBe(
        'Invalid config file <config>, line 3: unknown key "lisen" (the only key is "listen")',
      )
    }),
  )

  it.effect("rejects an unknown table, naming its header line", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(
        ['listen = "127.0.0.1:0"', "[server]", "port = 1"].join("\n"),
      )
      expect(message).toBe(
        'Invalid config file <config>, line 2: unknown key "server" (the only key is "listen")',
      )
    }),
  )

  it.effect("rejects a listen address without a port, naming its line", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage(["", 'listen = "localhost"'].join("\n"))
      expect(message).toBe(
        'Invalid config file <config>, line 2: listen must be a "host:port" string, such as "127.0.0.1:8318"',
      )
    }),
  )

  it.effect("rejects a listen address that is not a string", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage("listen = 8318")
      expect(message).toBe(
        'Invalid config file <config>, line 1: listen must be a "host:port" string, such as "127.0.0.1:8318"',
      )
    }),
  )

  it.effect("rejects a port above 65535", () =>
    Effect.gen(function* () {
      const message = yield* failureMessage('listen = "127.0.0.1:70000"')
      expect(message).toMatch(/line 1: listen must be a "host:port" string/)
    }),
  )
})
