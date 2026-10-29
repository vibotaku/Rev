---
name: setup
description: Register this machine as a Rev agent using an enrollment key, then verify the connection. Use when the user wants to connect Claude Code to Rev, set up or re-register a Rev agent, or the Rev tools report "Rev is not set up on this machine".
argument-hint: <rev-url> [enrollment-key | bao:<path>#<field>] [agent-name]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs *), Bash(node --version)
---

# Set up Rev on this machine

Rev is a self-hosted task and visual-review tracker. This machine becomes an **agent** account linked to the human who created the enrollment key. The agent can pull its assigned tasks, submit review kits, and answer feedback.

The bundled CLI is `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs`. It stores credentials in `~/.config/rev/config.json` (mode 0600). The Rev MCP server in this plugin reads that file on every call, so it works as soon as registration succeeds, with no restart.

Arguments: `$ARGUMENTS`

## Steps

1. **Check Node.js.** Run `node --version`; it must be 20 or newer. If it is older or missing, stop and tell the user to install Node.js 20+.

2. **Check for an existing setup.** Run `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs whoami`. If it prints an account, report it and stop, unless the user explicitly asked to register a new agent; in that case add `--force` in step 4.

3. **Collect the inputs.** Take them from the arguments, and ask the user for anything missing:
   - **Rev URL**, e.g. `https://rev.corp.example.com`.
   - **Enrollment key** (`rev_enroll_…`). A human creates one in Rev under **My agents → Enrollment keys**. It may arrive as:
     - a literal key;
     - `bao:<path>#<field>`, meaning an OpenBao/Vault KV secret such as `bao:rev#enroll_key` (mount `secret`);
     - nothing, if `REV_ENROLL_KEY` is already set in the environment.
   - **Agent name** (optional). It must be unique among the human's agents. The default is `<user>@<host>`. Suggest something descriptive, e.g. `claude-<host>-<repo>`.

   Treat the enrollment key as a secret: never print it, echo it, or write it to a file.

4. **Register.** Run exactly one of these:
   - Literal key:
     `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs register --url <url> --key <key> [--name <name>]`
   - Key in OpenBao/Vault (piped, so it never appears in output):
     `bao kv get -mount=secret -field=<field> <path> | node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs register --url <url> --key - [--name <name>]`
     Use `vault` instead of `bao` if only the Vault CLI is installed.
   - Key already in `REV_ENROLL_KEY`:
     `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs register --url <url> [--name <name>]`

   Common errors:
   - "already exists for this owner": pick another `--name`.
   - "revoked", "expired" or "no registrations left": ask the human for a fresh key.
   - "Cannot reach Rev": check the URL and the network.

5. **Verify.** Run `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs whoami`, then `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs projects` and `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs tasks`. If the agent has no projects yet, tell the user that their human can add it from the project's **Members** tab.

6. **Report.** Give the agent name, the linked human, the projects joined, and the number of open tasks. Mention that the `/rev:workflow` skill and the Rev MCP tools (`list_my_tasks`, `get_task`, `create_review`, …) are now ready.

## Optional: a `rev` command in the terminal

Only do this if the user asks. Download the CLI that matches the server:

```bash
mkdir -p ~/.local/bin && curl -fsSL <url>/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev
```
