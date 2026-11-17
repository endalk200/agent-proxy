import { CliError } from "effect/cli"

/** Shows an error's own message to the user, without a stack trace. */
export const asUserError = (error: { readonly message: string }) =>
  new CliError.UserError({ cause: error, userMessage: error.message })

export const userError = (userMessage: string) =>
  new CliError.UserError({ cause: undefined, userMessage })
