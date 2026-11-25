# agent-proxy

agent-proxy serves its owner's AI coding subscriptions from one endpoint, so every coding agent they use spends those subscriptions without logging in itself.

## Language

### Accounts

**Provider**:
The company whose subscription an account belongs to: Claude (Anthropic) or Codex (OpenAI).
_Avoid_: Vendor, backend, upstream

**Account**:
One login to one provider, with its credentials and identity (email, plan). The owner adds and removes accounts.
_Avoid_: Subscription, sub, credential, auth file

**Plan**:
The tier an account pays for, such as Claude Max 20x or ChatGPT Pro. Most plans are flat; a **usage-based** plan, such as an Enterprise organization's usage-based seat, pays for each request instead, up to a spend limit.
_Avoid_: Subscription, tier

**Pool**:
All enabled accounts of one provider, any of which may serve that provider's requests.
_Avoid_: Group, rotation

**Cooldown**:
The period an account sits out of its pool after hitting a provider limit (a used-up limit window, or a short rate limit), ending when the provider says the limit resets.
_Avoid_: Ban, block, suspension

**Account status**:
Where an account stands with its pool, exactly one of: **Active** (in the pool), **Cooling down** (out until a cooldown ends), **Needs sign-in** (out until the owner logs in again), or **Disabled** (out by the owner's choice).
_Avoid_: State, health, expired, banned

**Priority**:
The owner's ranking of an account within its pool, 1 first. Accounts may share a priority: a new session goes to the highest priority with an Active account, and among the accounts sharing it, to the one with the most headroom.
_Avoid_: Weight, order, tier

### Usage

**Limit window**:
A provider's rolling allowance for one account, such as Claude's 5-hour, weekly, and per-model weekly (Fable) windows, or Codex's 5-hour and weekly windows. It has a share used and a time it resets; the provider owns both, and the proxy observes them, changing them only when the owner redeems a limit reset.
_Avoid_: Quota, rate limit, usage limit, headroom (that is the router's view of the tightest window)

**Spend limit**:
The limit window of a usage-based plan: the most money its organization lets the account spend in a calendar month, with the money spent so far. Its share used is the money spent over the limit, and it resets on the 1st.
_Avoid_: Budget, cap, credits, overage

**Limit reset**:
A single-use grant from the provider that refills some of an account's limit windows before they would reset on their own. The owner **redeems** it; an unredeemed one may expire.
_Avoid_: Quota reset, reset credit, banked reset, grant, usage credits (those are pay-as-you-go billing past a limit)

**Usage**:
The requests that went through the proxy and the tokens each one spent, as the provider counted them.
_Avoid_: Traffic, stats, metrics, consumption

**Token kinds**:
The four disjoint parts of a request's tokens: uncached input, cache read, cache write, and output. Reasoning is part of output, and a cache write is to Claude's 5-minute or 1-hour cache; neither is a fifth kind.
_Avoid_: Prompt tokens, completion tokens, cached tokens

**Cache hit rate**:
The share of all input tokens (uncached input, cache read, and cache write) that were cache reads.
_Avoid_: Cache rate, hit ratio

**Equivalent cost**:
What usage would have cost at the provider's API list prices. For a flat plan, it measures what the plan is worth, not what was billed; a usage-based plan's spend limit shows what was billed. A write to Claude's 1-hour cache is priced at twice the input price, the 5-minute cache's at its own rate. A model with no known price is **unpriced** and left out of totals.
_Avoid_: Cost, spend, billing

### Clients

**Client**:
A coding agent that sends requests through the proxy, such as Claude Code, Codex, or opencode.
_Avoid_: Consumer, app, tool

**Session**:
One conversation in a client, identified by the client itself, and the unit that stays on one account.
_Avoid_: Thread, conversation, chat

**Proxy key**:
The secret a client presents to the proxy to be served. It is not any provider's credential.
_Avoid_: API key, token, client key

### Running it

**Daemon**:
The one long-running agent-proxy process on a machine, which serves the proxy, the daemon API and the dashboard. The CLI reaches it only over HTTP.
_Avoid_: Server, service, backend

**Install**:
The compiled `agent-proxy` binary at `~/.local/bin/agent-proxy`, built from a checkout by `bun run install-local`, with the dashboard embedded (ADR-0008).
_Avoid_: Package, release, deployment

**Build**:
What a binary was compiled from: its git commit, marked `-dirty` when the tree had uncommitted changes, or `source` for a run from the checkout.
_Avoid_: Version (that is the package version), revision

**Launch agent**:
The launchd job, `dev.endalk200.agent-proxy`, that `daemon install` registers on macOS. A daemon it runs is **supervised**: restarted after a crash, not after a clean stop.
_Avoid_: Service, plist, LaunchDaemon

**Connect** / **Disconnect**:
Pointing a client at the proxy through the client's own config file, and removing exactly what connect wrote there.
_Avoid_: Configure, setup, link
