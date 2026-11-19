# Install and run agent-proxy

## Requirements

- [Bun](https://bun.sh) 1.4.4 (the version in `package.json` `packageManager`)

## Install

Clone the repository first: `git clone https://github.com/endalk200/agent-proxy.git`. agent-proxy installs from that checkout as one self-contained binary, `~/.local/bin/agent-proxy`, with the dashboard built in; running it needs no Bun ([ADR-0008](adr/0008-installed-from-source-as-one-binary-supervised-by-a-launch-agent.md)).

```sh
bun install
bun run install-local          # build, install ~/.local/bin/agent-proxy, restart a running daemon
agent-proxy daemon install     # macOS: start the daemon at login, and again after a crash
agent-proxy connect claude-code
```

## Update

To update, `git pull` and run `bun run install-local` again. It replaces the binary atomically and restarts the daemon if one was running, so the new build serves at once; `--no-restart` leaves a running daemon on the old build. It never starts a daemon that was not running. `agent-proxy --version`, `info`, `daemon status` and the dashboard name the commit the binary was built from, with `-dirty` when the checkout had uncommitted changes.

## Uninstall

`agent-proxy uninstall` undoes it all: it shows what it would disconnect, asks once, then disconnects every connected client, removes the launch agent, stops the daemon and deletes the binary. Your accounts, proxy key, config and logs stay, and it prints where they are and the command that removes them.

## Run the daemon

The daemon serves the proxy and the dashboard at one address, `http://127.0.0.1:8318/` by default.

```sh
agent-proxy daemon start     # run it in the background; returns once it is ready
agent-proxy daemon status    # pid, address, uptime, build and logs; or why it is down (--json for scripts)
agent-proxy daemon stop      # SIGTERM; it finishes the requests in flight, then exits
agent-proxy daemon restart   # stop it, if it runs, and start it again
agent-proxy daemon run       # or run it in the foreground
```

A stopping daemon, as on `stop`, `restart` or an update, first finishes the requests in flight, still serving new ones meanwhile, so a client mid-turn is never cut off. It waits at most 10 minutes; run `daemon stop` again to cut them off and stop within seconds.

The daemon keeps its lock, state file (`daemon.json`, with its pid and the port it bound), and logs in `$XDG_STATE_HOME/agent-proxy/`, by default `~/.local/state/agent-proxy/`. One daemon runs per state directory. `--log-level debug` sets how much it logs. `daemon.log` holds one JSON object per line, and at 10 MB becomes `daemon.log.1`, replacing the one before. Whatever the daemon prints itself, such as a crash before its logger starts, goes to `daemon.stderr.log`. When the daemon is not running, `daemon status` exits 1 and still says where the logs are, how the launch agent stands, and the last error the daemon logged.

On macOS, `agent-proxy daemon install` registers a launch agent, `~/Library/LaunchAgents/dev.endalk200.agent-proxy.plist`, that runs the installed binary's `daemon run` when you log in and again if it crashes, with the config, state and data directories of the shell you ran it in. A clean `daemon stop` stays stopped until the next `daemon start` or login, and `start` and `restart` go through launchd. Run `install` again after moving the binary; `agent-proxy daemon uninstall` stops the daemon and removes the agent. It runs only as the installed binary, with `HOME` your real home, so a verify sandbox can never register one, and Linux is not supported yet.
