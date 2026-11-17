# Claude proxy

The daemon serves Claude Code on its listen address: with `ANTHROPIC_BASE_URL` pointing at the daemon and `apiKeyHelper` set to `agent-proxy key`, Claude Code's requests go to Claude as an account the daemon chooses from the Claude pool: a session stays on its account (ADR-0003), a new session goes to the highest-priority Active account, and an account that hits a limit cools down while the request moves to the next account before the client sees anything. Every request must carry the proxy key as `x-api-key` or `Authorization: Bearer`; the proxy replaces it with the account's OAuth token, adds the `oauth-2025-04-20` beta only when the client did not send it, and changes nothing else (ADR-0006). Claude's answer, including its status, `anthropic-ratelimit-unified-*` headers and streamed events, reaches the client as Claude sent it, event by event. The proxy's own errors use Anthropic's error format, so Claude Code shows their message.

## Sub-features

- `proxy-routes` serves `POST /v1/messages` and `POST /v1/messages/count_tokens`, query string included (Claude Code sends `?beta=true`), from `https://api.anthropic.com`.
- `proxy-hello` answers Claude Code's startup check, `HEAD /api/hello`, with 200 and no key.
- `proxy-no-key` a request with no key, or an empty one, gets 401 `authentication_error`: ``agent-proxy: no proxy key sent. Send the key `agent-proxy key` prints, as the x-api-key header or as Authorization: Bearer.``
- `proxy-wrong-key` a request with another key gets 401 `authentication_error`: ``agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.`` The key sent never appears in the answer.
- `proxy-account` the highest-priority Active Claude account serves a new session or a request with no session; accounts that need sign-in, are disabled or are cooling down are skipped; accounts sharing a priority go by the most headroom (`-5h-` and `-7d-utilization`), unknown counting as full.
- `proxy-sessions` requests with the same `x-claude-code-session-id` (subagents send their parent's) stay on the account that served the first, even after a higher-priority account becomes Active; a session idle for an hour, or whose account stops being Active or is removed, goes by priority again.
- `proxy-failover` a 429 before any byte reaches the client cools the account and sends the request to the next account, transparently: a window rejection (`anthropic-ratelimit-unified-status` or `-5h-`/`-7d-status: rejected`) until the latest rejected window's `-reset`, any other 429 for `Retry-After` only; `daemon.log` gets `"account cooling down"` with `account`, `until` and `window`. A failure after the answer has started streaming reaches the client as it is.
- `proxy-cooling-down` with every enabled Claude account cooling down (others may need sign-in), 429 `rate_limit_error` `agent-proxy: every Claude account is cooling down. The first is available again at <ISO time>.` with `retry-after`, `anthropic-ratelimit-unified-status: rejected`, `-unified-reset`, and for a window its `-representative-claim` and `-5h-`/`-7d-status` and `-reset`; when the account that just answered is the one that resets first, its own 429 reaches the client instead.
- `proxy-token-retry` when Claude answers 401, the account's tokens are refreshed once and the request is retried on the same account; a second 401 reaches the client. A refresh that is refused flags the account Needs sign-in, and the request goes to the next Active account or gets the `no Claude account available` error.
- `proxy-no-account` with no Claude account, 400 `invalid_request_error` ``agent-proxy: no Claude account. Add one with `agent-proxy accounts add claude`.``; with every Claude account needing sign-in or disabled, 400 ``agent-proxy: no Claude account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.``
- `proxy-passthrough` Claude sees the account's bearer token and the client's other headers and body unchanged; the client sees Claude's status, headers (limit headers and `request-id` included), and body unchanged, compressed or streamed.
- `proxy-unreachable` when Claude cannot be reached, 502 `api_error` `agent-proxy: could not reach Claude. Check this machine's network connection.`, logged as `"could not reach Claude"` in `daemon.log`.

## How to get to it (user POV)

- Point Claude Code at the daemon with `agent-proxy connect claude-code` (see [Connect](./connect.md)), which writes `"env": { "ANTHROPIC_BASE_URL": "<daemon address>" }` and `"apiKeyHelper": "agent-proxy key"` into `~/.claude/settings.json`; or add them by hand.
- Send any Anthropic API client's requests to the daemon's address with the key from `agent-proxy key`.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.
- The daemon is running in the run: `verify cli -- daemon start` exits `0`.
- `jq` and `curl` are on `PATH`.

Every drive below runs inside `verify shell -- -c '…'` and starts with these definitions; `m` sends a short message request with extra curl arguments, such as a key header:

```sh
a=$(jq -r .address "$XDG_STATE_HOME/agent-proxy/daemon.json"); k=$(bun apps/cli/src/bin.ts key)
m() { curl -s -w " HTTP %{http_code}\n" -X POST "$a/v1/messages?beta=true" -H "content-type: application/json" -H "anthropic-version: 2023-06-01" "$@" -d "{\"model\":\"claude-haiku-4-5\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"; }
```

- **Keys.** Run `m`, `m -H "x-api-key: ap-wrong"`, `m -H "authorization: Bearer ap-wrong"`, and `curl -s -I "$a/api/hello" | head -1`. The first prints the `no proxy key sent` error and `HTTP 401`; the next two the `wrong proxy key` error and `HTTP 401`, without `ap-wrong`; the last `HTTP/1.1 200 OK`.
- **No account.** Run `m -H "x-api-key: $k" -H "authorization: Bearer $k"`. It prints the `no Claude account. Add one …` error and `HTTP 400`.
- **Accounts that cannot serve, then one that can.** Seed accounts as in the [accounts](./accounts.md) Seeded list drive, with `seed s1 me@home.example Pro Home 1 true true` (needs sign-in). `m -H "x-api-key: $k"` prints the `every account needs sign-in or is disabled` error and `HTTP 400`. Seed `seed s2 spare@example.com Pro Spare 2 true false` (Active, with the seeded junk token). `m -H "x-api-key: $k" -H "authorization: Bearer $k"` now reaches the real Claude API with the seeded junk token, which Claude rejects with a 401. The proxy then refreshes the account with its junk refresh token, which Claude refuses, so it prints the `every account needs sign-in or is disabled` error and `HTTP 400`; `bun apps/cli/src/bin.ts accounts` shows Spare as `Needs sign-in`, and `daemon.log` has an `"account needs sign-in"` line whose `reason` starts `The refresh was refused:`.
- **Refresh and retry on a 401.** Start a fake outside the run on `127.0.0.1:51997` whose `POST /v1/oauth/token` answers any refresh with `{"access_token":"new-access-<n>","refresh_token":"good-<n>","expires_in":28800}`, and whose other paths answer 401 `authentication_error` to `Authorization: Bearer old-access` and 200 `{"type":"message","served_with":"<authorization>"}` to any other token, logging each request. In a new run, seed one Active account as in the [accounts](./accounts.md) Seeded list, with `"accessToken":"old-access"` and `"refreshToken":"good-0"`, then `verify cli --env 'AGENT_PROXY_PROVIDER_ENDPOINTS={"claude":{"apiBaseUrl":"http://127.0.0.1:51997","tokenUrl":"http://127.0.0.1:51997/v1/oauth/token"}}' -- daemon start`. Run `m -H "x-api-key: $k"` twice: both print `{"type":"message","served_with":"Bearer new-access-1"} HTTP 200`. The fake logs `Bearer old-access`, one refresh of `good-0`, then `Bearer new-access-1` twice, and the account file holds `new-access-1`.
- **Sessions, failover and cooldowns.** A fake Claude API on `127.0.0.1:52195` and a fake Codex backend on `127.0.0.1:52194` run outside the run, log each request's token and session header, and answer by the account token: Claude `token-a1` with 429 and `anthropic-ratelimit-unified-status`/`-5h-status: rejected` and `-reset` 47 minutes ahead, `token-a3` with a per-minute 429 (`retry-after: 30`, `unified-status: allowed`), any other with 200 `{"type":"message","served_with":"<authorization>"}`; Codex `token-c1` and `token-c2` with 429 `{"error":{"type":"usage_limit_reached","resets_at":<18 and 72 minutes ahead>}}`. Seed Claude `a1` (Work, 1), `a2` (Home, 2), `a3` (Spare, 3) and Codex `c1` (carol, 1), `c2` (dave, 2), all Active, with the [accounts](./accounts.md) Seeded list's `seed` taking the provider too and writing `"accessToken":"token-<id>"`; then `verify cli --built --env 'AGENT_PROXY_PROVIDER_ENDPOINTS={"claude":{"apiBaseUrl":"http://127.0.0.1:52195"},"codex":{"apiBaseUrl":"http://127.0.0.1:52194"}}' -- daemon start`. With `m` as above plus `-H "x-api-key: $k"`:
  - `m -H "x-claude-code-session-id: S1"` prints `"served_with":"Bearer token-a2"` and `HTTP 200`; the fake logs `token-a1` then `token-a2`. Again with `S1`, and with no session: `token-a2` each time, and the fake logs no more `token-a1`.
  - `bun apps/cli/dist/bin.js accounts` shows Work `Cooling down until <local time 47 minutes ahead>` and `New Claude sessions go to "Home".`; `daemon.log` has `"account cooling down"` for `a1` with `"window":"five_hour"`.
  - `accounts disable Home`, then `m -D -`: the fake logs `token-a3`, and the client gets Spare's own per-minute 429 (`retry-after: 30`, `"message":"per minute"`). `m -D -` again prints the proxy's `every Claude account is cooling down` 429 with `retry-after`, `anthropic-ratelimit-unified-status: rejected` and `-unified-reset`, and the fake logs nothing new. `accounts` ends `No Claude account can take new sessions until <time>, when the first cooldown ends.`
- **Rotated key.** Follow the Rotate drive in the [key](./key.md) feature: the old key gets the proxy's `wrong proxy key` 401, the new key reaches Claude.
- **Real limit (owner only).** With two real Claude accounts and one near its 5-hour limit at priority 1, work in Claude Code until it hits the limit: the conversation carries on without an error on the second account, `accounts` shows the first `Cooling down until <its reset>`, and once both are limited Claude Code shows "5-hour limit reached" with the reset time.
- **Real Claude Code (owner only).** With a real account added (`accounts add claude`), and Claude Code pointed at the daemon as above, run `claude` in a scratch directory and hold a two-turn conversation (for example "Remember the number 7." then "What number did I ask you to remember?"). Both turns answer; the second recalls the first. `/context` works (it calls `count_tokens`). Then run `agent-proxy key --rotate` in another terminal and send a third turn: it answers without a restart, because Claude Code runs `apiKeyHelper` again after the 401. Claude Code shows "API Usage Billing", because it sees an API key; that is expected.

## Gotchas

- Cooldowns, session bindings and headroom live in memory: `daemon stop` and `start` forget them all, and the next limit answer starts a cooldown again.
- A session is known only by `x-claude-code-session-id`; `curl` without it is routed by priority each time, so drive stickiness with the header.

- The seeded-account drive sends one request to the real `api.anthropic.com` and one refresh to the real `platform.claude.com` token endpoint, both with junk tokens. It contacts Claude but spends nothing; skip it offline, where it gets the `could not reach Claude` 502 instead.
- `curl` adds no `anthropic-beta`, so the proxy adds `oauth-2025-04-20` before forwarding; Claude Code 2.1.326 does not send it either.
- Without `-D -`, curl shows only the body; Claude's limit headers appear only on answers from a real account.
- The daemon's address changes on each start with the `listen = "127.0.0.1:0"` fixture; read it from the state file every time.
- The live drive needs the owner's real Claude account and a terminal; it cannot run unattended.
- `AGENT_PROXY_PROVIDER_ENDPOINTS` with an `apiBaseUrl` (see [accounts](./accounts.md)) points proxied requests at another Claude API, such as a fake, for drives that must not reach Anthropic.
