# Verify agent-proxy

A passing `bun run check` proves the code agrees with its tests. A **run** proves the app does what the change claims: drive the real CLI and web client the way a user does, inside a **sandbox** (throwaway HOME and XDG directories, see `docs/adr/0001-*`), and keep the **evidence**. Feature recipes live in the [feature map](features/README.md).

Every command here is `bun run --silent verify <subcommand>`, shortened below to `verify <subcommand>`; add `--help` to any subcommand for its flags. Work through the steps in order.

## Launch

1. `verify up` creates a run under `.verify/runs/<id>/`, with its own sandbox, and makes it the current run.
2. If the change touches the web client, start it:
   - `verify web` builds and serves `apps/web/dist`, which is what users get.
   - `verify web --dev` serves the Vite dev server with hot reload, for iterating.

Ready when: `up` has printed a run id and, for web changes, `web` has printed a URL.

The run's manifest records the PID of every process it starts. Cleanup stops only those.

The CLI is short-lived: each `verify cli` invocation runs one fresh process in the run's sandbox. The web server is long-lived: one per run, driven serially.

## Doctor

`verify doctor`

Healthy when: every line reads `ok`. It is read-only and checks that the run is up, that the CLI resolves its config inside the sandbox (**isolation**), and that each web server is alive, owned by this run, ready, and built from current source.

Run it before the first drive, and again after any drive that failed or surprised you. A `FAIL` line names its own remedy (a stale preview needs `verify web --restart`): apply it and rerun doctor. Drive only a run whose doctor is all `ok`.

## Drive

Read the [feature map index](features/README.md), then the feature file for every feature the change touches. Each file lists the user entry points and the exact drive for each one.

- **CLI**: `verify cli -- <agent-proxy args>` runs the source; `verify cli --built -- <args>` runs the bundle after `bun run build`. `--env KEY=VALUE` and `--unset KEY` adjust the sandbox environment for one invocation.
- **Web**: `verify browse <path>` loads a page in headless Chromium and saves a screenshot, the accessibility tree, and every console error. For clicks and typing, drive the run's URL with your harness's browser tool, and save its screenshots into the run's `artifacts/` directory.
- **By hand**: `verify shell` opens your shell with the run's environment, inheriting only `PATH`. `verify shell -- -c '<command>'` runs one command.

Done when every behaviour the change touches has been driven through every entry point its feature file lists. Proving one convenient entry point leaves the others unproven.

## Evidence

Proof for a run lands in `.verify/runs/<id>/artifacts/` (git-ignored). `verify cli` and `verify browse` write numbered evidence there and print the paths. A proof meets these standards:

- **User path.** Drive the CLI as a user types it and pages as a user loads them, never internal functions or test-only hooks.
- **Action and result.** Capture what was done and the state it produced: the command with its stdout, stderr, and exit code; the page with its accessibility tree and screenshot.
- **Side effects.** When a behaviour writes files or changes state, show that state from a second, read-only view.
- **Mocks.** Mock only where a production boundary already isolates the external system.
- **Dry runs.** Treat a dry-run or test mode as unproven until you observe what it skips: files, network, processes.
- **Journeys stay as written.** A drive that fails is a finding: report it with its evidence. Changing the feature file or the product to make it pass is a separate decision for the user.

Report each behaviour as: the entry point driven, the observed result, and the evidence path.

## Cleanup

`verify down`, after a failed drive too. It stops only the processes the run recorded starting, deletes the run's state, and keeps `artifacts/`. `verify down --all` tears down every run that is still up.

Done when `verify ls` shows the run as `down` and every evidence path you reported still exists. `verify prune` deletes runs that are down, evidence included; run it only when that evidence is no longer needed.

## Helpers

The harness is the `@agent-proxy/sandbox` package in `packages/sandbox/`, run as `bun run --silent verify <subcommand>` (entry point `packages/sandbox/src/bin.ts`). It shares its sandbox with the e2e suite (`docs/adr/0001-*`), so keep `bun run check` green after changing it.

| Subcommand                | Does                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `up`                      | Create a sandboxed run and make it current.                       |
| `doctor`                  | Read-only health and isolation checks.                            |
| `cli -- <args>`           | Run agent-proxy in the sandbox and record the result as evidence. |
| `web [--dev] [--restart]` | Serve the web client for this run on a free port.                 |
| `browse <path>`           | Load a page; save screenshot, accessibility tree, console errors. |
| `shell [-- -c '<cmd>']`   | Open a shell inside the sandbox.                                  |
| `down [--all]`            | Stop what the run started; keep evidence.                         |
| `ls`                      | List runs, oldest first.                                          |
| `prune`                   | Delete runs that are down, including their evidence.              |

Every subcommand except `up`, `ls`, and `prune` takes `--run <id>` to act on a run other than the current one.

## Keep the map current

A change that adds or alters a user-facing behaviour updates its feature file in the same change, and a new feature gets a new file plus a line in the index. The format is in the [feature map index](features/README.md). User-facing surfaces live in `apps/cli/src/cli.ts` (subcommands) and `apps/web/src` (pages).
