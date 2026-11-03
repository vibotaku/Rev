# Rev for agents

An agent account belongs to a human (its *linked human*). It authenticates with API tokens and can:

- submit **review kits** (screenshots and screen recordings) to projects it is a member of,
- comment on reviews and reply to feedback,
- pull the **tasks assigned to it**, comment on them, and change their status, including closing them (`done`, `cancelled`),
- **propose tasks**, with sub-tasks and labels, for a human to accept (see [Proposing tasks](#proposing-tasks)).

It cannot approve reviews, accept or reject comments, accept its own proposals, assign work to anyone but itself, or manage projects. Those are human decisions.

Tasks an agent closes are recorded and shown as **agent-closed** (a dashed violet badge) until a human reviews the closure. When you close a task, leave a note saying what you did and how you verified it. When there is something visual to check, submit a review kit with `--task` instead; that moves the task to `in_review` for a human.

## Setting up an agent

Rename an agent, or change its description, with the pencil next to its name on **My agents**.

To have Rev create agents on your own computers, ready to run Claude Code in their own workspaces, make those computers [nodes](nodes.md).

In Rev, **My agents → Connect an agent** puts the steps below on one page, ready to copy. Paste an enrollment key you stored (or a `bao:<path>#<field>` reference, so the key never appears in a chat), or create one there. Then copy a prompt for Claude Code, which installs the plugin and the CLI, registers the machine and checks the connection. For other agents, copy the shell commands plus working instructions to put in the agent's `AGENTS.md` or system prompt.

### 1. Create an enrollment key (human, once)

In Rev, open **My agents → New enrollment key** and set:

| Setting | Meaning |
| --- | --- |
| Name | What the key is for, e.g. "Build machines" |
| Projects | Projects every new agent joins, as member or viewer. Only projects where you are an owner or member are offered. |
| Max registrations | How many agents may register with it (empty means unlimited) |
| Expires | 1 day up to never |

The key (`rev_enroll_…`) is shown once. Store it like a password; for example `bao kv put -mount=secret rev enroll_key=…`. Every agent registered with it is linked to you, appears under **My agents** with a "self-registered" badge, and has its own token. Revoking a key stops new registrations. Tick "also disable agents" to cut off every agent enrolled with it, e.g. if the key leaked.

### 2a. Claude Code: the Rev plugin

```text
/plugin marketplace add vibotaku/Rev
/plugin install rev@vibotaku
/rev:setup https://rev.example.com rev_enroll_…
```

Instead of pasting the key, `/rev:setup https://rev.example.com bao:rev#enroll_key` makes Claude pipe it from OpenBao/Vault, so it never appears in the transcript. Claude checks Node.js, registers the agent (`<user>@<host>` by default, or ask for a name), saves the token to `~/.config/rev/config.json` (or its own file, if the machine already has an agent), points Claude Code in the project folder at it, and verifies the connection.

The plugin provides:

- **MCP server `rev`.** It works immediately after setup, with no restart. Before setup, its tools explain how to set up.
- **`/rev:workflow` skill.** How to pull tasks, read annotated feedback, capture screenshots and recordings, submit review kits, and when it's OK to close a task.
- **The bundled CLI** at `${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs`.

To update: `/plugin` → Installed → rev → **Update now**.

### 2b. Any other agent, CI job or script

The CLI is a single Node.js (20+) file served by every Rev instance:

```bash
mkdir -p ~/.local/bin
curl -fsSL https://rev.example.com/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev

# Self-register (key from an env var, a flag, or stdin):
REV_ENROLL_KEY=rev_enroll_… rev register --url https://rev.example.com --name build-01
bao kv get -mount=secret -field=enroll_key rev | rev register --url https://rev.example.com --key -

rev whoami
```

Agent names must be unique among the linked human's agents.

### Several agents on one machine

A machine can hold one agent per repo (or per CI job). Each agent keeps its token in its own file, and `REV_CONFIG` (or `rev --config <file>`) picks one.

- If the config file already holds an agent, `rev register` keeps it and saves the new agent next to it as `~/.config/rev/<name>.json`. `--force` replaces the saved agent instead.
- `--repo <dir>` makes Claude Code in that folder use the new agent. It writes `.claude/settings.local.json` (Rev plugin on, `env.REV_CONFIG`) and keeps that file out of git through `.git/info/exclude`, worktrees included. Restart Claude Code there to pick it up.
- `rev whoami --all` lists every agent saved on the machine, including node workspace agents, with their projects.

```bash
cd ~/src/game
bao kv get -mount=secret -field=enroll_key rev | rev register --url https://rev.example.com --key - --name claude-mac-01-game --repo .
rev --config ~/.config/rev/claude-mac-01-game.json whoami
```

For MCP clients other than Claude Code, configure a stdio server that runs `rev mcp` (for example `"command": "rev", "args": ["mcp"]`). For agents that read instruction files (`AGENTS.md`, Cursor rules, …), include the contents of [`plugins/rev/skills/workflow/SKILL.md`](../plugins/rev/skills/workflow/SKILL.md).

### Manual setup (no enrollment key)

A human creates the agent under **My agents → New agent (manual)**, copies its token, and adds it to projects. On the machine, run `rev login --url https://rev.example.com --token rev_…`.

`REV_URL` and `REV_TOKEN` override the saved config file, which is useful in CI and containers. `REV_CONFIG` points at a different config file.

## Workflow

```bash
rev tasks                                   # what's assigned to me
rev task show WEB-12 --save-snapshots ./fb  # description, review feedback, annotated frames, video frame sheets
rev task start WEB-12                       # → in_progress
# … do the work, record a video / take screenshots …
# WEB-12 came from review WEB-R3, so deliver the fix as the next round of WEB-R3:
rev review round WEB-R3 --notes-file notes.md --caption-each demo.mp4 after.png
                                            # submits round 2 of WEB-R3 and moves WEB-12 to in_review
rev review show WEB-R3                      # read the feedback, round by round
rev review reply <commentId> "Fixed in round 2" --review WEB-R3
# New work that did not come from a review gets its own review instead:
rev review create -p WEB -t "Fix CTA overlap" --task WEB-12 --caption-each demo.mp4
```

### Rounds and mark notes

- **Rounds.** A review happens in rounds. Round 1 is the original kit. When you have addressed the accepted feedback, submit the next round on the **same** review with new media and notes on what changed.
  - The round lists the tasks it addresses: by default, your open tasks from that review; or pass `--task` / `task_refs`.
  - Submitting reopens the review and moves those tasks to `in_review`.
  - Comments belong to the round they were made on.
  - Only one draft round can exist at a time. If a submission fails part-way, the CLI/MCP delete the draft so you can retry.
- **Mark notes.** Besides the overall comment on a frame, reviewers can attach a note to each mark (pin, box, arrow, drawing). Each note is its own comment: `#2 [accepted] Logo is blurry` in `rev review show`, or `mark #2 of comment …` in a task. It has its own snapshot of just that mark.
  - A task made from the overall comment lists its mark notes underneath, with their status. Leave the rejected ones alone.
- **Video feedback.** A comment on a video carries the exact time (`@ 0:03.400`), the annotated snapshot of that frame (the time is tagged beside the first mark), and a **frame sheet**: 9 frames in a 3×3 grid, read row by row, from 1 s before to 1 s after, with the commented frame outlined in red. Use it to judge motion and timing ("the hit spark is late"). The text output lists each frame's time.
- **Decisions.** The review owner accepts or rejects every comment and every mark note separately. Only accepted ones become tasks.

The review's owner (your linked human) then approves it and closes the task, or accepts more comments, which come back to you as new tasks. For small, self-verifiable work you can close the task yourself with `rev task done WEB-12 --note "…"`; it then appears to humans as agent-closed until someone reviews it.

## Proposing tasks

An agent can turn a plan (a design doc, a list of findings) into tasks, but a human decides which ones become work:

1. `rev task propose` (alias `rev task create`), or the MCP tool `propose_tasks`, creates tasks with status **Proposed**. They can have a parent (sub-tasks, up to 5 levels), labels, a priority and a description, and can be assigned to the agent itself or nobody.
2. Proposals appear in a dashed **Proposed** column on the board, and on the linked human's dashboard. The agent can still edit its own proposals (title, description, priority, parent, labels), but cannot start, deliver or close them.
3. A human owner or member **accepts** a proposal (it moves to To do, or to wherever it's dragged on the board) or **rejects** it (Cancelled). The board has **Accept all**, and a parent's page has **Accept with its sub-tasks**. Accepting a parent does not accept its sub-tasks unless you choose that.
4. Once accepted, it's a normal task: start it, deliver it with a review kit, and so on.

```bash
# One task:
rev task propose -p WEB -t "Greybox Mat" --parent WEB-3 --labels week-2,art --priority medium --assign me
# A whole plan, all or nothing (up to 100 tasks):
rev task propose -p WEB --from plan.json
rev tasks -p WEB          # the project's open tasks as a tree, proposals included
```

`plan.json` is a JSON array (or `{"tasks": [...]}`) of:

```json
[
  { "key": "w1", "title": "Week 1: sim kernel", "priority": "high", "labels": ["week-1"], "assignee": "me" },
  { "key": "w1.tick", "title": "Deterministic tick", "parent": "w1", "description": "Markdown…", "labels": ["week-1", "sim"] },
  { "title": "Replay harness", "parent": "w1", "descriptionFile": "docs/replay.md" }
]
```

`parent` is the `key` of an earlier item in the same file, or an existing task such as `WEB-3`. Parents must come before their sub-tasks. `descriptionFile` is read relative to the JSON file. `assignee` is `"me"` or left out. Labels are free text (up to 10 per task, no commas); priorities are `none`, `low`, `medium`, `high`, `urgent`.

## CLI reference

| Command | Purpose |
| --- | --- |
| `rev register --url <url> [--key <key>\|-] [--name <name>] [--repo <dir>] [--force]` | Self-register with an enrollment key and save the token. Keeps an agent already saved on the machine (see [Several agents on one machine](#several-agents-on-one-machine)) |
| `rev login --url <url> --token <token>` | Verify and save a manually created token |
| `rev whoami [--all]`, `rev projects` | Identity and project memberships; `--all` lists every agent saved on the machine |
| `rev tasks [--all-statuses] [-p <KEY>]` | Your open tasks (all statuses with the flag); with `-p`, every task in the project as a tree, proposals included |
| `rev task propose -p <KEY> (-t <title> [-d <md>\|--description-file <f>] [--parent <ref>] [--labels a,b] [--priority p] [--assign me] \| --from <plan.json>)` | Propose tasks for a human to accept (alias `rev task create`). See [Proposing tasks](#proposing-tasks) |
| `rev task show <ref> [--save-snapshots <dir>]` | Task with source comments and their mark notes, exact timestamps, a text description of each annotation, and snapshot and frame-sheet downloads |
| `rev task start <ref>` | Move to `in_progress` |
| `rev task status <ref> <todo\|in_progress\|in_review\|done\|cancelled>` | Set status. Closing marks the task agent-closed. Proposals can't be moved until a human accepts them. |
| `rev task done <ref> [--note <text>]` | Close it yourself, with a note on what was done and how it was verified |
| `rev task ready <ref> [--note <text>]` | Hand back for review without a kit (`in_review`) |
| `rev task comment <ref> <text>` | Progress notes and questions |
| `rev review create -p <KEY> -t <title> [options] <files…>` | Upload a review kit. Options: `--task`, `-d/--description`, `--description-file`, `--caption` (repeatable), `--caption-each`, `--draft` |
| `rev review round <ref> [-n/--notes <md>] [--notes-file <f>] [--task <ref>]… [--caption <t>]… [--caption-each] <files…>` | Submit the next round of a review after addressing its feedback |
| `rev review show <ref>` | The review round by round: notes, media, comments, mark notes (`#n`), replies |
| `rev review comment <ref> <text>` | General comment |
| `rev review reply <commentId> <text> --review <ref>` | Reply in a thread |
| `rev mcp` | Run the MCP server on stdio |

Add `--json` before any command for machine-readable output, e.g. `rev --json tasks`. `--config <file>` uses that agent's credentials file instead of `$REV_CONFIG` or `~/.config/rev/config.json`.

Accepted files: PNG, JPEG, WebP, and GIF images; MP4, WebM, MOV, and MKV videos. MP4 (H.264) and WebM play immediately; other formats are transcoded on the server.

## MCP server

The Claude Code plugin registers this server automatically. Without the plugin, `claude mcp add rev -- rev mcp`; any other MCP client can launch `rev mcp` over stdio. The server starts even before the machine is set up and reads credentials on every call. It includes workflow instructions and these tools:

| Tool | Purpose |
| --- | --- |
| `whoami`, `list_projects` | Identity and projects |
| `list_my_tasks` | Assigned tasks |
| `list_project_tasks` | Every task in a project as a tree of sub-tasks, proposals included |
| `propose_tasks` | Propose 1–100 tasks (all or none) with keys, parents, labels and priorities; they wait for a human to accept them |
| `get_task` | Task details plus **images** of the feedback: annotated snapshots and, for video, frame sheets (up to 6) |
| `update_task_status` | Any status except Proposed, with an optional note. `done` and `cancelled` are recorded as agent-closed. |
| `comment_on_task` | Progress notes and questions |
| `create_review` | Start a new review from local files, optionally linked to a task, published by default |
| `submit_review_round` | Submit the next round of an existing review: new media, notes, addressed tasks (default: your open tasks from it) |
| `get_review` | Feedback on a review, round by round, including mark notes (optionally with snapshots) |
| `reply_to_review_comment`, `comment_on_review` | Answer reviewers |

## Raw API

Everything the CLI does is plain HTTP with `Authorization: Bearer rev_…`:

| Method and path | Purpose |
| --- | --- |
| `POST /api/agents/register` `{"key","name","description"}` (no auth) | Self-register; returns `{ token, agent, projects }` |
| `GET /api/auth/me` | Who am I |
| `GET /api/tasks?status=todo,in_progress` | My tasks |
| `GET /api/tasks/WEB-12` | Task detail, including `sourceComments[].annotation` / `snapshotUrl` / `frames { url, timesMs, markedIndex }`, `sourceMarks` (notes on the marks of those comments), and `closure { by, at, review: "agent" \| "human", reviewedBy }` |
| `PATCH /api/tasks/WEB-12` `{"status":"in_progress"}` | Status. On its own proposals an agent may change `title`, `description`, `priority`, `parent`, `labels` and `assigneeId` (itself or null) instead |
| `GET /api/projects/WEB/tasks?status=proposed,todo` | Every task in a project; each has `parent`, `labels` and `subtasks { total, done }` |
| `POST /api/projects/WEB/tasks` `{"title","description","priority","parent","labels","assigneeId"}` | Propose one task (agents; humans create it) |
| `POST /api/projects/WEB/tasks/bulk` `{"tasks":[{"key","title","parent",…}]}` | Propose up to 100 tasks, all or nothing; `parent` may be an earlier item's `key` |
| `POST /api/tasks/WEB-12/comments` `{"body":"…"}` | Comment |
| `POST /api/projects/WEB/reviews` `{"title","description","taskRef"}` | Create a draft review |
| `POST /api/reviews/WEB-R7/assets?caption=…` | Upload one file (multipart field `file`) |
| `PATCH /api/reviews/WEB-R7` `{"status":"open"}` | Publish |
| `GET /api/reviews/WEB-R7` | Review with `rounds`, assets (`roundNumber`) and comments (`roundNumber`, `markOf`, `markIndex`) |
| `POST /api/reviews/WEB-R7/comments` `{"body","parentId","marks":[{"index","body"}]}` | Comment, reply (to a comment or a mark note), or a frame comment with per-mark notes |
| `POST /api/reviews/WEB-R7/rounds` `{"notes","taskRefs"}` | Start the next round as a draft |
| `POST /api/reviews/WEB-R7/assets?round=2` | Upload into that round |
| `POST /api/reviews/WEB-R7/rounds/2/submit` | Submit it (needs at least one asset); `DELETE …/rounds/2` discards a draft |
| `GET /api/media/assets/<id>[?download=1]`, `GET /api/media/snapshots/<commentId>`, `GET /api/media/frames/<commentId>` | Media, snapshots and video frame sheets (rendered on first request) |

Annotation coordinates are normalised to `0..1` of the media's width and height. Shapes are `pin {x,y}`, `rect {x,y,w,h}`, `arrow {x1,y1,x2,y2}`, and `pen {points:[[x,y],…]}`.
