# The config file is hand-edited TOML; accounts live in the data directory

The config file is TOML, edited only by hand: the CLI and dashboard never write to it, so comments and layout survive. Everything the proxy writes itself lives in the data directory (`$XDG_DATA_HOME/agent-proxy/`), readable only by the owner: one file per account holding its credentials, label, priority, and whether it is enabled, plus the proxy key. This settles two open questions from `docs/vision.md`.

Providers' refresh tokens are single-use: refreshing one invalidates the old one. So the proxy must be the only process that refreshes an account, and must persist the new tokens before using them. Machine-written files can be replaced atomically; a hand-edited config cannot, without losing the owner's edits.

## Considered Options

- **Accounts in the config file.** One file to back up, but the proxy would rewrite a hand-edited file on every token refresh.
- **The OS keychain.** Not available on a headless Linux box, which rules it out for running remotely.
- **YAML or JSONC config.** TOML reads cleanest by hand, the owner already edits Codex's `config.toml`, and Bun parses it natively.
