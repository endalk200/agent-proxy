import { Context, Layer } from "effect"

/**
 * Facts about the process the CLI is running in.
 *
 * Kept behind a service so commands never read `process` globals directly:
 * tests provide fixed values, and `bin.ts` provides the real ones.
 */
export class RuntimeInfo extends Context.Service<
  RuntimeInfo,
  {
    readonly runtime: string
    readonly runtimeVersion: string
    readonly platform: string
    readonly arch: string
  }
>()("agent-proxy/RuntimeInfo") {
  /** Reads the current process. Reports Bun when running under Bun, Node otherwise. */
  static readonly layerProcess = Layer.sync(RuntimeInfo, () => {
    const bunVersion = process.versions["bun"]
    return RuntimeInfo.of({
      runtime: bunVersion === undefined ? "node" : "bun",
      runtimeVersion: bunVersion ?? process.versions.node,
      platform: process.platform,
      arch: process.arch,
    })
  })
}
