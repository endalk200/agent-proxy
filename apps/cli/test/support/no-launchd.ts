import { Effect, Layer } from "effect"

import { Launchd } from "../../src/launchd.ts"

/**
 * Launchd for tests that never reach it: their HOME is not the real home, so
 * no command asks launchd anything, and one that did would fail the test
 * rather than touch the developer's real launch agents.
 */
export const noLaunchd = Layer.succeed(
  Launchd,
  Launchd.of({
    plistFile: Effect.die("launchd is not available in this test"),
    readPlist: Effect.die("launchd is not available in this test"),
    writePlist: () => Effect.die("launchd is not available in this test"),
    removePlist: Effect.die("launchd is not available in this test"),
    bootstrap: Effect.die("launchd is not available in this test"),
    bootout: Effect.die("launchd is not available in this test"),
    kickstart: () => Effect.die("launchd is not available in this test"),
    job: Effect.die("launchd is not available in this test"),
  }),
)
