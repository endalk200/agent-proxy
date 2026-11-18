import { Data, Runtime } from "effect"
import { CliError } from "effect/cli"

/** Shows an error's own message to the user, without a stack trace. */
export const asUserError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message })

export const userError = (userMessage: string) =>
  new CliError.UserError({ cause: undefined, userMessage })

/** Exits with `code` and prints nothing more: the command has already said what it had to. */
export class ExitCode extends Data.TaggedError("ExitCode")<{ readonly code: number }> {
  // `false` tells the runtime not to report this failure.
  override readonly [Runtime.errorReported] = false
  override get [Runtime.errorExitCode]() {
    return this.code
  }
}
