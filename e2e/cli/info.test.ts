import { spawnSync } from "node:child_process"

import { describe, expect, it } from "vitest"

import { cliBin } from "../support/paths.ts"

// Black-box: run the built binary as a user would and check only stdout,
// stderr, and the exit code.
const agentProxy = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  spawnSync("bun", [cliBin, ...args], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"], ...env },
  })

describe("agent-proxy (built binary)", () => {
  it("prints its version", () => {
    const result = agentProxy(["--version"])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/agent-proxy v\d+\.\d+\.\d+/)
  })

  it("info --json reports the runtime and resolved config path", () => {
    const result = agentProxy(["info", "--json"], { XDG_CONFIG_HOME: "/xdg" })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      runtime: "bun",
      configPath: "/xdg/agent-proxy/config.json",
    })
  })

  it("exits non-zero with a readable error when no config location exists", () => {
    const result = agentProxy(["info"])
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Could not resolve the config file path")
  })

  it("exits non-zero on an unknown subcommand", () => {
    const result = agentProxy(["bogus"])
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('Unknown subcommand "bogus"')
  })
})
