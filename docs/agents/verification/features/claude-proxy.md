# Claude proxy

The daemon serves Claude Code on its listen address: with `ANTHROPIC_BASE_URL` pointing at the daemon and `apiKeyHelper` set to `agent-proxy key`, Claude Code's requests go to Claude as the highest-priority Active Claude account. Every request must carry the proxy key as `x-api-key` or `Authorization: Bearer`; the proxy replaces it with the account's OAuth token, adds the `oauth-2025-04-20` beta only when the client did not send it, and changes nothing else (ADR-0006). Claude's answer, including its status, `anthropic-ratelimit-unified-*` headers and streamed events, reaches the client as Claude sent it, event by event. The proxy's own errors use Anthropic's error format, so Claude Code shows their message.

## Sub-features

- `proxy-routes` serves `POST /v1/messages` and `POST /v1/messages/count_tokens`, query string included (Claude Code sends `?beta=true`), from `https://api.anthropic.com`.
- `proxy-hello` answers Claude Code's startup check, `HEAD /api/hello`, with 200 and no key.
- `proxy-no-key` a request with no key, or an empty one, gets 401 `authentication_error`: ``agent-proxy: no proxy key sent. Send the key `agent-proxy key` prints, as the x-api-key header or as Authorization: Bearer.``
- `proxy-wrong-key` a request with another key gets 401 `authentication_error`: ``agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.`` The key sent never appears in the answer.
- `proxy-account` the highest-priority Active Claude account serves the request; accounts that need sign-in or are disabled are skipped.
- `proxy-no-account` with no Claude account, 400 `invalid_request_error` ``agent-proxy: no Claude account. Add one with `agent-proxy accounts add claude`.``; with every Claude account needing sign-in or disabled, 400 ``agent-proxy: no Claude account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.``
- `proxy-passthrough` Claude sees the account's bearer token and the client's other headers and body unchanged; the client sees Claude's status, headers (limit headers and `request-id` included), and body unchanged, compressed or streamed.
- `proxy-unreachable` when Claude cannot be reached, 502 `api_error` `agent-proxy: could not reach Claude. Check this machine's network connection.`, logged as `"could not reach Claude"` in `daemon.log`.

## How to get to it (user POV)

- Point Claude Code at the daemon in `~/.claude/settings.json` (by hand until `agent-proxy connect claude-code` exists): `"env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318" }` and `"apiKeyHelper": "agent-proxy key"`, with the daemon's address from `agent-proxy daemon status`.
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
- **Accounts that cannot serve, then one that can.** Seed accounts as in the [accounts](./accounts.md) Seeded list drive, with `seed s1 me@home.example Pro Home 1 true true` (needs sign-in). `m -H "x-api-key: $k"` prints the `every account needs sign-in or is disabled` error and `HTTP 400`. Seed `seed s2 spare@example.com Pro Spare 2 true false` (Active, with the seeded junk token). `m -H "x-api-key: $k" -H "authorization: Bearer $k"` now reaches the real Claude API, which answers `{"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."},"request_id":"req_…"}` and `HTTP 401`: Claude got the account's token as an OAuth bearer, not the proxy key, and its answer came back unchanged. Adding `-D -` to `m` shows Claude's `request-id` header.
- **Rotated key.** Follow the Rotate drive in the [key](./key.md) feature: the old key gets the proxy's `wrong proxy key` 401, the new key reaches Claude.
- **Real Claude Code (owner only).** With a real account added (`accounts add claude`), and Claude Code pointed at the daemon as above, run `claude` in a scratch directory and hold a two-turn conversation (for example "Remember the number 7." then "What number did I ask you to remember?"). Both turns answer; the second recalls the first. `/context` works (it calls `count_tokens`). Then run `agent-proxy key --rotate` in another terminal and send a third turn: it answers without a restart, because Claude Code runs `apiKeyHelper` again after the 401. Claude Code shows "API Usage Billing", because it sees an API key; that is expected.

## Gotchas

- The seeded-account drive sends one request to the real `api.anthropic.com` with a junk token. It contacts Claude but spends nothing; skip it offline, where it gets the `could not reach Claude` 502 instead.
- `curl` adds no `anthropic-beta`, so the proxy adds `oauth-2025-04-20` before forwarding; Claude Code 2.1.326 does not send it either.
- Without `-D -`, curl shows only the body; Claude's limit headers appear only on answers from a real account.
- The daemon's address changes on each start with the `listen = "127.0.0.1:0"` fixture; read it from the state file every time.
- The live drive needs the owner's real Claude account and a terminal; it cannot run unattended.
