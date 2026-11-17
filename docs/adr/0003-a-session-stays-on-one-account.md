# A session stays on one account

When a provider's pool has several accounts, each session is bound to one account and stays there until that account enters a cooldown. A new session goes to the highest-priority account not in a cooldown; headroom breaks ties only among accounts of equal priority, so the owner's priorities always win. We chose this over round-robin, CLIProxyAPI's default, because providers cache prompts per account: switching accounts mid-session re-sends the whole context uncached on every turn, which spends limits faster and slows responses. CLIProxyAPI's issue tracker is full of cache-miss reports that trace back to this.

## Considered Options

- **Round-robin per request.** Spreads load evenly but destroys prompt caching within a session.
- **Fill-first.** Uses accounts in priority order and moves on only at a limit. Keeps caching, but drains one account while others idle, and is the fallback if session binding proves fiddly.

## Consequences

- The proxy must identify sessions from what clients already send. A request with no recognisable session gets no binding.
- Priority and enabled/disabled are per-account settings, kept with the account. There is no global strategy setting until a real need for one appears.
- Breaking ties by headroom means the proxy reads each provider's limit signals from responses, even before the dashboard shows usage.
