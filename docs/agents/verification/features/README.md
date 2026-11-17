# agent-proxy feature map

The maintained source for what a user can do with agent-proxy and how to prove each behaviour. Read this index, then the file for the feature you are verifying. The commands come from the [runbook](../README.md).

## Baseline

- A run from `verify up` whose `verify doctor` is all `ok`.
- The sandbox config file holds the fixture `listen = "127.0.0.1:0"`, so a daemon binds any free port. No daemon is running.
- Web features also need `verify web` (or `verify web --dev`) for the current run.

## Driving conventions

- Commands are literal: keep names, flags, and quoting exactly as written.
- In the web client, find elements by ARIA role and accessible name, never by CSS selector or position.
- Start every drive from the baseline unless its preconditions say otherwise.

## Proof and skip reporting

- CLI proof is the evidence file `verify cli` prints: command, stdout, stderr, and exit code.
- Web proof is the screenshot and accessibility tree `verify browse` prints, plus its console and page-error counts.
- Record the sub-feature ID and entry point with every evidence path.
- Report an entry point as verified only through that entry point.
- Report an unreachable entry point with the command attempted and the unmet prerequisite.

## Feature file contract

Each file starts with an H1 title and one paragraph describing the user-visible behaviour, then exactly these H2 sections, in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every entry point a user has.
3. `Driving it with verify`: begins with `Preconditions:`, then one bullet per action pairing the exact command with the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

Name only user paths, stable handles, commands, and observable results; leave implementation details to the code.

## Features

- [Accounts](./accounts.md): `accounts` and `accounts --json` with each pool's next account and each cooldown's end, `accounts add claude` and `accounts add codex` through the browser or a pasted callback URL, cancelling a login, `accounts set`, `enable`, `disable` and `remove`, and the account files.
- [Claude proxy](./claude-proxy.md): Claude Code's requests served from the Claude pool, a session staying on its account, failover and cooldowns at Claude's limits, the 429 when every account is cooling down, the proxy key check, `HEAD /api/hello`, the "no account" errors, and passthrough of headers, limit headers and streams.
- [Codex proxy](./codex-proxy.md): Codex's and opencode's requests to `/backend-api/codex/` (`responses`, `models`, `alpha/search`) served from the Codex pool with `chatgpt-account-id`, sessions by `session-id` or `prompt_cache_key`, failover and cooldowns at `usage_limit_reached`, the `usage_limit_reached` 429 when every account is cooling down, the WebSocket 426, the key check and "no account" errors in OpenAI's shape, the 401 refresh and retry, and passthrough of `x-codex-*` headers and streams.
- [Connect](./connect.md): `connect claude-code`, `connect codex` and `connect opencode` with their diff, confirmation, `.bak` and `--print`, the already-connected no-op, a missing, invalid or linked config file, a `config.toml` it cannot change safely, `CODEX_HOME`, Codex's own validation of the written config, opencode's two providers, its key file reference, `.jsonc` and `OPENCODE_CONFIG_DIR`, opencode served live through both paths, and where the address comes from.
- [Proxy key](./key.md): `key` and `key --rotate`, the key file, and the old key's refusal after rotation.
- [Daemon](./daemon.md): `daemon run`, `start`, `stop`, and `status`, `/healthz`, the state file, the single-instance lock, JSON logs, and loading `config.toml`.
- [CLI info](./cli-info.md): version, runtime, and resolved config path, as text or JSON, including the error when no config location exists.
- [CLI help and version](./cli-help-and-version.md): help, version, shell completions, and rejection of unknown subcommands.
- [Web dashboard](./web-dashboard.md): the dashboard the daemon serves at `/`: the sidebar with the daemon switcher, sign-in badge and pool strip, each pool's accounts table with cooldowns and their countdowns, live updates from the daemon's event stream with a row flash and a notice, first run, the unreachable state and reconnecting, and Connect clients with the masked proxy key.
