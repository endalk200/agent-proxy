# Spike #6 findings: client wire behaviour through a proxy

Run on 2026-11-17 with Claude Code 2.1.326, codex-cli 0.169.0 (Homebrew cask) and opencode 2.3.0, against
the real upstreams through `spike/recorder.ts`. Each client used throwaway config dirs under `/tmp/ap-spike`.
The Codex account was on the ChatGPT **free** plan, and the Claude token came from `claude setup-token`.

## Claude Code (`ANTHROPIC_BASE_URL` + `apiKeyHelper`)

- **Key delivery:** the `apiKeyHelper` value goes out as **both** `Authorization: Bearer <key>` and `x-api-key: <key>`. The proxy must strip both.
- **`HEAD /api/hello`** is called at startup **without any key**. The proxy must answer it (200) without the key check.
- **Paths:** `/v1/messages?beta=true` and `/v1/messages/count_tokens?beta=true` (interactive `/context` calls count_tokens many times). No other endpoints were seen.
- **OAuth beta:** `oauth-2025-04-20` is **not** sent. The upstream accepted OAuth bearer requests **without** it (Haiku and Sonnet, 200). Adding it when absent is harmless and allowed by ADR-0006, but it is no longer required.
- **System prompt:** interactive sessions send "You are Claude Code, Anthropic's official CLI for Claude." `-p` and Agent SDK sessions send "You are a Claude agent, built on Anthropic's Claude Agent SDK." Both are accepted with the OAuth token. The first block is always `x-anthropic-billing-header: cc_version=…`.
- **Prompt cache:** the second turn reads the cache (`cache_read_input_tokens` ≈ 13.9k).
- **Session id:** `x-claude-code-session-id` is stable across `--resume`, and **subagent requests carry the parent's session id**. Title-generation side requests also carry it.
- **Subagents and resume:** both work.
- **Key rotation:** after a 401, Claude Code re-runs `apiKeyHelper` once and retries, so a rotated key is picked up transparently.
- **Limit headers:** the real responses carry `anthropic-ratelimit-unified-{status,reset,representative-claim,fallback-percentage,overage-*}` and `-5h-*`/`-7d-*` `{status,reset,utilization}`. `utilization` is a usable headroom signal.
- **429 display:** a window-limit 429 with `unified-*-status: rejected` and `-reset` headers shows as "5-hour limit reached · retrying in 1s (12:22pm) · attempt 4/10". In API-key mode Claude Code retries 429 up to 10 times.
- **UI label:** Claude Code shows "API Usage Billing", because it sees an API key.

## Codex (custom provider `name = "OpenAI"` + `auth` command)

Working config, accepted by 0.169.0:

```toml
model_provider = "agent-proxy"

[model_providers.agent-proxy]
name = "OpenAI" # must be exactly "OpenAI": enables Codex backend routes
base_url = "http://127.0.0.1:8318/backend-api/codex" # must end in /backend-api/codex
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }
```

- **Auth:** the `auth` command's output arrives as `Authorization: Bearer <key>`. It is called once per process. No `requires_openai_auth` and no `env_key`.
- **Paths:** `GET /backend-api/codex/models?client_version=0.169.0`, `POST /backend-api/codex/responses` (SSE) and, with `supports_websockets = true`, a `GET /backend-api/codex/responses` WebSocket upgrade.
- **WebSocket:** a **426 refusal falls back to HTTP** cleanly; Codex only logs an ERROR line. With `supports_websockets` unset (the default for custom providers) no upgrade is attempted. Recommendation: leave it unset in `connect codex`.
- **Streaming, reasoning across turns and resume** all work. Requests carry `store: false`, `include: ["reasoning.encrypted_content"]` and `reasoning.context: "all_turns"`. Resume keeps the same ids, and the second turn reads 12.4k cached tokens.
- **Session id:** a `session-id` header (with `thread-id`) **equals `prompt_cache_key`**, and both stay the same across `resume`.
- **`/compact`:** it works ("Context compacted"), and it goes through `POST /responses` (no separate endpoint was seen).
- **Model picker:** it works and lists Codex's catalog, with the warning "OpenAI base URL is overridden … Selecting models may not be supported". `/models` is served from the proxy.
- **Web search:** **not verifiable on this machine.** Every catalog model is `tool_mode: code_mode_only`, and the Homebrew cask lacks `codex-code-mode-host`, so no tool (including search) can run in this install, with or without the proxy. Per the source (`codex-rs/codex-api/src/endpoint/search.rs`), standalone search POSTs to `{base_url}/alpha/search`, so **the proxy must also route `/backend-api/codex/alpha/search`**. The provider must set `supports_standalone_web_search = true`, or keep `name = "OpenAI"`, which already enables it.
- **Response headers:** `x-codex-{plan-type,active-limit,primary-used-percent,primary-reset-at,primary-reset-after-seconds,primary-window-minutes,secondary-*,credits-*}` arrive, plus **`x-codex-turn-state`**, a sticky routing token that Codex echoes back. It is account-bound, so pass it through but expect it to be stale after a failover.
- **Lost without a ChatGPT login:** `/status` shows "Limits: data not available yet", and the model picker shows the override warning. Nothing else was observed missing in exec or TUI use.
- The interactive TUI needed `--no-daemon` here, because of the missing code-mode host. That is unrelated to the proxy.

## opencode 2.3.0

- **Claude path is the "Claude Agent" integration** (`claude-agent/{haiku,sonnet,opus,fable}`). It spawns the local `claude` through the Agent SDK with **`settingSources: []`**, so `~/.claude/settings.json` (and `apiKeyHelper`) is **ignored**. The base URL and key come from opencode's own config, mapped to env: `providers["claude-agent"].settings.baseURL` → `ANTHROPIC_BASE_URL` and `.apiKey` → `ANTHROPIC_API_KEY`, which goes out as `x-api-key`. The integration must be connected once (`opencode auth login claude-agent --method claude-login`) before its models appear.
  ```json
  "providers": {
    "claude-agent": { "settings": { "baseURL": "http://127.0.0.1:8318", "apiKey": "{file:~/.local/share/agent-proxy/key}" } },
    "agent-proxy-codex": {
      "name": "agent-proxy (Codex)", "canonical": "openai",
      "package": "@opencode/ai/providers/openai/responses",
      "settings": { "baseURL": "http://127.0.0.1:8318/backend-api/codex", "apiKey": "{file:~/.local/share/agent-proxy/key}" },
      "models": { "gpt-6-luna": { "name": "GPT-6 Luna" } }
    }
  }
  ```
  Requests carry `x-claude-code-session-id`, and the UA is `claude-cli/2.1.326 (external, sdk-ts, agent-sdk/…)`.
- **Codex path** (`@opencode/ai/providers/openai/responses`) works **unchanged**: the backend accepted every field opencode sent, including `max_output_tokens: 128000`. **No named per-client exceptions are needed.** It tries a WebSocket upgrade first, and a 426 falls back to HTTP. It sends no `session-id`; it sends `prompt_cache_key: ses_…`, `x-session-id`, `x-opencode-session-id` and `x-session-affinity`.
- **`{file:~/…}`** expands `~/`, and the key arrives.
- **Missing key file:** the Codex path sends **no `Authorization` header at all** (not an empty key), and the proxy's "no proxy key sent" error is shown verbatim. The Claude Agent path never reaches the proxy: `claude` fails locally with "Not logged in · Run `claude auth login`", which is misleading but not fixable in the proxy.
- **Rotated key:** **not picked up live.** `{file:}` is read at config load, so the next turn gets the proxy's "wrong proxy key" error. Restart opencode (or `opencode reload` for the service).

## "Every account needs sign-in": status code per client

| Status | Claude Code                                     | Codex                                                            | opencode (Codex path)             |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| 400    | **immediate**: `API Error: 400 <message>`       | **immediate**: `ERROR: {"error":{…"message":"<message>"}}`       | **immediate**: `Error: <message>` |
| 401    | re-runs `apiKeyHelper`, retries ~10× over 150s+ | retries 5×, ~7s: `unexpected status 401 Unauthorized: <message>` | immediate                         |
| 403    | retries ~10× over 150s+                         | retries 5×, ~7s, then the message                                | immediate                         |
| 503    | retries ~10× over 150s+                         | retries 5×, ~25s, then the message                               | retries 11×, ~84s                 |

**Choose 400 (`invalid_request_error`) for all three clients.** It is the only status that every client shows immediately with the proxy's message. Keep 401 for key errors only: there it makes Claude Code re-fetch the key, which is what rotation needs.

## Login parameters (confirmed against the installed clients)

- **Claude** (Claude Code 2.1.326):
  - client id `9d1c250a-e61b-44d9-88ed-5944d1962f5e` ✓.
  - Token URL `https://platform.claude.com/v1/oauth/token` ✓.
  - **Authorize URL changed** to `https://claude.com/cai/oauth/authorize` (the console flow uses `https://platform.claude.com/oauth/authorize`).
  - Redirect `http://localhost:<port>/callback` with a **random port**, so any loopback port works and 54545 is our choice, not a requirement.
  - Manual or paste flow: `redirect_uri=https://platform.claude.com/oauth/code/callback`, which displays a code to paste.
  - Scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins user:privacy_consents:write`.
  - PKCE S256, with the `code=true` param.
  - Profile: `GET https://api.anthropic.com/api/oauth/profile` ✓.
- **Codex** (codex-rs `login/`):
  - client id `app_EMoamEEZ73f0CkXaXp7hrann` ✓.
  - `https://auth.openai.com/oauth/authorize` and `/oauth/token` ✓.
  - Port 1455 ✓, but the **redirect host is `127.0.0.1`**: `http://127.0.0.1:1455/auth/callback`.
  - Scopes: `openid profile email offline_access api.connectors.read api.connectors.invoke`.
  - Extra params: `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<client>`.
  - Identity: the id_token claim `https://api.openai.com/auth` → `chatgpt_account_id`, `chatgpt_plan_type`, plus the email claim ✓.
