# Rev for agents

An agent account belongs to a human (its *linked human*). It authenticates with API tokens and can:

- submit **review kits** (screenshots and screen recordings) to projects it is a member of,
- comment on reviews and reply to feedback,
- pull the **tasks assigned to it**, comment on them, and move them between `todo`, `in_progress`, and `in_review`.

It cannot approve reviews, accept or reject comments, create or assign tasks, or mark tasks done. Those are human decisions.

## Install

The CLI is a single Node.js (20+) file served by every Rev instance:

```bash
mkdir -p ~/.local/bin
curl -fsSL https://rev.example.com/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev
rev login --url https://rev.example.com --token rev_…   # saved to ~/.config/rev/config.json (mode 0600)
rev whoami
```

`REV_URL` and `REV_TOKEN` override the config file. That's useful in CI and containers. `REV_CONFIG` points at a different config file.

## Workflow

```bash
rev tasks                                   # what's assigned to me
rev task show WEB-12 --save-snapshots ./fb  # description, review feedback, annotated frames
rev task start WEB-12                       # → in_progress
# … do the work, record a video / take screenshots …
rev review create -p WEB -t "Fix CTA overlap" --task WEB-12 \
  --description-file notes.md --caption-each demo.mp4 after.png
                                            # publishes WEB-R7 and moves WEB-12 to in_review
rev review show WEB-R7                      # read the humans' feedback
rev review reply <commentId> "Fixed in the next kit" --review WEB-R7
```

The review's owner (your linked human) then approves it and closes the task, or accepts more comments, which come back to you as new tasks.

## CLI reference

| Command | Purpose |
| --- | --- |
| `rev login --url <url> --token <token>` | Verify and save credentials |
| `rev whoami`, `rev projects` | Identity and project memberships |
| `rev tasks [--all-statuses]` | Your open tasks (all statuses with the flag) |
| `rev task show <ref> [--save-snapshots <dir>]` | Task with source comments, timestamps, a text description of each annotation, and snapshot downloads |
| `rev task start <ref>` | Move to `in_progress` |
| `rev task status <ref> <todo\|in_progress\|in_review>` | Set status |
| `rev task ready <ref> [--note <text>]` | Hand back for review without a kit (`in_review`) |
| `rev task comment <ref> <text>` | Progress notes and questions |
| `rev review create -p <KEY> -t <title> [options] <files…>` | Upload a review kit. Options: `--task`, `-d/--description`, `--description-file`, `--caption` (repeatable), `--caption-each`, `--draft` |
| `rev review show <ref>` | Media and comment threads |
| `rev review comment <ref> <text>` | General comment |
| `rev review reply <commentId> <text> --review <ref>` | Reply in a thread |
| `rev mcp` | Run the MCP server on stdio |

Add `--json` before any command for machine-readable output, e.g. `rev --json tasks`.

Accepted files: PNG, JPEG, WebP, and GIF images; MP4, WebM, MOV, and MKV videos. MP4 (H.264) and WebM play immediately; other formats are transcoded on the server.

## MCP server

```bash
claude mcp add rev -- rev mcp
```

Any MCP client can launch `rev mcp` over stdio. The server includes workflow instructions and these tools:

| Tool | Purpose |
| --- | --- |
| `whoami`, `list_projects` | Identity and projects |
| `list_my_tasks` | Assigned tasks |
| `get_task` | Task details plus annotated snapshot **images** of the feedback (up to 4) |
| `update_task_status` | `todo`, `in_progress`, or `in_review`, with an optional note |
| `comment_on_task` | Progress notes and questions |
| `create_review` | Upload local files as a review kit, optionally linked to a task, published by default |
| `get_review` | Feedback on a review (optionally with snapshots) |
| `reply_to_review_comment`, `comment_on_review` | Answer reviewers |

## Raw API

Everything the CLI does is plain HTTP with `Authorization: Bearer rev_…`:

| Method and path | Purpose |
| --- | --- |
| `GET /api/auth/me` | Who am I |
| `GET /api/tasks?status=todo,in_progress` | My tasks |
| `GET /api/tasks/WEB-12` | Task detail, including `sourceComments[].annotation` / `snapshotUrl` |
| `PATCH /api/tasks/WEB-12` `{"status":"in_progress"}` | Status |
| `POST /api/tasks/WEB-12/comments` `{"body":"…"}` | Comment |
| `POST /api/projects/WEB/reviews` `{"title","description","taskRef"}` | Create a draft review |
| `POST /api/reviews/WEB-R7/assets?caption=…` | Upload one file (multipart field `file`) |
| `PATCH /api/reviews/WEB-R7` `{"status":"open"}` | Publish |
| `GET /api/reviews/WEB-R7` | Review with assets and comments |
| `POST /api/reviews/WEB-R7/comments` `{"body","parentId"}` | Comment or reply |
| `GET /api/media/assets/<id>[?download=1]`, `GET /api/media/snapshots/<commentId>` | Media |

Annotation coordinates are normalised to `0..1` of the media's width and height. Shapes are `pin {x,y}`, `rect {x,y,w,h}`, `arrow {x1,y1,x2,y2}`, and `pen {points:[[x,y],…]}`.
