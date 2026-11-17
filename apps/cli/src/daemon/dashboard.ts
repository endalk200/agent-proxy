import { fileURLToPath } from "node:url"

import { Context, Effect, FileSystem, Path } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import type { LocalOnly } from "./http.ts"

/**
 * The built dashboard, served at `/` on the daemon's one listener.
 *
 * `bun run build` builds the web client into `apps/web/dist` and copies it
 * into the CLI bundle as `apps/cli/dist/web`, beside `bin.js`. The bundled
 * daemon finds it there; a daemon run from source finds `apps/web/dist`.
 */

/** Where the daemon looks for the build, first one holding an `index.html` wins. */
export const DashboardDirs = Context.Reference<ReadonlyArray<string>>("agent-proxy/DashboardDirs", {
  defaultValue: () => [
    // Bundled: this module is inside `dist/bin.js`.
    fileURLToPath(new URL("web", import.meta.url)),
    // Source: this module is `apps/cli/src/daemon/dashboard.ts`.
    fileURLToPath(new URL("../../../web/dist", import.meta.url)),
  ],
})

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

/** Vite names everything under `assets/` by its content hash, so it never changes. */
const cacheControlFor = (relative: string) =>
  relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"

const notFound = HttpServerResponse.text("Not found", { status: 404 })

const notBuilt = HttpServerResponse.text(
  "The agent-proxy dashboard is not built. Run `bun run build` in the agent-proxy checkout, then reload.",
  { status: 404 },
)

const serve = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const request = yield* HttpServerRequest.HttpServerRequest

  const dirs = yield* DashboardDirs
  const dir = yield* Effect.findFirst(dirs, (candidate) =>
    fs.exists(path.join(candidate, "index.html")).pipe(Effect.orElseSucceed(() => false)),
  )
  if (dir._tag === "None") return notBuilt

  const pathname = yield* Effect.try({
    try: () => decodeURIComponent(new URL(request.url, "http://dashboard").pathname),
    catch: () => "malformed",
  }).pipe(Effect.option)
  if (pathname._tag === "None") return notFound
  const relative = pathname.value === "/" ? "index.html" : pathname.value.replace(/^\/+/, "")
  const root = path.resolve(dir.value)
  const file = path.resolve(root, relative)
  if (!file.startsWith(`${root}${path.sep}`)) return notFound

  const info = yield* fs.stat(file).pipe(Effect.option)
  if (info._tag === "None" || info.value.type !== "File") return notFound
  const bytes = yield* fs.readFile(file)
  return HttpServerResponse.uint8Array(bytes, {
    contentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    headers: { "cache-control": cacheControlFor(path.relative(root, file)) },
  })
}).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(notFound)))

/** Serves the dashboard for every GET no other route claims. */
export const dashboardRoutes = (router: HttpRouter.HttpRouter, localOnly: LocalOnly) =>
  router.add("GET", "/*", localOnly(serve))
