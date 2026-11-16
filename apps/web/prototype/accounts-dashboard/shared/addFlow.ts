// PROTOTYPE: the add-account (and "Sign in again") flow as a small state machine with mocked timing.
// Each variant renders these steps however it likes (modal, drawer, inline, pane).
//
//   pick ──choose(provider)──▶ waiting ──(login tab approves | pasteCallback(url))──▶ verifying ──1.2s──▶ success
//
// choose() opens a mock provider login in a new tab. That tab has an "Allow" button which reports back
// and closes itself. If the popup is blocked, openLogin() retries; pasteCallback() is the headless/SSH path.

import { useCallback, useEffect, useRef, useState } from "react"

import { type Plan, type Provider, providerLoginHost, providerName } from "./model.ts"
import { actions, getState } from "./store.ts"

export type AddStep =
  | { kind: "pick" }
  | { kind: "waiting"; provider: Provider; popupBlocked: boolean; pasteError: string | null }
  | { kind: "verifying"; provider: Provider }
  | { kind: "success"; provider: Provider; accountId: string; reauth: boolean }

export interface AddFlow {
  step: AddStep
  /** Set when this flow is "Sign in again" for an existing account. */
  reauthAccountId: string | null
  choose(provider: Provider): void
  /** Re-opens the login tab (e.g. after the popup was blocked or closed). */
  openLogin(): void
  /** Returns an error message, or null when accepted. */
  pasteCallback(url: string): string | null
  /** Back to provider choice. */
  back(): void
  reset(): void
  /** The mock login URL to show or copy. */
  loginUrl(provider: Provider): string
}

const VERIFY_MS = 1200

const MOCK_IDENTITIES: Record<Provider, ReadonlyArray<{ email: string; plan: Plan; label: string }>> = {
  claude: [
    { email: "side-project@example.com", plan: "Claude Max 5x", label: "Side project" },
    { email: "lab@example.com", plan: "Claude Pro", label: "Lab" },
    { email: "team@work.example", plan: "Claude Max 20x", label: "Team Max" },
  ],
  codex: [
    { email: "me+codex@example.com", plan: "ChatGPT Plus", label: "Plus" },
    { email: "work@work.example", plan: "ChatGPT Pro", label: "Work Pro" },
  ],
}
let identityCursor = 0

export const loginUrl = (provider: Provider): string =>
  `https://${providerLoginHost[provider]}/oauth/authorize?client_id=agent-proxy&redirect_uri=http%3A%2F%2F127.0.0.1%3A8318%2Fcallback&state=${Math.random().toString(36).slice(2, 10)}`

const CALLBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*[?&]code=[\w-]+/

const openMockLoginTab = (provider: Provider, onApprove: () => void): boolean => {
  const w = window.open("", "_blank")
  if (w === null) return false
  const name = providerName[provider]
  const accent = provider === "claude" ? "#c96442" : "#10a37f"
  w.document.write(`<!doctype html><title>Sign in to ${name} (mock)</title>
<style>body{font:15px/1.5 system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f5f2;color:#222}
.c{background:#fff;padding:36px 40px;border-radius:16px;box-shadow:0 10px 40px #0002;max-width:380px;text-align:center}
small{color:#888;display:block;margin-bottom:18px}button{background:${accent};color:#fff;border:0;border-radius:10px;padding:11px 22px;font:600 15px system-ui;cursor:pointer}</style>
<div class="c"><small>PROTOTYPE · stands in for ${providerLoginHost[provider]}</small>
<h2>agent-proxy wants to use your ${name} account</h2><p>Approve to finish signing in. This tab closes itself.</p>
<button id="ok">Allow</button></div>`)
  w.document.close()
  const btn = w.document.getElementById("ok")
  btn?.addEventListener("click", () => {
    onApprove()
    w.close()
  })
  return true
}

export const useAddAccountFlow = (opts?: { reauthAccountId?: string; provider?: Provider }): AddFlow => {
  const reauthAccountId = opts?.reauthAccountId ?? null
  const [step, setStep] = useState<AddStep>({ kind: "pick" })
  const stepRef = useRef(step)
  stepRef.current = step
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const finish = useCallback(
    (provider: Provider) => {
      setStep({ kind: "verifying", provider })
      timer.current = setTimeout(() => {
        if (reauthAccountId !== null && getState().accounts.some((a) => a.id === reauthAccountId)) {
          actions.markSignedIn(reauthAccountId)
          setStep({ kind: "success", provider, accountId: reauthAccountId, reauth: true })
          return
        }
        const ids = MOCK_IDENTITIES[provider]
        const id = ids[identityCursor++ % ids.length]!
        const accountId = actions.addAccount({ provider, ...id })
        setStep({ kind: "success", provider, accountId, reauth: false })
      }, VERIFY_MS)
    },
    [reauthAccountId],
  )

  const launch = useCallback(
    (provider: Provider) => {
      const opened = openMockLoginTab(provider, () => {
        const s = stepRef.current
        if (s.kind === "waiting" && s.provider === provider) finish(provider)
      })
      return opened
    },
    [finish],
  )

  const choose = useCallback(
    (provider: Provider) => {
      setStep({ kind: "waiting", provider, popupBlocked: false, pasteError: null })
      const opened = launch(provider)
      if (!opened) setStep({ kind: "waiting", provider, popupBlocked: true, pasteError: null })
    },
    [launch],
  )

  // "Sign in again" skips the provider choice.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    const reauth = reauthAccountId === null ? undefined : getState().accounts.find((a) => a.id === reauthAccountId)
    const provider = reauth?.provider ?? opts?.provider
    if (provider !== undefined) {
      started.current = true
      choose(provider)
    }
  }, [choose, reauthAccountId, opts?.provider])

  return {
    step,
    reauthAccountId,
    choose,
    openLogin() {
      const s = stepRef.current
      if (s.kind !== "waiting") return
      const opened = launch(s.provider)
      setStep({ ...s, popupBlocked: !opened })
    },
    pasteCallback(url: string) {
      const s = stepRef.current
      if (s.kind !== "waiting") return null
      if (!CALLBACK.test(url.trim())) {
        const err = "That isn't a callback URL. It starts with http://localhost or http://127.0.0.1 and contains code="
        setStep({ ...s, pasteError: err })
        return err
      }
      finish(s.provider)
      return null
    },
    back() {
      if (timer.current !== null) clearTimeout(timer.current)
      setStep({ kind: "pick" })
    },
    reset() {
      if (timer.current !== null) clearTimeout(timer.current)
      started.current = false
      setStep({ kind: "pick" })
    },
    loginUrl,
  }
}

/** A callback URL that passes validation, for the prototype's "paste" path. */
export const EXAMPLE_CALLBACK = "http://127.0.0.1:8318/callback?code=mock-7Hq2xP&state=a1b2c3"
