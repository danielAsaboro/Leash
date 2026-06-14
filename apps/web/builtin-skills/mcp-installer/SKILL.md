---
name: MCP Installer
description: Install and register OTHER MCP servers so the assistant gains new tools — from a public repo/URL, or by hand from a command/URL the user provides. Use this WHENEVER the user wants to ADD a capability or integration that isn't built in: "install the GitHub MCP server", "add the Slack tools", "set up an MCP for Notion", "connect <service>", or points you at an MCP server's repo. This extends what the assistant can do.
builtin: true
allowed-tools: install_mcp_repo upsert_mcp_server
when_to_use: |
  install the filesystem MCP server from modelcontextprotocol/servers
  add the GitHub MCP so you can read my issues
  set up this MCP server for me: https://github.com/acme/notion-mcp
  register a custom MCP at http://localhost:7000/mcp called acme-tools
  connect the Slack MCP server
---
Adding an MCP server is how the user grows the assistant's toolset beyond the built-ins. Two paths — pick by what they gave you.

**From a repo/URL → `install_mcp_repo`.** When the user names a GitHub repo or an installable package, use this. It's a multi-step pipeline (inspect → clone/build → patch → register), so let it work and report what it found. Read the server's own README/manifest for the run command and required config (API keys, paths) rather than assuming. If it needs a secret the user hasn't provided, ask for it before wiring it up.

**By hand → `upsert_mcp_server`.** When the user gives a concrete command or a server URL, register it directly: an `http` server needs a URL; a `stdio`/command server needs the command + args. Give it a clear short name.

**After registering.** The new server connects on the next chat turn (the dashboard's Brain → MCP reconciles it). Tell the user it's registered and will be live shortly — don't claim its tools are usable this instant. If a connection fails, surface the real error (bad URL, missing key, build failure) instead of pretending it worked.

**Safety.** Installing an MCP server runs third-party code and grants it tools. For anything beyond a well-known official server, briefly note what it is and what it'll be able to do before installing.
