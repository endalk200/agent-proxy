import { CString, dlopen, FFIType, read } from "bun:ffi"

import { Context, Layer, Option } from "effect"

import packageJson from "../package.json" with { type: "json" }

/** What a compiled binary was built from: the checkout's commit, and whether its tree had uncommitted changes. */
export interface Build {
  readonly commit: string
  readonly dirty: boolean
}

/** The compiled binary this process runs as (ADR-0008). */
export interface Binary extends Build {
  /** The executable's absolute path. */
  readonly path: string
}

/**
 * Facts about the process the CLI is running in.
 *
 * Kept behind a service so commands never read `process` globals directly:
 * tests provide fixed values, and the entry points provide the real ones.
 */
export class RuntimeInfo extends Context.Service<
  RuntimeInfo,
  {
    readonly runtime: string
    readonly runtimeVersion: string
    readonly platform: string
    readonly arch: string
    /** The compiled binary this process runs as, or `None` when it runs from source. */
    readonly binary: Option.Option<Binary>
    /**
     * The account's home directory from the OS user record, whatever `HOME`
     * says; `None` when the record cannot be read.
     */
    readonly realHome: Option.Option<string>
  }
>()("agent-proxy/RuntimeInfo") {
  /** Reads the current process, running from source. Reports Bun when running under Bun, Node otherwise. */
  static readonly layerProcess = Layer.sync(RuntimeInfo, () => current(Option.none()))

  /** Reads the current process, running as the binary compiled from `build`. */
  static readonly layerCompiled = (build: Build) =>
    Layer.sync(RuntimeInfo, () => current(Option.some({ ...build, path: process.execPath })))
}

const current = (binary: Option.Option<Binary>) => {
  const bunVersion = process.versions["bun"]
  return RuntimeInfo.of({
    runtime: bunVersion === undefined ? "node" : "bun",
    runtimeVersion: bunVersion ?? process.versions.node,
    platform: process.platform,
    arch: process.arch,
    binary,
    realHome: homeFromUserRecord(),
  })
}

/**
 * `pw_dir` of the current user's `getpwuid(3)` record. Not `os.userInfo()`,
 * whose `homedir` Bun takes from `HOME`: a verify sandbox sets `HOME`, and
 * `daemon install` must tell it from the real home (ADR-0008).
 */
const homeFromUserRecord = (): Option.Option<string> => {
  // Where `pw_dir` sits in `struct passwd` on 64-bit macOS and Linux.
  const offset = process.platform === "darwin" ? 48 : process.platform === "linux" ? 32 : undefined
  if (offset === undefined) return Option.none()
  try {
    const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
      getuid: { args: [], returns: FFIType.u32 },
      getpwuid: { args: [FFIType.u32], returns: FFIType.ptr },
    })
    try {
      const record = libc.symbols.getpwuid(libc.symbols.getuid())
      if (record === null) return Option.none()
      const dir = read.ptr(record, offset)
      // Typed as a string, a CString is a String object: `toString` makes it a primitive.
      // oxlint-disable-next-line typescript/no-unnecessary-type-conversion
      return dir === 0 ? Option.none() : Option.some(new CString(dir).toString())
    } finally {
      libc.close()
    }
  } catch {
    return Option.none()
  }
}

/** The build a process runs: `abc1234`, `abc1234-dirty` when its tree had uncommitted changes, or `source`. */
export const buildLabel = (binary: Option.Option<Build>): string =>
  Option.match(binary, {
    onNone: () => "source",
    onSome: (build) => `${build.commit}${build.dirty ? "-dirty" : ""}`,
  })

/** The version the CLI and the daemon report: `0.0.0 (abc1234)`, or `0.0.0 (source)`. */
export const versionText = (binary: Option.Option<Build>): string =>
  `${packageJson.version} (${buildLabel(binary)})`
