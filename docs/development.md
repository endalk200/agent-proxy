# Develop agent-proxy

## Get started

```sh
bun install
bun apps/cli/src/bin.ts info
```

`bun install` also runs `effect-tsgo patch --oxlint`, which adds the Effect language service rules to the installed TypeScript and Oxlint.

## Commands

Run from the repository root:

| Command                 | What it does                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `bun run dev`           | Start every app in watch mode                                                          |
| `bun run build`         | Build the web client, then the CLI binary `apps/cli/dist/agent-proxy` with it embedded |
| `bun run install-local` | Build, and install the binary as `~/.local/bin/agent-proxy` (`--no-restart`)           |
| `bun run format`        | Format with Oxfmt (`format:check` to verify only)                                      |
| `bun run lint`          | Type-aware Oxlint with Effect rules (`lint:fix` to apply fixes)                        |
| `bun run typecheck`     | Type-check every workspace with TypeScript 7                                           |
| `bun run test`          | Unit and integration tests                                                             |
| `bun run test:e2e`      | Build, then run CLI and dashboard end-to-end tests                                     |
| `bun run check`         | Everything CI runs except end-to-end tests                                             |

The first end-to-end run needs a browser: `cd e2e && bun x playwright install chromium`.

## Layout

| Path        | Contents                                                               |
| ----------- | ---------------------------------------------------------------------- |
| `apps/cli`  | `@agent-proxy/cli`: the `agent-proxy` CLI and daemon, built on Effect  |
| `apps/web`  | `@agent-proxy/web`: the browser client (Vite and React)                |
| `packages/` | Shared internal packages, added as features need them                  |
| `e2e`       | End-to-end tests against the compiled CLI and the web client it serves |

## Tests

| Layer       | Location                   | Scope                                                        |
| ----------- | -------------------------- | ------------------------------------------------------------ |
| Unit        | `src/**/*.test.ts`         | In-memory, with test layers                                  |
| Integration | `apps/*/test/integration/` | Real platform services, run in-process                       |
| End-to-end  | `e2e/cli`, `e2e/web`       | The built binary as a child process; the web app in Chromium |

## See it run

`bun run verify` runs agent-proxy inside a sandbox: a directory under `.verify/runs/<id>/` that stands in for your home and XDG directories, so nothing touches your real configuration. Each command it runs and each page it loads is saved as evidence in the run's `artifacts/`.

```sh
bun run verify up                 # create a run
bun run verify doctor             # check it is isolated and healthy
bun run verify cli -- info        # run the CLI from source; output saved as evidence
bun run verify web                # build and serve the web client on a free port
bun run verify browse /           # screenshot, accessibility tree, and console errors
bun run verify down               # stop what the run started; evidence is kept
```

To work inside the sandbox yourself, `bun run verify shell` opens your shell with the run's environment and nothing else from your session except `PATH`. Run one command with `bun run verify shell -- -c 'bun apps/cli/src/bin.ts info'`.

Agents follow the same flow through the runbook in [`docs/agents/verification/README.md`](agents/verification/README.md). [ADR-0001](adr/0001-verification-runs-in-a-shared-sandbox.md) explains the design.
