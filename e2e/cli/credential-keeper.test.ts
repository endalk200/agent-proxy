import { defaultRepo, runCli, Sandbox } from "@agent-proxy/sandbox"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { TestClock } from "effect/testing"

// The credential keeper across a crash, black-box: the built daemon in a
// sandbox refreshes a seeded account against a fake Claude token endpoint
// that never answers, and is killed with SIGKILL mid-refresh. Only commands,
// account files, and what the fake receives are observed.

const Accounts = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(Schema.Struct({ label: Schema.String, status: Schema.String })),
  }),
)

const StateFile = Schema.fromJsonString(Schema.Struct({ pid: Schema.Int }))

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for `condition`, checking every 20ms, failing after 5 seconds. */
const eventually = (what: string, condition: () => boolean) =>
  Effect.promise(async () => {
    for (const deadline = Date.now() + 5000; !condition(); await Bun.sleep(20)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    }
  })

/** A Claude token endpoint that takes in refresh requests and never answers them. */
const silentTokenEndpoint = Effect.gen(function* () {
  const refreshes: Array<string> = []
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const body: unknown = await request.json()
          if (typeof body === "object" && body !== null && "refresh_token" in body) {
            refreshes.push(String(body.refresh_token))
          }
          return new Promise<Response>(() => {})
        },
      }),
    ),
    (running) => Effect.promise(() => running.stop(true)),
  )
  return { tokenUrl: `http://127.0.0.1:${server.port}/v1/oauth/token`, refreshes }
})

const credentials = {
  accessToken: "sk-ant-oat01-before-crash",
  refreshToken: "sk-ant-ort01-before-crash",
  // Due a refresh as soon as the daemon starts: it expires in 10 minutes.
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
}

layer(BunServices.layer)("agent-proxy credential keeper (built binary)", (it) => {
  it.effect(
    "a daemon killed mid-refresh leaves the old token pair, and the account needs sign-in after a restart",
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const claude = yield* silentTokenEndpoint
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-proxy-e2e-" })
          const sandbox = yield* Sandbox.scoped(`${root}/sandbox`)
          const env = {
            ...sandbox.env,
            AGENT_PROXY_PROVIDER_ENDPOINTS: JSON.stringify({
              claude: { tokenUrl: claude.tokenUrl },
            }),
          }
          const agentProxy = (args: ReadonlyArray<string>) =>
            runCli({ ...sandbox, env }, defaultRepo.cliBuilt, args, { cwd: root })
          yield* Effect.addFinalizer(() => agentProxy(["daemon", "stop"]).pipe(Effect.ignore))

          const accountsDir = `${sandbox.dataHome}/agent-proxy/accounts`
          const accountFile = `${accountsDir}/aa01.json`
          yield* fs.makeDirectory(accountsDir, { recursive: true, mode: 0o700 })
          yield* fs.writeFileString(
            accountFile,
            JSON.stringify({
              id: "aa01",
              provider: "claude",
              providerAccountId: "account-aa01:org-aa01",
              email: "me@work.example",
              plan: "Max 20x",
              label: "Work",
              priority: 1,
              enabled: true,
              needsSignIn: false,
              addedAt: "2026-11-01T00:00:00.000Z",
              lastUsedAt: null,
              credentials,
            }),
            { mode: 0o600 },
          )

          expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
          yield* eventually("the refresh", () => claude.refreshes.length === 1)
          const { pid } = yield* Schema.decodeEffect(StateFile)(
            yield* fs.readFileString(`${sandbox.stateHome}/agent-proxy/daemon.json`),
          )
          process.kill(pid, "SIGKILL")
          yield* eventually("the daemon to die", () => !isAlive(pid))

          const afterCrash = JSON.parse(yield* fs.readFileString(accountFile))
          expect(afterCrash.credentials).toEqual(credentials)

          expect((yield* agentProxy(["daemon", "start"])).exitCode).toBe(0)
          const listed = yield* agentProxy(["accounts", "--json"])
          expect(listed.exitCode).toBe(0)
          const { accounts } = yield* Schema.decodeEffect(Accounts)(listed.stdout)
          expect(accounts).toEqual([{ label: "Work", status: "needs-sign-in" }])
          expect(yield* agentProxy(["accounts"])).toMatchObject({
            exitCode: 0,
            stdout: expect.stringContaining("Work   me@work.example  Max 20x  1         Needs sign-in"),
          })
          expect(claude.refreshes).toEqual(["sk-ant-ort01-before-crash"])
          expect((yield* fs.readDirectory(accountsDir)).toSorted()).toEqual(["aa01.json"])
        }),
      ),
    60_000,
  )
})
