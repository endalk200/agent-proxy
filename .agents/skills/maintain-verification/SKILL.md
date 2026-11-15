---
name: maintain-verification
description: Use only when the user invokes it to audit the verify-agent-proxy skill and its feature map.
disable-model-invocation: true
---

# Maintain verification

The feature map in `.agents/skills/verify-agent-proxy/features/` goes stale the moment the app changes. This pass finds the **drift** and fixes it with proof. The unit of rigour is the feature: every feature file gets read against source and driven live.

## Outcome

End with exactly one, and say which:

- **clean**: every feature got source and live coverage, and nothing needed fixing.
- **changed**: proven corrections to the skill, the map, or the harness sit in the working tree as one reviewable change. Commit or open a PR only when the user asks.
- **blocked**: coverage could not finish, or a proven fix could not land safely. Name exactly what blocked it.

## Edit scope

Edit only `.agents/skills/verify-agent-proxy/` and the harness in `packages/sandbox/`. Product code stays untouched: when the app no longer does what the map says, decide whether the map drifted (fix the map) or the product regressed (report it as a **product gap**, keep it out of this change).

## Pass

1. **Index.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate, or dead index entries.

   Done when the index and the files match one to one.

2. **Source wave.** For each feature file, read the source behind it and answer: how does this user-facing feature actually work today? Flag likely drift with `file:line` citations, and write one live recipe that exercises the file's sub-features. If your harness has subagents, give each feature file to its own read-only subagent and run them concurrently. Subagents never drive the app and never edit.

   Done when every feature file has a summary, a drift verdict (citations, or "none"), and a recipe.

3. **Reconcile.** Merge overlapping recipes so the live pass needs as few app states as possible. Spot-check each cited drift against the code. Then look for user-facing surfaces missing from the map: subcommands registered in `apps/cli/src/cli.ts`, pages and routes under `apps/web/src`, and anything user-facing in `git log` since the map last changed. A surface counts as missing only with a concrete source path.

   Done when every drift claim is confirmed or dropped, and every missing surface has a source path.

4. **Live pass.** Follow the verify skill exactly: `verify up`, `verify doctor`, then drive every feature at least once. Hold three invariants for the whole pass:
   - **Doctor first.** Run doctor before the first drive, after any failed drive, and after anything surprising. When a drive leaves the app in an odd state that doctor cannot see, relaunch rather than hoping.
   - **Evidence survives.** Check that evidence captured so far exists at its printed path after each cleanup.
   - **Nothing outlives the pass.** Run `verify down` after the last drive, including re-drives of fixes, and after any abandoned attempt.

   A doctor failure caused by the skill itself is drift: fix it within edit scope, restart only what the fix invalidated, and retry once before calling the pass blocked. A feature that cannot be reached is **unreachable** only with the concrete missing prerequisite and the entry point you tried; if the map never mentions that prerequisite, that omission is drift too.

   Done when every feature file has been driven, or has a recorded unreachable reason.

5. **Triage.** Sort every finding into one of three:
   - **Drift**: the map describes the feature wrongly or incompletely. Fix the feature file.
   - **Harness gap**: the feature works but `verify` cannot drive it. Fix `packages/sandbox/`, document the new invocation in the verify skill, keep `bun run check` green, and re-drive the feature live before keeping the fix.
   - **Product gap**: the app is broken. Record it for the user, with evidence paths, and change nothing.

6. **Finish.** For changed, re-read every edited file, then report. For clean or blocked, report without editing.

## Report

The outcome; features covered, each with its evidence paths; unreachable features with their prerequisites; confirmed drift and what changed; harness gaps fixed; product gaps for the user. Keep working notes in `.verify/` (git-ignored), never in the repository.
