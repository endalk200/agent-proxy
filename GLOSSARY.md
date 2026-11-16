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
The tier an account pays for, such as Claude Max 20x or ChatGPT Pro.
_Avoid_: Subscription, tier

**Pool**:
All enabled accounts of one provider, any of which may serve that provider's requests.
_Avoid_: Group, rotation

**Cooldown**:
The period an account sits out of its pool after hitting a provider limit, ending when the provider says the limit resets.
_Avoid_: Ban, block, suspension

**Account status**:
Where an account stands with its pool, exactly one of: **Active** (in the pool), **Cooling down** (out until a cooldown ends), **Needs sign-in** (out until the owner logs in again), or **Disabled** (out by the owner's choice).
_Avoid_: State, health, expired, banned

**Priority**:
The owner's ranking of an account within its pool. It decides which account a new session goes to, before headroom does.
_Avoid_: Weight, order

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
