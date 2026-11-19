# The daemon must be drivable by verification runs

The daemon does not exist yet. When it is built, it must meet these requirements so a verification run (ADR-0001) can start it, know when it is usable, drive it, and stop it without touching anything else:

- **Foreground mode.** `agent-proxy daemon run` stays in the foreground and logs to the state directory. `daemon start` detaches it for users, as a wrapper around the same code path.
- **Ready means usable.** `GET /healthz` returns 200 only once the daemon can serve requests, after config is loaded and listeners are open, not merely when a socket accepts connections.
- **Discoverable instance.** On startup the daemon writes its pid and the port it actually bound to a state file under `$XDG_STATE_HOME/agent-proxy/`. A configured port of `0` binds any free port, so parallel runs never collide.
- **One daemon per state directory.** A lock in the state directory refuses a second daemon there, so a sandboxed daemon and the developer's daemon cannot interfere.
- **Clean shutdown.** SIGTERM finishes in-flight requests, removes the state file, and exits 0. The daemon serves on, new requests included, until no proxied request is in flight, at most 10 minutes, and only then stops accepting work, cancelling what is left after a short grace. A second SIGTERM stops waiting. (Amended 2026-11-19: SIGTERM first stopped accepting work at once and cut in-flight requests after 5 seconds, so every restart and update cut the owner's agents off mid-turn. A long drain that refused new work would trade that for an outage, since the next daemon cannot start until this one releases its lock and port.)
- **Observable.** Logs are structured (one JSON object per line) in the state directory, with the level set by `--log-level`. Every CLI command that reports daemon state supports `--json`.
- **Every path from the environment.** Config, state, logs, and sockets resolve from `HOME`/XDG variables or explicit flags (see ADR-0001).

These requirements are cheap to design in and expensive to retrofit: a daemon that only daemonises, or that reports ready before it is usable, forces sleeps and guesswork into every verification run and e2e test.
