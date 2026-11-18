#!/usr/bin/env bun
/**
 * `bun run install-local [--no-restart]`, from the repo root: builds
 * agent-proxy and installs it as `~/.local/bin/agent-proxy` (ADR-0008).
 * Updating is `git pull` and the same command.
 *
 * The new binary goes to a temporary file beside the installed one and is
 * renamed over it, so a client running `agent-proxy key` mid-update finds the
 * old binary or the new one, never half of one. A daemon that was running is
 * then restarted by the new binary, so the new build serves at once; with
 * `--no-restart`, or when no daemon runs, nothing is started or stopped. It
 * never installs the launch agent: that is `agent-proxy daemon install`.
 */
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { delimiter, join } from "node:path"

const repoRoot = join(import.meta.dir, "..", "..", "..")
const built = join(repoRoot, "apps", "cli", "dist", "agent-proxy")

const fail = (message: string): never => {
  console.error(`install-local: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const unknown = args.filter((arg) => arg !== "--no-restart")
if (unknown.length > 0) fail(`unknown argument ${unknown.join(" ")}; the only one is --no-restart`)
const restart = !args.includes("--no-restart")

const home = process.env["HOME"]
if (home === undefined || home === "") fail("HOME is not set, so there is no ~/.local/bin")
const binDir = join(home ?? "", ".local", "bin")
const target = join(binDir, "agent-proxy")

const build = spawnSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" })
if (build.status !== 0) fail("the build failed; nothing was installed")

mkdirSync(binDir, { recursive: true })
const temp = join(binDir, `.agent-proxy.${randomBytes(4).toString("hex")}.tmp`)
try {
  copyFileSync(built, temp)
  chmodSync(temp, 0o755)
  renameSync(temp, target)
} catch (error) {
  rmSync(temp, { force: true })
  fail(`could not install ${target}: ${error instanceof Error ? error.message : String(error)}`)
}
const version = spawnSync(target, ["--version"], { encoding: "utf8" }).stdout.trim()
console.log(`install-local: installed ${target}: ${version}`)

if (!(process.env["PATH"] ?? "").split(delimiter).includes(binDir)) {
  console.log(
    `install-local: ${binDir} is not on your PATH; add it to run \`agent-proxy\` by name.`,
  )
}

if (!restart) {
  console.log("install-local: --no-restart: a running daemon keeps running the old build.")
} else {
  // The installed binary asks, so it finds the daemon the way the owner's shell does.
  const status = spawnSync(target, ["daemon", "status"], { encoding: "utf8" })
  if (status.status === 0) {
    const restarted = spawnSync(target, ["daemon", "restart"], { stdio: "inherit" })
    if (restarted.status !== 0) fail("the new binary is installed, but the daemon did not restart")
  } else {
    console.log("install-local: no daemon is running, so none was started.")
  }
}
