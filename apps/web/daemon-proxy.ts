import { readFileSync } from "node:fs"
import { request } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"

import type { Connect, Plugin } from "vite"

/**
 * In `vite` and `vite preview`, sends the dashboard's `/api/` calls to the
 * daemon running for this environment, as found in its state file, so the
 * dev server shows real data. The daemon serves the built dashboard itself,
 * so none of this ships.
 *
 * With no daemon running, the connection is dropped, as it is when nothing
 * listens, and the dashboard shows the daemon as unreachable.
 */

const stateFile = () => {
  const stateHome = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state")
  return join(stateHome, "agent-proxy", "daemon.json")
}

/** The running daemon's address, or undefined when no state file names one. */
const daemonAddress = (): URL | undefined => {
  try {
    const state: unknown = JSON.parse(readFileSync(stateFile(), "utf8"))
    return typeof state === "object" &&
      state !== null &&
      "address" in state &&
      typeof state.address === "string"
      ? new URL(state.address)
      : undefined
  } catch {
    return undefined
  }
}

const forward: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url?.startsWith("/api/") !== true) return next()
  const target = daemonAddress()
  if (target === undefined) return req.socket.destroy()
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: target.host },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  upstream.on("error", () => req.socket.destroy())
  req.pipe(upstream)
}

export const daemonProxy = (): Plugin => ({
  name: "agent-proxy:daemon-proxy",
  configureServer: (server) => {
    server.middlewares.use(forward)
  },
  configurePreviewServer: (server) => {
    server.middlewares.use(forward)
  },
})
