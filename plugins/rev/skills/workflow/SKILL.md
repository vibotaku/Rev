---
name: workflow
description: Work through Rev, the team's task and visual-review tracker. Use to pick up tasks assigned to you, read annotated review feedback (video timestamps, marked-up snapshots), submit review kits with screenshots and screen recordings, answer reviewer comments, and close or hand back tasks. Triggers on mentions of Rev, task refs like WEB-12, review refs like WEB-R3, "review kit", or "check my Rev tasks".
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs *)
---

# Working with Rev

You act through an **agent account** linked to a human. Humans review your work visually: they scrub through your videos, draw on frames, and comment. The review's owner accepts the feedback that matters and turns it into tasks assigned back to you.

Use the **Rev MCP tools** from this plugin. If they are unavailable, use the bundled CLI, which has the same capabilities: `node ${CLAUDE_PLUGIN_ROOT}/cli/rev.mjs <command>` (`--help` lists commands; `--json` gives machine-readable output). If either says Rev is not set up, run `/rev:setup`.

## The loop

1. **Pull work.** Call `list_my_tasks`, then `get_task` with the task ref (`WEB-12`).
   - A task created from review feedback includes each source comment, with its video timestamp, a text description of the marks (box, arrow, pin, freehand, as percentages of the frame), and an **annotated snapshot image** of the exact frame. Read every one; each is a requirement.
   - CLI: `rev tasks`, `rev task show WEB-12 --save-snapshots ./rev-feedback`.
2. **Start.** Call `update_task_status` with `in_progress` (CLI: `rev task start WEB-12`).
3. **Do the work.** Use `comment_on_task` for progress notes or questions to the humans.
4. **Capture evidence** that a reviewer can check without running anything:
   - Screenshots: PNG/JPEG/WebP of the relevant screens, before and after if useful.
   - Screen recordings: short MP4 (H.264) or WebM clips, under about 60 s each, showing the flow that changed. Other formats work but are transcoded first.
   - Ways to capture:
     - Playwright: `page.screenshot({ path })`, or `browser.newContext({ recordVideo: { dir } })` for video.
     - macOS: `screencapture -x shot.png`; `screencapture -v clip.mov` for video.
     - Linux/X11: `ffmpeg -f x11grab -i :0 -t 20 clip.mp4`.
   - Save the files to a temp folder, not into the repo.
5. **Submit a review kit.** Call `create_review` with:
   - `project` (key), `title`, and `description` (markdown: what changed, why, how to verify, anything not done);
   - `files` (absolute paths) and optional `captions`;
   - `task_ref`, so the review is linked to the task. Publishing moves the task to `in_review`.

   CLI: `rev review create -p WEB -t "…" --task WEB-12 -d "…" --caption-each clip.mp4 after.png`.
6. **Respond to feedback.** Call `get_review` (with `include_snapshots: true` to see the marks). Use `reply_to_review_comment` to answer questions or explain decisions, and `comment_on_review` for general notes. Accepted comments come back to you as new tasks.

## Closing tasks

- Prefer handing work back for review (step 5) whenever there is anything visual or judgement-based to check.
- You may close your own task yourself (`update_task_status` with `done` or `cancelled`, or `rev task done WEB-12 --note "…"`) only when the work is small and you verified it objectively, e.g. tests or a reproducible check. Always add a note saying what you did and how you verified it.
- Tasks you close are shown to humans as **agent-closed** (a dashed violet badge) until a human reviews them. That is expected; don't try to avoid it.

## Rules

- You cannot approve reviews, accept or reject comments, create or assign tasks, or manage projects. Those decisions belong to the humans. Ask in a comment if you need one of them.
- Work only on tasks assigned to you, and link review kits only to your own tasks.
- Keep review titles short and specific. Put the reasoning in the description, not in the title.
- Never print or store Rev tokens or enrollment keys.
