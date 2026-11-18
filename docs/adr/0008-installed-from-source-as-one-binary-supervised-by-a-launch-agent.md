# Installed from source as one binary, supervised by a launch agent the CLI owns

agent-proxy is installed by building it from a checkout of this repo: `bun build --compile` makes one self-contained binary, with the dashboard embedded, and a repo script puts it at `~/.local/bin/agent-proxy`. Updating means pulling and running the same script, which replaces the binary atomically and restarts a running daemon. The build bakes in the git commit, so the CLI, `daemon status`, and the dashboard name the exact build that is running.

On macOS, `agent-proxy daemon install` writes and loads a launch agent (`dev.endalk200.agent-proxy`) that runs the installed binary's `daemon run` at login and restarts it after a crash, but not after a clean exit. Because the CLI wrote the agent, it knows when the daemon is supervised and starts, stops, and restarts it through launchd rather than against it.

## Considered Options

- **A Bun script plus a shim.** Keeps today's build, but ties the install to a Bun binary at an absolute path, since launchd and clients started from a GUI do not see `~/.bun/bin`. Every `agent-proxy key` that a client runs would also pay Bun's script start-up cost, and an update would swap a directory under a running daemon.
- **GitHub Releases or npm.** Built for others, and a downloaded unsigned binary is quarantined by Gatekeeper unless it is signed and notarized. A binary built locally is not quarantined. agent-proxy is a personal tool, and its owner always has a checkout.
- **A launch agent kept in the owner's dotfiles.** Leaner, but the CLI could not tell that launchd supervises the daemon, so `daemon stop` would SIGTERM a process that launchd restarts.

## Consequences

- `daemon install` refuses unless it runs as the compiled binary and `HOME` is the account's real home directory, taken from the OS user record. `launchctl` acts on the user's real launchd whatever `HOME` says, so a verify sandbox (ADR-0001) must never reach it. The launchd integration is checked by hand, not by e2e tests.
- Under launchd, a daemon refused by the single-instance lock (ADR-0002) exits 0, so launchd does not retry it every few seconds.
- `connect` writes the installed binary's absolute path into client configs, since a client's PATH may not include `~/.local/bin`.
- macOS only. Linux (`systemd --user`) and a download channel (Releases) are expected later, for running the daemon on a remote box (see `docs/vision.md`). Revisit this record then.
