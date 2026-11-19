# Connect your clients

`agent-proxy connect <client>` points a client at the daemon, and `agent-proxy disconnect <client>` points it back. Each client spends only its own provider's accounts: Claude Code your Claude accounts, Codex your Codex accounts, and opencode both.

## The proxy key

Every request to the proxy carries the proxy key, even on this machine. The daemon generates it on its first run and keeps it in `$XDG_DATA_HOME/agent-proxy/key`, readable only by you.

```sh
agent-proxy key            # print the key
agent-proxy key --rotate   # replace it; the old key stops working at once (restart Codex and opencode)
```

## Claude Code

Point Claude Code at the daemon:

```sh
agent-proxy connect claude-code          # show the change, ask, back up, write
agent-proxy connect claude-code --print  # print the settings only; change nothing
```

`connect claude-code` adds two settings to `~/.claude/settings.json` and leaves every other setting as it was:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318" },
  "apiKeyHelper": "/Users/you/.local/bin/agent-proxy key"
}
```

The installed binary writes its own absolute path, since Claude Code started from the Dock may not have `~/.local/bin` on its `PATH`; run from source, it writes the bare `agent-proxy key`. It shows the change as a diff and writes only when you answer `y`. The old file goes to `settings.json.bak` beside it. A missing file is created; a file that is not valid JSON is refused and left alone. A `settings.json` linked from a dotfiles repo stays a link, and the file it points to is the one changed; a link whose target is missing is refused. The file holds no secret: Claude Code fetches the key by running `agent-proxy key`. Running `connect` again when nothing would change says so and writes nothing.

`agent-proxy disconnect claude-code` points it back: it removes those two settings, and only while they still hold what `connect` wrote, showing the diff and asking first. A setting you changed since stays, and it says so; every other setting stays as it was. When `connect` had replaced a key helper of yours, `disconnect` points at the `.bak` that holds it. `disconnect codex` and `disconnect opencode` do the same for their files.

The address is the running daemon's. When the daemon is not running, `connect` uses the `listen` address in the config file, and fails if that is port 0, any free port, which is known only once the daemon runs.

Each request then goes to Claude as one of your Claude accounts, chosen as [Sessions and limits](routing.md) describes. When Claude rejects that account's token, the daemon refreshes it once and retries the request on the same account. Claude Code runs `agent-proxy key` again after a rejected key, so a rotated key takes effect without a restart. It shows "API Usage Billing", because it sees an API key; the requests still spend your subscription.

## Codex

Codex spends only your Codex accounts, and Claude Code only your Claude accounts. Point Codex at the daemon:

```sh
agent-proxy connect codex          # show the change, ask, back up, write
agent-proxy connect codex --print  # print the settings only; change nothing
```

`connect codex` sets `model_provider` and adds a provider table to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml` when `CODEX_HOME` is set, as Codex reads it):

```toml
model_provider = "agent-proxy"

[model_providers.agent-proxy]
name = "OpenAI" # must be exactly "OpenAI": it enables Codex's backend routes
base_url = "http://127.0.0.1:8318/backend-api/codex" # must end in /backend-api/codex
wire_api = "responses"
auth = { command = "agent-proxy", args = ["key"] }
```

The rest of the file stays byte for byte, comments included. A `model_provider` naming another provider is replaced in place, and an existing `[model_providers.agent-proxy]` table is replaced whole; the diff shows both. It asks, backs up and writes as `connect claude-code` does, keeps a linked file a link, and refuses a file that is not valid TOML. A file it cannot change without changing its meaning (the provider in dotted keys, a subtable of it, a multi-line string with a line that starts with `[`) is refused and left alone; add the `--print` settings by hand, with `model_provider` above the first table. The file holds no secret: Codex fetches the key by running `agent-proxy key` (the installed binary writes its absolute path in `command`). Codex runs it once per process, so restart Codex after `key --rotate`.

Codex profiles are never edited, but a `[profiles.<name>]` that sets its own `model_provider` wins over the root one, so `connect codex` warns about it: the active profile (`profile = "<name>"`) by name and line, and any other that `codex --profile <name>` could pick.

Leave `supports_websockets` unset. The daemon serves `POST /responses` (streamed), `GET /models` and `POST /alpha/search` under `/backend-api/codex` from `chatgpt.com`, as one of your Codex accounts, chosen as [Sessions and limits](routing.md) describes: it puts that account's token in `Authorization` and its ChatGPT workspace in `chatgpt-account-id`, and passes everything else through, the `x-codex-*` limit headers included. It refuses a WebSocket upgrade with 426, and Codex falls back to HTTP. When the backend rejects the account's token, the daemon refreshes it once and retries on the same account.

## opencode

opencode spends your Claude accounts through its Claude Agent integration, and your Codex accounts through an OpenAI Responses provider. Point both at the daemon:

```sh
agent-proxy connect opencode          # show the change, ask, back up, write
agent-proxy connect opencode --print  # print the settings only; change nothing
```

`connect opencode` adds two providers to opencode's global config, `~/.config/opencode/opencode.json` (`$XDG_CONFIG_HOME/opencode/` or `$OPENCODE_CONFIG_DIR` when set, and `opencode.jsonc` there when it exists, since opencode lets it win):

```json
{
  "providers": {
    "claude-agent": {
      "settings": {
        "baseURL": "http://127.0.0.1:8318",
        "apiKey": "{file:~/.local/share/agent-proxy/key}"
      }
    },
    "agent-proxy-codex": {
      "name": "agent-proxy (Codex)",
      "canonical": "openai",
      "package": "@opencode/ai/providers/openai/responses",
      "settings": {
        "baseURL": "http://127.0.0.1:8318/backend-api/codex",
        "apiKey": "{file:~/.local/share/agent-proxy/key}"
      },
      "models": { "gpt-6.1-sol": { "name": "GPT-6.1 Sol" }, "…": {} }
    }
  }
}
```

opencode cannot run a command for its key, so both providers read the key file with `{file:…}`, named by its real path (`~/…` only when it lies under your home directory); the config still holds no secret. The Claude Agent integration runs your local `claude` and ignores `~/.claude/settings.json`, which is why its base URL is set here. Its models appear once the integration is connected: run `opencode auth login claude-agent --method claude-login` once. `connect` lists four Codex models (`gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-luna`) only when the provider has none, so edit the list freely.

Comments, trailing commas and the rest of the file stay as they were; only the lines next to a new setting may be laid out again. Settings already in `claude-agent` or `agent-proxy-codex` that `connect` does not manage stay too. It asks, backs up and writes as `connect claude-code` does.

opencode reads the key file when it loads its config, so after `agent-proxy key --rotate` restart it, or run `opencode reload`. A missing key file makes opencode send no key, and the proxy answers `no proxy key sent`.
