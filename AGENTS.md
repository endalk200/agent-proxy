# agent-proxy

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `endalk200/agent-proxy` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Skill labels

Triage and Wayfinder label strings match their canonical role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Effect 4

Effect 4 renamed and changed much of the Effect 3 API. Before using an Effect API this repo does not already use,
read `LLMS.md` and the examples in `ai-docs/src/`, and search `migration/v3-to-v4.md`, in the Effect repo for
the installed version at `$(opensrc path effect)/../..`. The `source-context` skill covers `opensrc`.
