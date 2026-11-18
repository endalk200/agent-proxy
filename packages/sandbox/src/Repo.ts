import { fileURLToPath } from "node:url"

/** Absolute paths inside the agent-proxy checkout. */
export interface RepoPaths {
  readonly root: string
  readonly cliSource: string
  /** The compiled binary `bun run build` makes (ADR-0008). */
  readonly cliBuilt: string
  readonly webDir: string
  readonly verifyDir: string
}

export const repoPaths = (root: string): RepoPaths => ({
  root,
  cliSource: `${root}/apps/cli/src/bin.ts`,
  cliBuilt: `${root}/apps/cli/dist/agent-proxy`,
  webDir: `${root}/apps/web`,
  verifyDir: `${root}/.verify`,
})

/** The checkout this package lives in: packages/sandbox/src → repo root. */
export const defaultRepo: RepoPaths = repoPaths(
  fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, ""),
)
