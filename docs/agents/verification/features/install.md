# Install

`bun run install-local`, from the repo root, builds agent-proxy and installs it as one self-contained binary at `~/.local/bin/agent-proxy` (ADR-0008), with the dashboard embedded, so it runs without Bun and without the checkout. The new binary is written beside the old one and renamed over it, so a client running `agent-proxy key` mid-update never finds half a binary. A daemon that was running is restarted by the new binary, so the new build serves at once; `--no-restart` leaves it on the old build, and with no daemon running nothing is started. It never installs the launch agent. Updating is `git pull` and the same command. `agent-proxy uninstall`, run as the installed binary, shows every client change, asks once, then disconnects every connected client, removes the launch agent (or stops a daemon running without it), and deletes the binary. It keeps the accounts, usage, proxy key, config and logs, and prints where they are with an `rm -rf` that removes them.

## Sub-features

- `install-build` builds the web client and the binary, and installs `~/.local/bin/agent-proxy` (mode 0755), printing `install-local: installed <path>: agent-proxy v<version> (<commit>)`.
- `install-path` warns `… is not on your PATH; add it to run \`agent-proxy\` by name.`when`~/.local/bin`is not on`PATH`.
- `install-restart` restarts a running daemon with the new binary: `agent-proxy daemon restarted (pid <new pid>) at <address>`.
- `install-no-restart` with `--no-restart`, a running daemon keeps its pid: `install-local: --no-restart: a running daemon keeps running the old build.`
- `install-idle` with no daemon running: `install-local: no daemon is running, so none was started.`
- `install-standalone` the installed binary serves the dashboard at `/` with nothing beside it.
- `uninstall-plan` shows each connected client's diff, then the list of what it does, and asks `Uninstall agent-proxy? [y/N]` once.
- `uninstall-run` on `y`, disconnects every connected client, removes the launch agent or stops the daemon, deletes the binary, and prints the kept directories with `Remove them with: rm -rf …`.
- `uninstall-decline` any other answer: `Nothing changed; agent-proxy is still installed.`, exit `1`.
- `uninstall-sandbox` in a sandbox (`HOME` is not the real home), it refuses to delete a binary outside that `HOME`, such as the real install a verify shell finds on `PATH`: `` `uninstall` refuses to delete <path>, which is not under HOME … ``, and changes nothing.
- `uninstall-silent-daemon` while a daemon holds the state lock but does not answer (paused or wedged), it fails before changing anything: ``The daemon (pid <pid>) holds its lock but does not answer, so uninstall changed nothing. Stop it with `kill <pid>`, then run this again.``
- `uninstall-source` from source, it fails with exit `1` and `` `uninstall` removes the installed binary, and this is running from source, so there is none to remove. Run it as the installed `agent-proxy`. ``

## How to get to it (user POV)

- Run `bun run install-local` (or `bun run install-local --no-restart`) in the checkout.
- Run `agent-proxy --version`, `agent-proxy info`, `agent-proxy daemon status` to see the build.
- Run `agent-proxy uninstall` and answer the question.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.
- No daemon is running in the run.

The sandbox's `HOME` stands in for the owner's, so `install-local` installs into the run's `~/.local/bin` and restarts only the run's daemon.

- **Install.** Run `verify shell -- -c 'bun run --silent install-local --bogus'`: exit `1`, `install-local: unknown argument --bogus; the only one is --no-restart`, and nothing is built or installed. Run `verify shell -- -c 'bun run --silent install-local'`. It ends with `install-local: installed <run>/home/.local/bin/agent-proxy: agent-proxy v<version> (<commit>)`, the not-on-PATH warning, and `no daemon is running, so none was started.` Then `verify shell -- -c 'ls -l "$HOME/.local/bin"; "$HOME/.local/bin/agent-proxy" daemon status'`: the binary is `-rwxr-xr-x`, and status exits `1` (nothing was started).
- **Update restarts.** Run `verify shell -- -c '"$HOME/.local/bin/agent-proxy" daemon start; bun run --silent install-local; "$HOME/.local/bin/agent-proxy" daemon status'`. The install prints `agent-proxy daemon restarted (pid <new pid>) …` with a pid other than the start's, and status shows the new pid.
- **Update mid-turn.** With the daemon pointed at the 8-second fake Claude API and seeded as in the [Daemon](./daemon.md) Stop and restart mid-turn drive (started with `"$HOME/.local/bin/agent-proxy" daemon start` and that `--env` exported), start a turn as there, then within a second `bun run --silent install-local`. It prints the `Waiting for the daemon …` notice, then `agent-proxy daemon restarted (pid <new pid>) …` after the turn ends, and the turn's output holds `message_stop`.
- **No restart.** Run `verify shell -- -c 'bun run --silent install-local --no-restart; "$HOME/.local/bin/agent-proxy" daemon status'`. The pid is unchanged.
- **Standalone.** With that daemon running, `verify shell -- -c 'curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "$(jq -r .address "$XDG_STATE_HOME/agent-proxy/daemon.json")/"'` prints `200 text/html; charset=utf-8`.
- **Uninstall from source.** Run `verify cli -- uninstall`. Exit `1` with the from-source message; nothing changes.
- **Uninstall.** Connect Claude Code over a file of the owner's as in [Connect](./connect.md), then run `verify shell -- -c 'echo y | "$HOME/.local/bin/agent-proxy" uninstall'`. It shows the Claude Code diff and the plan, then `Disconnected Claude Code from the proxy.`, `Stopped the daemon (pid <pid>).`, `Deleted <run>/home/.local/bin/agent-proxy.`, and the kept directories. `settings.json` no longer names the proxy, the binary is gone, and `$XDG_DATA_HOME/agent-proxy` still holds `key` and `accounts/`.

### By hand, on the owner's Mac

- **Real install.** `bun run install-local` in the owner's shell installs `~/.local/bin/agent-proxy`; with the launch agent installed ([Daemon](./daemon.md)), an update prints `agent-proxy daemon restarted by its launch agent …`.
- **A GUI client finds the key.** After `agent-proxy connect claude-code` from the installed binary, quit Claude Code and start it from the Dock or Spotlight (not a terminal): its first request reaches the proxy, since `apiKeyHelper` names the binary's absolute path.
- **Uninstall.** `agent-proxy uninstall` removes the launch agent too (`launchctl print gui/$(id -u)/dev.endalk200.agent-proxy` reports `Could not find service`).

## Gotchas

- `install-local` runs `bun run build`, which bakes in the checkout's commit, so it always rebuilds (the CLI build is not cached).
- `install-local` restarts the daemon its own environment finds; run it in the shell whose `XDG_*` and `AGENT_PROXY_CONFIG` the daemon uses.
- In `verify shell`, run the sandbox's own `"$HOME/.local/bin/agent-proxy" uninstall`, never a bare `agent-proxy uninstall`: `PATH` is inherited, so the bare name may be the real install, which `uninstall` refuses to delete there.
- `uninstall` deletes the binary it runs as. Run `bun run install-local` again to reinstall; accounts, usage and the proxy key are still there.
