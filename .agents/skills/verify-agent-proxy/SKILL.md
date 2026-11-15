---
name: verify-agent-proxy
description: Use when a change to the agent-proxy CLI or web client needs to be seen working, or when asked to run, launch, drive, or screenshot agent-proxy.
---

# Verify agent-proxy

A passing `bun run check` proves the code agrees with its tests. A **run** proves the app does what the change claims: drive the real CLI and web client the way a user does, inside a **sandbox** (throwaway HOME and XDG directories, see `docs/adr/0001-*`), and keep the **evidence**.

Every command here is `bun run --silent verify <subcommand>`; add `--help` to any subcommand for its flags. Work through the steps in order.

## 1. Launch

1. `verify up` creates a run under `.verify/runs/<id>/` and makes it current.
2. If the change touches the web client, start it:
   - `verify web` builds and serves `apps/web/dist`, which is what users get.
   - `verify web --dev` serves the Vite dev server with hot reload, for iterating.

Done when `up` has printed a run id and, for web changes, `web` has printed a URL.

## 2. Doctor

Run `verify doctor` before the first drive, and again after any drive that surprised you. It is read-only: it confirms the run is up, that the CLI resolves its config inside the sandbox (**isolation**), and that each web server is alive, ours, ready, and built from current source.

Done when every line reads `ok`. A `FAIL` line names its own remedy (a stale preview needs `verify web --restart`); apply it and rerun doctor. Drive only a run whose doctor is all `ok`.

## 3. Drive

Read [`features/README.md`](features/README.md), then the feature file for every feature the change touches. Each file lists the user entry points and the exact drive for each one.

- **CLI**: `verify cli -- <agent-proxy args>` runs the source; `verify cli --built -- <args>` runs the bundle after `bun run build`. `--env KEY=VALUE` and `--unset KEY` adjust the sandbox environment for one invocation.
- **Web**: `verify browse <path>` loads a page in headless Chromium and saves a screenshot, the accessibility tree, and every console error. For clicks and typing, drive the run's URL with your harness's browser tool, and save its screenshots into the run's `artifacts/` directory.

Done when every behaviour the change touches has been driven through every entry point its feature file lists. Proving one convenient entry point leaves the others unproven.

## 4. Evidence

`verify cli` and `verify browse` write numbered evidence to `.verify/runs/<id>/artifacts/` and print the paths. A proof meets these standards:

- **User path.** Drive the CLI as a user types it and pages as a user loads them, never internal functions or test-only hooks.
- **Action and result.** Capture what was done and the state it produced: the command with its stdout, stderr, and exit code; the page with its accessibility tree and screenshot.
- **Side effects.** When a behaviour writes files or changes state, show that state from a second, read-only view.
- **Journeys stay as written.** A drive that fails is a finding: report it with its evidence. Changing the feature file or the product to make it pass is a separate decision for the user.

Report each behaviour as: the entry point driven, the observed result, and the evidence path.

## 5. Cleanup

Run `verify down`, after a failed drive too. It stops only the processes the run recorded starting, deletes the run's state, and keeps `artifacts/`.

Done when `verify ls` shows the run as `down` and every evidence path you reported still exists.

## Keep the map current

A change that adds or alters a user-facing behaviour updates its feature file in the same change, and a new feature gets a new file plus a line in the index. The format is in [`features/README.md`](features/README.md).
