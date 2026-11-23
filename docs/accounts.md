# Manage accounts

```sh
agent-proxy accounts add claude               # sign in through the browser
agent-proxy accounts add claude --no-browser  # print the URL; paste the callback URL
agent-proxy accounts add codex                # sign in to ChatGPT for Codex (also --no-browser)
agent-proxy accounts                          # provider, label, email, plan, priority, status (--json for scripts)
agent-proxy accounts set Work --label Personal --priority 1  # rename, or move within its pool
agent-proxy accounts set Home --share-priority-with Work     # Home and Work take turns at new sessions
agent-proxy accounts disable Work              # keep it out of its pool, at its priority
agent-proxy accounts enable Work               # put it back where it was
agent-proxy accounts remove Work               # forget it and its credentials
agent-proxy accounts resets                    # each account's limit resets (or one account's; --json)
agent-proxy accounts redeem Work               # redeem its only limit reset, after asking
agent-proxy accounts redeem Work --reset fable # name one by the start of its name or id (--yes skips asking)
```

The daemon runs each login itself ([ADR-0007](adr/0007-accounts-are-added-by-a-fresh-login.md)), so it must be running. A Claude sign-in redirects to `http://localhost:54545/callback`, and a Codex sign-in to `http://127.0.0.1:1455/auth/callback`, the port Codex itself uses, so a Codex login fails while `codex login` waits on it. The daemon listens there only while the login waits. When the browser cannot reach the daemon, such as over SSH, the redirected page fails to load: copy its address and paste it into `accounts add <provider> --no-browser`. A login nobody finishes expires after 10 minutes.

The dashboard runs the same logins: **Add account** asks for Claude or Codex and opens its sign-in page in a new tab while it waits, and **Sign in again** does the same for an account that needs it. When the browser cannot reach the daemon, paste the redirected address into the dialog instead. Closing the dialog cancels the login.

A new account joins the bottom of its pool, labelled after its email unless `--label` names it. Signing in again to an account the daemon already holds updates its credentials in place and keeps its priority and enabled setting, and its label unless `--label` gives a new one.

`accounts` ends with the order each pool's new sessions go in, such as `New Claude sessions go to "Work", then "Home".`: every Active account, by priority, then by the room left in its limits (see [Sessions and limits](routing.md)). An account that hit a limit shows **Cooling down** with the local time its cooldown ends, such as `Cooling down until 15:30`, and `--json` gives that end as `cooldownEndsAt`. A pool's priorities run 1, 2, 3 with no gaps, and accounts may share one. `--priority <n>` gives an account priority n on its own, moving the accounts from there down one place; `--share-priority-with <account>` puts it at that account's priority instead. A priority left empty closes up, as does removing the last account that held it. A disabled account keeps its priority, so enabling it returns it there. Removing an account deletes its file at once; a request it is already serving still finishes, and the next one goes to the next account.

While any account holds a [limit reset](usage.md#limit-resets), `accounts` shows a RESETS column with how many each one holds, and `--json` lists them as each account's `limitResets`. `accounts resets` lists them, soonest to expire first, with what each refills. `accounts redeem` needs `--reset` only when the account holds several; a name that fits several fails and lists them. Before redeeming, it shows how used each window the reset refills is and what the provider does to the account's reset schedule, then asks `Redeem? [y/N]`. Without a terminal to ask at, it redeems only with `--yes`. A redeem the provider refuses fails with why, and spends nothing.

The account a command acts on is named by its label, its email (either ignoring case), or the start of its id from `accounts --json`. A name that fits several accounts fails and lists them with their ids.

Accounts live in `$XDG_DATA_HOME/agent-proxy/accounts/`, by default `~/.local/share/agent-proxy/accounts/`: one file per account, readable only by you. Only the daemon writes them.

The daemon keeps each account's tokens fresh: it refreshes a Claude account about an hour before its token expires, and a Codex account about a day before, whether or not anything is using it. When the provider refuses a refresh, the account shows **Needs sign-in** and serves nothing until you sign in to it again, with `accounts add <provider>` or **Sign in again** in the dashboard. Any other failed refresh (the network is down or behind a captive portal, the connection drops, the provider answers with a server error, or the daemon stops mid-refresh) is retried a few minutes later with the same refresh token, and the account keeps serving with the token it has. Refresh tokens work once, but retrying costs nothing: if the provider did spend the token, it refuses the retry, and the account needs sign-in as it would have anyway.
