# Usage is recorded per request in a SQLite file the daemon owns

The daemon records one row per proxied request (time, provider, account, model, client, session, status, latency, and the four token kinds) in a SQLite file in the data directory, using Bun's built-in `bun:sqlite`, and keeps every row forever. The dashboard's ranges run from six hours to lifetime, with custom ranges, and only raw rows answer all of them. At one owner's volume of a few hundred thousand requests a year, SQLite aggregates any range in milliseconds without rollups. The same file holds each account's last-known limit windows, so a restarted daemon still knows them. The CLI and dashboard reach both only through the daemon API, never the file itself, so running the daemon remotely stays a deployment change.

CLIProxyAPI kept its usage in in-memory maps that grew without bound and were lost on every restart (its issues #3129 and #3225), then deleted them and left storage to third-party dashboards. Oh My CPA, the most complete of those, keeps raw events for 90 days in SQLite, plus permanent 15-minute and daily rollups.

## Considered Options

- **In-memory counters.** Simplest, but lost on restart, and they can't answer arbitrary ranges.
- **Raw rows with retention, plus permanent rollups.** Oh My CPA's design. It only pays off at volumes the owner doesn't have, and it fixes the finest granularity for older history.
- **An append-only log file (JSON lines).** No dependency, but every range query becomes a full scan, and history only grows.

## Consequences

- Token counts come from the provider's own usage events. The proxy reads a copy of each response stream as it passes through, and never alters the bytes the client gets (ADR-0006).
- Equivalent cost is not stored. It is computed at query time from a price table in the source, so fixing a price corrects history.
- A request that fails, hits a limit, or whose client disconnects mid-stream is still recorded, so success rates and partial usage are real.
