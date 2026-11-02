---
name: setup
description: Register this machine as a Rev agent using an enrollment key, then verify the connection. Use when the user wants to connect Claude Code to Rev, set up or re-register a Rev agent, or the Rev tools report "Rev is not set up on this machine".
argument-hint: <rev-url> [enrollment-key | bao:<path>#<field>] [agent-name]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs *), Bash(node --version)
---

# Set up Rev on this machine

Rev is a self-hosted task and visual-review tracker. This machine becomes an **agent** account linked to the human who created the enrollment key. The agent can pull its assigned tasks, submit review kits, and answer feedback.

The bundled CLI is `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs`. It stores credentials in `~/.config/rev/config.json` (mode 0600), or in the file `REV_CONFIG` names. The Rev MCP server in this plugin reads that file on every call, so the first agent on a machine works as soon as registration succeeds, with no restart.

A machine can hold several agents, for example one per repo. Each has its own file in `~/.config/rev/`, and a repo's `.claude/settings.local.json` picks one with `env.REV_CONFIG`.

Arguments: `$ARGUMENTS`

## Steps

1. **Check Node.js.** Run `node --version`; it must be 20 or newer. If it is older or missing, stop and tell the user to install Node.js 20+.

2. **Check for an existing setup.** Run `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs whoami`. If it prints an account, report it and stop, unless the user asked for a new agent (for example one for this repo). In that case continue: step 4 keeps the existing agent and saves the new one to its own file. Never pass `--force` for this; it replaces the existing agent's saved token.

3. **Collect the inputs.** Take them from the arguments, and ask the user for anything missing:
   - **Rev URL**, e.g. `https://rev.corp.example.com`.
   - **Enrollment key** (`rev_enroll_…`). A human creates one in Rev under **My agents → Enrollment keys**. It may arrive as:
     - a literal key;
     - `bao:<path>#<field>`, meaning an OpenBao/Vault KV secret such as `bao:rev#enroll_key` (mount `secret`);
     - nothing, if `REV_ENROLL_KEY` is already set in the environment.
   - **Agent name** (optional). It must be unique among the human's agents. The default is `<user>@<host>`. Suggest something descriptive, e.g. `claude-<host>-<repo>`.

   Treat the enrollment key as a secret: never print it, echo it, or write it to a file.

4. **Register.** Run exactly one of these from the project folder. `--repo .` makes Claude Code in this folder use the new agent; leave it out only if the user wants a machine-wide agent outside any repo.
   - Literal key:
     `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs register --url <url> --key <key> [--name <name>] --repo .`
   - Key in OpenBao/Vault (piped, so it never appears in output):
     `bao kv get -mount=secret -field=<field> <path> | node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs register --url <url> --key - [--name <name>] --repo .`
     Use `vault` instead of `bao` if only the Vault CLI is installed.
   - Key already in `REV_ENROLL_KEY`:
     `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs register --url <url> [--name <name>] --repo .`

   The command prints the file it saved the token to.

   Common errors:
   - "already exists for this owner" or "already holds an agent": pick another `--name`.
   - "revoked", "expired" or "no registrations left": ask the human for a fresh key.
   - "Cannot reach Rev": check the URL and the network.

5. **Verify** with the file step 4 printed: `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs --config <file> whoami`, then `projects` and `tasks` the same way. If the agent has no projects yet, tell the user that their human can add it from the project's **Members** tab.

6. **Report.** Give the agent name, the linked human, the projects joined, and the number of open tasks. Mention that the `/rev:workflow` skill and the Rev MCP tools (`list_my_tasks`, `get_task`, `create_review`, …) are ready. If the token went to a new file (the machine already had an agent), say that Claude Code must be restarted in this folder before the Rev tools use the new agent.

## Optional: a `rev` command in the terminal

Only do this if the user asks. Download the CLI that matches the server:

```bash
mkdir -p ~/.local/bin && curl -fsSL <url>/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev
```
