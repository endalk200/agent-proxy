# How requests are routed

A session stays on one account, so the provider's prompt cache keeps working ([ADR-0003](adr/0003-a-session-stays-on-one-account.md)). The daemon knows a session by what the client sends: Claude Code's `x-claude-code-session-id` (its subagents send their parent's), Codex's `session-id`, or, from opencode, the body's `prompt_cache_key`. A session's first request goes to the highest-priority Active account of its pool; among accounts that share a priority, it goes to the one with the most room left in its tightest 5-hour or weekly limit window, as the dashboard shows it (see [Usage and limit windows](usage.md)). Give several accounts one priority to spread new sessions across them; give each its own to use one until it hits a limit. The session then stays on that account until the account stops being Active or the session sits idle for an hour. A request that names no session is routed afresh every time. Sessions live in memory only.

When an account hits a limit, the daemon cools it down for as long as the provider says:

- a Claude window rejection (`anthropic-ratelimit-unified-*-status: rejected`) until that window resets;
- a Codex `usage_limit_reached` until its `resets_at`, for every model the account serves;
- any other 429, such as a per-minute rate limit, for its `Retry-After` only.

If nothing has reached the client yet, the request goes straight to the next account and the session moves with it, so the client never notices. A failure after the answer has started streaming reaches the client as it is. When every account in the pool is cooling down, the client gets the provider's own limit answer with the earliest reset: Claude Code shows the limit and when it resets, and Codex shows its usage-limit message. When every account needs sign-in or is disabled, the client gets a 400 saying so at once. The daemon keeps each cooldown in its usage store too, so after a restart it still skips the account until its limit resets.
