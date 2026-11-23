import {
  Clock,
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

import { type AccountStatus, Provider, providerNames } from "../accounts/account.ts"
import { Browser } from "../browser.ts"
import { confirm } from "../connectors/connector.ts"
import type {
  AccountListing,
  AccountView,
  LimitResetView,
  ListedAccount,
  LoginView,
  PoolView,
} from "../daemon/api.ts"
import {
  cancelLogin,
  type DaemonApiError,
  type DaemonNotRunning,
  type DaemonUnexpectedResponse,
  getLogin,
  listAccounts,
  listLimits,
  redeemReset,
  removeAccount,
  startLogin,
  submitCallback,
  updateAccount,
} from "../daemon/client.ts"
import { RuntimeInfo } from "../runtime-info.ts"
import { asUserError, userError } from "./errors.ts"

const statusNames: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  "cooling-down": "Cooling down",
  "needs-sign-in": "Needs sign-in",
  disabled: "Disabled",
}

const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" })

/** `iso` in local time: "15:30" when it is today, else "Jun 1 15:30". */
const clockText = (iso: string, now: number) => {
  const date = new Date(iso)
  const time = timeFormat.format(date)
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${dayFormat.format(date)} ${time}`
}

/** When a limit reset expires, in local time, with its year when that is not this year: "Jun 1 2099 15:30". */
const expiryText = (millis: number | null, now: number) => {
  if (millis === null) return "never"
  const date = new Date(millis)
  const day =
    date.getFullYear() === new Date(now).getFullYear()
      ? dayFormat.format(date)
      : `${dayFormat.format(date)} ${date.getFullYear()}`
  return `${day} ${timeFormat.format(date)}`
}

/** `rows` as an aligned table, two spaces between columns; the last column is not padded. */
const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  )
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  "),
  )
}

/** An account's status as the owner reads it, with when a cooldown ends. */
const statusText = (account: AccountView, now: number) =>
  account.status === "cooling-down" && account.cooldownEndsAt !== null
    ? `${statusNames[account.status]} until ${clockText(account.cooldownEndsAt, now)}`
    : statusNames[account.status]

/** Which accounts a pool's new sessions go to, in order, in a sentence. */
const formatPool = (pool: PoolView, accounts: ReadonlyArray<AccountView>, now: number) => {
  const name = providerNames[pool.provider]
  const order = pool.newSessionsOrder.flatMap((id) => {
    const account = accounts.find((candidate) => candidate.id === id)
    return account === undefined ? [] : [`"${account.label}"`]
  })
  if (order.length > 0) return `New ${name} sessions go to ${order.join(", then ")}.`
  const firstFree = accounts
    .filter((account) => account.provider === pool.provider && account.status === "cooling-down")
    .flatMap((account) => (account.cooldownEndsAt === null ? [] : [account.cooldownEndsAt]))
    .toSorted()[0]
  return firstFree === undefined
    ? `No ${name} account can take new sessions: each one needs sign-in or is disabled.`
    : `No ${name} account can take new sessions until ${clockText(firstFree, now)}, when the first cooldown ends.`
}

/**
 * The accounts as an aligned table and who gets each pool's new sessions, or
 * how to add the first one. A RESETS column counts each account's limit
 * resets, while any account holds one.
 */
export const formatAccounts = ({ accounts, pools }: AccountListing, now: number): string => {
  if (accounts.length === 0) {
    return "No accounts yet. Add one with `agent-proxy accounts add claude` or `agent-proxy accounts add codex`."
  }
  const resets = accounts.some((account) => account.limitResets.length > 0)
  const rows = [
    ["PROVIDER", "LABEL", "EMAIL", "PLAN", "PRIORITY", ...(resets ? ["RESETS"] : []), "STATUS"],
    ...accounts.map((account) => [
      account.provider,
      account.label,
      account.email,
      account.plan,
      String(account.priority),
      ...(resets
        ? [account.limitResets.length === 0 ? "" : String(account.limitResets.length)]
        : []),
      statusText(account, now),
    ]),
  ]
  return [...table(rows), "", ...pools.map((pool) => formatPool(pool, accounts, now))].join("\n")
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
    provider: Argument.Literals("provider", Provider.literals).pipe(
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
              account.label.trim().toLowerCase() === wanted ||
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

/** The windows a limit reset refills, by the owner's names for them: "5-hour, Weekly". */
const refillsText = (reset: LimitResetView) =>
  reset.refills.length === 0 ? "nothing it names" : reset.refills.map((w) => w.label).join(", ")

/** The limit resets of `accounts` as an aligned table, the soonest to expire first. */
const formatResets = (accounts: ReadonlyArray<ListedAccount>, now: number) =>
  table([
    ["ACCOUNT", "PROVIDER", "RESET", "REFILLS", "EXPIRES"],
    ...accounts
      .flatMap((account) => account.limitResets.map((reset) => ({ account, reset })))
      .toSorted((a, b) => (a.reset.expiresAt ?? Infinity) - (b.reset.expiresAt ?? Infinity))
      .map(({ account, reset }) => [
        account.label,
        account.provider,
        reset.name,
        refillsText(reset),
        `${expiryText(reset.expiresAt, now)}${reset.usableNow ? "" : `  (not usable now: ${reset.unavailableReason ?? "no reason given"})`}`,
      ]),
  ]).join("\n")

const resets = Command.make(
  "resets",
  {
    account: accountArgument.pipe(Argument.optional),
    json: jsonFlag,
  },
  Effect.fn("accounts.resets")(function* ({ account: query, json }) {
    const accounts = Option.isSome(query)
      ? [yield* findAccount(query.value)]
      : (yield* listAccounts.pipe(Effect.mapError(asUserError))).accounts
    if (json) {
      return yield* Console.log(
        JSON.stringify(
          accounts.map(({ id, provider, label, email, limitResets }) => ({
            id,
            provider,
            label,
            email,
            limitResets,
          })),
          null,
          2,
        ),
      )
    }
    const [only] = accounts
    if (accounts.every((account) => account.limitResets.length === 0)) {
      return yield* Console.log(
        Option.isSome(query) && only !== undefined
          ? `${describe(only)} holds no limit resets.`
          : "No account holds a limit reset.",
      )
    }
    yield* Console.log(formatResets(accounts, yield* Clock.currentTimeMillis))
  }),
).pipe(
  Command.withDescription(
    "List each account's limit resets, or one account's: what each refills and when it expires",
  ),
)

/** One limit reset in a list to pick from: its name, id and expiry. */
const resetLines = (candidates: ReadonlyArray<LimitResetView>, now: number) => {
  const rows = table(
    candidates.map((reset) => [
      reset.name,
      reset.id,
      `expires ${expiryText(reset.expiresAt, now)}`,
    ]),
  )
  return rows.map((row) => `  ${row}`)
}

/** What a limit reset is named by, ignoring case: its name and its id. */
const namesOf = (reset: LimitResetView) => [reset.name.toLowerCase(), reset.id.toLowerCase()]

/**
 * The limit reset of `account` that `query` names: the one whose name or id
 * is `query`, ignoring case, else the one whose name or id starts with it.
 * With no `query`, the account's only one. Anything else fails, listing what
 * it could mean.
 */
const pickReset = (account: ListedAccount, query: Option.Option<string>, now: number) =>
  Effect.gen(function* () {
    const all = account.limitResets
    const owner = `${providerNames[account.provider]} account "${account.label}"`
    if (all.length === 0) return yield* userError(`${describe(account)} holds no limit resets.`)
    if (Option.isNone(query)) {
      const [only] = all
      if (all.length === 1 && only !== undefined) return only
      return yield* userError(
        [
          `${owner} holds ${all.length} limit resets. Name one with --reset:`,
          ...resetLines(all, now),
        ].join("\n"),
      )
    }
    const wanted = query.value.trim().toLowerCase()
    const exact = all.filter((reset) => namesOf(reset).includes(wanted))
    const matches =
      wanted === ""
        ? []
        : exact.length > 0
          ? exact
          : all.filter((reset) => namesOf(reset).some((name) => name.startsWith(wanted)))
    const [match] = matches
    if (match === undefined) {
      return yield* userError(
        [
          `No limit reset of ${owner} matches "${query.value}". Name one by the start of its name or id:`,
          ...resetLines(all, now),
        ].join("\n"),
      )
    }
    if (matches.length > 1) {
      return yield* userError(
        [
          `"${query.value}" matches ${matches.length} limit resets. Name one by more of its name or id:`,
          ...resetLines(matches, now),
        ].join("\n"),
      )
    }
    return match
  })

/** What redeeming does to the account's reset schedule, by provider. */
const sideEffects = {
  claude: "Claude keeps this account's weekly reset day.",
  codex: "Codex moves this account's weekly refresh to a week from now.",
} as const

/** What the owner is asked to confirm: the reset, how used each window it refills is now, and what happens to the schedule. */
const redeemQuestion = (
  account: ListedAccount,
  reset: LimitResetView,
  windows: ReadonlyArray<{ readonly id: string; readonly usedPct: number }>,
  now: number,
) => {
  const width = Math.max(...reset.refills.map((window) => window.label.length))
  return [
    `Redeem "${reset.name}" on ${describe(account)}?`,
    ...(reset.refills.length === 0
      ? ["  It refills no window agent-proxy shows."]
      : [
          "  It refills:",
          ...reset.refills.map((refilled) => {
            const used = windows.find((window) => window.id === refilled.id)?.usedPct
            return `    ${refilled.label.padEnd(width)}  ${used === undefined ? "not read yet" : `${used}% used`}`
          }),
        ]),
    `  ${sideEffects[account.provider]}`,
    `  It expires ${expiryText(reset.expiresAt, now)}. A redeem can't be undone.`,
  ].join("\n")
}

const redeem = Command.make(
  "redeem",
  {
    account: accountArgument,
    reset: Flag.String("reset").pipe(
      Flag.optional,
      Flag.withDescription(
        "The limit reset to redeem, by the start of its name or id; needed when the account holds several",
      ),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Redeem without asking first"),
    ),
  },
  Effect.fn("accounts.redeem")(function* ({ account: query, reset: resetQuery, yes }) {
    const now = yield* Clock.currentTimeMillis
    const account = yield* findAccount(query)
    const reset = yield* pickReset(account, resetQuery, now)
    if (!reset.usableNow) {
      return yield* userError(
        `"${reset.name}" cannot be redeemed now: ${reset.unavailableReason ?? `${providerNames[account.provider]} gives no reason`}.`,
      )
    }
    if (!yes) {
      if (!(yield* RuntimeInfo).interactive) {
        return yield* userError(
          "Not redeemed: there is no terminal to confirm at. Run it again with --yes to redeem without asking.",
        )
      }
      const limits = yield* listLimits.pipe(Effect.mapError(asUserError))
      const windows = limits.find((entry) => entry.accountId === account.id)?.windows ?? []
      yield* Console.log(redeemQuestion(account, reset, windows, now))
      if (!(yield* confirm("Redeem?"))) return yield* Console.log("Nothing redeemed.")
    }
    const result = yield* redeemReset(account.id, reset.id).pipe(
      // The daemon answered moments ago: no answer now may come after it redeemed.
      Effect.catchTag("DaemonNotRunning", () =>
        userError(
          `No answer came back from the daemon, so whether "${reset.name}" was redeemed is unknown. Run \`agent-proxy accounts resets ${query}\` once it answers: a redeemed one is no longer listed.`,
        ),
      ),
      Effect.mapError(asUserError),
    )
    if (result.outcome !== "redeemed") return yield* userError(result.message)
    yield* Console.log(result.message)
  }),
).pipe(
  Command.withDescription(
    "Redeem one of an account's limit resets, after asking; it refills the windows it names",
  ),
)

const set = Command.make(
  "set",
  {
    account: accountArgument,
    label: Flag.String("label").pipe(Flag.optional, Flag.withDescription("A new label")),
    priority: Flag.Int("priority").pipe(
      Flag.optional,
      Flag.withDescription(
        "A priority in its pool, 1 first, to hold alone; the accounts from there down move down one",
      ),
    ),
    shareWith: Flag.String("share-priority-with").pipe(
      Flag.optional,
      Flag.withDescription(
        "Another account in its pool (label, email or id start) whose priority it then shares; new sessions go to whichever has the most headroom",
      ),
    ),
  },
  Effect.fn("accounts.set")(function* ({ account: query, label, priority, shareWith }) {
    if (Option.isNone(label) && Option.isNone(priority) && Option.isNone(shareWith)) {
      return yield* userError(
        "Nothing to change. Give --label, and --priority or --share-priority-with.",
      )
    }
    if (Option.isSome(priority) && Option.isSome(shareWith)) {
      return yield* userError("Give --priority or --share-priority-with, not both.")
    }
    if (Option.isSome(label) && label.value.trim() === "") {
      return yield* userError("A label cannot be blank.")
    }
    const before = yield* findAccount(query)
    const partner = Option.isSome(shareWith) ? yield* findAccount(shareWith.value) : undefined
    const after = yield* updateAccount(before.id, {
      ...(Option.isSome(label) ? { label: label.value.trim() } : {}),
      ...(Option.isSome(priority) ? { priority: priority.value } : {}),
      ...(partner === undefined ? {} : { sharePriorityWith: partner.id }),
    }).pipe(Effect.mapError(asUserError))
    if (Option.isSome(label)) {
      yield* Console.log(`Renamed ${describe(before)} to "${after.label}".`)
    }
    if (Option.isSome(priority)) {
      yield* Console.log(`Moved ${describe(after)} to priority ${after.priority}.`)
    }
    if (partner !== undefined) {
      yield* Console.log(
        partner.id === after.id
          ? `${describe(after)} stays at priority ${after.priority}.`
          : `${describe(after)} now shares priority ${after.priority} with "${partner.label}".`,
      )
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
    yield* Console.log(
      json ? JSON.stringify(list, null, 2) : formatAccounts(list, yield* Clock.currentTimeMillis),
    )
  }),
).pipe(
  Command.withDescription("List accounts with their status, or add, change or remove one"),
  Command.withSubcommands([add, set, enable, disable, remove, resets, redeem]),
)
