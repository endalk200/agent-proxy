import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect"

/**
 * Where Claude's API and OAuth login live, and the loopback port the login's
 * redirect returns to.
 */
export interface ClaudeEndpoints {
  /** The origin of Claude's API, which proxied requests go to with their path and query. */
  readonly apiBaseUrl: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly profileUrl: string
  /** The port the login's callback listener binds on 127.0.0.1. Port 0 binds any free port. */
  readonly callbackPort: number
}

/**
 * Where the Codex backend and OpenAI's OAuth login live, and the loopback port
 * the login's redirect returns to.
 */
export interface CodexEndpoints {
  /**
   * The origin of the Codex backend, which proxied requests go to with their
   * path (`/backend-api/codex/…`) and query.
   */
  readonly apiBaseUrl: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  /** The port the login's callback listener binds on 127.0.0.1. Port 0 binds any free port. */
  readonly callbackPort: number
}

export interface Endpoints {
  readonly claude: ClaudeEndpoints
  readonly codex: CodexEndpoints
}

/**
 * The real providers, as confirmed by the spike against Claude Code 2.1.326
 * and codex-cli 0.169.0.
 */
export const realEndpoints: Endpoints = {
  claude: {
    apiBaseUrl: "https://api.anthropic.com",
    authorizeUrl: "https://claude.com/cai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    profileUrl: "https://api.anthropic.com/api/oauth/profile",
    callbackPort: 54_545,
  },
  codex: {
    apiBaseUrl: "https://chatgpt.com",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    // Codex's own callback port: OpenAI's OAuth client redirects only to Codex's ports.
    callbackPort: 1455,
  },
}

/**
 * Names the environment variable that points the daemon at other provider
 * endpoints: a JSON object shaped like `Endpoints`, any field optional, laid
 * over the real ones. It exists so verification runs and e2e tests can sign in
 * and proxy against fake providers through the built binary. It is not a
 * setting for owners.
 */
export const ENDPOINTS_OVERRIDE = "AGENT_PROXY_PROVIDER_ENDPOINTS"

const Override = Schema.fromJsonString(
  Schema.Struct({
    claude: Schema.optionalKey(
      Schema.Struct({
        apiBaseUrl: Schema.optionalKey(Schema.String),
        authorizeUrl: Schema.optionalKey(Schema.String),
        tokenUrl: Schema.optionalKey(Schema.String),
        profileUrl: Schema.optionalKey(Schema.String),
        callbackPort: Schema.optionalKey(Schema.Int),
      }),
    ),
    codex: Schema.optionalKey(
      Schema.Struct({
        apiBaseUrl: Schema.optionalKey(Schema.String),
        authorizeUrl: Schema.optionalKey(Schema.String),
        tokenUrl: Schema.optionalKey(Schema.String),
        callbackPort: Schema.optionalKey(Schema.Int),
      }),
    ),
  }),
)

export class EndpointsOverrideError extends Data.TaggedError("EndpointsOverrideError")<{
  readonly cause: unknown
}> {
  override get message() {
    return `${ENDPOINTS_OVERRIDE} is not a valid endpoints override: ${String(this.cause)}`
  }
}

/**
 * The providers' URLs. The daemon reaches providers only through these, so
 * tests point it at fake providers by providing a different layer, and the
 * built binary by setting `AGENT_PROXY_PROVIDER_ENDPOINTS`.
 */
export class ProviderEndpoints extends Context.Service<ProviderEndpoints, Endpoints>()(
  "agent-proxy/ProviderEndpoints",
) {
  static readonly layer = Layer.effect(
    ProviderEndpoints,
    Effect.gen(function* () {
      const raw = yield* Config.option(Config.NonEmptyString(ENDPOINTS_OVERRIDE))
      if (Option.isNone(raw)) {
        return ProviderEndpoints.of(realEndpoints)
      }
      const override = yield* Schema.decodeEffect(Override)(raw.value)
      return ProviderEndpoints.of({
        claude: { ...realEndpoints.claude, ...override.claude },
        codex: { ...realEndpoints.codex, ...override.codex },
      })
    }).pipe(Effect.mapError((cause) => new EndpointsOverrideError({ cause }))),
  )
}
