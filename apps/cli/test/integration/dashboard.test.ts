import { request } from "node:http"

import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

import { startDaemon } from "../../src/daemon/daemon.ts"
import { Dashboard, type DashboardSource } from "../../src/daemon/dashboard.ts"
import { Processes } from "../../src/processes.ts"
import { ProviderEndpoints } from "../../src/providers/endpoints.ts"
import { RuntimeInfo } from "../../src/runtime-info.ts"

// The daemon serves the built dashboard at `/` on its one listener, beside
// `/api/` and the proxy routes. A temporary directory stands in for the build.

const INDEX = "<!doctype html><title>agent-proxy</title><div id=root></div>"
const SCRIPT = "console.log('dashboard')"

/** A daemon in a throwaway home that finds the dashboard in `source` (`built` is a fake build). */
const makeDaemon = (source: (built: string) => ReadonlyArray<string> | DashboardSource) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-dashboard-" })
    const built = `${root}/web`
    yield* fs.makeDirectory(`${built}/assets`, { recursive: true })
    yield* fs.writeFileString(`${built}/index.html`, INDEX)
    yield* fs.writeFileString(`${built}/assets/index-abc123.js`, SCRIPT)
    yield* fs.writeFileString(`${root}/secret.txt`, "not part of the dashboard")
    yield* fs.makeDirectory(`${root}/config/agent-proxy`, { recursive: true })
    yield* fs.writeFileString(`${root}/config/agent-proxy/config.toml`, 'listen = "127.0.0.1:0"\n')
    const env = {
      HOME: `${root}/home`,
      XDG_CONFIG_HOME: `${root}/config`,
      XDG_STATE_HOME: `${root}/state`,
      XDG_DATA_HOME: `${root}/data`,
    }
    return yield* startDaemon.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
      Effect.provideService(
        Dashboard,
        ((given) => ("_tag" in given ? given : { _tag: "Directories", dirs: given }))(
          source(built),
        ),
      ),
    )
  })

const get = (url: string) =>
  Effect.gen(function* () {
    const response = yield* (yield* HttpClient.HttpClient).get(url)
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      cacheControl: response.headers["cache-control"] ?? "",
      body: yield* response.text,
    }
  })

/**
 * Sends a request with headers a browser sets and fetch cannot (Host), as a
 * page in the owner's browser would after DNS rebinding or a cross-site post.
 */
const raw = (address: string, method: string, path: string, headers: Record<string, string>) =>
  Effect.callback<{ status: number; body: string }>((resume) => {
    const url = new URL(address)
    const sent = request(
      { hostname: url.hostname, port: url.port, method, path, headers },
      (answer) => {
        let body = ""
        answer.setEncoding("utf8")
        answer.on("data", (chunk: string) => (body += chunk))
        answer.on("end", () => resume(Effect.succeed({ status: answer.statusCode ?? 0, body })))
      },
    )
    sent.on("error", (error) => resume(Effect.die(error)))
    sent.end()
  })

layer(
  Layer.mergeAll(
    BunServices.layer,
    RuntimeInfo.layerProcess,
    Processes.layerProcess,
    FetchHttpClient.layer,
    ProviderEndpoints.layer,
  ),
)("daemon dashboard", (it) => {
  it.effect("serves the dashboard's index.html at /, never cached", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [built])
      const page = yield* get(`${daemon.address}/`)
      expect(page.status).toBe(200)
      expect(page.contentType).toMatch(/^text\/html/)
      expect(page.cacheControl).toBe("no-cache")
      expect(page.body).toBe(INDEX)
    }),
  )

  it.effect("serves index.html for the dashboard's own pages, so a reload of one works", () =>
    Effect.gen(function* () {
      for (const source of [
        (built: string) => [built],
        (built: string): DashboardSource => ({
          _tag: "Embedded",
          files: { "index.html": `${built}/index.html` },
        }),
      ]) {
        const daemon = yield* makeDaemon(source)
        for (const path of ["/accounts", "/accounts?range=30d"]) {
          const page = yield* get(`${daemon.address}${path}`)
          expect({ path, status: page.status, body: page.body }).toEqual({
            path,
            status: 200,
            body: INDEX,
          })
          expect(page.contentType).toMatch(/^text\/html/)
          expect(page.cacheControl).toBe("no-cache")
        }
      }
    }),
  )

  it.effect("serves the dashboard's hashed assets with their type, cached for good", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [built])
      const script = yield* get(`${daemon.address}/assets/index-abc123.js`)
      expect(script.status).toBe(200)
      expect(script.contentType).toMatch(/^text\/javascript/)
      expect(script.cacheControl).toBe("public, max-age=31536000, immutable")
      expect(script.body).toBe(SCRIPT)
    }),
  )

  it.effect("uses the first directory that holds a build", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [`${built}/missing`, built])
      expect((yield* get(`${daemon.address}/`)).body).toBe(INDEX)
    }),
  )

  it.effect("answers 404 for files the build does not have, and for paths outside it", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [built])
      for (const path of [
        "/assets/missing.js",
        "/api/missing",
        "/assets",
        "/%2e%2e/secret.txt",
        "/assets/%2e%2e/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/%E0%A4%A",
      ]) {
        const response = yield* get(`${daemon.address}${path}`)
        expect({ path, status: response.status }).toEqual({ path, status: 404 })
        expect(response.body).not.toContain("not part of the dashboard")
      }
    }),
  )

  it.effect("serves the files embedded in the binary, and only those", () =>
    Effect.gen(function* () {
      // The compiled binary names each file of the build by where Bun put it.
      const daemon = yield* makeDaemon((built) => ({
        _tag: "Embedded",
        files: {
          "index.html": `${built}/index.html`,
          "assets/index-abc123.js": `${built}/assets/index-abc123.js`,
        },
      }))
      const page = yield* get(`${daemon.address}/`)
      expect(page.status).toBe(200)
      expect(page.contentType).toMatch(/^text\/html/)
      expect(page.body).toBe(INDEX)
      const script = yield* get(`${daemon.address}/assets/index-abc123.js`)
      expect(script.contentType).toMatch(/^text\/javascript/)
      expect(script.cacheControl).toBe("public, max-age=31536000, immutable")
      expect(script.body).toBe(SCRIPT)
      for (const path of ["/assets/missing.js", "/secret.txt", "/%2e%2e/secret.txt", "/toString"]) {
        expect({ path, status: (yield* get(`${daemon.address}${path}`)).status }).toEqual({
          path,
          status: 404,
        })
      }
    }),
  )

  it.effect("keeps the daemon API and health check beside the dashboard", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [built])
      expect((yield* get(`${daemon.address}/healthz`)).status).toBe(200)
      const accounts = yield* get(`${daemon.address}/api/accounts`)
      expect(accounts.status).toBe(200)
      expect(JSON.parse(accounts.body)).toEqual({ accounts: [], pools: [] })
    }),
  )

  it.effect("says how to build the dashboard when no build is found", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [`${built}/missing`])
      const page = yield* get(`${daemon.address}/`)
      expect(page.status).toBe(404)
      expect(page.body).toContain("The agent-proxy dashboard is not built.")
      expect(page.body).toContain("bun run build")
    }),
  )

  it.effect("refuses the daemon API to a page from another site, by its Host or Origin", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [built])
      const host = new URL(daemon.address).host
      // A rebound name that resolves to loopback still names another site.
      const rebound = yield* raw(daemon.address, "GET", "/api/key", {
        host: `evil.example:${new URL(daemon.address).port}`,
      })
      expect(rebound.status).toBe(403)
      expect(rebound.body).not.toContain("ap-")
      // A name that only looks like a loopback address is a name all the same,
      // even from its own page.
      const port = new URL(daemon.address).port
      for (const name of ["127.evil.example", "127.0.0.1.evil.example", "::ffff:127.evil"]) {
        const lookalike = `${name.includes(":") ? `[${name}]` : name}:${port}`
        const read = yield* raw(daemon.address, "GET", "/api/key", { host: lookalike })
        expect({ name, status: read.status }).toEqual({ name, status: 403 })
        const rotated = yield* raw(daemon.address, "POST", "/api/key/rotate", {
          host: lookalike,
          origin: `http://${lookalike}`,
        })
        expect({ name, status: rotated.status }).toEqual({ name, status: 403 })
      }
      // A cross-site form post carries its page's Origin.
      for (const origin of ["https://evil.example", "null", "http://localhost:5173"]) {
        const posted = yield* raw(daemon.address, "POST", "/api/key/rotate", { host, origin })
        expect({ origin, status: posted.status }).toEqual({ origin, status: 403 })
      }
      const page = yield* raw(daemon.address, "GET", "/", { host: "evil.example" })
      expect(page.status).toBe(403)
    }),
  )

  it.effect("serves the daemon API to the CLI, its own dashboard, and loopback names", () =>
    Effect.gen(function* () {
      const daemon = yield* makeDaemon((built) => [built])
      const { host, port, origin } = new URL(daemon.address)
      expect((yield* raw(daemon.address, "GET", "/api/key", { host })).status).toBe(200)
      expect(
        (yield* raw(daemon.address, "GET", "/api/key", { host: `localhost:${port}` })).status,
      ).toBe(200)
      expect((yield* raw(daemon.address, "POST", "/api/key/rotate", { host, origin })).status).toBe(
        200,
      )
      expect(
        (yield* raw(daemon.address, "POST", "/api/key/rotate", {
          host: `localhost:${port}`,
          origin: `http://localhost:${port}`,
        })).status,
      ).toBe(200)
    }),
  )
})
