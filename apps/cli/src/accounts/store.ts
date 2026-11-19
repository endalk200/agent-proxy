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

import { ensurePrivateDirectory, writeFileAtomic } from "../atomic-file.ts"
import { resolveDataDir } from "../paths.ts"
import {
  Account,
  type CredentialState,
  type Credentials,
  type Identity,
  type Provider,
  providerNames,
} from "./account.ts"
import { AccountChanges } from "./changes.ts"
import { levelsOf, numbered, place } from "./priority.ts"

/**
 * The accounts the daemon holds (ADR-0004): one JSON file per account, mode
 * 0600, in `accounts/` under the data directory, both directories mode 0700.
 * The daemon is the only writer, and every write replaces a file atomically.
 * Nothing outside this module knows the files exist. Each change raises
 * `AccountChanges`' signal once it is written.
 */

export class AccountStoreError extends Data.TaggedError("AccountStoreError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** No account has this id. */
export class AccountNotFound extends Data.TaggedError("AccountNotFound")<{ readonly id: string }> {
  override get message() {
    return `No account ${this.id}.`
  }
}

/** A priority past either end of the account's pool: it can take 1 to `max`. */
export class PriorityOutOfRange extends Data.TaggedError("PriorityOutOfRange")<{
  readonly provider: Provider
  readonly max: number
}> {
  override get message() {
    const pool = `the ${providerNames[this.provider]} pool`
    return this.max === 1
      ? `It is the only account in ${pool}, so its priority is 1.`
      : `In ${pool}, a priority is 1${this.max === 2 ? " or 2" : ` to ${this.max}`}.`
  }
}

/** An account can share a priority only with another account in its own pool. */
export class CannotSharePriority extends Data.TaggedError("CannotSharePriority")<{
  readonly message: string
}> {}

/** The settings the owner changes on an account; each one left out stays as it is. */
export interface AccountSettings {
  readonly label?: string | undefined
  /**
   * A priority in the account's pool, 1 first, which the account then holds
   * alone: the accounts from that priority down move down one.
   */
  readonly priority?: number | undefined
  /**
   * The id of another account in the pool whose priority the account then
   * shares. Not given with `priority`.
   */
  readonly sharePriorityWith?: string | undefined
  /** A disabled account sits out of its pool but keeps its priority. */
  readonly enabled?: boolean | undefined
}

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

/** A file `writeFileAtomic` creates before renaming it over an account file. */
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
    /**
     * Changes the owner's settings on the account with `id`, and returns it as
     * stored. A new or shared priority moves it within its pool, and the
     * others shift to keep the pool's priorities 1, 2, 3 and so on.
     */
    readonly updateSettings: (
      id: string,
      settings: AccountSettings,
    ) => Effect.Effect<
      Account,
      AccountStoreError | AccountNotFound | PriorityOutOfRange | CannotSharePriority
    >
    /**
     * Forgets the account with `id`, credentials and all, and returns it as it
     * was. When it held its priority alone, the accounts below it move up one.
     */
    readonly remove: (id: string) => Effect.Effect<Account, AccountStoreError | AccountNotFound>
    /**
     * Changes the credential state of account `id` to what `change` makes of
     * the account as currently stored, persisted before this returns. The
     * owner's settings are left alone. `change` returns `undefined` to leave
     * the account unchanged. Returns the account as stored afterwards, or
     * none when there is no account `id`.
     */
    readonly updateCredentials: (
      id: string,
      change: (account: Account) => CredentialState | undefined,
    ) => Effect.Effect<Option.Option<Account>, AccountStoreError>
    /** Records that the account served a request at `at` (ISO time); a removed account stays removed. */
    readonly markUsed: (id: string, at: string) => Effect.Effect<void, AccountStoreError>
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
      const changes = yield* AccountChanges
      // Writes are serialized, so two logins finishing together never pick the same priority.
      const writes = yield* Semaphore.make(1)
      /**
       * Runs a change that may span several files: once it starts, it
       * finishes, and then says some account may have changed, even when it
       * failed partway.
       */
      const changing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        writes.withPermit(Effect.uninterruptible(effect)).pipe(Effect.ensuring(changes.signal))

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
          .toSorted(
            (a, b) =>
              a.provider.localeCompare(b.provider) ||
              a.priority - b.priority ||
              a.addedAt.localeCompare(b.addedAt) ||
              a.id.localeCompare(b.id),
          )
      }).pipe(Effect.mapError(storeError(`Could not read the accounts in ${dir}`)))

      /** Replaces the account's file atomically, both directories readable by the owner only. */
      const write = (account: Account) =>
        Effect.gen(function* () {
          yield* ensurePrivateDirectory(dataDir)
          yield* ensurePrivateDirectory(dir)
          yield* writeFileAtomic(
            path.join(dir, `${account.id}.json`),
            `${JSON.stringify(account, null, 2)}\n`,
          )
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(storeError(`Could not save account ${account.id} in ${dir}`)),
        )

      /**
       * Writes the accounts of `next`, a pool as it is to be, whose priority
       * differs from `before`'s, the same pool as stored.
       */
      const writeMoved = (before: ReadonlyArray<Account>, next: ReadonlyArray<Account>) => {
        const was = new Map(before.map((account) => [account.id, account.priority]))
        return Effect.forEach(
          next.filter((account) => was.get(account.id) !== account.priority),
          write,
          { discard: true },
        )
      }

      const upsert = Effect.fn("AccountStore.upsert")(function* (
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
          // A fresh sign-in settles any refresh a stopped daemon left unrecorded.
          const { refreshStartedAt: _settled, ...kept } = existing
          const account: Account = {
            ...kept,
            email: identity.email,
            plan: identity.plan,
            label: options.label?.trim() ?? existing.label,
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
          label: options.label?.trim() ?? suggestLabel(identity.email, pool),
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
      }, changing)

      const updateSettings = Effect.fn("AccountStore.updateSettings")(function* (
        id: string,
        settings: AccountSettings,
      ) {
        const accounts = yield* list
        const existing = accounts.find((account) => account.id === id)
        if (existing === undefined) return yield* new AccountNotFound({ id })
        const account: Account = {
          ...existing,
          label: settings.label?.trim() ?? existing.label,
          enabled: settings.enabled ?? existing.enabled,
        }
        const placement =
          settings.sharePriorityWith !== undefined
            ? ({ _tag: "Share", with: settings.sharePriorityWith } as const)
            : settings.priority !== undefined
              ? ({ _tag: "Own", priority: settings.priority } as const)
              : undefined
        if (placement === undefined) {
          yield* write(account)
          return account
        }

        const pool = accounts.filter((other) => other.provider === account.provider)
        const placed = place(
          pool.map((other) => (other.id === id ? account : other)),
          id,
          placement,
        )
        switch (placed._tag) {
          case "OutOfRange":
            return yield* new PriorityOutOfRange({ provider: account.provider, max: placed.max })
          case "NotInPool": {
            const other = accounts.find((candidate) => candidate.id === placed.id)
            return yield* new CannotSharePriority({
              message:
                other === undefined
                  ? `No account ${placed.id} to share a priority with.`
                  : `"${other.label}" is in the ${providerNames[other.provider]} pool, and an account shares a priority only within its own pool.`,
            })
          }
        }
        const moved = placed.pool.find((other) => other.id === id) ?? account
        // The account itself first, so its own settings are never left unwritten.
        yield* write(moved)
        yield* writeMoved(
          pool,
          placed.pool.filter((other) => other.id !== id),
        )
        return moved
      }, changing)

      const remove = Effect.fn("AccountStore.remove")(function* (id: string) {
        const accounts = yield* list
        const account = accounts.find((other) => other.id === id)
        if (account === undefined) return yield* new AccountNotFound({ id })
        yield* fs
          .remove(path.join(dir, `${id}.json`))
          .pipe(Effect.mapError(storeError(`Could not remove account ${id} from ${dir}`)))
        const pool = accounts.filter((other) => other.provider === account.provider)
        yield* writeMoved(pool, numbered(levelsOf(pool.filter((other) => other.id !== id))))
        return account
      }, changing)

      // A change that failed between its file writes, or a file edited by
      // hand, can leave a pool with a gap between priorities. Close the gaps,
      // so every pool's priorities are 1, 2, 3… again; accounts that share
      // a priority keep sharing it.
      yield* list.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            [...new Set(all.map((account) => account.provider))],
            (provider) => {
              const pool = all.filter((account) => account.provider === provider)
              return writeMoved(pool, numbered(levelsOf(pool)))
            },
            { discard: true },
          ),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("could not repair account priorities").pipe(
            Effect.annotateLogs({ dir, cause: cause.message }),
          ),
        ),
      )

      const updateCredentials = Effect.fn("AccountStore.updateCredentials")(
        function* (id: string, change: (account: Account) => CredentialState | undefined) {
          const file = `${id}.json`
          // A file removed meanwhile stays removed: never written back.
          if (!isAccountFile(file) || !(yield* fs.exists(path.join(dir, file)))) {
            return Option.none<Account>()
          }
          const stored = yield* read(file)
          if (Option.isNone(stored)) return stored
          const next = change(stored.value)
          if (next === undefined) return stored
          const {
            credentials: _old,
            needsSignIn: _flag,
            refreshStartedAt: _marker,
            ...rest
          } = stored.value
          const account: Account = { ...rest, ...next }
          yield* write(account)
          return Option.some(account)
        },
        (effect) =>
          writes
            .withPermit(
              effect.pipe(
                Effect.catchTag("PlatformError", (cause) =>
                  Effect.fail(
                    new AccountStoreError({
                      message: `Could not read the accounts in ${dir}`,
                      cause,
                    }),
                  ),
                ),
              ),
            )
            .pipe(Effect.ensuring(changes.signal)),
      )

      const markUsed = Effect.fn("AccountStore.markUsed")(
        function* (id: string, at: string) {
          const file = `${id}.json`
          // A file removed meanwhile stays removed: never written back.
          if (!isAccountFile(file) || !(yield* fs.exists(path.join(dir, file)))) return
          const stored = yield* read(file)
          if (Option.isNone(stored)) return
          yield* write({ ...stored.value, lastUsedAt: at })
        },
        (effect) =>
          writes
            .withPermit(
              effect.pipe(
                Effect.catchTag("PlatformError", (cause) =>
                  Effect.fail(
                    new AccountStoreError({
                      message: `Could not read the accounts in ${dir}`,
                      cause,
                    }),
                  ),
                ),
              ),
            )
            .pipe(Effect.ensuring(changes.signal)),
      )

      return AccountStore.of({ list, upsert, updateSettings, remove, updateCredentials, markUsed })
    }),
  )
}
