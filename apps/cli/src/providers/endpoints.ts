import { Context, Layer } from "effect"

/** Where Claude's OAuth login lives, and the loopback port its redirect returns to. */
export interface ClaudeOAuthEndpoints {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly profileUrl: string
  /** The port the login's callback listener binds on 127.0.0.1. Port 0 binds any free port. */
  readonly callbackPort: number
}

/**
 * The providers' URLs. The daemon reaches providers only through these, so
 * tests point it at fake providers by providing a different layer.
 */
export class ProviderEndpoints extends Context.Service<
  ProviderEndpoints,
  { readonly claude: ClaudeOAuthEndpoints }
>()("agent-proxy/ProviderEndpoints") {
  /** The real providers, as confirmed by the spike against Claude Code 2.1.326. */
  static readonly layer = Layer.succeed(
    ProviderEndpoints,
    ProviderEndpoints.of({
      claude: {
        authorizeUrl: "https://claude.com/cai/oauth/authorize",
        tokenUrl: "https://platform.claude.com/v1/oauth/token",
        profileUrl: "https://api.anthropic.com/api/oauth/profile",
        callbackPort: 54_545,
      },
    }),
  )
}
