# Accounts are added by a fresh login, never imported

An account is added only through a provider login that the daemon runs itself, started from the CLI or the dashboard. The provider redirects to a fixed localhost port, or the owner pastes the callback URL, which also works over SSH or on a remote box. Credentials are never imported from `~/.claude`, `~/.codex`, or the macOS keychain, though importing would save a login.

Both providers' refresh tokens are single-use. An imported account would be refreshed by both the proxy and the official CLI, and each refresh would sign the other out. Logging in again with an account already present (same provider account id) refreshes its credentials in place rather than adding a duplicate.
