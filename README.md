# Boldbobbin for AI agents

Lets an MCP agent (Claude Code, Codex, Cursor and others) work on the design
you have open in Boldbobbin, in the browser or the desktop app: read it, edit
it with short scripts you can undo, and see the real stitches.

## Claude Code

```
/plugin install boldbobbin --marketplace Boldbobbin/agent
```

Then start a new session. In Boldbobbin choose **File > Connect an AI agent…**
and paste the prompt it shows into Claude Code.

On Claude Code older than 2.1.275, add the marketplace first:
`/plugin marketplace add Boldbobbin/agent`, then
`/plugin install boldbobbin@boldbobbin`.

## Other agents

Add the bridge as a local (stdio) MCP server:

```json
{ "mcpServers": { "boldbobbin": { "command": "npx", "args": ["-y", "@boldbobbin/agent"] } } }
```

With the desktop app you can instead point the agent at the app itself, with
nothing installed: `http://127.0.0.1:47831/mcp` (Streamable HTTP), while Agent
connections is on.

## How it works

A browser tab cannot accept connections, so the bridge listens on
`ws://127.0.0.1:47832` (or the next free port up to 47835, one per agent) and
the Boldbobbin tab connects to it. The desktop app listens on
`http://127.0.0.1:47831/mcp`, and the bridge connects to it. The bridge only
carries messages; it never reads or changes a design itself.

- Listens on `127.0.0.1` only.
- Accepts browser connections only from Boldbobbin's own pages (the `Origin`
  header).
- An agent still needs the pairing code Boldbobbin shows, once per design.
- Your browser may ask whether the Boldbobbin page may reach apps on this
  device: allow it.

Environment: `BOLDBOBBIN_RELAY_PORT` (one port instead of the range),
`BOLDBOBBIN_DESKTOP_PORT` (default 47831).

## License

The bridge, its plugin files and this README are under the MIT License
(`LICENSE`). "Boldbobbin" and the Boldbobbin logo are trademarks of
Boldbobbin GmbH; the license does not grant any right to use them. The
Boldbobbin app itself is proprietary and is not part of this repository.

## For maintainers

This directory is published as the public `Boldbobbin/agent` repository (a
Claude Code plugin marketplace whose plugin is the repository root) and as the
npm package `@boldbobbin/agent`. Its source of truth is
`tools/boldbobbin-agent/` in the Boldbobbin app repository. `catalogue.json`
and `skills/boldbobbin/SKILL.md` are generated from the app's MCP catalogue
(the `bb` scripting documentation is not: the bridge asks the running app);
do not edit them by hand (`relayCatalogue.test.ts`, `UPDATE_MCP_CATALOGUE=1`).
