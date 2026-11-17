# Web dashboard

The daemon serves the built dashboard at `/` on its own listener, beside `/api/` and the proxy routes. It is a sidebar app shell in a dense console style, light or dark from the system setting. The sidebar holds the daemon switcher ("This Mac" and the daemon's address, with address, version, uptime and Copy address), Accounts with a red badge counting accounts that need sign-in, a pool strip saying who gets each pool's new sessions, and Connect clients. The Accounts page shows one table per pool, headed by which account gets new sessions, and each row's priority, label and email, plan badge, status, last used, enabled switch and an actions menu. With no accounts it shows a three-step first-run guide. When the daemon stops answering, a banner says so and the page keeps the last reported state, dimmed and read-only, until the daemon answers again. Connect clients is a dialog with the three `agent-proxy connect` commands and the proxy key, masked until revealed, each with a copy button. The enabled switch is read-only and the actions menu's items are disabled until the dashboard manages accounts; planned pages are hidden.

## Sub-features

- `dashboard-served` answers `GET /` with the dashboard's `index.html` (`no-cache`) and `/assets/*` with immutable caching; any other path the build lacks, or one outside it, is a 404; with no build found, `/` says to run `bun run build`.
- `dashboard-clean-load` loads with HTTP 200, title `agent-proxy`, no console errors and no page errors.
- `dashboard-pools` shows a region per pool with a table `"<Provider> accounts"` in priority order: priority, label (with a `New sessions` pill on the account that gets them), email, plan, status (`Active`, `Needs sign-in`, `Disabled`), last used (`Never`, `4 min ago`, `yesterday`, …), switch `"<label> enabled"`, and button `"Actions for <label>"`; the region's header reads `New sessions go to <label>`, `No account can take new sessions` (with a callout), or `Every <Provider> account is disabled`.
- `dashboard-sidebar` shows link `Accounts` with `<n> need(s) sign-in` when any account does, else the account count; and a `Pools` list whose items are named `<Provider>: new sessions go to <label>`, `…: no account can take new sessions`, or `…: every account is disabled`.
- `dashboard-switcher` opens a popover titled `Running` (or `Can't reach the daemon`) with Address, Version and Uptime, and a `Copy address` button that copies `http://<address>`.
- `dashboard-first-run` shows a `Get started` list (`Add an account` with `agent-proxy accounts add claude`, `Connect your clients` with the three commands and the proxy key, `Add a fallback`) while the daemon holds no accounts.
- `dashboard-connect-clients` opens dialog `Connect clients` with `agent-proxy connect claude-code`, `codex` and `opencode`, each with `Copy <command>`, the pools each client spends, and the proxy key masked as its first 6 characters, 16 dots and its last 4; `Reveal` shows it whole and `Hide` masks it again; `Copy proxy key` copies it. A copy button is named `Copied` for a moment after it copies.
- `dashboard-unreachable` shows a status banner `Can't reach the daemon at <address>.` within about 3 seconds of the daemon stopping, keeps the tables and pool strip as last reported, dims them, disables every actions menu, and shows `Unreachable` in the switcher; it clears once the daemon answers again. A daemon that answers with an error shows `The daemon answered with an error.` and its message.
- `dashboard-narrow` drops the tables' Last used column first, then Plan, then (on phones) Enabled, and folds the sidebar into an icon rail whose items keep their names.

## How to get to it (user POV)

- Open the daemon's address (`agent-proxy daemon status` prints it; `http://127.0.0.1:8318/` by default) in a browser.
- In development, `bun run dev` (or `verify web --dev`) serves the dashboard with hot reload, and `vite preview` (or `verify web`) serves the build; both pass `/api/` to the daemon named in `$XDG_STATE_HOME/agent-proxy/daemon.json`.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`. `bun run build` has run, so the daemon finds the dashboard.
- Accounts are seeded as in [Accounts](./accounts.md) → Seeded list (Work 1 Active, Personal Max 2 Needs sign-in, Spare 3 Disabled), and `verify cli -- daemon start` exits `0`.
- `verify web` has printed a URL; `verify doctor` includes `web build fresh`.

- **Load.** Run `verify browse /`. Exit `0`; `status 200`, `title agent-proxy`, `console 0 error(s)`, `pageerror 0`.
- **Codex pool.** With a Codex account added as in the [accounts](./accounts.md) Codex sign-in drive (label `Work`, `carol@example.com`, `Pro`) beside the seeded Claude accounts, run `verify browse /`. The accessibility tree has a region `Codex` after `Claude`, reading `New sessions go to Work`, with table `Codex accounts` holding that account (`Pro`, `Active`), and the `Pools` list has `Codex: new sessions go to Work`.
- **Pools and sidebar.** Read the saved `.aria.yml`. It has `navigation "Dashboard"` with `link "Accounts 1 needs sign-in"` and `listitem "Claude: new sessions go to Work"`; `region "Claude"` with `paragraph: New sessions go to Work` and `table "Claude accounts"` whose rows read `1 Work New sessions me@work.example Max 20x Active …`, `2 Personal Max me@home.example Max 5x Needs sign-in …`, `3 Spare spare@example.com Pro Disabled …`; `switch "Work enabled" [checked]` and `switch "Spare enabled"` unchecked.
- **Served by the daemon.** With your browser tool, open the daemon's own address from `verify cli -- daemon status`. Same page, status 200. `verify shell -- -c 'curl -s -o /dev/null -w "%{http_code}\n" "$(bun apps/cli/src/bin.ts daemon status --json | grep -o "http://[^\"]*")/assets/missing.js"'` prints `404`.
- **Connect clients.** In the browser tool, click button `Connect clients`. Dialog `Connect clients` lists the three commands; the text labelled `Proxy key` is masked and differs from `verify cli -- key`'s output; after `Reveal` it equals it. `Copy proxy key` turns into `Copied`, and the clipboard holds the key.
- **Switcher.** Click button `This Mac <address>`. A popover titled `Running` shows the address, `v0.0.0` and an uptime; `Copy address` copies `http://<address>`.
- **Unreachable.** With the page open, run `verify cli -- daemon stop`. Within about 3 seconds a status banner reads `Can't reach the daemon at <address>. … This is what it last reported …`; the Claude table is still there, dimmed; `Actions for Work` is disabled; the switcher reads `Unreachable`. `verify cli -- daemon start` again: the banner clears on the next poll (the new daemon has a new port, so reload the page at its new address when driving the daemon directly).
- **First run.** Move the seeded files aside (`verify shell -- -c 'mv "$XDG_DATA_HOME/agent-proxy/accounts" "$TMPDIR/aside"'`) and reload. `list "Get started"` shows the three steps and `agent-proxy accounts add claude`; there is no table and no Pools list. Move the files back.
- **Visual.** Screenshot at 1360×860 and 390×844, light and dark (your browser tool's colour-scheme emulation). Desktop shows all seven columns; at 390 wide the sidebar is an icon rail and the table shows priority, account, status and actions only.
- **Dev server.** Run `verify web --dev`, then `verify browse /`. Same results as Load and Pools and sidebar.

## Gotchas

- `verify web` and `verify browse` drive Vite's server, which passes `/api/` to the sandbox's daemon through its state file; with no daemon running, the page shows the unreachable banner, not an error. Driving the daemon's own address is the user's path.
- The dashboard polls every 3 seconds; live updates by event stream come later, so wait a poll before reading a change made from the CLI.
- `verify web` serves a build. After editing anything the build reads (`apps/web/src`, `index.html`, `vite.config.ts`, `daemon-proxy.ts`, the package's `package.json` or `tsconfig.json`), doctor reports `web build fresh` as `FAIL` until `verify web --restart`. The daemon reads the build at request time, so after `bun run build` a reload shows it without restarting the daemon.
- The daemon looks for the build at `dist/web` beside its bundle (`apps/cli/dist/web`, copied there by the CLI build), then at `apps/web/dist` when it runs from source.
- Clipboard reads need permission in the browser tool (`clipboard-read`, `clipboard-write`); `127.0.0.1` counts as a secure context, so writes work without HTTPS.
- In dev mode the page loads React Refresh scripts, so compare accessibility trees rather than raw HTML between modes.
