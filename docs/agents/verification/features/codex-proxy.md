# Codex proxy

The daemon serves Codex on its listen address: with a custom Codex provider named `OpenAI` whose `base_url` is the daemon's address plus `/backend-api/codex` and whose `auth` command is `agent-proxy key`, Codex's requests go to the Codex backend at `https://chatgpt.com` as the highest-priority Active Codex account; opencode's OpenAI Responses provider works the same way. A Codex client spends only Codex accounts, and a Claude client only Claude accounts. Every request must carry the proxy key as `Authorization: Bearer` or `x-api-key`; the proxy replaces it with the account's OAuth token, sets `chatgpt-account-id` to the account's ChatGPT workspace, and changes nothing else (ADR-0006): the client's `session-id`, `originator`, other headers and body arrive as sent. The backend's answer, including its status, `x-codex-*` headers (`x-codex-turn-state` too) and streamed events, reaches the client as sent, event by event; a redirect is passed back, never followed. The proxy's own errors use OpenAI's error format, so Codex and opencode show their message.

## Sub-features

- `codex-routes` serves `POST /backend-api/codex/responses` (streamed), `GET /backend-api/codex/models` with its `?client_version=` query, and `POST /backend-api/codex/alpha/search` (standalone web search) from `https://chatgpt.com`, path and query unchanged.
- `codex-websocket` refuses the WebSocket upgrade (`GET /backend-api/codex/responses` with `Upgrade: websocket`) with 426 `{"error":{"message":"agent-proxy: WebSocket is not supported. Send the request over HTTP.","type":"invalid_request_error","param":null,"code":null}}`, without needing the key; Codex and opencode then fall back to HTTP.
- `codex-no-key` a request with no key gets 401 `{"error":{"message":"agent-proxy: no proxy key sent. …","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}`; `codex-wrong-key` another key gets 401 with ``agent-proxy: wrong proxy key. Run `agent-proxy key` to see the current key.``, never echoing the key sent.
- `codex-account` the highest-priority Active Codex account serves the request; accounts that need sign-in or are disabled are skipped; Claude accounts never serve a Codex request, nor Codex accounts a Claude one.
- `codex-token-retry` when the backend answers 401, the account's tokens are refreshed once (the rejected answer's body is cancelled, not read) and the request is retried on the same account; a refresh that is refused flags the account Needs sign-in, and the request goes to the next Active Codex account or gets the `no Codex account available` error.
- `codex-no-account` with no Codex account, 400 ``agent-proxy: no Codex account. Add one with `agent-proxy accounts add codex`.``; with every Codex account needing sign-in or disabled, 400 ``agent-proxy: no Codex account available, every account needs sign-in or is disabled. Run `agent-proxy accounts`.``; both `invalid_request_error`, the status every client shows at once.
- `codex-passthrough` the backend sees `Authorization: Bearer <account token>` and `chatgpt-account-id: <account id>` (replacing any the client sent), no `x-api-key`, and the client's other headers and body unchanged; the client sees the backend's status, headers and body unchanged, streamed.
- `codex-unreachable` when the backend cannot be reached, 502 `server_error` `agent-proxy: could not reach Codex. Check this machine's network connection.`, logged as `"could not reach Codex"` in `daemon.log`.

## How to get to it (user POV)

- Add a Codex account (`agent-proxy accounts add codex`, see [Accounts](./accounts.md)), then point Codex at the daemon with `agent-proxy connect codex` (see [Connect](./connect.md)), which writes into `~/.codex/config.toml`:

  ```toml
  model_provider = "agent-proxy"
  
  [model_providers.agent-proxy]
  name = "OpenAI"
  base_url = "http://127.0.0.1:8318/backend-api/codex"
  wire_api = "responses"
  auth = { command = "agent-proxy", args = ["key"] }
  ```

- Point opencode's `@opencode/ai/providers/openai/responses` provider at `<daemon address>/backend-api/codex` with `apiKey` `{file:~/.local/share/agent-proxy/key}`.
- Send any Responses API client's requests to `<daemon address>/backend-api/codex/…` with the key from `agent-proxy key`.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`. `bun run build` has run, for `--built`.
- `jq` and `curl` are on `PATH`; nothing listens on `127.0.0.1:1455` or `127.0.0.1:51996`.
- A fake OpenAI runs outside the run on `127.0.0.1:51996` and logs each request: `GET /oauth/authorize` redirects to its `redirect_uri` with a `code` and the `state`; `POST /oauth/token` answers a form-encoded code exchange, and a JSON refresh of a refresh token it issued, with `{"id_token":<JWT whose payload has "email":"carol@example.com" and "https://api.openai.com/auth":{"chatgpt_account_id":"acct-carol","chatgpt_plan_type":"pro"}>,"access_token":"at-<n>","refresh_token":"rt-<n>","expires_in":<lifetime>}`, and can be told to answer the next refresh with a given status or to make `<lifetime>` 86405 (due a refresh in 5 seconds); `/backend-api/codex/*` answers 401 to access tokens it was told to reject, `/models` and `/alpha/search` with JSON, and `/responses` with a `response.created` event, then 2 seconds later a `response.completed` event, each with `x-codex-turn-state` and `x-codex-primary-used-percent`.
- The daemon runs against it: `verify cli --built --env 'AGENT_PROXY_PROVIDER_ENDPOINTS={"codex":{"apiBaseUrl":"http://127.0.0.1:51996","authorizeUrl":"http://127.0.0.1:51996/oauth/authorize","tokenUrl":"http://127.0.0.1:51996/oauth/token"}}' -- daemon start` exits `0`, and a Codex account is added as in the [accounts](./accounts.md) Codex sign-in drive.

Every drive below runs inside `verify shell -- -c '…'` and starts with these definitions; `r` sends a short Responses request with extra curl arguments:

```sh
a=$(jq -r .address "$XDG_STATE_HOME/agent-proxy/daemon.json"); k=$(bun apps/cli/dist/bin.js key)
r() { curl -s -w " HTTP %{http_code}\n" -X POST "$a/backend-api/codex/responses" -H "content-type: application/json" "$@" -d '{"model":"gpt-6-luna","input":"hi","stream":true}'; }
```

- **Keys.** `r` prints the `no proxy key sent` error with `"code":"invalid_api_key"` and `HTTP 401`; `r -H "authorization: Bearer ap-wrong"` the `wrong proxy key` error and `HTTP 401`, without `ap-wrong`.
- **Streamed, as the account.** `curl -s -N -D "$TMPDIR/h" -X POST "$a/backend-api/codex/responses" -H "authorization: Bearer $k" -H "session-id: sess-123" -H "originator: codex_exec" -H "content-type: application/json" -d '{}' | while IFS= read -r l; do [ -n "$l" ] && echo "$(date +%s) $l"; done` prints `response.created` lines 2 seconds before `response.completed`; `$TMPDIR/h` has `x-codex-turn-state` and `x-codex-primary-used-percent`. The fake logs the request with `Bearer at-<n>`, `chatgpt-account-id=acct-carol`, `session-id=sess-123`, `originator=codex_exec` and no `x-api-key`.
- **Models and search.** `curl -s "$a/backend-api/codex/models?client_version=0.169.0" -H "authorization: Bearer $k"` and a `POST "$a/backend-api/codex/alpha/search"` with the key both print the fake's JSON with `HTTP 200`; the fake logs the path with its query.
- **WebSocket.** `curl -s -w " HTTP %{http_code}\n" "$a/backend-api/codex/responses" -H "connection: Upgrade" -H "upgrade: websocket" -H "sec-websocket-version: 13" -H "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ=="` prints the `WebSocket is not supported` error and `HTTP 426`; the fake logs nothing.
- **Native routing.** With only a Codex account, `curl -s -X POST "$a/v1/messages" -H "x-api-key: $k" -d '{}'` prints Anthropic's ``no Claude account. Add one with `agent-proxy accounts add claude`.`` and `HTTP 400`.
- **Refresh and retry on a 401.** Tell the fake to reject the latest access token, then `r -H "authorization: Bearer $k"` prints `HTTP 200`. The fake logs the request with the old token, one JSON refresh of its `rt-<n>`, then the request with the new token.
- **No account.** `accounts disable <label>`, then `r -H "authorization: Bearer $k"` prints the `no Codex account available …` error and `HTTP 400`.
- **Real Codex (owner only).** With a real Codex account added (`accounts add codex`) and `~/.codex/config.toml` set as above, run `codex exec "Say hi"` and then the TUI (`codex`, with `--no-daemon` if the install lacks `codex-code-mode-host`) in a scratch directory: a two-turn conversation answers and the second turn recalls the first; `/model` lists the catalog (with the "base URL is overridden" warning); `/compact` works; `codex resume` continues the session. Codex logs one ERROR line if `supports_websockets` is set, then works over HTTP.

## Gotchas

- The real login and the owner-only drive contact `auth.openai.com` and `chatgpt.com`; every other drive reaches only the fake through `AGENT_PROXY_PROVIDER_ENDPOINTS`.
- Codex's provider must be named exactly `OpenAI` and its `base_url` must end in `/backend-api/codex`, or Codex uses other paths the proxy does not serve.
- `x-codex-turn-state` is bound to the account that issued it; after a failover to another account Codex may send a stale one, which the proxy passes through unchanged.
- Codex sends `session-id` (equal to `prompt_cache_key`); opencode sends none, only `prompt_cache_key` and its own `x-session-id`.
- The daemon's address changes on each start with the `listen = "127.0.0.1:0"` fixture; read it from the state file every time.
- The live check cannot run unattended: it needs the owner's ChatGPT account and a browser.
