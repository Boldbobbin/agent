# Boldbobbin for AI agents

Lets an MCP agent (Claude Code, Codex, Cursor and others) work on the design
you have open in Boldbobbin, in the browser or the desktop app: read it, edit
it with short scripts you can undo, and see the real stitches.

## Claude Code

```
/plugin install boldbobbin --marketplace Boldbobbin/agent
```

Then start a new session. In Boldbobbin choose **Agent > I have my own…** (or
**File > Connect an AI agent…**) and paste the prompt it shows into Claude
Code.

On Claude Code older than 2.1.275, add the marketplace first:
`/plugin marketplace add Boldbobbin/agent`, then
`/plugin install boldbobbin@boldbobbin`.

## Codex

In a terminal, with the Codex CLI:

```
codex mcp add boldbobbin -- npx -y @boldbobbin/agent
```

With Codex in VS Code or the Codex app, which may leave no `codex` command in
the terminal, add these lines to `~/.codex/config.toml` instead (in VS Code:
Codex's gear menu > MCP settings > Open config.toml), or paste the prompt and
let Codex add them:

```toml
[mcp_servers.boldbobbin]
command = "npx"
args = ["-y", "@boldbobbin/agent"]
```

Then start Codex again (in VS Code: restart the extension). In Boldbobbin choose **Agent > I have my own…** (or
**File > Connect an AI agent…**) and paste the prompt it shows into Codex. The
first start downloads the bridge; if the Boldbobbin tools are missing the
first time, start Codex once more.

## Other agents

Every agent needs Node 18 or newer. Add the bridge as a local (stdio) MCP
server (in Cursor: `~/.cursor/mcp.json`):

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
- Files are read and written here, on your computer; the app never sees a
  path. `boldbobbin_add_picture` reads a PNG, JPEG, WebP, GIF or BMP picture
  (15 MB at most, checked by its first bytes). `boldbobbin_export` writes a
  machine file only with the format's own extension (`.pes`, `.dst`…), and
  never over an existing file unless the agent passes `overwrite`. The
  bridge runs outside an agent's own sandbox, so ask your agent to write
  only where you said.
- An export follows the app's own rules: a design holding Pro features
  your plan does not include is refused, as the Export button does.
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
