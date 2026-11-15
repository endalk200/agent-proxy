# agent-proxy

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `endalk200/agent-proxy` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Skill labels

Triage and Wayfinder label strings match their canonical role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Working in this repo

Bun workspaces orchestrated by Turbo. `bun run check` is the gate before handing work back; it runs format, lint, typecheck, unit, and integration. `bun run test:e2e` builds the apps and runs the black-box suite in `e2e/` (first run needs `bun x playwright install chromium` inside `e2e/`).

- **Versions**: shared dependency versions live in the root `package.json` catalog; workspaces reference them as `catalog:`.
- **Effect toolchain lockstep**: `typescript`, `oxlint`, `oxlint-tsgolint`, and `@effect/tsgo` are exact-pinned and upgraded together. The `postinstall` patch and `effect-tsgo oxlint` reject any combination `@effect/tsgo` does not list as supported.
- **Effect diagnostics come from lint, not typecheck.** The tsconfig plugin runs with `diagnostics: false`; `effecttsgo/*` rules run through Oxlint, and warnings fail the build.
- **Platform boundary**: within `apps/cli/src`, only `bin.ts` imports `@effect/platform-bun`. Commands depend on Effect services (`FileSystem`, `Path`, `Config`, `RuntimeInfo`) so tests can supply their own. Integration tests provide the real Bun services on purpose: Bun is the only runtime the CLI ships on.
- **Tests**: unit tests sit beside the code as `src/**/*.test.ts`; integration tests (real platform services, in-process) go in `test/integration/`; e2e tests drive built output from `e2e/`. Share layers with `@effect/vitest`'s `layer(...)` and swap per-test values with `Effect.provideService`; `Effect.provide` with a layer inside a test fails `effecttsgo/strict-effect-provide`.
