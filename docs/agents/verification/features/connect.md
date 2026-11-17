# Connect

`agent-proxy connect claude-code` points Claude Code at the proxy by adding `env.ANTHROPIC_BASE_URL` (the daemon's address) and `apiKeyHelper: "agent-proxy key"` to `~/.claude/settings.json`, and leaves every other setting as it was. The file never holds the proxy key: Claude Code fetches it by running `agent-proxy key` (ADR-0005). The command shows the change as a unified diff, asks `Write ~/.claude/settings.json? [y/N]`, and only on `y` or `yes` copies the old file to `settings.json.bak` beside it and writes the new one atomically, keeping the file's mode. A missing file is created; a file that is not valid JSON, or not a JSON object, is refused and left alone; a `settings.json` that is a symlink stays a link, and the file it points to is the one changed. Running it again when nothing would change says so and writes nothing. `--print` prints only the settings to add and touches no file. The address is the running daemon's, asked through its API; with no daemon running it is the `listen` address in `config.toml`, unless that is port 0.

## Sub-features

- `connect-diff` prints `Connecting Claude Code to the proxy at <address> changes ~/.claude/settings.json:`, a unified diff (`--- /dev/null` for a missing file), and the `[y/N]` question, before writing anything.
- `connect-write` on `y` or `yes`, writes the merged settings (2-space JSON, other keys and their order kept, the two settings added or replaced) and prints `Connected Claude Code to the proxy at <address>.`, plus ` The old settings are in ~/.claude/settings.json.bak.` when a file existed.
- `connect-backup` `settings.json.bak` holds the file exactly as it was, with its mode; a missing file gets no `.bak`.
- `connect-decline` any other answer, an empty line, or closed input fails with exit `1` and `Nothing written; ~/.claude/settings.json is unchanged.`
- `connect-changed` a file that changed while the question waited fails with exit `1` and `~/.claude/settings.json changed while you were deciding, so nothing was written. Run this again to see the change against it.`
- `connect-repeat` when both settings already hold these values, prints `Claude Code is already connected to the proxy at <address>; ~/.claude/settings.json is unchanged.`, exits `0`, and asks nothing.
- `connect-missing` creates `~/.claude/` and `settings.json` (mode 0600) when they do not exist.
- `connect-invalid` fails with exit `1` and `~/.claude/settings.json is not valid JSON (<parser message>), so it was left unchanged. Fix it, or move it aside, and run this again.`; a JSON array or an `env` that is not an object fails with `… does not hold Claude Code settings (it is not a JSON object | its env is not an object), so it was left unchanged.`
- `connect-symlink` a linked `settings.json` stays a link to the same file, which now holds the change; the `.bak` sits beside the link, not in the linked directory.
- `connect-print` (`--print`) prints the two settings as JSON on stdout and `Add these settings to ~/.claude/settings.json:` on stderr, exits `0`, and reads or writes no file.
- `connect-address` uses the running daemon's address; with no daemon, the config's `listen` (`0.0.0.0` becomes `127.0.0.1`) plus the note `The daemon is not running, so Claude Code will fail until you start it with \`agent-proxy daemon start\`.`; with no daemon and port 0, fails with exit `1`and`The agent-proxy daemon is not running, and config.toml lets it listen on any free port, so its address is not known yet. Start it with \`agent-proxy daemon start\`, then run this again.`
- `connect-live` a fresh Claude Code session started after `connect` sends its requests to the proxy with the key `agent-proxy key` prints.

## How to get to it (user POV)

- Run `agent-proxy connect claude-code` and answer the question, or `agent-proxy connect claude-code --print`.
- Read `~/.claude/settings.json` and `~/.claude/settings.json.bak` afterwards.
- Start Claude Code (`claude`) in a new terminal after connecting.

## Driving it with verify

Preconditions:

- `verify doctor` is all `ok`.
- The run's `$HOME/.claude` does not exist: `verify shell -- -c 'ls -A "$HOME"'` prints nothing.

`verify cli` gives the command no stdin, so it answers only paths that never ask. Answers go in through `verify shell` with a pipe, which reads the same as typing.

- **Port 0, no daemon.** Run `verify cli -- connect claude-code` and `verify cli -- connect claude-code --print`. Each exits `1` with the `config.toml lets it listen on any free port` message; `$HOME/.claude` still does not exist.
- **Print.** Run `verify cli -- daemon start`, then `verify cli -- connect claude-code --print`. Exit `0`; stdout is `{ "env": { "ANTHROPIC_BASE_URL": "<the address daemon start printed>" }, "apiKeyHelper": "agent-proxy key" }` (pretty-printed), stderr `Add these settings to ~/.claude/settings.json:`. `verify shell -- -c 'ls -A "$HOME"'` still prints nothing.
- **Decline, then confirm, then repeat.** Run:
  `verify shell -- -c 'mkdir -p "$HOME/.claude"; printf "{\n  \"model\": \"opus\",\n  \"env\": { \"DISABLE_TELEMETRY\": \"1\" }\n}\n" > "$HOME/.claude/settings.json"; echo n | bun apps/cli/src/bin.ts connect claude-code; echo "exit=$?"; ls -A "$HOME/.claude"; echo y | bun apps/cli/src/bin.ts connect claude-code; echo "exit=$?"; ls -lA "$HOME/.claude"; cat "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.bak"; bun apps/cli/src/bin.ts connect claude-code </dev/null; echo "exit=$?"'`.
  Both runs print the diff (`-  "env": { "DISABLE_TELEMETRY": "1" }`, then `+` lines for `env` with `DISABLE_TELEMETRY` and `ANTHROPIC_BASE_URL`, and `+  "apiKeyHelper": "agent-proxy key"`) and `Write ~/.claude/settings.json? [y/N]`. The first ends `Nothing written; ~/.claude/settings.json is unchanged.`, `exit=1`, and only `settings.json`. The second ends `Connected Claude Code to the proxy at <address>. The old settings are in ~/.claude/settings.json.bak.` and `exit=0`; the listing shows `settings.json` and `settings.json.bak`, both `-rw-r--r--`; `settings.json` keeps `"model": "opus"` and `DISABLE_TELEMETRY` and adds the two settings; the `.bak` is the original. The third prints `Claude Code is already connected to the proxy at <address>; ~/.claude/settings.json is unchanged.` and `exit=0`, asking nothing.
- **Missing file, linked file, invalid JSON.** Run:
  `verify shell -- -c 'c="$HOME/.claude"; rm -rf "$c"; echo y | bun apps/cli/src/bin.ts connect claude-code | tail -n 1; ls -lA "$c"; rm -rf "$c"; mkdir -p "$c" "$HOME/dotfiles/claude"; echo "{ \"model\": \"opus\" }" > "$HOME/dotfiles/claude/settings.json"; ln -s "$HOME/dotfiles/claude/settings.json" "$c/settings.json"; echo y | bun apps/cli/src/bin.ts connect claude-code > /dev/null; ls -lA "$c"; ls -A "$HOME/dotfiles/claude"; cat "$HOME/dotfiles/claude/settings.json"; rm -rf "$c" "$HOME/dotfiles"; mkdir -p "$c"; echo "{ not json" > "$c/settings.json"; bun apps/cli/src/bin.ts connect claude-code </dev/null; echo "exit=$?"; ls -A "$c"; cat "$c/settings.json"'`.
  The missing file is created as `-rw-------` `settings.json`, with no `.bak`. The linked file stays `settings.json -> …/dotfiles/claude/settings.json` beside a new `settings.json.bak`; the dotfiles directory holds only `settings.json`, now with the two settings. The invalid file fails with the `is not valid JSON (JSON Parse error: …)` message, `exit=1`, and is still `{ not json`, alone.
- **No daemon, fixed port.** Run `verify cli -- daemon stop`, then:
  `verify shell -- -c 'f="$HOME/fixed.toml"; echo "listen = \"0.0.0.0:9318\"" > "$f"; rm -rf "$HOME/.claude"; AGENT_PROXY_CONFIG="$f" bun apps/cli/src/bin.ts connect claude-code --print; echo y | AGENT_PROXY_CONFIG="$f" bun apps/cli/src/bin.ts connect claude-code | tail -n 2; rm -r "$f" "$HOME/.claude"'`.
  Both print `"ANTHROPIC_BASE_URL": "http://127.0.0.1:9318"` and the `The daemon is not running, so Claude Code will fail …` note (on stderr for `--print`).
- **Claude Code reaches the proxy, without an account.** With the daemon running and `connect` confirmed as above, put a shim on `PATH` so Claude Code's `apiKeyHelper` finds `agent-proxy`: `mkdir -p .verify/runs/<id>/bin; printf '#!/bin/sh\nexec bun %s/apps/cli/src/bin.ts "$@"\n' "$PWD" > .verify/runs/<id>/bin/agent-proxy; chmod +x .verify/runs/<id>/bin/agent-proxy`. Then `verify shell -- -c 'export PATH="<repo>/.verify/runs/<id>/bin:$PATH" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; cd /tmp; claude -p "Say hi"; echo "exit=$?"'`. It prints `API Error: 400 agent-proxy: no Claude account. Add one with \`agent-proxy accounts add claude\`.`and`exit=1`: Claude Code read the settings, sent its request to the proxy, and the key it fetched passed (a wrong key reads `wrong proxy key`).
- **Real Claude Code session (owner only).** On the owner's machine, with a real Claude account added and the daemon running, run `agent-proxy connect claude-code`, answer `y`, then start `claude` in a new terminal and send two turns. Both answer through the proxy (the daemon's `daemon.log` shows the requests), and Claude Code shows "API Usage Billing". Restore with `mv ~/.claude/settings.json.bak ~/.claude/settings.json` if wanted.
- **Built bundle.** After `bun run build`, repeat Port 0 and Print with `verify cli --built`. Same results.

## Gotchas

- `verify cli` has no stdin; drive the question through `verify shell` with `echo y |`. Piped input is not echoed, so `Connected …` follows the question on the same line.
- Never drive `connect` outside `verify shell` or `verify cli`: it writes the real `~/.claude/settings.json` of whoever runs it.
- `apiKeyHelper` runs `agent-proxy key` through the shell, so `agent-proxy` must be on Claude Code's `PATH`; the sandbox has no installed binary, hence the shim.
- The sandbox config is `listen = "127.0.0.1:0"`: a daemon there binds a new port on every start, so a connected `settings.json` points at a dead port after a restart. Run `connect` again after `daemon start`.
- `claude` started with the run's `HOME` reads the run's `~/.claude`, and its requests go to the run's proxy, which holds no account, so none reaches Anthropic's API. Do not add a real account to the run for this drive.
