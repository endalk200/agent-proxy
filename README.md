# agent-proxy

A command-line tool that runs as a background daemon, with a browser client for watching and controlling it.

The application is early. The CLI runs the daemon (`agent-proxy daemon run | start | stop | status`), adds, lists, and manages Claude accounts (`agent-proxy accounts`), prints the proxy key (`agent-proxy key`), and reports its setup (`info`). The daemon serves Claude Code from your Claude accounts, and a dashboard of your accounts at its own address (`http://127.0.0.1:8318/` by default); Codex and opencode come later.

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
agent-proxy accounts                          # provider, label, email, plan, priority, status (--json for scripts)
agent-proxy accounts set Work --label Personal --priority 1  # rename, or move within its pool
agent-proxy accounts disable Work              # keep it out of its pool, at its priority
agent-proxy accounts enable Work               # put it back where it was
agent-proxy accounts remove Work               # forget it and its credentials
```

The daemon runs each login itself (ADR-0007), so it must be running. The sign-in redirects to `http://localhost:54545/callback`, where the daemon listens while the login waits. When the browser cannot reach the daemon, such as over SSH, the redirected page fails to load: copy its address and paste it into `accounts add claude --no-browser`. A login nobody finishes expires after 10 minutes.

A new account joins the bottom of its pool, labelled after its email unless `--label` names it. Signing in again to an account the daemon already holds updates its credentials in place and keeps its priority and enabled setting, and its label unless `--label` gives a new one.

`accounts` ends with which account gets each pool's new sessions: the highest-priority Active one. Priority is a place in the pool: moving an account to priority 1 moves the others down one place, and removing one moves those below it up. A disabled account keeps its place, so enabling it returns it there. Removing an account deletes its file at once; a request it is already serving still finishes, and the next one goes to the next account.

The account a command acts on is named by its label, its email (either ignoring case), or the start of its id from `accounts --json`. A name that fits several accounts fails and lists them with their ids.

Accounts live in `$XDG_DATA_HOME/agent-proxy/accounts/`, by default `~/.local/share/agent-proxy/accounts/`: one file per account, readable only by you. Only the daemon writes them.

## Serving Claude Code

Every request to the proxy carries the proxy key, even on this machine. The daemon generates it on its first run and keeps it in `$XDG_DATA_HOME/agent-proxy/key`, readable only by you.

```sh
agent-proxy key            # print the key
agent-proxy key --rotate   # replace it; the old key stops working at once
```

Point Claude Code at the daemon in `~/.claude/settings.json`, with the address `agent-proxy daemon status` shows:

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8318" },
  "apiKeyHelper": "agent-proxy key"
}
```

Each request then goes to Claude as your highest-priority Active Claude account. Claude Code runs `agent-proxy key` again after a rejected key, so a rotated key takes effect without a restart. It shows "API Usage Billing", because it sees an API key; the requests still spend your subscription.

## Configuration

The config file is TOML, edited by hand; agent-proxy never writes it. `agent-proxy info` shows which file the CLI loads. It checks, in order: `AGENT_PROXY_CONFIG`, then `$XDG_CONFIG_HOME/agent-proxy/config.toml`, then `~/.config/agent-proxy/config.toml`. A missing file means every default applies; a file named by `AGENT_PROXY_CONFIG` must exist.

```toml
# Where the daemon listens. Port 0 binds any free port.
listen = "127.0.0.1:8318"
```

`listen` is the only key. A syntax error or an unknown key fails with a message naming its line.
