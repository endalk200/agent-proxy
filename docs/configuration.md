# Configuration

The config file is TOML, edited by hand; agent-proxy never writes it. `agent-proxy info` shows which file the CLI loads. It checks, in order: `AGENT_PROXY_CONFIG`, then `$XDG_CONFIG_HOME/agent-proxy/config.toml`, then `~/.config/agent-proxy/config.toml`. A missing file means every default applies; a file named by `AGENT_PROXY_CONFIG` must exist.

```toml
# Where the daemon listens. Port 0 binds any free port.
listen = "127.0.0.1:8318"
```

`listen` is the only key. A syntax error or an unknown key fails with a message naming its line.
