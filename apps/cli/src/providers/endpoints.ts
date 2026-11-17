import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect"

/** Where Claude's OAuth login lives, and the loopback port its redirect returns to. */
export interface ClaudeOAuthEndpoints {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly profileUrl: string
  /** The port the login's callback listener binds on 127.0.0.1. Port 0 binds any free port. */
  readonly callbackPort: number
}

export interface Endpoints {
  readonly claude: ClaudeOAuthEndpoints
}

/** The real providers, as confirmed by the spike against Claude Code 2.1.326. */
export const realEndpoints: Endpoints = {
  claude: {
    authorizeUrl: "https://claude.com/cai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    profileUrl: "https://api.anthropic.com/api/oauth/profile",
    callbackPort: 54_545,
  },
}

/**
 * Names the environment variable that points the daemon at other provider
 * endpoints: a JSON object shaped like `Endpoints`, any field optional, laid
 * over the real ones. It exists so verification runs and e2e tests can sign in
 * against fake providers through the built binary. It is not a setting for owners.
 */
export const ENDPOINTS_OVERRIDE = "AGENT_PROXY_PROVIDER_ENDPOINTS"

const Override = Schema.fromJsonString(
  Schema.Struct({
    claude: Schema.optionalKey(
      Schema.Struct({
        authorizeUrl: Schema.optionalKey(Schema.String),
        tokenUrl: Schema.optionalKey(Schema.String),
        profileUrl: Schema.optionalKey(Schema.String),
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
      })
    }).pipe(Effect.mapError((cause) => new EndpointsOverrideError({ cause }))),
  )
}
