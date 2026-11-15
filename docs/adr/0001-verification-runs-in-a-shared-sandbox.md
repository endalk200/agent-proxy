# Verification runs in a sandbox shared with e2e tests

Agents prove a change by running the real CLI and web client, not only by passing checks. Every such run happens in a sandbox: a directory whose home, XDG config, state, cache, data, and temp locations are throwaway, with an environment that inherits only `PATH`. A run never reads the developer's configuration, never meets their daemon, and only stops the processes it recorded starting. The sandbox lives in one package, `@agent-proxy/sandbox`, used by both the e2e suite and the `bun run verify` tool, so the isolation the tests rely on is the isolation agents get.

## Considered Options

- **Run against the developer's real environment.** Simplest, but an agent would read and overwrite real config and could drive or kill the developer's daemon.
- **Containers per run.** Strong isolation, but slow to start, and the daemon must eventually run natively on macOS and Linux, which a Linux container does not exercise.
- **Separate harnesses for e2e and agent runs.** Each would drift, and a bug in one isolation scheme would hide behind the other passing.

## Consequences

- Everything per-user that agent-proxy reads or writes must come from `HOME` or an XDG variable, never a hard-coded path. Otherwise a sandbox cannot redirect it.
- Evidence (command output, screenshots, accessibility trees) is written to the run's `artifacts/` and survives teardown. `verify prune` is the only command that deletes it.
- Process supervision relies on POSIX process groups and `ps`. Windows is not supported by the verify tool.
