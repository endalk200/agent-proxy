# Every proxy request carries the proxy key

Every request to the proxy must carry the proxy key, even on localhost, as `Authorization: Bearer` or `x-api-key`; the proxy strips it before forwarding upstream. The key is generated on first run and stored in the data directory (ADR-0004). Skipping the key on localhost would make running remotely a design change rather than a deployment change, which `AGENTS.md` forbids. Every client already needs a token setting of some kind, so the key costs nothing once the CLI writes it into client configs.

This covers the proxy's provider endpoints only. How the CLI and dashboard authenticate to the daemon's own API is decided with remote access.

## Consequences

- Codex's built-in OpenAI provider sends its own ChatGPT login and cannot carry an extra header. Whether Codex uses that provider or a custom provider carrying the key is decided by testing both.
