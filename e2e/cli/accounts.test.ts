import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { TestClock } from "effect/testing"

// `accounts`, black-box: the built binary in a sandbox, with accounts seeded
// into the sandbox's data directory in the daemon's file format, so no
// provider is contacted. Logins are covered in-process against a fake Claude.

const Accounts = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        email: Schema.String,
        plan: Schema.String,
        priority: Schema.Int,
        status: Schema.String,
      }),
    ),
  }),
)

const sandboxed = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
  const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
  const agentProxy = (args: ReadonlyArray<string>) =>
    runCli(sandbox, defaultRepo.cliBuilt, args, { cwd: root })
  // Registered after the sandbox, so it runs before the sandbox is removed.
  yield* Effect.addFinalizer(() => agentProxy(["daemon", "stop"]).pipe(Effect.ignore))

  const accountsDir = `${sandbox.dataHome}/agent-proxy/accounts`
  const seed = (account: {
    id: string
    email: string
    plan: string
    label: string
    priority: number
    enabled: boolean
    needsSignIn: boolean
  }) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(accountsDir, { recursive: true, mode: 0o700 })
      yield* fs.writeFileString(
        `${accountsDir}/${account.id}.json`,
        JSON.stringify({
          ...account,
          provider: "claude",
          providerAccountId: `account-${account.id}:org-${account.id}`,
          addedAt: "2026-11-01T00:00:00.000Z",
          lastUsedAt: null,
          credentials: {
            accessToken: "sk-ant-oat01-seeded",
            refreshToken: "sk-ant-ort01-seeded",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        }),
        { mode: 0o600 },
      )
    })

  return { agentProxy, seed }
})

layer(BunServices.layer)("agent-proxy accounts (built binary)", (it) => {
  it.effect(
    "lists seeded accounts with their status, as a table and as JSON without credentials",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const { agentProxy, seed } = yield* sandboxed
          expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
          expect((yield* agentProxy(["accounts"])).stdout.trim()).toBe(
            "No accounts yet. Add one with `agent-proxy accounts add claude`.",
          )

          yield* seed({
            id: "aa01",
            email: "me@work.example",
            plan: "Max 20x",
            label: "Work",
            priority: 1,
            enabled: true,
            needsSignIn: false,
          })
          yield* seed({
            id: "aa02",
            email: "spare@example.com",
            plan: "Pro",
            label: "Spare",
            priority: 2,
            enabled: false,
            needsSignIn: false,
          })

          const table = yield* agentProxy(["accounts"])
          expect(table.exitCode).toBe(0)
          expect(table.stdout.trim()).toBe(
            [
              "PROVIDER  LABEL  EMAIL              PLAN     PRIORITY  STATUS",
              "claude    Work   me@work.example    Max 20x  1         Active",
              "claude    Spare  spare@example.com  Pro      2         Disabled",
            ].join("\n"),
          )

          const json = yield* agentProxy(["accounts", "--json"])
          expect(json.exitCode).toBe(0)
          expect(json.stdout).not.toContain("seeded")
          const { accounts } = yield* Schema.decodeEffect(Accounts)(json.stdout)
          expect(accounts.map(({ label, status }) => ({ label, status }))).toEqual([
            { label: "Work", status: "active" },
            { label: "Spare", status: "disabled" },
          ])
        }),
      ),
    60_000,
  )
})
