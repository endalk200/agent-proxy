# agent-proxy

A command-line tool that runs as a background daemon, with a browser client for watching and controlling it.

The application is early. The CLI runs the daemon (`agent-proxy daemon run | start | stop | status`), adds, lists, and manages Claude and Codex accounts (`agent-proxy accounts`), prints the proxy key (`agent-proxy key`), points Claude Code, Codex and opencode at the daemon (`agent-proxy connect claude-code | codex | opencode`), and reports its setup (`info`). The daemon serves Claude Code from your Claude accounts, Codex from your Codex (ChatGPT) accounts, opencode from both, and a dashboard of your accounts at its own address (`http://127.0.0.1:8318/` by default).

## Requirements

- [Bun](https://bun.sh) 1.4.4 (the version in `package.json` `packageManager`)

## Getting started

```sh
bun install
bun apps/cli/src/bin.ts info
```

`bun install` also runs `effect-tsgo patch --oxlint`, which adds the Effect language service rules to the installed TypeScript and Oxlint.

## Commands

Run from the repository root:

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `bun run dev`       | Start every app in watch mode                                   |
| `bun run build`     | Build the web client, then the CLI bundle with it in `dist/web` |
| `bun run format`    | Format with Oxfmt (`format:check` to verify only)               |
| `bun run lint`      | Type-aware Oxlint with Effect rules (`lint:fix` to apply fixes) |
| `bun run typecheck` | Type-check every workspace with TypeScript 7                    |
| `bun run test`      | Unit and integration tests                                      |
| `bun run test:e2e`  | Build, then run CLI and dashboard end-to-end tests              |
| `bun run check`     | Everything CI runs except end-to-end tests                      |

The first end-to-end run needs a browser: `cd e2e && bun x playwright install chromium`.

## Layout

| Path        | Contents                                                              |
| ----------- | --------------------------------------------------------------------- |
| `apps/cli`  | `@agent-proxy/cli`: the `agent-proxy` CLI and daemon, built on Effect |
| `apps/web`  | `@agent-proxy/web`: the browser client (Vite and React)               |
| `packages/` | Shared internal packages, added as features need them                 |
| `e2e`       | End-to-end tests against the built CLI and web client                 |

## Tests

| Layer       | Location                   | Scope                                                        |
| ----------- | -------------------------- | ------------------------------------------------------------ |
| Unit        | `src/**/*.test.ts`         | In-memory, with test layers                                  |
| Integration | `apps/*/test/integration/` | Real platform services, run in-process                       |
| End-to-end  | `e2e/cli`, `e2e/web`       | The built binary as a child process; the web app in Chromium |

## Seeing it run

`bun run verify` runs agent-proxy inside a sandbox: a directory under `.verify/runs/<id>/` that stands in for your home and XDG directories, so nothing touches your real configuration. Each command it runs and each page it loads is saved as evidence in the run's `artifacts/`.

```sh
bun run verify up                 # create a run
bun run verify doctor             # check it is isolated and healthy
bun run verify cli -- info        # run the CLI from source; output saved as evidence
bun run verify web                # build and serve the web client on a free port
bun run verify browse /           # screenshot, accessibility tree, and console errors
bun run verify down               # stop what the run started; evidence is kept
```

To work inside the sandbox yourself, `bun run verify shell` opens your shell with the run's environment and nothing else from your session except `PATH`. Run one command with `bun run verify shell -- -c 'bun apps/cli/src/bin.ts info'`.

Agents follow the same flow through the runbook in `docs/agents/verification/README.md`. `docs/adr/0001-*` explains the design.

## Running the daemon

```sh
agent-proxy daemon start     # run it in the background; returns once it is ready
agent-proxy daemon status    # pid, address, and uptime (--json for scripts)
agent-proxy daemon stop      # SIGTERM, then wait for it to exit
agent-proxy daemon run       # or run it in the foreground
```

The daemon keeps its lock, state file (`daemon.json`, with its pid and the port it bound), and logs (`daemon.log`, one JSON object per line) in `$XDG_STATE_HOME/agent-proxy/`, by default `~/.local/state/agent-proxy/`. One daemon runs per state directory. `--log-level debug` sets how much it logs.

## Accounts

```sh
agent-proxy accounts add claude               # sign in through the browser
agent-proxy accounts add claude --no-browser  # print the URL; paste the callback URL
agent-proxy accounts add codex                # sign in to ChatGPT for Codex (also --no-browser)
agent-proxy accounts                          # provider, label, email, plan, priority, status (--json for scripts)
agent-proxy accounts set Work --label Personal --priority 1  # rename, or move within its pool
agent-proxy accounts disable Work              # keep it out of its pool, at its priority
agent-proxy accounts enable Work               # put it back where it was
agent-proxy accounts remove Work               # forget it and its credentials
```

The daemon runs each login itself (ADR-0007), so it must be running. A Claude sign-in redirects to `http://localhost:54545/callback`, and a Codex sign-in to `http://127.0.0.1:1455/auth/callback`, the port Codex itself uses, so a Codex login fails while `codex login` waits on it. The daemon listens there only while the login waits. When the browser cannot reach the daemon, such as over SSH, the redirected page fails to load: copy its address and paste it into `accounts add <provider> --no-browser`. A login nobody finishes expires after 10 minutes.

The dashboard runs the same logins: **Add account** asks for Claude or Codex and opens its sign-in page in a new tab while it waits, and **Sign in again** does the same for an account that needs it. When the browser cannot reach the daemon, paste the redirected address into the dialog instead. Closing the dialog cancels the login.

A new account joins the bottom of its pool, labelled after its email unless `--label` names it. Signing in again to an account the daemon already holds updates its credentials in place and keeps its priority and enabled setting, and its label unless `--label` gives a new one.

`accounts` ends with which account gets each pool's new sessions: the highest-priority Active one (see [Sessions and limits](#sessions-and-limits)). An account that hit a limit shows **Cooling down** with the local time its cooldown ends, such as `Cooling down until 15:30`, and `--json` gives that end as `cooldownEndsAt`. Priority is a place in the pool: moving an account to priority 1 moves the others down one place, and removing one moves those below it up. A disabled account keeps its place, so enabling it returns it there. Removing an account deletes its file at once; a request it is already serving still finishes, and the next one goes to the next account.

The account a command acts on is named by its label, its email (either ignoring case), or the start of its id from `accounts --json`. A name that fits several accounts fails and lists them with their ids.

Accounts live in `$XDG_DATA_HOME/agent-proxy/accounts/`, by default `~/.local/share/agent-proxy/accounts/`: one file per account, readable only by you. Only the daemon writes them.

The daemon keeps each account's tokens fresh: it refreshes a Claude account about an hour before its token expires, and a Codex account about a day before, whether or not anything is using it. When a refresh is refused, or its outcome is lost (the connection drops after it was sent, the provider answers with a gateway error, or the daemon stops mid-refresh), the account shows **Needs sign-in** and serves nothing until you sign in to it again, with `accounts add <provider>` or **Sign in again** in the dashboard. Refresh tokens work once, so a refresh that may have happened is never retried. A refresh that never reached the provider, or that it answered with 429 or 503, is retried a few minutes later.

## Serving Claude Code

Every request to the proxy carries the proxy key, even on this machine. The daemon generates it on its first run and keeps it in `$XDG_DATA_HOME/agent-proxy/key`, readable only by you.

```sh
agent-proxy key            # print the key
agent-proxy key --rotate   # replace it; the old key stops working at once
```

Point Claude Code at the daemon:

```sh
agent-proxy connect claude-code          # show the change, ask, back up, write
agent-proxy connect claude-code --print  # print the settings only; change nothing
```

`connect claude-code` adds two settings to `~/.claude/settings.json` and leaves every other setting as it was:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318" },
  "apiKeyHelper": "agent-proxy key"
}
```

It shows the change as a diff and writes only when you answer `y`. The old file goes to `settings.json.bak` beside it. A missing file is created; a file that is not valid JSON is refused and left alone. A `settings.json` linked from a dotfiles repo stays a link, and the file it points to is the one changed; a link whose target is missing is refused. The file holds no secret: Claude Code fetches the key by running `agent-proxy key`. Running `connect` again when nothing would change says so and writes nothing.

The address is the running daemon's. When the daemon is not running, `connect` uses the `listen` address in the config file, and fails if that is port 0, any free port, which is known only once the daemon runs.

Each request then goes to Claude as one of your Claude accounts, chosen as [Sessions and limits](#sessions-and-limits) describes. When Claude rejects that account's token, the daemon refreshes it once and retries the request on the same account. Claude Code runs `agent-proxy key` again after a rejected key, so a rotated key takes effect without a restart. It shows "API Usage Billing", because it sees an API key; the requests still spend your subscription.

## Serving Codex

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

The rest of the file stays byte for byte, comments included. A `model_provider` naming another provider is replaced in place, and an existing `[model_providers.agent-proxy]` table is replaced whole; the diff shows both. It asks, backs up and writes as `connect claude-code` does, keeps a linked file a link, and refuses a file that is not valid TOML. A file it cannot change without changing its meaning (the provider in dotted keys, a subtable of it, a multi-line string with a line that starts with `[`) is refused and left alone; add the `--print` settings by hand, with `model_provider` above the first table. The file holds no secret: Codex fetches the key by running `agent-proxy key`.

Leave `supports_websockets` unset. The daemon serves `POST /responses` (streamed), `GET /models` and `POST /alpha/search` under `/backend-api/codex` from `chatgpt.com`, as one of your Codex accounts, chosen as [Sessions and limits](#sessions-and-limits) describes: it puts that account's token in `Authorization` and its ChatGPT workspace in `chatgpt-account-id`, and passes everything else through, the `x-codex-*` limit headers included. It refuses a WebSocket upgrade with 426, and Codex falls back to HTTP. When the backend rejects the account's token, the daemon refreshes it once and retries on the same account.

## Serving opencode

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

## Sessions and limits

A session stays on one account, so the provider's prompt cache keeps working (ADR-0003). The daemon knows a session by what the client sends: Claude Code's `x-claude-code-session-id` (its subagents send their parent's), Codex's `session-id`, or, from opencode, the body's `prompt_cache_key`. A session's first request goes to the highest-priority Active account of its pool; accounts that share a priority, which happens only when a change was interrupted, go to the one with the most headroom left in its usage windows. The session then stays on that account until the account stops being Active or the session sits idle for an hour. A request that names no session is routed afresh every time. Sessions live in memory only.

When an account hits a limit, the daemon cools it down for as long as the provider says:

- a Claude window rejection (`anthropic-ratelimit-unified-*-status: rejected`) until that window resets;
- a Codex `usage_limit_reached` until its `resets_at`, for every model the account serves;
- any other 429, such as a per-minute rate limit, for its `Retry-After` only.

If nothing has reached the client yet, the request goes straight to the next account and the session moves with it, so the client never notices. A failure after the answer has started streaming reaches the client as it is. When every account in the pool is cooling down, the client gets the provider's own limit answer with the earliest reset: Claude Code shows the limit and when it resets, and Codex shows its usage-limit message. When every account needs sign-in or is disabled, the client gets a 400 saying so at once. Cooldowns live in memory; after a restart, the next limit answer starts them again.

## Configuration

The config file is TOML, edited by hand; agent-proxy never writes it. `agent-proxy info` shows which file the CLI loads. It checks, in order: `AGENT_PROXY_CONFIG`, then `$XDG_CONFIG_HOME/agent-proxy/config.toml`, then `~/.config/agent-proxy/config.toml`. A missing file means every default applies; a file named by `AGENT_PROXY_CONFIG` must exist.

```toml
# Where the daemon listens. Port 0 binds any free port.
listen = "127.0.0.1:8318"
```

`listen` is the only key. A syntax error or an unknown key fails with a message naming its line.
