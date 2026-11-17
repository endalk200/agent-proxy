# Daemon

`agent-proxy daemon` runs the daemon in the foreground (`run`) or in the background (`start`), reports it (`status`), and stops it (`stop`). The daemon loads `config.toml`, listens on its `listen` address, answers `GET /healthz` with 200 once it is usable, and records its pid and bound port in a state file. It keeps a single-instance lock and JSON logs in its state directory, and exits 0 on SIGTERM after removing the state file. Commands that need the daemon fail with a one-line hint when it is not running and never start it.

## Sub-features

- `daemon-start` starts the daemon in the background and returns once `/healthz` is 200.
- `daemon-status` reports pid, address, uptime, and version, as text or `--json`.
- `daemon-stop` sends SIGTERM, waits for the daemon to exit, and leaves no state file.
- `daemon-run` serves in the foreground and exits 0 on SIGTERM.
- `daemon-not-running` fails with a hint naming `agent-proxy daemon start`, and starts nothing.
- `daemon-single-instance` refuses a second daemon on the same state directory.
- `daemon-free-port` binds any free port for `listen = "…:0"` and records the actual port.
- `daemon-healthz` answers `GET /healthz` with 200.
- `daemon-logs` writes one JSON object per line to `daemon.log`; `--log-level` sets the minimum level.
- `config-errors` fails on a malformed config or an unknown key, naming the problem and its line, and on an `AGENT_PROXY_CONFIG` that names a missing file.

## How to get to it (user POV)

- Run `agent-proxy daemon start`, `agent-proxy daemon status [--json]`, `agent-proxy daemon stop`.
- Run `agent-proxy daemon run [--log-level <level>]` and stop it with SIGTERM or Ctrl-C.
- Request `GET <address>/healthz`, where the address comes from `daemon status` or the state file.
- Read `$XDG_STATE_HOME/agent-proxy/daemon.json` (state file) and `daemon.log` (logs).
- Edit `$XDG_CONFIG_HOME/agent-proxy/config.toml`, or point `AGENT_PROXY_CONFIG` at another file.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.
- No daemon is running in the run: `verify cli -- daemon status` exits `1`.

- **Not running.** Run `verify cli -- daemon status` and `verify cli -- daemon status --json`. Each exits `1`; stderr contains ``The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`.`` Then `verify shell -- -c 'ls "$XDG_STATE_HOME/agent-proxy"'` shows no `daemon.json`.
- **Start.** Run `verify cli -- daemon start`. Exit `0`; stdout is `agent-proxy daemon started (pid <pid>) at http://127.0.0.1:<port>` with a non-zero port.
- **State file.** Run `verify shell -- -c 'cat "$XDG_STATE_HOME/agent-proxy/daemon.json"'`. JSON with `pid` and `port` matching the start line, and `address` `http://127.0.0.1:<port>`.
- **Health.** Run `verify shell -- -c 'curl -s -w " %{http_code}" "$(sed -n "s/.*\"address\": \"\(.*\)\".*/\1/p" "$XDG_STATE_HOME/agent-proxy/daemon.json")/healthz"'`. Output ends in `200`.
- **Status.** Run `verify cli -- daemon status`. Exit `0`; lines start `agent-proxy daemon is running`, `pid`, `address`, `uptime`, `version`. Run `verify cli -- daemon status --json`. Exit `0`; JSON with `pid`, `address`, `version`, `startedAt`, `uptimeSeconds`.
- **Second daemon.** With the daemon running, run `verify cli -- daemon start`. Exit `1`; stderr contains `The agent-proxy daemon is already running (pid <pid>)`. Run `verify cli -- daemon run`. Exit `1`; stderr contains `Another agent-proxy daemon (pid <pid>) is already running for`.
- **Logs.** Run `verify shell -- -c 'cat "$XDG_STATE_HOME/agent-proxy/daemon.log"'`. Every line parses as JSON; one has `"message":"daemon started"` and `"level":"INFO"`.
- **Stop.** Run `verify cli -- daemon stop`. Exit `0`; stdout is `agent-proxy daemon stopped (pid <pid>)`. The state file is gone, `ps -p <pid>` finds nothing, and `daemon status` exits `1` with the not-running hint. A second `daemon stop` exits `1` with the same hint.
- **Foreground and SIGTERM.** Run `verify shell -- -c 'bun apps/cli/src/bin.ts daemon run --log-level debug & p=$!; until [ -f "$XDG_STATE_HOME/agent-proxy/daemon.json" ]; do sleep 0.1; done; kill -TERM $p; wait $p; echo "exit=$?"; ls "$XDG_STATE_HOME/agent-proxy"'`. Stdout has `agent-proxy daemon listening on http://127.0.0.1:<port> (pid <pid>)`, then `exit=0`, and the listing has no `daemon.json`.
- **Bad config.** Run `verify shell -- -c 'printf "listen = \"127.0.0.1:0\"\nport = 8318\n" > "$TMPDIR/bad.toml"'`, then `verify cli --env AGENT_PROXY_CONFIG=.verify/runs/<id>/tmp/bad.toml -- daemon start`. Exit `1`; stderr contains `line 2: unknown key "port" (the only key is "listen")`. Repeat with `listen = "127.0.0.1:0` (no closing quote) on line 1: stderr contains `line 1: Unterminated string`. Run `verify cli --env AGENT_PROXY_CONFIG=.verify/runs/<id>/tmp/missing.toml -- daemon start`: exit `1`, stderr contains `AGENT_PROXY_CONFIG names` and `which does not exist.` After each, `daemon status` exits `1`.
- **Built bundle.** After `bun run build`, repeat Start, Status, and Stop with `verify cli --built`. Same results.

## Gotchas

- `daemon start` detaches, so the run's manifest does not record the daemon. `verify down` stops it through `agent-proxy daemon stop`; a daemon started with `verify shell` in the background must be stopped the same way.
- The sandbox config binds port 0, so the port changes on every start. Read it from the start line, `daemon status`, or the state file; never hard-code `8318`.
- The log is written in batches about once a second, so a line can appear up to a second after the event. A daemon killed with SIGKILL can lose its last second of logs and leaves its state file behind; the next `status` reports it as not running. Its lock is a kernel `flock` on `daemon.lock`, released by the OS when the process dies, so the next `start` takes it at once.
- A missing config file at the default location means defaults, which listen on `127.0.0.1:8318`, not port 0. Take the run id from `verify up` or `verify ls`, not `ls` (which may print color codes into the path).
- Errors print as `ERROR` followed by the message on the next line. Assert on the message, not the layout.
