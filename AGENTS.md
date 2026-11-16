# agent-proxy

agent-proxy serves the owner's AI coding subscriptions (Claude, Codex) from one endpoint, so Claude Code, Codex, opencode, and other clients point at it instead of each logging in to its own account. It is a lean alternative to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI): a daemon, a CLI that runs and configures it, and a web dashboard.

It is a personal tool, built for the owner's workflow first. Others are welcome to use it; generality waits for a real need.

Almost nothing is built or designed yet. A decision recorded in `docs/adr/` is settled; anything else is open, so propose it to the owner rather than assume it.

## What matters

- **Native routing.** Each client spends only its own provider's subscriptions: Claude Code uses Claude accounts, Codex uses Codex accounts, and opencode may use either because it already speaks both providers' APIs. Requests pass through in the provider's own format; the proxy chooses the account, never the API.
- **A dashboard worth opening.** The web client lists every connected account, adds and removes accounts, and shows usage. It looks sleek and modern: visual polish is part of done, not a later pass.
- **A config file edited by hand.** Small and readable, with defaults that cover the common case. A setting earns its place only when no default serves.
- **Lean.** Every provider, option, and endpoint exists because the owner uses it. Completeness for its own sake is the bloat this project replaces.
- **Local first, remote later.** It works on one machine with nothing to set up beyond adding accounts. Running it on a remote box (over Tailscale or similar) is wanted but undesigned; until it is, the CLI and web client reach the daemon only through its HTTP API, so going remote stays a deployment change.

Session archiving and skills sync come after the proxy works. Before a design choice about storage, the daemon's API, remote access, or syncing across machines, read `docs/vision.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `endalk200/agent-proxy` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Skill labels

Triage and Wayfinder label strings match their canonical role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Verification

Before calling a user-facing change done, reproducing a bug in the running app, or confirming a review finding live, follow `docs/agents/verification/README.md`. A change to a user-facing behaviour updates its file in `docs/agents/verification/features/` in the same change.

## Effect 4

Effect 4 renamed and changed much of the Effect 3 API. Before using an Effect API this repo does not already use,
read `LLMS.md` and the examples in `ai-docs/src/`, and search `migration/v3-to-v4.md`, in the Effect repo for
the installed version at `$(opensrc path effect)/../..`. The `source-context` skill covers `opensrc`.
