import { Context, Effect, FileSystem, Option, Path } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import type { LocalOnly } from "./http.ts"

/**
 * The built dashboard, served at `/` on the daemon's one listener.
 *
 * The dashboard routes its pages in the browser, so each page's path, such
 * as `/accounts`, is served `index.html` too: a reload or a link to one works.
 *
 * `bun run build` builds the web client into `apps/web/dist` and embeds it in
 * the compiled binary (ADR-0008), whose entry point hands the daemon the
 * embedded files. A daemon run from source is pointed at `apps/web/dist`.
 */

/** Where the daemon finds the build. */
export type DashboardSource =
  /** Directories to look in, first one holding an `index.html` wins. */
  | { readonly _tag: "Directories"; readonly dirs: ReadonlyArray<string> }
  /** Files embedded in the binary: each path under the build, such as `assets/index-abc.js`, to the file holding it. */
  | { readonly _tag: "Embedded"; readonly files: Readonly<Record<string, string>> }

/** The dashboard's build, given by the entry point. With none, the dashboard is not built. */
export const Dashboard = Context.Reference<DashboardSource>("agent-proxy/Dashboard", {
  defaultValue: () => ({ _tag: "Directories", dirs: [] }),
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

/** The dashboard's pages other than `/`, which it routes itself; each is served `index.html`. */
const PAGES = new Set(["accounts"])

/** Vite names everything under `assets/` by its content hash, so it never changes. */
const cacheControlFor = (relative: string) =>
  relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache"

const notFound = HttpServerResponse.text("Not found", { status: 404 })

const notBuilt = HttpServerResponse.text(
  "The agent-proxy dashboard is not built. Run `bun run build` in the agent-proxy checkout, then reload.",
  { status: 404 },
)

/** The file holding `relative` in the build, or `None` when the build has no such file. */
const locate = (source: DashboardSource, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (source._tag === "Embedded") {
      return Object.hasOwn(source.files, relative)
        ? Option.fromNullishOr(source.files[relative])
        : Option.none<string>()
    }
    const dir = yield* Effect.findFirst(source.dirs, (candidate) =>
      fs.exists(path.join(candidate, "index.html")).pipe(Effect.orElseSucceed(() => false)),
    )
    if (Option.isNone(dir)) return Option.none<string>()
    const root = path.resolve(dir.value)
    const file = path.resolve(root, relative)
    if (!file.startsWith(`${root}${path.sep}`)) return Option.none<string>()
    const info = yield* fs.stat(file).pipe(Effect.option)
    return Option.isSome(info) && info.value.type === "File" ? Option.some(file) : Option.none()
  })

const serve = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const request = yield* HttpServerRequest.HttpServerRequest

  const source = yield* Dashboard
  if (Option.isNone(yield* locate(source, "index.html"))) return notBuilt

  const pathname = yield* Effect.try({
    try: () => decodeURIComponent(new URL(request.url, "http://dashboard").pathname),
    catch: () => "malformed",
  }).pipe(Effect.option)
  if (Option.isNone(pathname)) return notFound
  // Normalized, so `assets/../index.html` is looked up, and cached, as `index.html`.
  const requested = path.normalize(pathname.value.replace(/^\/+/, "").replace(/\/+$/, ""))
  const relative = pathname.value === "/" || PAGES.has(requested) ? "index.html" : requested

  const file = yield* locate(source, relative)
  if (Option.isNone(file)) return notFound
  const bytes = yield* fs.readFile(file.value)
  return HttpServerResponse.uint8Array(bytes, {
    contentType: CONTENT_TYPES[path.extname(relative)] ?? "application/octet-stream",
    headers: { "cache-control": cacheControlFor(relative) },
  })
}).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(notFound)))

/** Serves the dashboard for every GET no other route claims. */
export const dashboardRoutes = (router: HttpRouter.HttpRouter, localOnly: LocalOnly) =>
  router.add("GET", "/*", localOnly(serve))
