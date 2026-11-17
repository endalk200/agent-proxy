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

import type { AccountStatus, Provider } from "../accounts/account.ts"
import { Browser } from "../browser.ts"
import type { AccountView, LoginView } from "../daemon/api.ts"
import {
  cancelLogin,
  type DaemonApiError,
  type DaemonNotRunning,
  type DaemonUnexpectedResponse,
  getLogin,
  listAccounts,
  startLogin,
  submitCallback,
} from "../daemon/client.ts"
import { asUserError, userError } from "./errors.ts"

const providerNames: Readonly<Record<Provider, string>> = { claude: "Claude" }

const statusNames: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  "needs-sign-in": "Needs sign-in",
  disabled: "Disabled",
}

/** The accounts as an aligned table, or how to add the first one. */
export const formatAccounts = (accounts: ReadonlyArray<AccountView>): string => {
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
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n")
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
    yield* browser
      .open(login.authorizeUrl)
      .pipe(
        Effect.catchTag("BrowserError", () =>
          Console.log("Could not open a browser. Open the URL above yourself."),
        ),
      )
    return yield* awaitLogin(login.id)
  })

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

export const accountsCommand = Command.make(
  "accounts",
  { json: jsonFlag },
  Effect.fn("accounts")(function* ({ json }) {
    const { accounts } = yield* listAccounts.pipe(Effect.mapError(asUserError))
    yield* Console.log(json ? JSON.stringify({ accounts }, null, 2) : formatAccounts(accounts))
  }),
).pipe(
  Command.withDescription("List accounts with their status, or add one"),
  Command.withSubcommands([add]),
)
