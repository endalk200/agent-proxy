# Accounts

`agent-proxy accounts` lists the accounts the daemon holds, with provider, label, email, plan, priority, and status, as a table or `--json`. `agent-proxy accounts add claude` signs in a Claude account through a login the daemon runs: it opens the browser, or with `--no-browser` prints the sign-in URL and takes the callback URL the owner pastes. The login's redirect returns to `http://localhost:54545/callback`, where the daemon listens only while a login waits. A new account joins the bottom of its pool, labelled after its email unless `--label` names it; signing in to an account already held updates its credentials and keeps its priority and enabled setting, and its label unless `--label` gives a new one. The daemon keeps each account in its own 0600 file in `$XDG_DATA_HOME/agent-proxy/accounts/`, a 0700 directory.

## Sub-features

- `accounts-list` prints a table of provider, label, email, plan, priority, and status (Active, Needs sign-in, Disabled), or says how to add the first account.
- `accounts-json` prints `{ "accounts": [...] }` with the same fields plus `id`, `providerAccountId`, `enabled`, `addedAt`, and `lastUsedAt`, and never credentials.
- `accounts-add-browser` opens the browser at Claude's sign-in page and finishes when the redirect reaches the daemon.
- `accounts-add-paste` (`--no-browser`) prints the sign-in URL and the redirect address, and takes a pasted callback URL; a rejected paste asks again.
- `accounts-add-result` reports `Added Claude account "<label>" (<email>, <plan>) at priority <n>.` or `Signed in again to Claude account "<label>" …; its credentials are updated.`
- `accounts-login-cancel` cancels the login in the daemon on Ctrl-C and frees port 54545; a login nobody finishes expires after 10 minutes, and one Claude does not answer within 30 seconds fails.
- `accounts-callback-page` answers the browser on `localhost:54545/callback`: a success page, or a 400 page naming the problem.
- `accounts-files` keeps one 0600 JSON file per account in a 0700 directory, replaced atomically; a temp file a crash left behind is removed when the daemon starts.
- `accounts-not-running` fails with the daemon-down hint and starts nothing.

## How to get to it (user POV)

- Run `agent-proxy accounts [--json]`.
- Run `agent-proxy accounts add claude [--label <label>] [--no-browser]`, then sign in to Claude in the browser, or paste the URL the browser was redirected to.
- Press Ctrl-C while `accounts add` waits.
- The browser lands on `http://localhost:54545/callback?code=…&state=…` after signing in.
- Read `$XDG_DATA_HOME/agent-proxy/accounts/` (account files) and the `"login started"` and `"login finished"` lines of the daemon's `daemon.log`.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.
- The daemon is running in the run: `verify cli -- daemon start` exits `0`.
- Nothing else listens on port 54545: `curl -s localhost:54545` fails to connect.

- **Not running.** Before `daemon start`, run `verify cli -- accounts` and `verify cli -- accounts add claude`. Each exits `1`; stderr contains ``The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`.``
- **Empty.** Run `verify cli -- accounts`. Exit `0`; stdout is ``No accounts yet. Add one with `agent-proxy accounts add claude`.`` Run `verify cli -- accounts --json`. Exit `0`; stdout is `{ "accounts": [] }` (pretty-printed).
- **Seeded list.** Seed three accounts the way the daemon writes them:
  `verify shell -- -c 'd="$XDG_DATA_HOME/agent-proxy/accounts"; mkdir -p -m 700 "$XDG_DATA_HOME/agent-proxy" "$d"; seed() { umask 077; printf "{\"id\":\"%s\",\"provider\":\"claude\",\"providerAccountId\":\"acct-%s:org-%s\",\"email\":\"%s\",\"plan\":\"%s\",\"label\":\"%s\",\"priority\":%s,\"enabled\":%s,\"needsSignIn\":%s,\"addedAt\":\"2026-11-01T00:00:00.000Z\",\"lastUsedAt\":null,\"credentials\":{\"accessToken\":\"seeded\",\"refreshToken\":\"seeded\",\"expiresAt\":\"2099-01-01T00:00:00.000Z\"}}" "$1" "$1" "$1" "$2" "$3" "$4" "$5" "$6" "$7" > "$d/$1.json"; }; seed a1 me@work.example "Max 20x" Work 1 true false; seed a2 me@home.example "Max 5x" "Personal Max" 2 true true; seed a3 spare@example.com Pro Spare 3 false false'`.
  Run `verify cli -- accounts`. Exit `0`; a header `PROVIDER  LABEL  EMAIL  PLAN  PRIORITY  STATUS` (aligned) and rows `Work … Active`, `Personal Max … Needs sign-in`, `Spare … Disabled`, in priority order. Run `verify cli -- accounts --json`. Exit `0`; three accounts with `status` `active`, `needs-sign-in`, `disabled`, and the word `seeded` appears nowhere in stdout.
- **Paste login, rejected pastes, Ctrl-C.** Run:
  `verify shell -- -c 'in="$TMPDIR/paste"; out="$TMPDIR/add.out"; rm -f "$in" "$out"; mkfifo "$in"; bun apps/cli/src/bin.ts accounts add claude --no-browser < "$in" > "$out" 2>&1 & p=$!; exec 3>"$in"; until grep -q "paste it here:" "$out"; do sleep 0.1; done; cat "$out"; curl -s -w " HTTP %{http_code}\n" "http://localhost:54545/callback?code=x&state=wrong"; echo "not a url" >&3; echo "http://localhost:54545/callback?code=x&state=wrong" >&3; until grep -q "another Claude sign-in" "$out"; do sleep 0.1; done; tail -n 2 "$out"; kill -INT $p; wait $p; echo "exit=$?"; curl -s localhost:54545 || echo "54545 free"; sleep 1.5; grep "\"login" "$XDG_STATE_HOME/agent-proxy/daemon.log"'`.
  The printed URL is `https://claude.com/cai/oauth/authorize?` with `code=true`, `client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e`, `response_type=code`, `redirect_uri=http://localhost:54545/callback` (encoded), the eight spike scopes, `code_challenge_method=S256`, a `code_challenge`, and a `state`; then `After you sign in, the browser is sent to http://localhost:54545/callback. … paste it here:`. The curl prints a page saying `That URL belongs to another Claude sign-in, not the one in progress.` and `HTTP 400`. The two pastes print `That is not a URL. … Try again:` and `That URL belongs to another Claude sign-in, not the one in progress. Try again:`. Then `exit=130`, `54545 free`, and log lines `"login started"` and `"login finished"` with `"status":"cancelled"`.
- **Real sign-in (owner only).** With a real Claude account, run `verify cli -- accounts add claude --label Work` in a session that can open a browser, or the paste drive above with the real redirect URL pasted instead of the bad ones. Exit `0`; stdout ends `Added Claude account "Work" (<email>, <plan>) at priority <n>.`; the browser shows `Signed in to Claude`. Run it again: stdout ends `Signed in again to Claude account "Work" …; its credentials are updated.`, and `accounts` still lists one row for that email. `verify shell -- -c 'ls -la "$XDG_DATA_HOME/agent-proxy" "$XDG_DATA_HOME/agent-proxy/accounts"'` shows `drwx------` directories and one `-rw-------` file per account, with no `.tmp` files.
- **Built bundle.** After `bun run build`, repeat Empty and Seeded list with `verify cli --built`. Same results.

## Gotchas

- `verify cli` has no stdin, so the paste path is driven through `verify shell` with a FIFO; keep the FIFO's writer open (`exec 3>`) or `accounts add` sees end of input.
- `accounts add claude` without `--no-browser` opens the machine's real browser at claude.com; do not run it unattended.
- `AGENT_PROXY_PROVIDER_ENDPOINTS` (a JSON object shaped like `{"claude":{"apiBaseUrl":…,"authorizeUrl":…,"tokenUrl":…,"profileUrl":…,"callbackPort":…}}`, any field optional) points the daemon at other provider endpoints. Set it with `verify cli --env` on `daemon start` to drive a full sign-in against a fake provider through the built binary. It is for verification and tests only, not an owner setting; an invalid value stops the daemon from starting with a message naming the variable.
- A finished login contacts the real Claude token and profile endpoints. Only the owner's real sign-in reaches them; the drives above never send Claude a request.
- Port 54545 is fixed. A daemon outside the run that is waiting on a Claude login holds it, and the run's login then fails with `Could not listen on 127.0.0.1:54545`.
- Seeded files must match the daemon's format exactly; a file that does not decode is skipped with a `"skipping an unreadable account file"` warning in `daemon.log`, not shown as an error.
- The log is written in batches about once a second; wait before reading the login lines.
