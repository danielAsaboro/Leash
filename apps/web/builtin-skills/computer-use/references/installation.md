# Open Computer Use Installation

Open Computer Use runs locally as an npm-installed CLI and stdio MCP server.

Install or update the local package through the Mycelium workspace dependency, not as an ad hoc global requirement:

```sh
npm install open-computer-use@0.1.53
```

Verify the CLI:

```sh
open-computer-use -h
open-computer-use call list_apps
```

On macOS, run:

```sh
open-computer-use doctor
```

If Accessibility or Screen Recording is missing, the onboarding UI may open. Ask the user to approve the requested permissions in System Settings. Do not bypass TCC prompts or silently manipulate protected settings.

Leash launches the MCP server as:

```json
{
  "command": "open-computer-use",
  "args": ["mcp"]
}
```

All reasoning/model calls stay inside Leash/QVAC. Open Computer Use is only the local desktop automation MCP.
