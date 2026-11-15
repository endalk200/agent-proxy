import { chromium } from "@playwright/test"
import { Data, Effect, FileSystem } from "effect"

import * as Runs from "./Runs.ts"

export class BrowseError extends Data.TaggedError("BrowseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** What a page load proved, plus where the evidence files are. */
export interface BrowseReport {
  readonly url: string
  readonly finalUrl: string
  readonly status: number
  readonly title: string
  readonly consoleErrors: ReadonlyArray<string>
  readonly pageErrors: ReadonlyArray<string>
  readonly files: {
    readonly screenshot: string
    readonly aria: string
    readonly report: string
  }
}

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new BrowseError({ message, cause }) })

/**
 * Loads `url` in headless Chromium and captures a full-page screenshot, the
 * accessibility tree (the stable handles to assert on), and every console
 * error and uncaught exception.
 */
export const capture = Effect.fn("Browse.capture")(function* (
  run: Runs.Run,
  url: string,
  label: string,
) {
  const fs = yield* FileSystem.FileSystem
  const prefix = yield* Runs.nextArtifact(run, `browse-${label}`)
  const files = {
    screenshot: `${prefix}.png`,
    aria: `${prefix}.aria.yml`,
    report: `${prefix}.json`,
  }
  // The browser gets the sandbox environment and keeps its profile in the
  // sandbox, like every other process a run starts.
  const browser = yield* Effect.acquireRelease(
    attempt("Could not launch Chromium. Run `bun x playwright install chromium` in e2e/.", () =>
      chromium.launchPersistentContext(`${run.sandbox.tmp}/chromium-profile`, {
        env: run.sandbox.env,
      }),
    ),
    (opened) => Effect.promise(() => opened.close()),
  )
  const page = yield* attempt("Could not open a page", () => browser.newPage())
  const consoleErrors: Array<string> = []
  const pageErrors: Array<string> = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => pageErrors.push(error.message))

  const response = yield* attempt(`Could not load ${url}`, () =>
    page.goto(url, { waitUntil: "networkidle" }),
  )
  const title = yield* attempt("Could not read the title", () => page.title())
  const aria = yield* attempt("Could not read the accessibility tree", () =>
    page.locator("body").ariaSnapshot(),
  )
  yield* attempt("Could not take a screenshot", () =>
    page.screenshot({ path: files.screenshot, fullPage: true }),
  )

  const report: BrowseReport = {
    url,
    finalUrl: page.url(),
    status: response?.status() ?? 0,
    title,
    consoleErrors,
    pageErrors,
    files,
  }
  yield* fs.writeFileString(files.aria, `${aria}\n`)
  yield* fs.writeFileString(files.report, `${JSON.stringify(report, null, 2)}\n`)
  return report
}, Effect.scoped)
