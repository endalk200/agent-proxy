# agent-proxy

A command-line tool that runs as a background daemon, with a browser client for watching and controlling it.

The repository is scaffolded but the application is not built yet. The CLI has one command, `info`.

## Requirements

- [Bun](https://bun.sh) 1.4.4 (the version in `package.json` `packageManager`)

## Getting started

```sh
bun install
bun apps/cli/src/bin.ts info
```

`bun install` also runs `effect-tsgo patch --oxlint`, which adds the Effect language service rules to the installed TypeScript and Oxlint.

## Commands

Run from the repository root:

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `bun run dev`       | Start every app in watch mode                                   |
| `bun run build`     | Build the CLI bundle and the web client                         |
| `bun run format`    | Format with Oxfmt (`format:check` to verify only)               |
| `bun run lint`      | Type-aware Oxlint with Effect rules (`lint:fix` to apply fixes) |
| `bun run typecheck` | Type-check every workspace with TypeScript 7                    |
| `bun run test`      | Unit and integration tests                                      |
| `bun run test:e2e`  | Build, then run CLI and browser end-to-end tests                |
| `bun run check`     | Everything CI runs except end-to-end tests                      |

The first end-to-end run needs a browser: `cd e2e && bun x playwright install chromium`.

## Layout

| Path        | Contents                                                              |
| ----------- | --------------------------------------------------------------------- |
| `apps/cli`  | `@agent-proxy/cli`: the `agent-proxy` CLI and daemon, built on Effect |
| `apps/web`  | `@agent-proxy/web`: the browser client (Vite and React)               |
| `packages/` | Shared internal packages, added as features need them                 |
| `e2e`       | End-to-end tests against the built CLI and web client                 |

## Tests

| Layer       | Location                   | Scope                                                        |
| ----------- | -------------------------- | ------------------------------------------------------------ |
| Unit        | `src/**/*.test.ts`         | In-memory, with test layers                                  |
| Integration | `apps/*/test/integration/` | Real platform services, run in-process                       |
| End-to-end  | `e2e/cli`, `e2e/web`       | The built binary as a child process; the web app in Chromium |

## Configuration

`agent-proxy info` shows which configuration file the CLI would load. It checks, in order: `AGENT_PROXY_CONFIG`, then `$XDG_CONFIG_HOME/agent-proxy/config.json`, then `~/.config/agent-proxy/config.json`. Nothing reads the file yet.
