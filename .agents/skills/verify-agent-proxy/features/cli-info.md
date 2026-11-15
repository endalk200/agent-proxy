# CLI info

`agent-proxy info` shows the installed version, the runtime and platform it runs on, and the config file path the CLI would load, as aligned text or as JSON. When no config location can be derived, it exits non-zero with a one-line error.

## Sub-features

- `info-text` prints four aligned lines: product and version, runtime, platform, config.
- `info-json` prints the same facts as a JSON object with `--json`.
- `info-config-explicit` uses `AGENT_PROXY_CONFIG` verbatim when set.
- `info-config-xdg` falls back to `$XDG_CONFIG_HOME/agent-proxy/config.json`, then `$HOME/.config/agent-proxy/config.json`.
- `info-error` fails with a readable message when none of the three is set.

## How to get to it (user POV)

- Run `agent-proxy info` in a terminal.
- Run `agent-proxy info --json` for machine-readable output.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.

- **Text.** Run `verify cli -- info`. Exit `0`; four lines start `agent-proxy`, `runtime`, `platform`, `config`, and the config line ends in `/config/agent-proxy/config.json` inside the run directory.
- **JSON.** Run `verify cli -- info --json`. Exit `0`; stdout parses as JSON with keys `version`, `runtime`, `runtimeVersion`, `platform`, `arch`, `configPath`, and `runtime` is `bun`.
- **Explicit config.** Run `verify cli --env AGENT_PROXY_CONFIG=/tmp/agent-proxy-explicit.json -- info --json`. Exit `0`; `configPath` is `/tmp/agent-proxy-explicit.json`.
- **XDG fallback.** Run `verify cli --unset XDG_CONFIG_HOME -- info --json`. Exit `0`; `configPath` is the run's `home/.config/agent-proxy/config.json`.
- **Error.** Run `verify cli --unset HOME --unset XDG_CONFIG_HOME -- info`. Exit `1`; stderr contains `Could not resolve the config file path` and no stack trace.
- **Built bundle.** After `bun run build`, run `verify cli --built -- info --json`. Same result as the JSON drive.

## Gotchas

- An empty `AGENT_PROXY_CONFIG` counts as unset, not as a path.
- A relative `AGENT_PROXY_CONFIG` resolves against the working directory, which for `verify cli` is the repository root.
- `info` only resolves the path; a missing config file is not an error.
