# Accounts dashboard prototype: notes

**Question:** what should agent-proxy's web dashboard look like, starting with the accounts page?

**Verdict (owner, 2026-11-16):** a **sidebar app shell in a dense console style** (round 2's "A1 Sidebar"). This folder holds that direction, cleaned up. It is disposable: rebuild it in `apps/web/src` with production tests, accessibility and error handling rather than promoting this code.

Run it from the repo root with `bun run prototype:accounts`, then open http://localhost:5180. The yellow-and-black bar at the bottom is prototype chrome, not part of the design. From it you can load the edge-state scenarios (first run, a Claude pool where every account is cooling down, a single account), simulate the daemon's live changes (an account hitting its limit, a sign-in expiring, a cooldown ending, the daemon going down), inspect the in-memory state, and toggle light or dark.

## How we got here

| Round | Commit      | Variants                                                                                                                                                                                                 | Owner's verdict                                                         |
| ----- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1     | `8d0df93`   | A Console (dense tables), B Lanes (airy priority ladders), C Keyboard (terminal-style master-detail), D Calm (single-column settings page)                                                               | A is "definitely the right direction"; B, C and D "absolutely terrible" |
| 2     | `37eb456`   | Four app shells in A's style: A1 Sidebar, A2 Top tabs with an Overview page and a page per account, A3 Data grid (one table, expanding rows), A4 Rail and activity (icon rail, ⌘K palette, right column) | A1 chosen, the rest removed                                             |
| Final | this commit | A1 cleaned and polished                                                                                                                                                                                  |                                                                         |

Check out either commit and run the same command to see that round's full comparison.

## The chosen direction

- **Visual language:** neutral greys, one restrained blue accent, crisp 1px borders, dense tables, system font, light and dark. Tokens and primitives are in `dashboard/base.css`.
- **App shell (`dashboard/Dashboard.tsx`, `dashboard/shell.css`):** a full-height left sidebar.
  - **Top:** a daemon switcher, "This Mac · 127.0.0.1:8318". Its menu shows address, version and uptime, offers Copy address, and lists "Connect to a remote daemon" as Planned. This is where remote daemons slot in later.
  - **Pages:** Accounts (a red badge counts accounts needing sign-in; an amber dot means a pool is blocked), then Usage, Sessions and Skills, marked Planned.
  - **Pools:** a strip showing which account gets each pool's new sessions, visible from every page.
  - **Bottom:** Connect clients (a dialog) and Settings (Planned).
- **Page header pattern:** every page has a title, a one-line description and right-aligned actions. Planned pages render a placeholder with a faint skeleton of their eventual layout (`dashboard/future.tsx`).
- **Accounts page (`dashboard/accounts.tsx`):**
  - **Layout:** one table per provider. The section header says which account gets new sessions, or "No account available · next reset …".
  - **Rows:** priority badge, label and email, plan badge, status with reset time and countdown or a "Sign in again" button, last used, enable switch, ⋯ menu.
  - **Editing:** drag the grip (or use arrow keys) to change priority; double-click a label to rename it.
  - **Narrow widths:** tables drop "Last used", then "Plan", rather than overflowing.
- **Account sheet (`dashboard/sheet.tsx`):**
  - **Opening:** clicking a row slides a sheet in from the right. The page stays usable: clicking another row swaps the sheet, clicking elsewhere or Esc closes it. On screens 1280px and wider the page makes room for the sheet instead of sitting under it.
  - **Contents:** a status card with its action, then tabs Overview, Activity (this account's events) and Usage (Planned). Overview has priority with move up/down, the enable switch, details and the pool order. Remove sits at the bottom.
  - **Later:** per-account usage lives here.
- **Dialogs:**
  - **Add account / Sign in again (`dashboard/AddAccountModal.tsx`):** pick a provider, then the login opens in a new tab while the dialog waits. A "paste the callback URL" path covers headless or SSH use. Success shows the signed-in email and plan with an editable label.
  - **Remove:** a confirmation.
  - **Connect clients:** the three `agent-proxy connect …` commands with copy buttons and which pool each client uses, plus the proxy key (masked, reveal and copy).
- **Live updates:** a changed row flashes in its new status colour, and a toast describes the change. The sidebar badge and pool strip update too.
- **Daemon unreachable:** a banner, a red dot on the switcher, the page dimmed and read-only, still showing the last reported state.

## What we learned

- The owner wants a pro tool's density and restraint (Linear/Vercel). Airy gradients, retro-terminal styling and settings-app calm were all rejected outright.
- Design the **shell**, not the page. The dashboard will grow Usage, Sessions, Skills and remote daemons (`docs/vision.md`). A sidebar has room for all of them, and a daemon switcher is the natural home for "which daemon am I looking at".
- **"Which account gets new sessions" is the most useful line on the page.** Every variant in both rounds converged on showing it per pool, and the final design shows it in two places: each section header and the sidebar.
- A slide-over sheet beats a separate page for account details at this size: the table stays in view, and swapping between accounts is one click.
- Put an account's details where its usage will go. The sheet's Usage tab reserves that spot.

## Decisions about the dashboard's behaviour

The prototype assumes these. The owner didn't object, but none is formally decided; settle them in the design session.

1. **Disabled accounts keep their place** in the priority order and are skipped. Re-enabling puts them back where they were.
2. **"Needs sign-in" accounts are skipped** when choosing who gets new sessions, the same as cooling-down ones.
3. **A new account joins at the lowest priority** of its pool. Its label is suggested and can be edited on the success screen.
4. **Removing an account:** sessions already using it finish, and new sessions go to the next account.
5. **When the daemon is unreachable,** the dashboard shows the last known state, read-only, rather than an empty or error page.
6. **The proxy key** appears in Connect clients for now. Settings (Planned) is its eventual home, alongside the daemon's address and the config file's location.

**Still open:** when every account in a pool is cooling down or needs sign-in, what happens to a new session? It could wait for the next reset or fail straight away. The UI deliberately says only "No account available · next reset …" until this is decided.

## Limits

- **Mock data only:** everything lives in `shared/store.ts`, in memory, and the timing is faked. There is no daemon API yet.
- **No real login:** the provider login tab is a stand-in page with an "Allow" button.
- **Not production code:** there are no tests. The lint config on this branch ignores `apps/web/prototype/**`, because the prototype breaks production lint rules (accessibility roles, refs read during render, type assertions).
