import {
  type Config,
  Console,
  Effect,
  type FileSystem,
  Option,
  type Path,
  Schedule,
  Terminal,
} from "effect"
import { Argument, Command, Flag } from "effect/cli"
import type { HttpClient } from "effect/http"

import { type AccountStatus, providerNames } from "../accounts/account.ts"
import { Browser } from "../browser.ts"
import type { AccountList, AccountView, LoginView, PoolView } from "../daemon/api.ts"
import {
  cancelLogin,
  type DaemonApiError,
  type DaemonNotRunning,
  type DaemonUnexpectedResponse,
  getLogin,
  listAccounts,
  removeAccount,
  startLogin,
  submitCallback,
  updateAccount,
} from "../daemon/client.ts"
import { asUserError, userError } from "./errors.ts"

const statusNames: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  "needs-sign-in": "Needs sign-in",
  disabled: "Disabled",
}

/** Which account a pool's new sessions go to, in a sentence. */
const formatPool = (pool: PoolView, accounts: ReadonlyArray<AccountView>) => {
  const name = providerNames[pool.provider]
  const next = accounts.find((account) => account.id === pool.newSessionsAccountId)
  return next === undefined
    ? `No ${name} account can take new sessions: each one needs sign-in or is disabled.`
    : `New ${name} sessions go to "${next.label}".`
}

/** The accounts as an aligned table and who gets each pool's new sessions, or how to add the first one. */
export const formatAccounts = ({ accounts, pools }: AccountList): string => {
  if (accounts.length === 0) {
    return "No accounts yet. Add one with `agent-proxy accounts add claude`."
  }
  const rows = [
    ["PROVIDER", "LABEL", "EMAIL", "PLAN", "PRIORITY", "STATUS"],
    ...accounts.map((account) => [
      account.provider,
      account.label,
      account.email,
      account.plan,
      String(account.priority),
      statusNames[account.status],
    ]),
  ]
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  )
  const table = rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  "),
  )
  return [...table, "", ...pools.map((pool) => formatPool(pool, accounts))].join("\n")
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Print machine-readable JSON"),
)

/** How often the CLI asks the daemon whether a login has finished. */
const POLL = Schedule.spaced("500 millis")

const awaitLogin = (id: string) =>
  getLogin(id).pipe(Effect.repeat({ schedule: POLL, until: (login) => login.status !== "pending" }))

/** Opens the browser at the login's sign-in page and waits for the redirect to finish it. */
const signInWithBrowser = (login: LoginView, name: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    yield* Console.log(
      `Opening your browser to sign in to ${name}. If it does not open, visit:\n\n  ${login.authorizeUrl}\n\nWaiting for you to sign in (Ctrl-C cancels)…`,
    )
    // The opener runs beside the wait, not before it: `xdg-open` can stay
    // attached to the browser it starts, and the login must finish regardless.
    yield* browser.open(login.authorizeUrl).pipe(
      Effect.catchTag("BrowserError", () =>
        Console.log("Could not open a browser. Open the URL above yourself."),
      ),
      Effect.forkScoped,
    )
    return yield* awaitLogin(login.id)
  }).pipe(Effect.scoped)

/**
 * Prints the sign-in page's URL and waits for the owner to paste the URL the
 * browser was redirected to. A redirect that does reach the daemon finishes
 * the login too.
 */
const signInWithPaste = (login: LoginView, name: string) =>
  Effect.gen(function* () {
    const terminal = yield* Terminal.Terminal
    const redirect = new URL(login.authorizeUrl).searchParams.get("redirect_uri")
    yield* Console.log(
      `Open this URL in a browser and sign in to ${name}:\n\n  ${login.authorizeUrl}\n\nAfter you sign in, the browser is sent to ${redirect}. If that page does not load, copy its address from the address bar and paste it here:`,
    )
    /** Reads pasted lines until one finishes the login; a rejected one asks again. */
    const pasted: Effect.Effect<
      LoginView,
      Config.ConfigError | DaemonApiError | DaemonNotRunning | DaemonUnexpectedResponse,
      FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
    > = terminal.readLine.pipe(
      Effect.map((line) => line.trim()),
      Effect.flatMap((line) => (line === "" ? pasted : submitCallback(login.id, line))),
      Effect.catchIf(
        (error) => error._tag === "DaemonApiError" && error.status === 400,
        (error) => Effect.andThen(Console.log(`${error.message} Try again:`), pasted),
      ),
      // Input closed (Ctrl-D): keep waiting for the browser.
      Effect.catchTag("QuitError", () => Effect.never),
    )
    return yield* Effect.raceFirst(pasted, awaitLogin(login.id))
  })

/** What the owner sees once a login has finished. */
const report = (login: LoginView, name: string) => {
  const account = login.account
  switch (login.status) {
    case "succeeded":
      return account === undefined
        ? Console.log(`Signed in to ${name}.`)
        : Console.log(
            login.created === true
              ? `Added ${name} account "${account.label}" (${account.email}, ${account.plan}) at priority ${account.priority}.`
              : `Signed in again to ${name} account "${account.label}" (${account.email}, ${account.plan}); its credentials are updated.`,
          )
    case "failed":
      return Effect.fail(userError(`Sign-in failed: ${login.error ?? "unknown error"}`))
    case "expired":
      return Effect.fail(
        userError("The sign-in timed out after 10 minutes. Run the command again."),
      )
    case "cancelled":
      return Effect.fail(userError("The sign-in was cancelled."))
    case "pending":
      return Effect.fail(userError("The sign-in did not finish."))
  }
}

const add = Command.make(
  "add",
  {
    provider: Argument.Literals("provider", ["claude"]).pipe(
      Argument.withDescription("The provider to sign in to"),
    ),
    label: Flag.String("label").pipe(
      Flag.optional,
      Flag.withDescription("A label for the account; defaults to its email's name"),
    ),
    noBrowser: Flag.Boolean("no-browser").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the sign-in URL and paste the callback URL instead"),
    ),
  },
  Effect.fn("accounts.add")(function* ({ provider, label, noBrowser }) {
    const name = providerNames[provider]
    const login = yield* startLogin({
      provider,
      ...(Option.isSome(label) ? { label: label.value } : {}),
    }).pipe(Effect.mapError(asUserError))
    const finished = yield* Effect.gen(function* () {
      return noBrowser ? yield* signInWithPaste(login, name) : yield* signInWithBrowser(login, name)
    }).pipe(
      Effect.onInterrupt(() => cancelLogin(login.id).pipe(Effect.ignore)),
      Effect.mapError(asUserError),
    )
    yield* report(finished, name)
  }),
).pipe(
  Command.withDescription(
    "Sign in to an account through the daemon; signing in to one it holds refreshes it",
  ),
)

/**
 * The account an `<account>` argument names: the one whose label or email is
 * `query`, ignoring case, or whose id starts with it. Naming none, or more
 * than one, fails with a message listing what it could mean.
 */
const findAccount = (query: string) =>
  Effect.gen(function* () {
    const { accounts } = yield* listAccounts.pipe(Effect.mapError(asUserError))
    const wanted = query.trim().toLowerCase()
    const matches =
      wanted === ""
        ? []
        : accounts.filter(
            (account) =>
              account.label.toLowerCase() === wanted ||
              account.email.toLowerCase() === wanted ||
              account.id.toLowerCase().startsWith(wanted),
          )
    const [match] = matches
    if (match === undefined) {
      return yield* userError(
        `No account matches "${query}". Run \`agent-proxy accounts\` to see each one's label and email.`,
      )
    }
    if (matches.length > 1) {
      const candidates = matches.map(
        (account) =>
          `  ${account.id}  ${providerNames[account.provider]}  "${account.label}"  ${account.email}`,
      )
      return yield* userError(
        [
          `"${query}" matches ${matches.length} accounts. Name one by its label, its email, or enough of its id:`,
          ...candidates,
        ].join("\n"),
      )
    }
    return match
  })

/** How an account is named in what the commands print. */
const describe = (account: AccountView) =>
  `${providerNames[account.provider]} account "${account.label}" (${account.email})`

const accountArgument = Argument.String("account").pipe(
  Argument.withDescription("The account's label, email, or the start of its id"),
)

const set = Command.make(
  "set",
  {
    account: accountArgument,
    label: Flag.String("label").pipe(Flag.optional, Flag.withDescription("A new label")),
    priority: Flag.Int("priority").pipe(
      Flag.optional,
      Flag.withDescription("A new place in its pool, 1 first; the others shift to make room"),
    ),
  },
  Effect.fn("accounts.set")(function* ({ account: query, label, priority }) {
    if (Option.isNone(label) && Option.isNone(priority)) {
      return yield* userError("Nothing to change. Give --label, --priority, or both.")
    }
    if (Option.isSome(label) && label.value.trim() === "") {
      return yield* userError("A label cannot be blank.")
    }
    const before = yield* findAccount(query)
    const after = yield* updateAccount(before.id, {
      ...(Option.isSome(label) ? { label: label.value.trim() } : {}),
      ...(Option.isSome(priority) ? { priority: priority.value } : {}),
    }).pipe(Effect.mapError(asUserError))
    if (Option.isSome(label)) {
      yield* Console.log(`Renamed ${describe(before)} to "${after.label}".`)
    }
    if (Option.isSome(priority)) {
      yield* Console.log(`Moved ${describe(after)} to priority ${after.priority}.`)
    }
  }),
).pipe(Command.withDescription("Change an account's label or its priority in its pool"))

const enable = Command.make(
  "enable",
  { account: accountArgument },
  Effect.fn("accounts.enable")(function* ({ account: query }) {
    const before = yield* findAccount(query)
    const after = yield* updateAccount(before.id, { enabled: true }).pipe(
      Effect.mapError(asUserError),
    )
    yield* Console.log(`Enabled ${describe(after)} at priority ${after.priority}.`)
  }),
).pipe(Command.withDescription("Put an account back in its pool, at its priority"))

const disable = Command.make(
  "disable",
  { account: accountArgument },
  Effect.fn("accounts.disable")(function* ({ account: query }) {
    const before = yield* findAccount(query)
    const after = yield* updateAccount(before.id, { enabled: false }).pipe(
      Effect.mapError(asUserError),
    )
    yield* Console.log(`Disabled ${describe(after)}. It keeps priority ${after.priority}.`)
  }),
).pipe(Command.withDescription("Keep an account out of its pool without removing it"))

const remove = Command.make(
  "remove",
  { account: accountArgument },
  Effect.fn("accounts.remove")(function* ({ account: query }) {
    const account = yield* findAccount(query)
    const removed = yield* removeAccount(account.id).pipe(Effect.mapError(asUserError))
    yield* Console.log(`Removed ${describe(removed)} and its credentials.`)
  }),
).pipe(
  Command.withDescription(
    "Forget an account and its credentials; requests it is serving still finish",
  ),
)

export const accountsCommand = Command.make(
  "accounts",
  { json: jsonFlag },
  Effect.fn("accounts")(function* ({ json }) {
    const list = yield* listAccounts.pipe(Effect.mapError(asUserError))
    yield* Console.log(json ? JSON.stringify(list, null, 2) : formatAccounts(list))
  }),
).pipe(
  Command.withDescription("List accounts with their status, or add, change or remove one"),
  Command.withSubcommands([add, set, enable, disable, remove]),
)
