import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import { Context, Data, Effect, FileSystem, Layer, Path, Ref, Semaphore } from "effect"

import { ensurePrivateDirectory, writeFileAtomic } from "../atomic-file.ts"
import { resolveProxyKeyFile } from "../paths.ts"

/**
 * The proxy key (ADR-0005): the secret every proxy request carries. The
 * daemon generates it on first run and keeps it in `key` in the data
 * directory, mode 0600, holding the key alone, so a client config can read
 * it with `{file:…}`. Rotating it replaces it at once: the old key stops
 * working with the next request.
 */

export class ProxyKeyError extends Data.TaggedError("ProxyKeyError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const generate = () => `ap-${randomBytes(32).toString("base64url")}`

const digest = (key: string) => createHash("sha256").update(key).digest()

export class ProxyKey extends Context.Service<
  ProxyKey,
  {
    /** The key clients must present. */
    readonly current: Effect.Effect<string>
    /** True when `presented` is the current key, compared in constant time. */
    readonly matches: (presented: string) => Effect.Effect<boolean>
    /** Replaces the key with a new one, persisted before it takes effect, and returns it. */
    readonly rotate: Effect.Effect<string, ProxyKeyError>
  }
>()("agent-proxy/ProxyKey") {
  /** The key in the data directory resolved from the environment, generated if missing. */
  static readonly layer = Layer.effect(
    ProxyKey,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = yield* resolveProxyKeyFile
      const dataDir = path.dirname(file)

      const save = (key: string) =>
        Effect.gen(function* () {
          yield* ensurePrivateDirectory(dataDir)
          yield* writeFileAtomic(file, key)
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProxyKeyError({ message: `Could not save the proxy key in ${file}`, cause }),
          ),
        )

      const stored = yield* fs.readFileString(file).pipe(
        Effect.map((text) => text.trim()),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
        Effect.mapError(
          (cause) =>
            new ProxyKeyError({ message: `Could not read the proxy key in ${file}`, cause }),
        ),
      )
      const initial = stored === "" ? generate() : stored
      if (stored === "") yield* save(initial)

      const key = yield* Ref.make(initial)
      const rotations = yield* Semaphore.make(1)

      return ProxyKey.of({
        current: Ref.get(key),
        matches: (presented) =>
          Effect.map(Ref.get(key), (current) =>
            timingSafeEqual(digest(presented), digest(current)),
          ),
        // Waiting for the permit can be interrupted; the commit cannot, so the
        // key file and the key the proxy accepts never disagree.
        rotate: rotations.withPermit(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const next = generate()
              yield* save(next)
              yield* Ref.set(key, next)
              return next
            }),
          ),
        ),
      })
    }),
  )
}
