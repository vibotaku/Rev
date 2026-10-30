# Rev for agents

An agent account belongs to a human (its *linked human*). It authenticates with API tokens and can:

- submit **review kits** (screenshots and screen recordings) to projects it is a member of,
- comment on reviews and reply to feedback,
- pull the **tasks assigned to it**, comment on them, and change their status, including closing them (`done`, `cancelled`).

It cannot approve reviews, accept or reject comments, create or assign tasks, or manage projects. Those are human decisions.

Tasks an agent closes are recorded and shown as **agent-closed** (a dashed violet badge) until a human reviews the closure. When you close a task, leave a note saying what you did and how you verified it. When there is something visual to check, submit a review kit with `--task` instead; that moves the task to `in_review` for a human.

## Setting up an agent

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

Instead of pasting the key, `/rev:setup https://rev.example.com bao:rev#enroll_key` makes Claude pipe it from OpenBao/Vault, so it never appears in the transcript. Claude checks Node.js, registers the machine (`<user>@<host>` by default, or ask for a name), saves the token to `~/.config/rev/config.json`, and verifies the connection.

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

`rev register` refuses to overwrite an existing setup unless you pass `--force`. Agent names must be unique among the linked human's agents.

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
- **Video feedback.** A comment on a video carries the exact time (`@ 0:03.400`), the annotated snapshot of that frame, and a **frame sheet**: 9 frames in a 3×3 grid, read row by row, from 1 s before to 1 s after, with the commented frame outlined in red. Use it to judge motion and timing ("the hit spark is late"). The text output lists each frame's time.
- **Decisions.** The review owner accepts or rejects every comment and every mark note separately. Only accepted ones become tasks.

The review's owner (your linked human) then approves it and closes the task, or accepts more comments, which come back to you as new tasks. For small, self-verifiable work you can close the task yourself with `rev task done WEB-12 --note "…"`; it then appears to humans as agent-closed until someone reviews it.

## CLI reference

| Command | Purpose |
| --- | --- |
| `rev register --url <url> [--key <key>\|-] [--name <name>] [--force]` | Self-register with an enrollment key and save the token |
| `rev login --url <url> --token <token>` | Verify and save a manually created token |
| `rev whoami`, `rev projects` | Identity and project memberships |
| `rev tasks [--all-statuses]` | Your open tasks (all statuses with the flag) |
| `rev task show <ref> [--save-snapshots <dir>]` | Task with source comments and their mark notes, exact timestamps, a text description of each annotation, and snapshot and frame-sheet downloads |
| `rev task start <ref>` | Move to `in_progress` |
| `rev task status <ref> <todo\|in_progress\|in_review\|done\|cancelled>` | Set status. Closing marks the task agent-closed. |
| `rev task done <ref> [--note <text>]` | Close it yourself, with a note on what was done and how it was verified |
| `rev task ready <ref> [--note <text>]` | Hand back for review without a kit (`in_review`) |
| `rev task comment <ref> <text>` | Progress notes and questions |
| `rev review create -p <KEY> -t <title> [options] <files…>` | Upload a review kit. Options: `--task`, `-d/--description`, `--description-file`, `--caption` (repeatable), `--caption-each`, `--draft` |
| `rev review round <ref> [-n/--notes <md>] [--notes-file <f>] [--task <ref>]… [--caption <t>]… [--caption-each] <files…>` | Submit the next round of a review after addressing its feedback |
| `rev review show <ref>` | The review round by round: notes, media, comments, mark notes (`#n`), replies |
| `rev review comment <ref> <text>` | General comment |
| `rev review reply <commentId> <text> --review <ref>` | Reply in a thread |
| `rev mcp` | Run the MCP server on stdio |

Add `--json` before any command for machine-readable output, e.g. `rev --json tasks`.

Accepted files: PNG, JPEG, WebP, and GIF images; MP4, WebM, MOV, and MKV videos. MP4 (H.264) and WebM play immediately; other formats are transcoded on the server.

## MCP server

The Claude Code plugin registers this server automatically. Without the plugin, `claude mcp add rev -- rev mcp`; any other MCP client can launch `rev mcp` over stdio. The server starts even before the machine is set up and reads credentials on every call. It includes workflow instructions and these tools:

| Tool | Purpose |
| --- | --- |
| `whoami`, `list_projects` | Identity and projects |
| `list_my_tasks` | Assigned tasks |
| `get_task` | Task details plus **images** of the feedback: annotated snapshots and, for video, frame sheets (up to 6) |
| `update_task_status` | Any status, with an optional note. `done` and `cancelled` are recorded as agent-closed. |
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
| `PATCH /api/tasks/WEB-12` `{"status":"in_progress"}` | Status |
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
