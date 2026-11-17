import { randomBytes } from "node:crypto"

import {
  Context,
  Data,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
} from "effect"

import { resolveDataDir } from "../paths.ts"
import { Account, type Credentials, type Identity } from "./account.ts"

/**
 * The accounts the daemon holds (ADR-0004): one JSON file per account, mode
 * 0600, in `accounts/` under the data directory, both directories mode 0700.
 * The daemon is the only writer, and every write replaces a file atomically.
 * Nothing outside this module knows the files exist.
 */

export class AccountStoreError extends Data.TaggedError("AccountStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** What signing in produced: the stored account, and whether it is new. */
export interface Upserted {
  readonly account: Account
  readonly created: boolean
}

const AccountJson = Schema.fromJsonString(Account)

const storeError = (message: string) => (cause: unknown) =>
  new AccountStoreError({ message, cause })

/** Account files end in `.json`; anything else, such as a temp file a crash left, is ignored. */
const isAccountFile = (name: string) => name.endsWith(".json") && !name.startsWith(".")

/** A file `write` creates before renaming it over an account file. */
const isTempFile = (name: string) => name.startsWith(".") && name.endsWith(".tmp")

/**
 * The label a new account gets when the owner gives none: its email's local
 * part, numbered when another account in its pool already has that label.
 */
const suggestLabel = (email: string, pool: ReadonlyArray<Account>) => {
  const base = email.split("@")[0] || email
  const taken = new Set(pool.map((account) => account.label))
  let label = base
  for (let n = 2; taken.has(label); n++) label = `${base} ${n}`
  return label
}

export class AccountStore extends Context.Service<
  AccountStore,
  {
    /** Every account, ordered by provider and then priority. */
    readonly list: Effect.Effect<ReadonlyArray<Account>, AccountStoreError>
    /**
     * Stores the account a login signed in to. An account already held (same
     * provider and provider account id) gets the new identity and credentials,
     * is no longer flagged as needing sign-in, and keeps its settings, except
     * for `label` when one is given. A new account joins the bottom of its pool.
     */
    readonly upsert: (
      identity: Identity,
      credentials: Credentials,
      options: { readonly label?: string | undefined },
    ) => Effect.Effect<Upserted, AccountStoreError>
  }
>()("agent-proxy/AccountStore") {
  /** The store in the data directory resolved from the environment. */
  static readonly layer = Layer.effect(
    AccountStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDir = yield* resolveDataDir
      const dir = path.join(dataDir, "accounts")
      // Writes are serialized, so two logins finishing together never pick the same priority.
      const writes = yield* Semaphore.make(1)

      // A crash between writing a temp file and renaming it leaves the temp
      // file, credentials and all. The daemon is the only writer and holds
      // its lock by now, so any temp file here is such a leftover.
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(dir))) return
        const leftovers = (yield* fs.readDirectory(dir)).filter(isTempFile)
        yield* Effect.forEach(leftovers, (name) => fs.remove(path.join(dir, name)), {
          discard: true,
        })
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("could not remove leftover account temp files").pipe(
            Effect.annotateLogs({ dir, cause: cause.message }),
          ),
        ),
      )

      const read = (file: string) =>
        fs.readFileString(path.join(dir, file)).pipe(
          Effect.flatMap(Schema.decodeEffect(AccountJson)),
          Effect.asSome,
          Effect.catch((cause) =>
            Effect.logWarning("skipping an unreadable account file").pipe(
              Effect.annotateLogs({ file, cause: String(cause) }),
              Effect.as(Option.none<Account>()),
            ),
          ),
        )

      const list = Effect.gen(function* () {
        if (!(yield* fs.exists(dir))) return []
        const files = (yield* fs.readDirectory(dir)).filter(isAccountFile)
        const accounts = yield* Effect.forEach(files, read)
        return accounts
          .flatMap((account) => (Option.isSome(account) ? [account.value] : []))
          .toSorted((a, b) => a.provider.localeCompare(b.provider) || a.priority - b.priority)
      }).pipe(Effect.mapError(storeError(`Could not read the accounts in ${dir}`)))

      /** Both directories exist and are readable by the owner only, even if they existed before. */
      const ensureDirectories = Effect.forEach(
        [dataDir, dir],
        (directory) =>
          fs
            .makeDirectory(directory, { recursive: true, mode: 0o700 })
            .pipe(Effect.andThen(fs.chmod(directory, 0o700))),
        { discard: true },
      )

      /**
       * Replaces the account's file atomically: the new content goes to a
       * temp file, is flushed to disk, and is renamed over the old file. A
       * crash leaves the old file or the new one, never part of either.
       */
      const write = (account: Account) =>
        Effect.gen(function* () {
          yield* ensureDirectories
          const target = path.join(dir, `${account.id}.json`)
          const temp = path.join(dir, `.${account.id}.json.${randomBytes(4).toString("hex")}.tmp`)
          const content = new TextEncoder().encode(`${JSON.stringify(account, null, 2)}\n`)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temp, { flag: "wx", mode: 0o600 })
              yield* file.writeAll(content)
              yield* file.sync
            }),
          )
          yield* fs.rename(temp, target)
        }).pipe(Effect.mapError(storeError(`Could not save account ${account.id} in ${dir}`)))

      const upsert = Effect.fn("AccountStore.upsert")(
        function* (
          identity: Identity,
          credentials: Credentials,
          options: { readonly label?: string | undefined },
        ) {
          const accounts = yield* list
          const existing = accounts.find(
            (account) =>
              account.provider === identity.provider &&
              account.providerAccountId === identity.providerAccountId,
          )
          if (existing !== undefined) {
            const account: Account = {
              ...existing,
              email: identity.email,
              plan: identity.plan,
              label: options.label ?? existing.label,
              needsSignIn: false,
              credentials,
            }
            yield* write(account)
            return { account, created: false }
          }

          const pool = accounts.filter((account) => account.provider === identity.provider)
          const now = yield* DateTime.now
          const account: Account = {
            id: randomBytes(8).toString("hex"),
            provider: identity.provider,
            providerAccountId: identity.providerAccountId,
            email: identity.email,
            plan: identity.plan,
            label: options.label ?? suggestLabel(identity.email, pool),
            priority: Math.max(0, ...pool.map((other) => other.priority)) + 1,
            enabled: true,
            needsSignIn: false,
            addedAt: DateTime.formatIso(now),
            lastUsedAt: null,
            credentials,
          }
          yield* write(account)
          const upserted: Upserted = { account, created: true }
          return upserted
        },
        (effect) => writes.withPermit(effect),
      )

      return AccountStore.of({ list, upsert })
    }),
  )
}
