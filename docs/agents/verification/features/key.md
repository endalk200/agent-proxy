# Proxy key

`agent-proxy key` prints the proxy key, the secret every proxy request must carry (ADR-0005), and nothing else on stdout, so a client can run it to fetch the key: Claude Code through `apiKeyHelper`, Codex through its `auth` command. opencode reads the key file instead, with `{file:…}`. `agent-proxy key --rotate` replaces the key; the old key is refused from the next request on, and Claude Code, which runs `apiKeyHelper` again after a 401, picks up the new one by itself. opencode reads the key file only when it loads its config, so it needs a restart or `opencode reload`. The daemon generates the key on its first run and keeps it, alone, in `$XDG_DATA_HOME/agent-proxy/key`, mode 0600. Both commands ask the running daemon and answer in well under the 5 seconds Codex gives its auth command.

## Sub-features

- `key-print` prints the key on stdout, the same key every time, until it is rotated.
- `key-rotate` (`--rotate`) prints a new key on stdout and, on stderr, `Rotated the proxy key; the old key no longer works. Clients that run \`agent-proxy key\` pick up the new one on their next request. opencode reads the key file only when it starts: restart it, or run \`opencode reload\`.`
- `key-old-refused` a proxy request with a rotated-out key gets the proxy's `wrong proxy key` 401 at once.
- `key-file` keeps the key alone in a 0600 `key` file in the 0700 data directory, kept across daemon restarts.
- `key-not-running` both forms fail with exit `1` and the daemon-down hint naming `agent-proxy daemon start`, and start nothing.
- `key-fast` both forms answer, daemon up or down, in a few hundred milliseconds.

## How to get to it (user POV)

- Run `agent-proxy key` or `agent-proxy key --rotate`.
- A client runs `agent-proxy key` for its key: Claude Code's `apiKeyHelper`, Codex's `auth` command.
- Read `$XDG_DATA_HOME/agent-proxy/key`, the file opencode's `{file:…}` reads.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.

- **Not running.** Before `daemon start`, run `verify cli -- key` and `verify cli -- key --rotate`. Each exits `1` in well under a second; stdout is empty and stderr contains ``The agent-proxy daemon is not running. Start it with `agent-proxy daemon start`.``
- **Print.** Run `verify cli -- daemon start`, then `verify cli -- key` twice. Each exits `0` with the same single line on stdout, `ap-` and 43 more characters, and empty stderr. `verify shell -- -c 'ls -la "$XDG_DATA_HOME/agent-proxy"; cat "$XDG_DATA_HOME/agent-proxy/key"; echo'` shows a `drwx------` directory and a `-rw-------` `key` file holding exactly that key.
- **Rotate.** Save the key with `old=$(bun run --silent verify shell -- -c 'bun apps/cli/src/bin.ts key')`, then run `verify cli -- key --rotate`. Exit `0`; stdout is a new key, stderr the rotation note above. Then:
  `bun run --silent verify shell -- -c "a=\$(jq -r .address \"\$XDG_STATE_HOME/agent-proxy/daemon.json\"); curl -s -w ' HTTP %{http_code}\n' -X POST \"\$a/v1/messages?beta=true\" -H 'content-type: application/json' -H \"x-api-key: $old\" -d '{}'"`.
  It prints the `wrong proxy key` error and `HTTP 401`. `verify cli -- key` prints the new key, and so does `cat` of the key file.
- **Restart.** Run `verify cli -- daemon stop`, `verify cli -- daemon start`, `verify cli -- key`. The key is the one `--rotate` printed.
- **Built bundle.** After `bun run build`, repeat Not running and Print with `verify cli --built`. Same results.

## Gotchas

- The key is a secret. It appears in evidence files; do not paste them anywhere public.
- `verify cli` records stdout and stderr separately; the rotation note is on stderr, so a client reading stdout gets only the key.
- The daemon is the only writer of the key file. Editing it by hand takes effect only after a daemon restart.
