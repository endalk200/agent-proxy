import { readFileSync } from "node:fs"

/**
 * True while a process with `pid` is running. A daemon that exited but was
 * never reaped (its adopting parent, such as a container's PID 1, does not
 * reap) is a zombie that `kill(pid, 0)` still finds; on Linux it counts as gone.
 */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== "linux") return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
  } catch {
    return false
  }
}
