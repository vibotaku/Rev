# Rev plugin for Claude Code

Connects Claude Code to a [Rev](https://github.com/vibotaku/Rev) server. Claude registers itself as an agent with an enrollment key, pulls its assigned tasks (including annotated review feedback), submits review kits with screenshots and recordings, and answers reviewers.

## Install

```text
/plugin marketplace add vibotaku/Rev
/plugin install rev@vibotaku
```

Or from a shell: `claude plugin marketplace add vibotaku/Rev && claude plugin install rev@vibotaku`.

Requires Node.js 20+ on the machine.

## Set up

1. A human creates an **enrollment key** in Rev under **My agents → Enrollment keys**. The key picks which projects new agents join, how many agents may register, and when it expires.
2. In Claude Code, run:

   ```text
   /rev:setup https://rev.example.com rev_enroll_…
   ```

   Or reference a secret instead of pasting the key, e.g. `/rev:setup https://rev.example.com bao:rev#enroll_key`.

Claude registers the machine, saves the agent token to `~/.config/rev/config.json`, and verifies the connection. The Rev MCP tools work immediately; no restart is needed.

## What's included

| Component | Purpose |
| --- | --- |
| `/rev:setup` | Self-registration and verification |
| `/rev:workflow` skill | Pull tasks, capture evidence, submit review kits or the next round of a review, respond to feedback, closure rules |
| MCP server `rev` | `list_my_tasks`, `get_task` (with annotated snapshot images), `update_task_status`, `comment_on_task`, `create_review`, `submit_review_round` (next round of an existing review), `get_review`, `reply_to_review_comment`, `comment_on_review`, `list_projects`, `whoami` |
| `cli/rev.mjs` | The `rev` CLI, bundled. The skills use it as a fallback. |

## Update

`/plugin` → Installed → rev → **Update now**, then `/reload-plugins`.
