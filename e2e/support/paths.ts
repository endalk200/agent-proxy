import { fileURLToPath } from "node:url"

/** Built CLI entry point. `turbo run test:e2e` builds it first via `^build`. */
export const cliBin = fileURLToPath(new URL("../../apps/cli/dist/bin.js", import.meta.url))

/** Built web client. Served by `vite preview` for the Playwright suite. */
export const webDir = fileURLToPath(new URL("../../apps/web", import.meta.url))
