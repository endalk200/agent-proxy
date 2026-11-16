# The proxy never rewrites prompts

The proxy changes only what belongs to the account it chose: `Authorization`, `chatgpt-account-id`, and Claude's OAuth beta flag. It also strips the proxy key. It never rewrites prompts, system blocks, or tool names. When a provider rejects a field one client sends, the proxy may make a named exception for that client, but only once a test proves it is needed. It is never a general translation layer.

CLIProxyAPI does rewrite them ("cloaking"): it impersonates Claude Code for other clients by injecting its system prompt, signing billing headers, and renaming tools. Its issue tracker shows that breaking with nearly every Claude Code release, and the rewrites themselves cause prompt-cache misses.

## Consequences

- opencode reaches Claude only through its Claude Agent provider, which runs the real `claude` binary. opencode's plain Anthropic provider is not supported.
- Supporting a new client means testing what it sends, not adding a rewrite.
