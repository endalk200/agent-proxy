import { Context, Data, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class BrowserError extends Data.TaggedError("BrowserError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** The system's command for opening `url` in the default browser. */
const openCommand = (url: string) =>
  process.platform === "darwin"
    ? ChildProcess.make("open", [url])
    : process.platform === "win32"
      ? ChildProcess.make("cmd", ["/c", "start", "", url])
      : ChildProcess.make("xdg-open", [url])

/**
 * The owner's web browser, which the CLI opens to sign in to a provider.
 *
 * Kept behind a service so commands never spawn processes for it directly:
 * `bin.ts` provides `layerSystem`, and tests provide a fake browser.
 */
export class Browser extends Context.Service<
  Browser,
  { readonly open: (url: string) => Effect.Effect<void, BrowserError> }
>()("agent-proxy/Browser") {
  /** Opens URLs with the system's default browser: `open`, `xdg-open`, or `start`. */
  static readonly layerSystem = Layer.effect(
    Browser,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return Browser.of({
        open: (url) =>
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(openCommand(url))
            const exitCode = yield* handle.exitCode
            if (exitCode !== 0) {
              return yield* new BrowserError({ message: `the browser opener exited ${exitCode}` })
            }
          }).pipe(
            Effect.scoped,
            Effect.catchTag("PlatformError", (cause) =>
              Effect.fail(new BrowserError({ message: cause.message, cause })),
            ),
          ),
      })
    }),
  )
}
