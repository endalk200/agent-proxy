# Vision

Where agent-proxy is heading beyond the proxy. `AGENTS.md` holds what matters now; this file holds what comes later and what is still undecided. Nothing here is designed: an idea becomes a commitment only through an ADR in `docs/adr/`.

The ideas below share one direction: agent-proxy grows from a proxy on one machine into a hub that the owner's agents on every machine talk to. Prefer designs that leave that door open, without building for it yet.

## Remote

The owner wants to run the daemon on one of their VMs or boxes and reach it from other machines, probably over Tailscale. Unanswered: how clients authenticate to a daemon that is not on localhost, whether the daemon serves the web client itself, and whether one daemon serves the clients of several machines.

## Session archive

Collect every session from the owner's coding agents (Claude Code, Codex, opencode) into one central store, possibly an analytics database, so the owner can review and audit them to understand usage and improve their workflow. Today each agent keeps its sessions in its own local files on each machine.

## Skills sync

The owner's skills catalog lives in `endalk200/skills`, and the global ones are installed through their dotfiles repo. Keeping skills in sync across several workstations is manual. agent-proxy may take over distributing skills to every machine and agent.

## Open questions

- **What usage means.** Tokens and requests per account, remaining subscription limits (such as Claude's five-hour window), or both.
- **Providers beyond Claude and Codex.** None are planned; add one when the owner has a subscription to use.
