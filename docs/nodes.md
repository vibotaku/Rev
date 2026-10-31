# Nodes: workspaces and agents on your computers

A **node** is a computer running `rev node`, a small background service. Once a computer is a node, you can do this from **Nodes** in Rev, without going to that machine:

- **Create a workspace:** a folder on the node, either cloned from a git repository or empty (`git init`), working on one Rev project. You can pick an existing project or create one on the spot.
- **Get an agent for it.** The node registers a new agent account for the workspace, `claude-<node>-<workspace>`, linked to you and a member of the project. It sets the folder up so Claude Code there uses that agent: the Rev plugin is enabled, and `REV_CONFIG` points at the agent's own login file.
- **Start and stop Claude Code** in the workspace. It runs in a tmux session called `rev-<workspace>`. When started, it is asked to work through its Rev tasks. Whenever a new task is assigned to its agent, the node types a note about it into the session, usually within 30 seconds.

The node connects out to Rev (it long-polls for work), so the computer needs no open ports, and it works behind NAT.

## Setting up a node

Requirements:

- Node.js 20 or newer.
- git, to clone repositories.
- tmux and [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in as the computer's user, to start agents.

In Rev, open **Nodes → Add a node**, paste or create an enrollment key, and run the commands it shows on the computer:

```bash
mkdir -p ~/.local/bin && curl -fsSL https://rev.example.com/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev
REV_ENROLL_KEY=rev_enroll_… ~/.local/bin/rev node install --url https://rev.example.com
```

Use `~/.local/bin/rev` rather than plain `rev`: macOS has a `rev` command of its own.

`rev node install`:

1. Registers the computer as a node owned by the key's creator. Like an agent registration, this uses up one registration of the key.
2. Saves the node's settings and token in `~/.config/rev/node.json` (mode 600).
3. Installs and starts the background service. On macOS this is a launchd agent, `~/Library/LaunchAgents/com.vibotaku.rev-node.plist`, logging to `~/Library/Logs/rev-node.log`. On Linux it is a systemd user service, `rev-node.service`; follow it with `journalctl --user -u rev-node -f`.

The node then appears under **Nodes**, with the tools it found.

| Option | Default | |
| --- | --- | --- |
| `--name <name>` | the host name | Shown in Rev, and part of agent names |
| `--root <dir>` | `~/rev-workspaces` | Where workspaces are created |
| `--claude-args "<args>"` | none | Extra `claude` arguments for agent sessions, e.g. `"--permission-mode acceptEdits"` or `"--model sonnet"` |
| `--no-service` | | Only register; run `rev node run` yourself |
| `--force` | | Register again as a new node |

Running `rev node install` again on a node keeps its registration. It reinstalls the service with the current CLI and applies any new `--root` or `--claude-args`. To upgrade a node, download the CLI again and rerun `rev node install`.

Other commands:

- `rev node status` shows the node's settings, tools and workspaces.
- `rev node run` serves Rev in the foreground; it is what the service runs.
- `rev node uninstall` removes the service. The node stays registered until you remove it in Rev.

### What agents may do without asking

Agent sessions run Claude Code with your normal Claude Code settings, plus `--claude-args`. Each workspace also allows the Rev tools, `mcp__plugin_rev_rev`, in its `.claude/settings.local.json`. That file is listed in `.git/info/exclude`, so it is never committed.

Nobody is at the keyboard, so give the session enough permissions to work, for example `--permission-mode acceptEdits` or an allow list in your settings. Otherwise it waits at a permission prompt until someone attaches and answers.

Permissions can only be set on the machine itself. Nothing in Rev can change them.

### Watching an agent

On the node, run `tmux attach -t rev-<workspace>`; the terminal icon next to a workspace in Rev copies this command. You see the session as the agent sees it and can type into it. Detach with `Ctrl-b d`.

### macOS: privacy permissions

Programs started by launchd don't get the permissions your terminal app has. Two things can need a one-time **Allow** for **node**, on the Mac's own screen:

- **Local Network**, when Rev's address is on the Mac's local network. Until you allow it, the node can't reach Rev: its log shows `EHOSTUNREACH`, and Rev shows it offline. It retries every minute.
- **Files and Folders**, when Claude Code reads files on an external volume or in Desktop, Documents or Downloads, for example a skill symlinked from there. Claude Code waits until you answer. When a session is stuck like this, starting it fails after 60 seconds with a note about it.

macOS doesn't always pop up the question for command-line programs like node. If it doesn't, turn node on yourself under **System Settings → Privacy & Security → Local Network**, and under **Files and Folders**. A Homebrew upgrade of node can reset these permissions.

To fix it, either:

- allow node as above (or give it Full Disk Access); or
- run the node from your terminal instead of as a service:
  ```bash
  ~/.local/bin/rev node install --no-service
  tmux new -d -s rev-node '~/.local/bin/rev node run'
  ```

### Linux: keep it running while you are logged out

```bash
loginctl enable-linger $USER
```

## Who can do what

- A node belongs to the human whose enrollment key registered it. That person and admins can see it, create workspaces on it, and start or stop its agents. Admins see every node with **All nodes**.
- Workspace agents are linked to the node's owner. They follow the usual agent rules: they work on tasks assigned to them, submit reviews, and can't decide on reviews or assign work.
- To create a workspace for a project, you must be an owner or member of it, or create the project there and then.
- A node runs only these jobs:
  - create a workspace;
  - start a session;
  - stop a session.

  It never runs commands sent from Rev. Workspace names are plain folder names, so a workspace can't be created outside the node's workspace folder. Repository URLs must be `https://`, `ssh://` or `git@host:path`.
- Disabling a node in Rev stops its token from working. Removing a node, or a workspace, disables the agents it created. Their folders stay on the machine.
- Disabling the node's owner also cuts the node off, like their agents.

## Troubleshooting

- **The node shows as offline.** Check the service log (see above), or run `~/.local/bin/rev node run` in a terminal to watch it.
- **"Setup failed".** The error comes from the node. Typical causes are `git clone` failing (private repositories need credentials for the node's user) or the folder already existing with files in it. Remove the workspace and create it again under another name, or delete the folder first.
- **A session won't start.** `tmux` or `claude` may be missing (the node card shows which tools it has), or Claude Code may not be signed in for that user, or it may be stuck on a macOS permission (see above). Attach with tmux to see what it shows.
