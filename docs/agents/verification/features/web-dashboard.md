# Web dashboard

The browser client's landing page. Today it is a shell: a heading naming the product and a sentence saying the daemon dashboard will live here. It must load without console errors or uncaught exceptions.

## Sub-features

- `dashboard-shell` renders the `agent-proxy` heading and placeholder text.
- `dashboard-clean-load` loads with HTTP 200, no console errors, and no page errors.

## How to get to it (user POV)

- Open the web client's root URL, `/`, in a browser.

## Driving it with verify

Preconditions:

- `verify web` has printed a URL for the current run.
- `verify doctor` is all `ok`, including `web build fresh`.

- **Load.** Run `verify browse /`. Exit `0`; `status 200`, `title agent-proxy`, `console 0 error(s)`, `pageerror 0`.
- **Shell content.** Read the saved `.aria.yml`. It contains `heading "agent-proxy" [level=1]` and a paragraph `The daemon dashboard will live here.`
- **Visual.** Open the saved `.png`. The heading and paragraph are visible.
- **Dev server.** Run `verify web --dev`, then `verify browse /`. Same results as the load and shell content drives.

## Gotchas

- `verify web` serves a build. After editing anything the build reads (`apps/web/src`, `index.html`, `vite.config.ts`, the package's `package.json` or `tsconfig.json`), doctor reports `web build fresh` as `FAIL` until `verify web --restart`.
- In dev mode the page loads React Refresh scripts, so compare accessibility trees rather than raw HTML between modes.
