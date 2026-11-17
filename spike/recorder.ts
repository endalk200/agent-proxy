// Disposable recording proxy for the client wire-behaviour spike (#6).
// Never merged to main. Forwards Claude and Codex traffic to the real upstreams
// with a hand-supplied token and logs what each client sends.
//
// Env:
//   SPIKE_DIR          working dir (default /tmp/ap-spike)
//   PORT               listen port (default 8319)
//   CLAUDE_ADD_BETA    "1" adds oauth-2025-04-20 when absent (default "1")
// Files under SPIKE_DIR:
//   key                expected proxy key (re-read every request, to test rotation)
//   claude-token       Claude OAuth access token (from `claude setup-token`)
//   mode.json          fault injection: {"claude":{"status":401},"codex":{"status":503}}
//   log.jsonl          one record per request (written)
//   bodies/<n>.json    full request bodies (written)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DIR = process.env.SPIKE_DIR ?? "/tmp/ap-spike"
const PORT = Number(process.env.PORT ?? 8319)
const ADD_BETA = (process.env.CLAUDE_ADD_BETA ?? "1") === "1"
const CLAUDE_UPSTREAM = "https://api.anthropic.com"
const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex"
const OAUTH_BETA = "oauth-2025-04-20"
const SECRET_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "chatgpt-account-id",
])

let seq = 0
const read = (f: string) =>
  existsSync(join(DIR, f)) ? readFileSync(join(DIR, f), "utf8").trim() : ""
const codexAuth = () =>
  JSON.parse(readFileSync(join(homedir(), ".codex/auth.json"), "utf8")).tokens as {
    access_token: string
    account_id: string
  }
const mode = () => {
  try {
    return JSON.parse(read("mode.json") || "{}") as Record<string, { status: number } | undefined>
  } catch {
    return {}
  }
}

const redactHeaders = (h: Headers) => {
  const out: Record<string, string> = {}
  h.forEach((v, k) => {
    out[k] = SECRET_HEADERS.has(k)
      ? `<redacted len=${v.length}${v.startsWith("Bearer ") ? " bearer" : ""}>`
      : v
  })
  return out
}

const keyStatus = (h: Headers) => {
  const expected = read("key")
  const auth = h.get("authorization")
  const xKey = h.get("x-api-key")
  const sent = auth !== null ? auth.replace(/^Bearer\s*/i, "") : xKey
  const via = auth !== null ? "authorization" : xKey !== null ? "x-api-key" : "none"
  const status =
    sent === null ? "missing" : sent === "" ? "empty" : sent === expected ? "match" : "mismatch"
  return { via, status }
}

const summarizeBody = (text: string) => {
  if (!text) return null
  try {
    const b = JSON.parse(text)
    const sys = Array.isArray(b.system)
      ? b.system
      : b.system
        ? [{ type: "text", text: b.system }]
        : []
    return {
      keys: Object.keys(b),
      model: b.model,
      stream: b.stream,
      max_tokens: b.max_tokens,
      max_output_tokens: b.max_output_tokens,
      metadata: b.metadata,
      prompt_cache_key: b.prompt_cache_key,
      store: b.store,
      include: b.include,
      reasoning: b.reasoning,
      thinking: b.thinking,
      service_tier: b.service_tier,
      instructions_head:
        typeof b.instructions === "string" ? b.instructions.slice(0, 120) : undefined,
      system: sys.map((s: { text?: string; cache_control?: unknown }) => ({
        head: s.text?.slice(0, 120),
        cache_control: s.cache_control,
      })),
      tools: Array.isArray(b.tools)
        ? b.tools.map((t: { name?: string; type?: string }) => t.name ?? t.type)
        : undefined,
      messages: Array.isArray(b.messages) ? b.messages.length : undefined,
      input: Array.isArray(b.input)
        ? b.input.map((i: { type?: string; role?: string }) => i.type ?? i.role)
        : undefined,
    }
  } catch {
    return { nonJson: text.length }
  }
}

const log = (rec: object) => appendFileSync(join(DIR, "log.jsonl"), JSON.stringify(rec) + "\n")

const claudeError = (status: number) => {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 429
          ? "rate_limit_error"
          : status === 400
            ? "invalid_request_error"
            : status === 404
              ? "not_found_error"
              : "api_error"
  return Response.json(
    {
      type: "error",
      error: {
        type,
        message:
          status === 429
            ? "This request would exceed your account's rate limit. Please try again later."
            : "agent-proxy: no Claude account available, every account needs sign-in. Run agent-proxy accounts.",
      },
    },
    {
      status,
      headers:
        status === 429
          ? {
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-utilization": "1.0",
              "anthropic-ratelimit-unified-5h-reset": String(
                Math.floor(Date.now() / 1000) + 2 * 3600,
              ),
              "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 2 * 3600),
              "anthropic-ratelimit-unified-representative-claim": "five_hour",
              "anthropic-ratelimit-unified-overage-status": "rejected",
              "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
            }
          : {},
    },
  )
}
const codexError = (status: number) =>
  Response.json(
    {
      error: {
        type: "invalid_request_error",
        code: "account_unavailable",
        message:
          "agent-proxy: no Codex account available, every account needs sign-in. Run agent-proxy accounts.",
      },
    },
    { status },
  )

// Tee an upstream body to the client unbuffered while scanning SSE for usage.
const relay = (upstream: Response, rec: Record<string, unknown>, t0: number) => {
  if (!upstream.body) return { body: null, done: Promise.resolve() }
  const decoder = new TextDecoder()
  let chunks = 0
  let firstByteMs: number | undefined
  let tail = ""
  const usage: unknown[] = []
  const errors: string[] = []
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const body = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        chunks++
        firstByteMs ??= Date.now() - t0
        tail += decoder.decode(chunk, { stream: true })
        const lines = tail.split("\n")
        tail = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          try {
            const ev = JSON.parse(line.slice(5))
            if (ev.type === "message_start") usage.push({ message_start: ev.message?.usage })
            if (ev.type === "message_delta" && ev.usage) usage.push({ message_delta: ev.usage })
            if (ev.type === "response.completed") {
              usage.push({ completed: ev.response?.usage })
              Object.assign(rec, {
                chunks,
                firstByteMs,
                totalMs: Date.now() - t0,
                usage,
                errors,
                completedEvent: true,
              })
              resolveDone()
            }
            if (ev.type === "error" || ev.type === "response.failed")
              errors.push(line.slice(0, 400))
          } catch {}
        }
        ctl.enqueue(chunk)
      },
      flush() {
        if (!String(upstream.headers.get("content-type")).includes("event-stream") && tail) {
          try {
            const j = JSON.parse(tail)
            if (j.usage) usage.push({ json: j.usage })
            if (j.error) errors.push(JSON.stringify(j.error).slice(0, 400))
          } catch {
            if (upstream.status >= 400) errors.push(tail.slice(0, 400))
          }
        }
        Object.assign(rec, { chunks, firstByteMs, totalMs: Date.now() - t0, usage, errors })
        resolveDone()
      },
    }),
  )
  return { body, done }
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    const t0 = Date.now()
    const id = ++seq
    const url = new URL(req.url)
    const path = url.pathname + url.search
    const isCodex = url.pathname.startsWith("/backend-api/codex")
    const provider = isCodex ? "codex" : "claude"
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text()
    if (bodyText) writeFileSync(join(DIR, "bodies", `${id}.json`), bodyText)
    const rec: Record<string, unknown> = {
      id,
      at: new Date().toISOString(),
      provider,
      method: req.method,
      path,
      key: keyStatus(req.headers),
      headers: redactHeaders(req.headers),
      body: summarizeBody(bodyText),
    }

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      rec.response = { status: 426, note: "websocket refused" }
      log(rec)
      return Response.json(
        {
          error: {
            type: "invalid_request_error",
            message: "agent-proxy: WebSocket transport is not supported; use HTTP.",
          },
        },
        { status: 426 },
      )
    }

    // Key enforcement (off unless SPIKE_DIR/enforce-key exists); /api/hello is exempt.
    const ks = rec.key as { status: string }
    if (
      existsSync(join(DIR, "enforce-key")) &&
      url.pathname !== "/api/hello" &&
      ks.status !== "match"
    ) {
      rec.response = { status: 401, keyRejected: ks.status }
      log(rec)
      const msg =
        ks.status === "mismatch"
          ? "agent-proxy: wrong proxy key. Run agent-proxy key to see the current key."
          : "agent-proxy: no proxy key sent."
      return provider === "claude"
        ? Response.json(
            { type: "error", error: { type: "authentication_error", message: msg } },
            { status: 401 },
          )
        : Response.json(
            { error: { type: "invalid_request_error", code: "invalid_api_key", message: msg } },
            { status: 401 },
          )
    }

    const injected = mode()[provider]
    if (injected) {
      rec.response = { status: injected.status, injected: true }
      log(rec)
      return provider === "claude" ? claudeError(injected.status) : codexError(injected.status)
    }

    const headers = new Headers(req.headers)
    for (const h of [
      "host",
      "authorization",
      "x-api-key",
      "content-length",
      "connection",
      "accept-encoding",
    ])
      headers.delete(h)
    headers.set("accept-encoding", "identity")
    let target: string
    if (isCodex) {
      const a = codexAuth()
      headers.set("authorization", `Bearer ${a.access_token}`)
      headers.set("chatgpt-account-id", a.account_id)
      target = CODEX_UPSTREAM + url.pathname.slice("/backend-api/codex".length) + url.search
    } else {
      headers.set("authorization", `Bearer ${read("claude-token")}`)
      const beta = headers.get("anthropic-beta") ?? ""
      const hasBeta = beta
        .split(",")
        .map((s) => s.trim())
        .includes(OAUTH_BETA)
      rec.oauthBetaSent = hasBeta
      if (!hasBeta && ADD_BETA)
        headers.set("anthropic-beta", beta ? `${beta},${OAUTH_BETA}` : OAUTH_BETA)
      target = CLAUDE_UPSTREAM + path
    }

    let upstream: Response
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: bodyText || undefined,
        redirect: "manual",
        decompress: true,
      } as RequestInit)
    } catch (e) {
      rec.response = { error: String(e) }
      log(rec)
      return Response.json(
        { type: "error", error: { type: "api_error", message: `spike upstream error: ${e}` } },
        { status: 502 },
      )
    }
    const resHeaders = new Headers(upstream.headers)
    for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"])
      resHeaders.delete(h)
    rec.response = { status: upstream.status, headers: redactHeaders(upstream.headers) }
    const { body, done } = relay(upstream, rec.response as Record<string, unknown>, t0)
    let logged = false
    done.then(() => {
      if (!logged) ((logged = true), log(rec))
    })
    req.signal.addEventListener("abort", () => {
      if (!logged)
        ((logged = true), Object.assign(rec.response as object, { clientAborted: true }), log(rec))
    })
    return new Response(body, { status: upstream.status, headers: resHeaders })
  },
})

console.log(`spike recorder on http://127.0.0.1:${server.port} (dir ${DIR}, addBeta=${ADD_BETA})`)
