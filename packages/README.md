# packages

Shared internal packages. They are not built: `exports` point at `src/*.ts`, and Bun and Vite compile them from source.

- `sandbox`: isolated environments for running agent-proxy, and the `bun run verify` tool. Used by the e2e suite and by agents proving a change.

Expected next, each created when the first feature needs it:

- `config`: the configuration file schema (Effect Schema) and loader.
- `contract`: the `HttpApi` definition shared by the daemon (server) and the web client.
