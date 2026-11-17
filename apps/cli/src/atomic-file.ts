import { randomBytes } from "node:crypto"

import { Effect, FileSystem, Path } from "effect"

/**
 * Replaces `file` atomically with `content`, readable only by the owner: the
 * content goes to a temp file beside it (mode 0600), is flushed to disk, and
 * is renamed over the old file. A crash leaves the old file or the new one,
 * never part of either, plus at most a leftover temp file named
 * `.<name>.<random>.tmp`.
 */
export const writeFileAtomic = (file: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`,
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(temp, { flag: "wx", mode: 0o600 })
        yield* handle.writeAll(new TextEncoder().encode(content))
        yield* handle.sync
      }),
    )
    yield* fs.rename(temp, file)
  })

/** Creates `directory` and its parents, and makes it readable by the owner only, even if it existed. */
export const ensurePrivateDirectory = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.chmod(directory, 0o700)
  })
