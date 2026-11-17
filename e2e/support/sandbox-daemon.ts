import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Schema } from "effect"

/**
 * The built daemon in a fresh sandbox (ADR-0001), for Playwright, which runs
 * under Node rather than inside Effect. Accounts are seeded as files in the
 * daemon's format with far-future expiries, so no provider is contacted.
 */

export interface SeededAccount {
  readonly id: string
  readonly label: string
  readonly email: string
  readonly plan: string
  readonly priority: number
  readonly enabled?: boolean
  readonly needsSignIn?: boolean
  readonly lastUsedAt?: string | null
}

export interface SandboxDaemon {
  /** The daemon's base URL, where it serves the dashboard. */
  readonly address: string
  /** Runs the built `agent-proxy` with `args` in the sandbox and returns its stdout. */
  readonly agentProxy: (args: ReadonlyArray<string>) => Promise<string>
  readonly seed: (account: SeededAccount) => Promise<void>
  /** Stops the daemon and removes the sandbox. */
  readonly dispose: () => Promise<void>
}

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer))

const StateFile = Schema.fromJsonString(Schema.Struct({ address: Schema.String }))

export const startSandboxDaemon = async (): Promise<SandboxDaemon> => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-e2e-web-"))
  const sandbox = await run(Sandbox.create(`${root}/sandbox`))
  const agentProxy = (args: ReadonlyArray<string>) =>
    run(
      Effect.gen(function* () {
        const result = yield* runCli(sandbox, defaultRepo.cliBuilt, args, { cwd: root })
        if (result.exitCode !== 0) {
          return yield* Effect.die(
            new Error(`agent-proxy ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`),
          )
        }
        return result.stdout
      }),
    )

  await agentProxy(["daemon", "start"])
  const address = await run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const state = yield* fs.readFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`)
      return (yield* Schema.decodeEffect(StateFile)(state)).address
    }),
  )

  const accountsDir = `${sandbox.dataHome}/agent-proxy/accounts`
  const seed = (account: SeededAccount) =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(accountsDir, { recursive: true, mode: 0o700 })
        yield* fs.writeFileString(
          `${accountsDir}/${account.id}.json`,
          JSON.stringify({
            id: account.id,
            provider: "claude",
            providerAccountId: `account-${account.id}:org-${account.id}`,
            email: account.email,
            plan: account.plan,
            label: account.label,
            priority: account.priority,
            enabled: account.enabled ?? true,
            needsSignIn: account.needsSignIn ?? false,
            addedAt: "2026-11-01T00:00:00.000Z",
            lastUsedAt: account.lastUsedAt ?? null,
            credentials: {
              accessToken: "sk-ant-oat01-seeded",
              refreshToken: "sk-ant-ort01-seeded",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          }),
          { mode: 0o600 },
        )
      }),
    )

  const dispose = async () => {
    await agentProxy(["daemon", "stop"]).catch(() => undefined)
    await run(Sandbox.destroy(sandbox, { keepArtifacts: false }))
    await run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })))
  }

  return { address, agentProxy, seed, dispose }
}
