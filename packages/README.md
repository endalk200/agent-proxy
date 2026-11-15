# packages

Shared internal packages live here. None exist yet; each is created when the first feature needs it. Expected ones:

- `config`: the configuration file schema (Effect Schema) and loader.
- `contract`: the `HttpApi` definition shared by the daemon (server) and the web client.

Internal packages are not built. Point `exports` at `src/*.ts`; Bun and Vite compile them from source.
