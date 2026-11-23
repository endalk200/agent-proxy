# Limit resets are redeemed only at the owner's command, through the providers' own client endpoints

Claude and Codex both hand out limit resets, single-use grants that refill an account's limit windows early, and they expire if nobody redeems them. The daemon reads each account's limit resets with its limit windows and redeems one only when the owner asks, from the dashboard or `agent-proxy accounts redeem`, both through the daemon API. It never redeems one on its own. A redeem can't be undone, resets are scarce, and the providers' side effects differ: a Codex reset moves the weekly refresh to a week from the redeem, while a Claude reset keeps the weekly reset day. So the choice of which reset to spend, and when, stays the owner's.

Neither provider documents an API for limit resets. The daemon calls the endpoints their own clients call: Codex CLI's `/wham/rate-limit-reset-credits` and its `/consume`, and Claude Code's `/api/oauth/usage?cedar_ember=1` and `/api/organizations/{org}/reset_rate_limits`. Claude lists grants only to its Claude Code surface, which it recognises by the `claude-cli/<version> (external, cli)` user agent, so the daemon's own Claude calls send that agent, with the version taken from the newest Claude Code request it has served. All of this can change without notice. When a read fails or comes back in a shape the daemon doesn't recognise, the account shows no resets and keeps serving.

## Considered Options

- **Redeem automatically when a pool runs dry**, as Codex desktop's "Allow your assistant to use resets" does. Rejected for now: it would spend a scarce, irreversible grant on whatever session happened to be running, and on Codex it would move the weekly refresh without the owner knowing.
- **Show resets and link out to each provider's own page.** No private endpoints, but Claude Code doesn't offer the redeem itself, and the dashboard would show what it can't act on.
- **Send no client user agent.** More honest about what is calling, but Claude then reports every account as ineligible and shows none of its resets.

## Consequences

- Buying a reset stays in the browser. Codex sells some accounts an instant reset only at `chatgpt.com/codex/purchase/reset`, and the dashboard links there only when the provider says the account is eligible.
- Usage credits, the pay-as-you-go billing past a limit, are not limit resets, and the daemon doesn't touch them.
