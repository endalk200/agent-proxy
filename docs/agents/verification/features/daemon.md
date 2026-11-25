# Daemon

`agent-proxy daemon` runs the daemon in the foreground (`run`) or in the background (`start`), reports it (`status`), stops it (`stop`), restarts it (`restart`), and on macOS registers it with launchd (`install`, `uninstall`). The daemon loads `config.toml`, listens on its `listen` address, answers `GET /healthz` with 200 once it is usable, and records its pid and bound port in a state file. It keeps a single-instance lock and JSON logs, rotated at 10 MB, in its state directory, and exits 0 on SIGTERM after removing the state file. When it is not running, `status` says where the logs are, how the launch agent stands, and the last error the daemon logged. Commands that need the daemon fail with a hint when it is not running and never start it.

## Sub-features

- `daemon-start` starts the daemon in the background and returns once `/healthz` is 200.
- `daemon-status` reports pid, address, uptime, version with the build's commit, and the logs path, as text or `--json`.
- `daemon-status-down` exits `1` when the daemon is not running, and still prints the logs path, the launch agent's state, and the last error the daemon logged; `--json` prints the same facts as JSON.
- `daemon-restart` stops the daemon as `stop` does and starts it again (or starts it when none runs), through launchd when the launch agent is installed.
- `daemon-stop` sends SIGTERM, waits for the daemon to exit, and leaves no state file. A daemon with proxied requests in flight goes on serving, new requests included, until none is in flight (at most 10 minutes), then stops. Past a second, `stop` prints "Waiting for the daemon (pid <pid>) to finish the requests in flight, at most 10m. To cut them off and stop within seconds, run" followed by the `agent-proxy daemon stop` command and "again.". A second SIGTERM (or Ctrl-C) ends the wait: what is still in flight gets 5 seconds, then is cut. A client that goes away mid-request no longer counts as in flight.
- `daemon-run` serves in the foreground and exits 0 on SIGTERM, once no proxied request is in flight.
- `daemon-not-running` fails with a hint naming `agent-proxy daemon start`, and starts nothing.
- `daemon-single-instance` refuses a second daemon on the same state directory, or on the same data directory: through `start`, `The daemon could not start: Another agent-proxy daemon (pid <pid>) is already running for <data dir>.`
- `daemon-free-port` binds any free port for `listen = "…:0"` and records the actual port.
- `daemon-healthz` answers `GET /healthz` with 200.
- `daemon-api-local` serves `/api/` and the dashboard only to this machine, and only to requests whose `Host` names the daemon (a loopback IP address, `localhost`, or the listen host; a name that only looks like a loopback address, such as `127.evil.example`, is refused) and whose `Origin`, when sent, is the daemon's own. Anything else gets 403 `The daemon API is not served to other sites' pages.`, and a client on another machine 403 `The daemon API is served to clients on this machine only.`
- `daemon-logs` writes one JSON object per line to `daemon.log`; `--log-level` sets the minimum level. At 10 MB, at startup or after a write, it becomes `daemon.log.1`, replacing any older one. What the daemon prints itself, such as a crash before its logger exists, goes to `daemon.stderr.log`.
- `daemon-install` (macOS, the installed binary only) writes `~/Library/LaunchAgents/dev.endalk200.agent-proxy.plist` and loads it: launchd runs the daemon at login and after a crash, but not after a clean stop. It refuses from source, in a verify sandbox (`HOME` is not the real home), and on Linux. Run again, it stops the running daemon with SIGTERM first, so the requests in flight finish, before launchd reloads the agent.
- `daemon-supervised` with the launch agent installed: `start` and `restart` go through launchd, `stop` keeps the daemon stopped until the next start or login, and a supervised daemon refused by the lock exits 0.
- `daemon-uninstall` stops the supervised daemon and removes the launch agent; with none installed it says so and exits `0`.
- `daemon-usage-api` serves `GET /api/usage/summary`, `/api/usage/series`, `/api/usage/breakdown`, `GET /api/limits` and `POST /api/limits/refresh`, and adds `usage-recorded` and `limits-changed` to `GET /api/events`; the drives are in [Usage and limit windows](./usage.md). It keeps usage, limit windows and cooldowns in `usage.sqlite` in its data directory.
- `daemon-dashboard-pages` serves the dashboard's `index.html` for `/` and for its pages, such as `/accounts`, so a reload of one works.
- `config-errors` fails on a malformed config or an unknown key, naming the problem and its line, and on an `AGENT_PROXY_CONFIG` that names a missing file.

## How to get to it (user POV)

- Run `agent-proxy daemon start`, `agent-proxy daemon status [--json]`, `agent-proxy daemon stop`, `agent-proxy daemon restart`.
- Run `agent-proxy daemon install` and `agent-proxy daemon uninstall` (macOS, installed binary).
- Run `agent-proxy daemon run [--log-level <level>]` and stop it with SIGTERM or Ctrl-C.
- Request `GET <address>/healthz`, where the address comes from `daemon status` or the state file.
- Request `GET <address>/accounts`, and the usage and limit routes in [Usage and limit windows](./usage.md).
- Read `$XDG_STATE_HOME/agent-proxy/daemon.json` (state file), `daemon.log` and `daemon.log.1` (logs), and `daemon.stderr.log`.
- Edit `$XDG_CONFIG_HOME/agent-proxy/config.toml`, or point `AGENT_PROXY_CONFIG` at another file.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.
- No daemon is running in the run: `verify cli -- daemon status` exits `1`.

- **Not running.** Run `verify cli -- daemon status`. Exit `1`; stderr contains ``The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`.``, then `logs          <state dir>/daemon.log` and `launch agent  not installed`. Run `verify cli -- daemon status --json`. Exit `1`; stdout is JSON `{"running": false, "logs": "<state dir>/daemon.log", "launchAgent": {"installed": false}, "lastError": null}`. Then `verify shell -- -c 'ls "$XDG_STATE_HOME/agent-proxy"'` shows no `daemon.json`.
- **Start.** Run `verify cli -- daemon start`. Exit `0`; stdout is `agent-proxy daemon started (pid <pid>) at http://127.0.0.1:<port>` with a non-zero port.
- **State file.** Run `verify shell -- -c 'cat "$XDG_STATE_HOME/agent-proxy/daemon.json"'`. JSON with `pid` and `port` matching the start line, and `address` `http://127.0.0.1:<port>`.
- **Health.** Run `verify shell -- -c 'curl -s -w " %{http_code}" "$(sed -n "s/.*\"address\": \"\(.*\)\".*/\1/p" "$XDG_STATE_HOME/agent-proxy/daemon.json")/healthz"'`. Output is `{"status":"ok"} 200`.
- **Other sites.** Run `verify shell -- -c 'a=$(jq -r .address "$XDG_STATE_HOME/agent-proxy/daemon.json"); curl -s -w " %{http_code}\n" -H "Host: evil.example" "$a/api/key"; curl -s -w " %{http_code}\n" -X POST -H "Origin: https://evil.example" "$a/api/key/rotate"; curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: $a" "$a/api/key"'`. The first two print the 403 error and `403`; the last prints `200`.
- **Status.** Run `verify cli -- daemon status`. Exit `0`; lines start `agent-proxy daemon is running`, `pid`, `address`, `uptime`, `version` (`<version> (source)` from source, `<version> (<commit>)` with `--built`), and `logs`. Run `verify cli -- daemon status --json`. Exit `0`; JSON with `running: true`, `pid`, `address`, `version`, `build`, `startedAt`, `uptimeSeconds`, `logs`, `launchAgent`.
- **Second daemon.** With the daemon running, run `verify cli -- daemon start`. Exit `1`; stderr contains `The agent-proxy daemon is already running (pid <pid>)`. Run `verify cli -- daemon run`. Exit `1`; stderr contains `Another agent-proxy daemon (pid <pid>) is already running for`. Run `verify cli --env XDG_STATE_HOME=<run>/tmp/state2 -- daemon start` (another state directory, the same data directory). Exit `1`; stderr contains `The daemon could not start: Another agent-proxy daemon (pid <pid>) is already running for <run>/data/agent-proxy.`
- **Logs.** Run `verify shell -- -c 'cat "$XDG_STATE_HOME/agent-proxy/daemon.log"'`. Every line parses as JSON; one has `"message":"daemon started"` and `"level":"INFO"`.
- **Restart.** With the daemon running, run `verify cli -- daemon restart`. Exit `0`; stdout is `agent-proxy daemon restarted (pid <new pid>) at http://127.0.0.1:<port>`, and the old pid is gone. With none running, it prints `agent-proxy daemon started …`.
- **Lookalike names.** With the daemon running, `verify shell -- -c 'a=$(jq -r .address "$XDG_STATE_HOME/agent-proxy/daemon.json"); p=${a##*:}; for h in "127.0.0.1:$p" "localhost:$p" "127.evil.example:$p"; do curl -s -o /dev/null -w "$h %{http_code}\n" -H "Host: $h" "$a/api/key"; done; curl -s -o /dev/null -w "rotate %{http_code}\n" -X POST -H "Host: 127.evil.example:$p" -H "Origin: http://127.evil.example:$p" "$a/api/key/rotate"'` prints `200`, `200`, `403`, and `rotate 403`.
- **Stop and restart mid-turn.** Start a fake Claude API outside the run on `127.0.0.1:51997` (any small Bun server) that answers every request with a `text/event-stream` that sends a `message_start` event at once, waits 8 seconds, then sends `message_delta` and `message_stop` and ends. Stop the daemon, seed `a1` (Work, 1, Active) as in the [accounts](./accounts.md) Seeded list, and `verify cli --env 'AGENT_PROXY_PROVIDER_ENDPOINTS={"claude":{"apiBaseUrl":"http://127.0.0.1:51997"}}' -- daemon start`. In `verify shell`, with `a` the daemon's address and `k=$(bun apps/cli/src/bin.ts key)`, run `(curl -sN "$a/v1/messages" -H "x-api-key: $k" -H "content-type: application/json" -d '{"stream":true}' > "$TMPDIR/turn.out"; echo "turn exit=$?" >> "$TMPDIR/turn.out") & sleep 1; bun apps/cli/src/bin.ts daemon restart & sleep 2; curl -s -o /dev/null -w "meanwhile %{http_code}\n" "$a/v1/messages" -H "x-api-key: $k" -H "content-type: application/json" -d '{}'; wait; cat "$TMPDIR/turn.out"`.
  - About a second after the restart starts, stderr has `Waiting for the daemon (pid <old pid>) to finish the requests in flight, at most 10m. …`; `meanwhile 200` (the old daemon still serves, about 8 seconds later); then `agent-proxy daemon restarted (pid <new pid>) …` once both answers are done.
  - `turn.out` holds `message_start` through `message_stop` and `turn exit=0`: the turn was not cut.
  - `daemon.log` has `"daemon stopping once the requests in flight finish"` with `"inFlight":1`, then `"no request in flight; stopping"` and `"daemon stopped"`.
  - Second stop: start another turn the same way and, at once, `bun apps/cli/src/bin.ts daemon stop & sleep 1; bun apps/cli/src/bin.ts daemon stop; wait`. Both print `agent-proxy daemon stopped (pid <pid>)` about 5 seconds after the second (the grace for what is still in flight), before the 8-second answer would have ended, `daemon.log` has `"asked again to stop; stopping without waiting for the requests in flight"` (a warning), and the turn ends without `message_stop`.
- **Last error.** With the daemon running, run `verify cli -- daemon run` (refused), then `verify cli -- daemon stop` and `verify cli -- daemon status`. Exit `1`; stderr ends with `last error    Another agent-proxy daemon (pid <pid>) is already running for <state dir>.`
- **Stop.** Run `verify cli -- daemon stop`. Exit `0`; stdout is `agent-proxy daemon stopped (pid <pid>)`. The state file is gone, `ps -p <pid>` finds nothing, and `daemon status` exits `1` with the not-running hint. A second `daemon stop` exits `1` with the same hint.
- **Foreground and SIGTERM.** Run `verify shell -- -c 'bun apps/cli/src/bin.ts daemon run --log-level debug & p=$!; until [ -f "$XDG_STATE_HOME/agent-proxy/daemon.json" ]; do sleep 0.1; done; kill -TERM $p; wait $p; echo "exit=$?"; ls "$XDG_STATE_HOME/agent-proxy"'`. Stdout has `agent-proxy daemon listening on http://127.0.0.1:<port> (pid <pid>)`, then `exit=0`, and the listing has no `daemon.json`.
- **Bad config.** Run `verify shell -- -c 'printf "listen = \"127.0.0.1:0\"\nport = 8318\n" > "$TMPDIR/bad.toml"'`, then `verify cli --env AGENT_PROXY_CONFIG=.verify/runs/<id>/tmp/bad.toml -- daemon start`. Exit `1`; stderr contains `line 2: unknown key "port" (the only key is "listen")`. Repeat with `listen = "127.0.0.1:0` (no closing quote) on line 1: stderr contains `line 1: Unterminated string`. Run `verify cli --env AGENT_PROXY_CONFIG=.verify/runs/<id>/tmp/missing.toml -- daemon start`: exit `1`, stderr contains `AGENT_PROXY_CONFIG names` and `which does not exist.` After each, `daemon status` exits `1`.
- **Dashboard pages.** After `bun run build`, with the built daemon running, `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "$a/accounts"` prints `200 text/html; charset=utf-8`, and `"$a/missing.js"` prints `404`.
- **Compiled binary.** After `bun run build`, repeat Start, Status, and Stop with `verify cli --built`. Same results, with the commit in `version`.
- **Install refused in the sandbox.** Run `verify cli --built -- daemon install`. Exit `1`; stderr contains ``\`daemon install\` refuses to run while HOME (<sandbox home>) is not your home directory``. Run `verify shell -- -c 'ls "$HOME/Library"'`: no such directory. Run `verify cli -- daemon install` (source): exit `1`, stderr names `bun run install-local`. Run `verify cli --built -- daemon uninstall`: exit `0`, `The launch agent is not installed; nothing to remove.`

### By hand, on the owner's Mac (not in a sandbox)

The launch agent talks to the real launchd, so no run can drive it (ADR-0008). After `bun run install-local` (see [Install](./install.md)), in the owner's own shell:

- **Install.** Run `agent-proxy daemon install`. It prints `Installed the launch agent ~/Library/LaunchAgents/dev.endalk200.agent-proxy.plist: …` and `agent-proxy daemon started by its launch agent (pid <pid>) at …`. `launchctl print gui/$(id -u)/dev.endalk200.agent-proxy` shows `state = running` and that pid.
- **Crash.** Run `kill -9 <pid>`. Within about 10 seconds `agent-proxy daemon status` shows a new pid.
- **Stop stays stopped.** Run `agent-proxy daemon stop`, wait 15 seconds: `daemon status` exits `1` with `launch agent  loaded, not running (last exit code 0)`.
- **Start and restart.** Run `agent-proxy daemon start`, then `agent-proxy daemon restart`: each prints `… by its launch agent (pid <pid>) …`, with a new pid after restart.
- **Reinstall mid-turn.** Ask Claude Code, through the proxy, for something that streams for a minute (a long essay), and while it streams run `agent-proxy daemon install` again. It prints the `Waiting for the daemon …` notice, the answer finishes in Claude Code, and only then does the install print `agent-proxy daemon started by its launch agent (pid <new pid>) …`.
- **Login.** Log out and in again: `daemon status` shows it running.
- **Uninstall.** Run `agent-proxy daemon uninstall`: the plist is gone, `launchctl print …` reports `Could not find service`, and `daemon status` says `launch agent  not installed`.

## Gotchas

- `daemon start` detaches, so the run's manifest does not record the daemon. `verify down` stops it through `agent-proxy daemon stop`; a daemon started with `verify shell` in the background must be stopped the same way. When a daemon still holds the sandbox's lock after that (it is paused or wedged), `verify down` keeps the run up, names the pid the lock records, and exits `1`; it goes by the lock, never by the state file's pid, which may be stale or reused.
- The sandbox config binds port 0, so the port changes on every start. Read it from the start line, `daemon status`, or the state file; never hard-code `8318`.
- Each log line is written as it happens. A daemon killed with SIGKILL leaves its state file behind; the next `status` reports it as not running. Its lock is a kernel `flock` on `daemon.lock`, released by the OS when the process dies, so the next `start` takes it at once.
- A missing config file at the default location means defaults, which listen on `127.0.0.1:8318`, not port 0. Take the run id from `verify up` or `verify ls`, not `ls` (which may print color codes into the path).
- Errors print as `ERROR` followed by the message on the next line. Assert on the message, not the layout.
- `last error` is the last ERROR line in `daemon.log`, however old: read it with the log's timestamps before calling it the cause.
- Never run `daemon install` outside a sandbox to "check" it from an agent session: it registers a real launch agent. The by-hand section is the owner's.
