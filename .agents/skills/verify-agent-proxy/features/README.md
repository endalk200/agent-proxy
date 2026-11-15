# agent-proxy feature map

The maintained source for what a user can do with agent-proxy and how to prove each behaviour. Read this index, then the file for the feature you are verifying.

## Baseline

- A run from `verify up` whose `verify doctor` is all `ok`.
- The sandbox config file holds the fixture `{}`. Nothing reads it yet.
- Web features also need `verify web` (or `verify web --dev`) for the current run.

## Driving conventions

- Commands are literal: keep names, flags, and quoting exactly as written.
- In the web client, find elements by ARIA role and accessible name, never by CSS selector or position.
- Start every drive from the baseline unless its preconditions say otherwise.

## Feature file contract

Each file starts with an H1 title and one paragraph describing the user-visible behaviour, then exactly these H2 sections, in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every entry point a user has.
3. `Driving it with verify`: begins with `Preconditions:`, then one bullet per action pairing the exact command with the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

Name only user paths, stable handles, commands, and observable results; leave implementation details to the code.

## Features

- [CLI info](./cli-info.md): version, runtime, and resolved config path, as text or JSON, including the error when no config location exists.
- [CLI help and version](./cli-help-and-version.md): help, version, shell completions, and rejection of unknown subcommands.
- [Web dashboard](./web-dashboard.md): the browser client's landing page.
